"""WordPress Global Plugin Library service.

A thin global layer on top of the existing per-site WP-CLI plugin management
(:class:`WordPressService`). It lets an operator register their own plugins from
a GitHub repo or a local path in a global library, cache a snapshot on disk, and
install/update those plugins across any number of managed WordPress sites.

Design notes
------------
- The cache lives at ``paths.WP_PLUGIN_CACHE_DIR/<slug>/`` and holds a working
  copy of the plugin folder (a git clone for GitHub sources, an rsync/copy
  snapshot for local sources — never a symlink, which is brittle across Docker
  volume mounts and deployments).
- Installing copies the cache dir into ``<site_root>/wp-content/plugins/<slug>``
  on the host. For Docker sites that host dir is bind-mounted into the container,
  so the copy is visible to WP-CLI, which auto-detects Docker via
  :meth:`WordPressService.wp_cli`.
"""

import os
import re
import shutil
import subprocess
from datetime import datetime
from typing import Dict, List, Optional

from app import db, paths
from app.models.wordpress_custom_plugin import WordPressCustomPlugin, WordPressSitePlugin
from app.models.wordpress_site import WordPressSite
from .wordpress_service import WordPressService
from app.utils.system import run_privileged

# Slug rule: lowercase letters, digits, single dashes (a wp-content/plugins dir name).
_SLUG_RE = re.compile(r'^[a-z0-9]+(?:-[a-z0-9]+)*$')


class PluginLibraryError(Exception):
    """Raised for validation / operation failures the API should surface as 400."""


class WordPressPluginLibraryService:

    CACHE_DIR = paths.WP_PLUGIN_CACHE_DIR

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    @classmethod
    def cache_path(cls, slug: str) -> str:
        return os.path.join(cls.CACHE_DIR, slug)

    @staticmethod
    def slugify(value: str) -> str:
        value = (value or '').lower()
        value = re.sub(r'[^a-z0-9]+', '-', value).strip('-')
        return value

    @staticmethod
    def validate_slug(slug: str) -> str:
        slug = (slug or '').strip()
        if not slug or not _SLUG_RE.match(slug):
            raise PluginLibraryError(
                'Invalid slug: use lowercase letters, digits and single dashes')
        return slug

    @classmethod
    def _github_clone_url(cls, plugin: WordPressCustomPlugin, user_id: Optional[int]) -> str:
        """Resolve the git URL to clone/pull for a GitHub source.

        Supports ``owner/repo``, a full ``https://…`` / ``git@…`` URL, and an
        authenticated URL via an OAuth source connection when ``connection_id``
        is set.
        """
        src = (plugin.source_url or '').strip()

        if plugin.connection_id and user_id is not None:
            # owner/repo is required to resolve an authenticated URL
            full_name = src
            if src.startswith('http'):
                # strip scheme/host to get owner/repo
                full_name = re.sub(r'^https?://[^/]+/', '', src)
            full_name = re.sub(r'\.git$', '', full_name)
            try:
                from app.services.source_connection_service import SourceConnectionService
                info = SourceConnectionService.get_authenticated_clone_url(
                    user_id, plugin.connection_id, full_name)
                return info['clone_url']
            except Exception as e:
                raise PluginLibraryError(f'Could not resolve authenticated repo URL: {e}')

        if src.startswith('http') or src.startswith('git@'):
            return src
        # Bare owner/repo → public GitHub HTTPS URL
        if re.match(r'^[\w.-]+/[\w.-]+$', src):
            return f'https://github.com/{src}.git'
        raise PluginLibraryError('Invalid GitHub source: use owner/repo or a git URL')

    # ------------------------------------------------------------------
    # Header parsing
    # ------------------------------------------------------------------
    _HEADER_FIELDS = {
        'name': 'Plugin Name',
        'version': 'Version',
        'description': 'Description',
        'author': 'Author',
    }

    @classmethod
    def parse_plugin_header(cls, cache_path: str, slug: str) -> Dict[str, Optional[str]]:
        """Read the plugin header block from ``<slug>.php`` or the first PHP file.

        WordPress only reads the first 8 KB of the main file for headers, so we
        do the same rather than scanning entire files.
        """
        candidate = os.path.join(cache_path, f'{slug}.php')
        php_file = candidate if os.path.isfile(candidate) else None

        if php_file is None and os.path.isdir(cache_path):
            for entry in sorted(os.listdir(cache_path)):
                if entry.lower().endswith('.php'):
                    php_file = os.path.join(cache_path, entry)
                    break

        result: Dict[str, Optional[str]] = {k: None for k in cls._HEADER_FIELDS}
        if not php_file or not os.path.isfile(php_file):
            return result

        try:
            with open(php_file, 'r', encoding='utf-8', errors='replace') as fh:
                blob = fh.read(8192)
        except OSError:
            return result

        for key, label in cls._HEADER_FIELDS.items():
            # e.g.  * Plugin Name: My Plugin
            m = re.search(rf'^[ \t/*#@]*{re.escape(label)}\s*:\s*(.+)$', blob, re.MULTILINE)
            if m:
                result[key] = m.group(1).strip()
        return result

    # ------------------------------------------------------------------
    # Sync (fetch source into cache)
    # ------------------------------------------------------------------
    @classmethod
    def sync_plugin(cls, plugin: WordPressCustomPlugin, user_id: Optional[int] = None) -> Dict:
        """Refresh the cached copy from source and re-parse the plugin header."""
        dest = cls.cache_path(plugin.slug)
        try:
            os.makedirs(cls.CACHE_DIR, exist_ok=True)

            if plugin.source_type == 'github':
                cls._sync_github(plugin, dest, user_id)
            elif plugin.source_type == 'local':
                cls._sync_local(plugin, dest)
            else:
                raise PluginLibraryError(f'Unknown source_type: {plugin.source_type}')

            header = cls.parse_plugin_header(dest, plugin.slug)
            if header.get('name'):
                plugin.name = header['name']
            if header.get('version'):
                plugin.version = header['version']
            if header.get('description'):
                plugin.description = header['description']
            if header.get('author'):
                plugin.author = header['author']

            plugin.last_synced_at = datetime.utcnow()
            plugin.sync_error = None
            db.session.commit()
            return {'success': True, 'plugin': plugin.to_dict()}
        except PluginLibraryError as e:
            plugin.sync_error = str(e)
            db.session.commit()
            return {'success': False, 'error': str(e)}
        except Exception as e:
            plugin.sync_error = str(e)
            db.session.commit()
            return {'success': False, 'error': str(e)}

    @classmethod
    def _sync_github(cls, plugin: WordPressCustomPlugin, dest: str, user_id: Optional[int]):
        url = cls._github_clone_url(plugin, user_id)
        branch = plugin.branch or 'main'
        git_dir = os.path.join(dest, '.git')

        if os.path.isdir(git_dir):
            # Existing clone → fetch + hard reset to the tracked branch/tag.
            subprocess.run(['git', '-C', dest, 'remote', 'set-url', 'origin', url],
                           capture_output=True, text=True, timeout=30)
            fetch = subprocess.run(['git', '-C', dest, 'fetch', '--depth', '1', 'origin', branch],
                                   capture_output=True, text=True, timeout=180)
            if fetch.returncode != 0:
                raise PluginLibraryError(f'git fetch failed: {fetch.stderr.strip()}')
            reset = subprocess.run(['git', '-C', dest, 'reset', '--hard', 'FETCH_HEAD'],
                                   capture_output=True, text=True, timeout=60)
            if reset.returncode != 0:
                raise PluginLibraryError(f'git reset failed: {reset.stderr.strip()}')
        else:
            if os.path.exists(dest):
                shutil.rmtree(dest, ignore_errors=True)
            clone = subprocess.run(
                ['git', 'clone', '--depth', '1', '--branch', branch, url, dest],
                capture_output=True, text=True, timeout=300)
            if clone.returncode != 0:
                # Retry without --branch (repo default branch / tag mismatch)
                shutil.rmtree(dest, ignore_errors=True)
                clone = subprocess.run(['git', 'clone', '--depth', '1', url, dest],
                                       capture_output=True, text=True, timeout=300)
                if clone.returncode != 0:
                    raise PluginLibraryError(f'git clone failed: {clone.stderr.strip()}')

    @classmethod
    def _sync_local(cls, plugin: WordPressCustomPlugin, dest: str):
        src = (plugin.source_url or '').strip()
        if not src or not os.path.isdir(src):
            raise PluginLibraryError(f'Local source path not found: {src}')
        # Snapshot copy (not a symlink) so the site never depends on the live path.
        if os.path.exists(dest):
            shutil.rmtree(dest, ignore_errors=True)
        shutil.copytree(src, dest)

    # ------------------------------------------------------------------
    # Library CRUD
    # ------------------------------------------------------------------
    @classmethod
    def add_plugin(cls, data: Dict, user_id: Optional[int] = None) -> Dict:
        source_type = (data.get('source_type') or 'github').strip()
        if source_type not in ('github', 'local'):
            raise PluginLibraryError('source_type must be "github" or "local"')

        source_url = (data.get('source_url') or '').strip()
        if not source_url:
            raise PluginLibraryError('source_url is required')

        # Derive a slug if not supplied: last path segment of the source.
        slug = (data.get('slug') or '').strip()
        if not slug:
            base = os.path.basename(source_url.rstrip('/')).replace('.git', '')
            slug = cls.slugify(base)
        slug = cls.validate_slug(slug)

        if WordPressCustomPlugin.query.filter_by(slug=slug).first():
            raise PluginLibraryError(f'A plugin with slug "{slug}" already exists')

        plugin = WordPressCustomPlugin(
            slug=slug,
            source_type=source_type,
            source_url=source_url,
            branch=(data.get('branch') or 'main').strip(),
            connection_id=data.get('connection_id'),
            name=data.get('name'),
            is_active=True,
        )
        db.session.add(plugin)
        db.session.commit()

        sync = cls.sync_plugin(plugin, user_id)
        result = plugin.to_dict()
        if not sync.get('success'):
            result['sync_error'] = sync.get('error')
        return result

    @classmethod
    def update_plugin(cls, plugin_id: int, data: Dict, user_id: Optional[int] = None) -> Dict:
        plugin = WordPressCustomPlugin.query.get(plugin_id)
        if not plugin:
            raise PluginLibraryError('Plugin not found')

        resync = False
        if 'source_url' in data and data['source_url']:
            plugin.source_url = data['source_url'].strip()
            resync = True
        if 'source_type' in data and data['source_type']:
            if data['source_type'] not in ('github', 'local'):
                raise PluginLibraryError('source_type must be "github" or "local"')
            plugin.source_type = data['source_type']
            resync = True
        if 'branch' in data and data['branch']:
            plugin.branch = data['branch'].strip()
            resync = True
        if 'connection_id' in data:
            plugin.connection_id = data['connection_id']
            resync = True
        if 'is_active' in data:
            plugin.is_active = bool(data['is_active'])
        db.session.commit()

        if resync:
            cls.sync_plugin(plugin, user_id)
        return plugin.to_dict()

    @classmethod
    def delete_plugin(cls, plugin_id: int) -> Dict:
        plugin = WordPressCustomPlugin.query.get(plugin_id)
        if not plugin:
            raise PluginLibraryError('Plugin not found')
        dest = cls.cache_path(plugin.slug)
        if os.path.isdir(dest):
            shutil.rmtree(dest, ignore_errors=True)
        db.session.delete(plugin)
        db.session.commit()
        return {'success': True}

    @classmethod
    def list_plugins(cls) -> List[Dict]:
        plugins = WordPressCustomPlugin.query.order_by(
            WordPressCustomPlugin.created_at.desc()).all()
        return [p.to_dict() for p in plugins]

    @classmethod
    def get_plugin(cls, plugin_id: int) -> Optional[Dict]:
        plugin = WordPressCustomPlugin.query.get(plugin_id)
        if not plugin:
            return None
        data = plugin.to_dict(include_installations=True)
        # Enrich installations with site names for the detail view.
        for inst in data['installations']:
            site = WordPressSite.query.get(inst['wordpress_site_id'])
            inst['site_name'] = (
                site.application.name if site and site.application else None)
        return data

    # ------------------------------------------------------------------
    # Per-site operations
    # ------------------------------------------------------------------
    @staticmethod
    def _site_root(site: WordPressSite) -> str:
        if not site.application or not site.application.root_path:
            raise PluginLibraryError('Site has no root path')
        return site.application.root_path

    @classmethod
    def _copy_into_site(cls, plugin: WordPressCustomPlugin, site: WordPressSite) -> str:
        """Copy the cached plugin folder into the site's wp-content/plugins."""
        cache = cls.cache_path(plugin.slug)
        if not os.path.isdir(cache):
            raise PluginLibraryError('Plugin is not synced yet — sync it first')

        target = os.path.join(cls._site_root(site), 'wp-content', 'plugins', plugin.slug)
        # Fresh copy: remove any prior version, then copy the cache (minus .git).
        run_privileged(['rm', '-rf', target])
        run_privileged(['mkdir', '-p', os.path.dirname(target)])
        run_privileged(['cp', '-a', cache, target])
        git_dir = os.path.join(target, '.git')
        if os.path.exists(git_dir):
            run_privileged(['rm', '-rf', git_dir])
        # WordPress files must be owned by the web user.
        run_privileged(['chown', '-R', 'www-data:www-data', target])
        return target

    @classmethod
    def _upsert_installation(cls, plugin: WordPressCustomPlugin, site: WordPressSite,
                             status: str, version: Optional[str]) -> WordPressSitePlugin:
        row = WordPressSitePlugin.query.filter_by(
            wordpress_site_id=site.id, custom_plugin_id=plugin.id).first()
        if not row:
            row = WordPressSitePlugin(
                wordpress_site_id=site.id, custom_plugin_id=plugin.id)
            db.session.add(row)
        row.status = status
        row.installed_version = version
        db.session.commit()
        return row

    @classmethod
    def install_on_site(cls, plugin: WordPressCustomPlugin, site: WordPressSite,
                        activate: bool = True) -> Dict:
        root = cls._site_root(site)
        cls._copy_into_site(plugin, site)

        status = 'inactive'
        if activate:
            act = WordPressService.wp_cli(root, ['plugin', 'activate', plugin.slug])
            status = 'active' if act.get('success') else 'inactive'

        cls._upsert_installation(plugin, site, status, plugin.version)
        return {'success': True, 'status': status, 'slug': plugin.slug}

    @classmethod
    def update_on_site(cls, plugin: WordPressCustomPlugin, site: WordPressSite) -> Dict:
        root = cls._site_root(site)
        row = WordPressSitePlugin.query.filter_by(
            wordpress_site_id=site.id, custom_plugin_id=plugin.id).first()
        was_active = bool(row and row.status == 'active')

        cls._copy_into_site(plugin, site)

        status = 'inactive'
        if was_active:
            act = WordPressService.wp_cli(root, ['plugin', 'activate', plugin.slug])
            status = 'active' if act.get('success') else 'inactive'

        cls._upsert_installation(plugin, site, status, plugin.version)
        return {'success': True, 'status': status, 'slug': plugin.slug}

    @classmethod
    def uninstall_from_site(cls, plugin: WordPressCustomPlugin, site: WordPressSite) -> Dict:
        root = cls._site_root(site)
        WordPressService.wp_cli(root, ['plugin', 'deactivate', plugin.slug])
        WordPressService.wp_cli(root, ['plugin', 'delete', plugin.slug])

        row = WordPressSitePlugin.query.filter_by(
            wordpress_site_id=site.id, custom_plugin_id=plugin.id).first()
        if row:
            db.session.delete(row)
            db.session.commit()
        return {'success': True}

    @classmethod
    def bulk_update(cls, plugin: WordPressCustomPlugin) -> Dict:
        """Push the latest cached version to every site that has it installed."""
        rows = WordPressSitePlugin.query.filter(
            WordPressSitePlugin.custom_plugin_id == plugin.id,
            WordPressSitePlugin.status != 'not_installed',
        ).all()

        results = []
        for row in rows:
            site = WordPressSite.query.get(row.wordpress_site_id)
            if not site:
                continue
            try:
                res = cls.update_on_site(plugin, site)
                results.append({'site_id': site.id, 'success': res.get('success', False)})
            except Exception as e:
                row.status = 'error'
                db.session.commit()
                results.append({'site_id': site.id, 'success': False, 'error': str(e)})

        updated = sum(1 for r in results if r.get('success'))
        return {'success': True, 'updated': updated, 'total': len(results), 'results': results}

    @classmethod
    def scan_site(cls, site: WordPressSite) -> Dict:
        """Compare WP-CLI ``plugin list`` against the library and upsert rows.

        Lets the per-site Plugins tab know which installed plugins are managed by
        the library (and whether they are behind the library version).
        """
        root = cls._site_root(site)
        installed = {p.get('name'): p for p in WordPressService.get_plugins(root)}

        managed = []
        for plugin in WordPressCustomPlugin.query.all():
            info = installed.get(plugin.slug)
            if info is None:
                # Not on the site — drop any stale row.
                row = WordPressSitePlugin.query.filter_by(
                    wordpress_site_id=site.id, custom_plugin_id=plugin.id).first()
                if row:
                    db.session.delete(row)
                    db.session.commit()
                continue
            status = 'active' if info.get('status') == 'active' else 'inactive'
            cls._upsert_installation(plugin, site, status, info.get('version'))
            managed.append(plugin.slug)

        return {'success': True, 'managed_slugs': managed}

    @classmethod
    def managed_for_site(cls, site: WordPressSite) -> List[Dict]:
        """Return managed-plugin metadata for a site, keyed for the Plugins tab.

        Each entry: slug, installed_version, library_version, update_available.
        """
        rows = WordPressSitePlugin.query.filter(
            WordPressSitePlugin.wordpress_site_id == site.id,
            WordPressSitePlugin.status != 'not_installed',
        ).all()
        out = []
        for row in rows:
            plugin = WordPressCustomPlugin.query.get(row.custom_plugin_id)
            if not plugin:
                continue
            out.append({
                'slug': plugin.slug,
                'plugin_id': plugin.id,
                'installed_version': row.installed_version,
                'library_version': plugin.version,
                'status': row.status,
                'update_available': cls._version_behind(row.installed_version, plugin.version),
            })
        return out

    @staticmethod
    def _version_behind(installed: Optional[str], library: Optional[str]) -> bool:
        """True when the installed version is older than the library version.

        Best-effort numeric compare (falls back to string inequality) — plugin
        versions are overwhelmingly dotted numerics.
        """
        if not installed or not library:
            return False
        if installed == library:
            return False

        def parts(v):
            nums = re.findall(r'\d+', v)
            return [int(n) for n in nums]

        pi, pl = parts(installed), parts(library)
        if not pi or not pl:
            return installed != library
        length = max(len(pi), len(pl))
        pi += [0] * (length - len(pi))
        pl += [0] * (length - len(pl))
        return pi < pl
