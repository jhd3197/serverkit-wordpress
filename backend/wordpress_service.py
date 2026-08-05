import os
import subprocess
import secrets
import string
import shutil
import json
from datetime import datetime
from typing import Dict, List, Optional
from pathlib import Path

from app import paths
from app.utils.system import run_privileged, privileged_cmd


class WordPressService:
    """Service for WordPress installation and management."""

    WP_CLI_PATH = '/usr/local/bin/wp'
    WP_DOWNLOAD_URL = 'https://wordpress.org/latest.tar.gz'
    BACKUP_DIR = paths.WP_BACKUP_DIR

    # Security headers for wp-config.php
    SECURITY_CONSTANTS = '''
// ServerKit Security Hardening
define('DISALLOW_FILE_EDIT', true);
define('DISALLOW_FILE_MODS', false);
define('FORCE_SSL_ADMIN', true);
define('WP_AUTO_UPDATE_CORE', 'minor');

// Security Keys (auto-generated)
'''

    @classmethod
    def is_wp_cli_installed(cls) -> bool:
        """Check if WP-CLI is installed."""
        return os.path.exists(cls.WP_CLI_PATH)

    @classmethod
    def install_wp_cli(cls) -> Dict:
        """Install WP-CLI."""
        try:
            commands = [
                ['curl', '-O', 'https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar'],
                ['chmod', '+x', 'wp-cli.phar'],
            ]

            for cmd in commands:
                result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
                if result.returncode != 0:
                    return {'success': False, 'error': result.stderr}

            result = run_privileged(['mv', 'wp-cli.phar', cls.WP_CLI_PATH], timeout=120)
            if result.returncode != 0:
                return {'success': False, 'error': result.stderr}

            return {'success': True, 'message': 'WP-CLI installed successfully'}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    @classmethod
    def wp_cli(cls, path: str, command: List[str], user: str = 'www-data', timeout: int = None) -> Dict:
        """Execute a WP-CLI command. Auto-detects Docker-based sites.

        ``timeout`` overrides the default per-call wall-clock limit; pass a
        generous value for long operations like ``db export``/``db import`` so a
        large database is never truncated mid-restore.
        """
        # Check if this is a Docker-based site (has docker-compose.yml)
        compose_file = os.path.join(path, 'docker-compose.yml')
        if os.path.exists(compose_file):
            return cls._wp_cli_docker(path, command, timeout=timeout)

        if not cls.is_wp_cli_installed():
            install_result = cls.install_wp_cli()
            if not install_result['success']:
                return install_result

        try:
            cmd = privileged_cmd([cls.WP_CLI_PATH, '--path=' + path] + command, user=user)
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=timeout or 300,
                cwd=path
            )

            return {
                'success': result.returncode == 0,
                'output': result.stdout,
                'error': result.stderr if result.returncode != 0 else None
            }
        except subprocess.TimeoutExpired:
            return {'success': False, 'error': 'Command timed out'}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    @classmethod
    def _wp_cli_docker(cls, path: str, command: List[str], timeout: int = None) -> Dict:
        """Execute a WP-CLI command inside a Docker WordPress container."""
        # Resolve container name from the Application record
        container_name = None
        from app.models import Application
        app = Application.query.filter_by(root_path=path).first()
        if app:
            container_name = app.name

        if not container_name:
            # Fallback: derive from directory name
            container_name = os.path.basename(path)

        try:
            # Ensure WP-CLI is available inside the container
            check = subprocess.run(
                ['docker', 'exec', container_name, 'which', 'wp'],
                capture_output=True, text=True, timeout=10
            )
            if check.returncode != 0:
                # Install WP-CLI inside the container
                install_cmd = (
                    'curl -sO https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar'
                    ' && chmod +x wp-cli.phar && mv wp-cli.phar /usr/local/bin/wp'
                )
                install = subprocess.run(
                    ['docker', 'exec', container_name, 'bash', '-c', install_cmd],
                    capture_output=True, text=True, timeout=120
                )
                if install.returncode != 0:
                    return {'success': False, 'error': f'Failed to install WP-CLI in container: {install.stderr}'}

            # Run wp-cli inside the WordPress container
            cmd = ['docker', 'exec', container_name, 'wp', '--allow-root'] + command
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=timeout or 60
            )

            return {
                'success': result.returncode == 0,
                'output': result.stdout,
                'error': result.stderr if result.returncode != 0 else None
            }
        except subprocess.TimeoutExpired:
            return {'success': False, 'error': 'Command timed out'}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    @classmethod
    def install_wordpress(cls, path: str, config: Dict) -> Dict:
        """Install WordPress at the specified path."""
        site_url = config.get('site_url')
        site_title = config.get('site_title', 'My WordPress Site')
        admin_user = config.get('admin_user', 'admin')
        admin_password = config.get('admin_password') or cls._generate_password()
        admin_email = config.get('admin_email')
        db_name = config.get('db_name')
        db_user = config.get('db_user')
        db_password = config.get('db_password')
        db_host = config.get('db_host', 'localhost')
        db_prefix = config.get('db_prefix', 'wp_')

        if not all([site_url, admin_email, db_name, db_user, db_password]):
            return {'success': False, 'error': 'Missing required configuration'}

        try:
            # Create directory
            run_privileged(['mkdir', '-p', path])
            run_privileged(['chown', 'www-data:www-data', path])

            # Download WordPress
            download_result = cls.wp_cli(path, ['core', 'download', '--locale=en_US'])
            if not download_result['success']:
                return download_result

            # Create wp-config.php
            config_result = cls.wp_cli(path, [
                'config', 'create',
                f'--dbname={db_name}',
                f'--dbuser={db_user}',
                f'--dbpass={db_password}',
                f'--dbhost={db_host}',
                f'--dbprefix={db_prefix}'
            ])
            if not config_result['success']:
                return config_result

            # Install WordPress
            install_result = cls.wp_cli(path, [
                'core', 'install',
                f'--url={site_url}',
                f'--title={site_title}',
                f'--admin_user={admin_user}',
                f'--admin_password={admin_password}',
                f'--admin_email={admin_email}',
                '--skip-email'
            ])
            if not install_result['success']:
                return install_result

            # Set permissions
            cls._set_permissions(path)

            # Apply security hardening
            cls.harden_wordpress(path)

            return {
                'success': True,
                'message': 'WordPress installed successfully',
                'admin_user': admin_user,
                'admin_password': admin_password,
                'path': path,
                'url': site_url
            }

        except Exception as e:
            return {'success': False, 'error': str(e)}

    @classmethod
    def get_php_info(cls, path: str) -> Dict:
        """Read the LIVE PHP version + key ini limits from inside the running
        WordPress container via the Docker-aware wp_cli bridge. Read-only.
        """
        info = {}
        ver = cls.wp_cli(path, ['eval', 'echo phpversion();'])
        if ver.get('success'):
            info['php_version'] = (ver.get('output') or '').strip()
        php = (
            "foreach(['memory_limit','upload_max_filesize','post_max_size',"
            "'max_execution_time','max_input_time'] as $k){"
            "echo $k.'='.ini_get($k).\"\\n\";}"
        )
        limits = cls.wp_cli(path, ['eval', php])
        parsed = {}
        if limits.get('success'):
            for line in (limits.get('output') or '').splitlines():
                line = line.strip()
                if '=' in line:
                    k, v = line.split('=', 1)
                    parsed[k.strip()] = v.strip()
        info['limits'] = parsed
        info['source'] = 'container'
        return info

    @classmethod
    def get_available_php_versions(cls) -> List[str]:
        """Official wordpress image PHP variant tags we support switching to."""
        return ['8.1', '8.2', '8.3']

    @classmethod
    def set_php_version(cls, path: str, version: str) -> Dict:
        """Switch a Docker WP site to a different PHP by rewriting the compose
        image tag (wordpress:<wp>-php<version>-apache) and recreating the app
        container. Volumes/DB persist. NOT host php-fpm. Brief downtime.
        """
        from app.services.docker_service import DockerService
        if version not in cls.get_available_php_versions():
            return {'success': False, 'error': f'Unsupported PHP version: {version}'}
        compose_file = os.path.join(path, 'docker-compose.yml')
        if not os.path.exists(compose_file):
            return {'success': False, 'error': 'Not a Docker-stack site (no docker-compose.yml)'}
        try:
            with open(compose_file, 'r') as f:
                content = f.read()
            import re as _re
            m = _re.search(r'image:\s*wordpress:([^\s]+)', content)
            if not m:
                return {'success': False, 'error': 'wordpress image line not found in compose file'}
            current_tag = m.group(1)
            # Derive the WP core from the existing tag; fall back to the known core for
            # legacy compose files that still carry an unresolved ${VERSION...} literal,
            # so the switch never drops the core pin (e.g. -> php8.2-apache).
            wp_core = current_tag.split('-')[0] if current_tag and current_tag[0].isdigit() else cls.WP_CORE
            new_tag = f'{wp_core}-php{version}-apache'
            new_content = content.replace(f'image: wordpress:{current_tag}', f'image: wordpress:{new_tag}')
            with open(compose_file, 'w') as f:
                f.write(new_content)
            up = DockerService.compose_up(path, detach=True, build=False)
            if not up.get('success'):
                return {'success': False, 'error': up.get('error') or 'compose up failed', 'image_tag': new_tag}
            cls._wait_for_wp_ready(path)
            live = cls.get_php_info(path).get('php_version')
            return {'success': True, 'message': f'Switched to PHP {version}', 'image_tag': new_tag, 'php_version': live}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    # --- Per-site PHP ini limits (#24 write side) -------------------------------
    # The official wordpress:*-apache image is Apache + mod_php and scans
    # /usr/local/etc/php/conf.d for *.ini drop-ins. We persist a host-side ini and
    # BIND-MOUNT it into conf.d so it survives container recreate — a plain
    # `docker exec` write would be lost on the next `compose up`. Every directive is
    # whitelisted + regex-validated because the value is written as a raw php.ini line.
    PHP_LIMIT_SPEC = {
        'memory_limit':        r'^(-1|\d{1,5}[KMGkmg]?)$',
        'upload_max_filesize': r'^\d{1,5}[KMGkmg]?$',
        'post_max_size':       r'^\d{1,5}[KMGkmg]?$',
        'max_execution_time':  r'^\d{1,5}$',
        'max_input_time':      r'^-?\d{1,5}$',
        'max_input_vars':      r'^\d{1,6}$',
    }
    PHP_CONF_DIR = 'php-conf'
    PHP_CONF_FILE = 'zz-serverkit.ini'
    PHP_CONF_CONTAINER = '/usr/local/etc/php/conf.d/zz-serverkit.ini'

    @classmethod
    def get_php_limit_spec(cls) -> Dict:
        """The editable php.ini directives (key -> validation regex) the limits
        panel may set. Exposed so the frontend renders exactly the safe set."""
        return dict(cls.PHP_LIMIT_SPEC)

    @staticmethod
    def _read_php_ini(ini_path: str) -> Dict:
        """Parse a simple `key = value` ini into a dict (comments/blank lines skipped).
        Never raises — a missing/garbled file just yields {}."""
        out = {}
        if os.path.exists(ini_path):
            try:
                with open(ini_path, 'r') as f:
                    for line in f:
                        line = line.strip()
                        if not line or line.startswith(';') or '=' not in line:
                            continue
                        k, v = line.split('=', 1)
                        out[k.strip()] = v.strip()
            except Exception:
                pass
        return out

    @classmethod
    def set_php_limits(cls, path: str, limits: Dict) -> Dict:
        """Durably set per-site PHP ini limits for a Docker WP site.

        Writes a host-side conf.d drop-in, bind-mounts it into the container's
        php conf.d (so it survives recreate), then reloads: a newly-added mount is
        applied via `compose up -d` (recreates the app container); a content-only
        change restarts the `wordpress` service so mod_php re-reads php.ini.
        Partial updates merge with any previously-set directives.
        """
        import re as _re
        import yaml
        from app.services.docker_service import DockerService

        compose_file = os.path.join(path, 'docker-compose.yml')
        if not os.path.exists(compose_file):
            return {'success': False, 'error': 'Not a Docker-stack site (no docker-compose.yml)'}

        # 1) Validate + sanitize against the whitelist (values become raw ini lines).
        clean = {}
        for k, v in (limits or {}).items():
            if k not in cls.PHP_LIMIT_SPEC:
                return {'success': False, 'error': f'Unknown PHP limit: {k}'}
            val = str(v).strip()
            # fullmatch (not match) so a value like "256M\nevil = 1" can never
            # smuggle an extra ini directive past the `$` anchor into the file.
            if not _re.fullmatch(cls.PHP_LIMIT_SPEC[k], val):
                return {'success': False, 'error': f'Invalid value for {k}: {val}'}
            clean[k] = val
        if not clean:
            return {'success': False, 'error': 'No valid limits provided'}

        try:
            # 2) Write the host ini FIRST — a single-file bind-mount needs the
            #    source to exist before `compose up`, else Docker makes a dir.
            conf_dir = os.path.join(path, cls.PHP_CONF_DIR)
            os.makedirs(conf_dir, exist_ok=True)
            ini_path = os.path.join(conf_dir, cls.PHP_CONF_FILE)
            merged = cls._read_php_ini(ini_path)
            merged.update(clean)
            body = ['; Managed by ServerKit (#24) — per-site PHP limits. Do not edit by hand.']
            body += [f'{k} = {v}' for k, v in merged.items()]
            with open(ini_path, 'w') as f:
                f.write('\n'.join(body) + '\n')

            # 3) Ensure the wordpress service bind-mounts the ini into conf.d.
            with open(compose_file, 'r') as f:
                compose = yaml.safe_load(f) or {}
            wp = (compose.get('services') or {}).get('wordpress')
            if not isinstance(wp, dict):
                return {'success': False, 'error': 'wordpress service not found in compose file'}
            mount = f'./{cls.PHP_CONF_DIR}/{cls.PHP_CONF_FILE}:{cls.PHP_CONF_CONTAINER}:ro'
            vols = wp.get('volumes') or []
            mount_added = mount not in vols
            if mount_added:
                vols.append(mount)
                wp['volumes'] = vols
                with open(compose_file, 'w') as f:
                    yaml.dump(compose, f, default_flow_style=False, sort_keys=False)

            # 4) Apply: recreate if the mount is new, else restart so php.ini reloads.
            if mount_added:
                res = DockerService.compose_up(path, detach=True, build=False)
            else:
                res = DockerService.compose_restart(path, service='wordpress')
            if not res.get('success'):
                return {'success': False, 'error': res.get('error') or 'Failed to apply PHP limits'}
            cls._wait_for_wp_ready(path)
            return {'success': True, 'message': 'PHP limits updated', 'limits': merged,
                    'applied': cls.get_php_info(path).get('limits', {})}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    @classmethod
    def is_multisite(cls, path: str) -> bool:
        """Return True if the WordPress install at ``path`` is a multisite network.

        Uses ``wp core is-multisite`` (exit 0 = multisite, non-zero = single).
        Routes through the Docker-aware wp_cli bridge automatically.
        """
        result = cls.wp_cli(path, ['core', 'is-multisite'])
        return bool(result.get('success'))

    @classmethod
    def get_wordpress_info(cls, path: str) -> Optional[Dict]:
        """Get WordPress installation info."""
        if not os.path.exists(os.path.join(path, 'wp-config.php')):
            return None

        info = {'path': path}

        # Get core version
        version_result = cls.wp_cli(path, ['core', 'version'])
        if version_result['success']:
            info['version'] = version_result['output'].strip()

        # Check for updates
        update_result = cls.wp_cli(path, ['core', 'check-update', '--format=json'])
        if update_result['success'] and update_result['output'].strip():
            try:
                updates = json.loads(update_result['output'])
                info['update_available'] = len(updates) > 0
                info['latest_version'] = updates[0]['version'] if updates else info.get('version')
            except Exception:
                info['update_available'] = False

        # Get site URL
        url_result = cls.wp_cli(path, ['option', 'get', 'siteurl'])
        if url_result['success']:
            info['url'] = url_result['output'].strip()

        # Get site title
        title_result = cls.wp_cli(path, ['option', 'get', 'blogname'])
        if title_result['success']:
            info['title'] = title_result['output'].strip()

        # Get admin email
        email_result = cls.wp_cli(path, ['option', 'get', 'admin_email'])
        if email_result['success']:
            info['admin_email'] = email_result['output'].strip()

        # Detect multisite (wp core is-multisite: exit 0 = multisite)
        info['multisite'] = cls.is_multisite(path)

        return info

    @classmethod
    def update_wordpress(cls, path: str) -> Dict:
        """Update WordPress core."""
        result = cls.wp_cli(path, ['core', 'update'])
        if result['success']:
            # Update database if needed
            cls.wp_cli(path, ['core', 'update-db'])
            return {'success': True, 'message': 'WordPress updated successfully'}
        return result

    @classmethod
    def get_plugins(cls, path: str) -> List[Dict]:
        """Get list of installed plugins."""
        result = cls.wp_cli(path, ['plugin', 'list', '--format=json'])
        if result['success']:
            try:
                return json.loads(result['output'])
            except Exception:
                return []
        return []

    @classmethod
    def install_plugin(cls, path: str, plugin: str, activate: bool = True) -> Dict:
        """Install a WordPress plugin."""
        cmd = ['plugin', 'install', plugin]
        if activate:
            cmd.append('--activate')

        result = cls.wp_cli(path, cmd)
        if result['success']:
            return {'success': True, 'message': f'Plugin {plugin} installed'}
        return result

    @classmethod
    def uninstall_plugin(cls, path: str, plugin: str) -> Dict:
        """Uninstall a WordPress plugin."""
        # Deactivate first
        cls.wp_cli(path, ['plugin', 'deactivate', plugin])

        result = cls.wp_cli(path, ['plugin', 'delete', plugin])
        if result['success']:
            return {'success': True, 'message': f'Plugin {plugin} uninstalled'}
        return result

    @classmethod
    def activate_plugin(cls, path: str, plugin: str) -> Dict:
        """Activate a plugin."""
        result = cls.wp_cli(path, ['plugin', 'activate', plugin])
        return result

    @classmethod
    def deactivate_plugin(cls, path: str, plugin: str) -> Dict:
        """Deactivate a plugin."""
        result = cls.wp_cli(path, ['plugin', 'deactivate', plugin])
        return result

    @classmethod
    def update_plugins(cls, path: str, plugins: List[str] = None) -> Dict:
        """Update plugins."""
        cmd = ['plugin', 'update']
        if plugins:
            cmd.extend(plugins)
        else:
            cmd.append('--all')

        result = cls.wp_cli(path, cmd)
        if result['success']:
            return {'success': True, 'message': 'Plugins updated'}
        return result

    @classmethod
    def update_themes(cls, path: str, themes: List[str] = None) -> Dict:
        """Update themes."""
        cmd = ['theme', 'update']
        if themes:
            cmd.extend(themes)
        else:
            cmd.append('--all')

        result = cls.wp_cli(path, cmd)
        if result['success']:
            return {'success': True, 'message': 'Themes updated'}
        return result

    @classmethod
    def get_themes(cls, path: str) -> List[Dict]:
        """Get list of installed themes."""
        result = cls.wp_cli(path, ['theme', 'list', '--format=json'])
        if result['success']:
            try:
                return json.loads(result['output'])
            except Exception:
                return []
        return []

    @classmethod
    def install_theme(cls, path: str, theme: str, activate: bool = False) -> Dict:
        """Install a WordPress theme."""
        cmd = ['theme', 'install', theme]
        if activate:
            cmd.append('--activate')

        result = cls.wp_cli(path, cmd)
        if result['success']:
            return {'success': True, 'message': f'Theme {theme} installed'}
        return result

    @classmethod
    def activate_theme(cls, path: str, theme: str) -> Dict:
        """Activate a theme."""
        result = cls.wp_cli(path, ['theme', 'activate', theme])
        return result

    @classmethod
    def backup_wordpress(cls, path: str, include_db: bool = True) -> Dict:
        """Create a backup of WordPress installation."""
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        site_name = os.path.basename(path)
        backup_name = f'{site_name}_{timestamp}'
        backup_path = os.path.join(cls.BACKUP_DIR, backup_name)

        try:
            # Create backup directory
            run_privileged(['mkdir', '-p', backup_path])

            # Backup files
            files_backup = os.path.join(backup_path, 'files.tar.gz')
            run_privileged(
                ['tar', '-czf', files_backup, '-C', os.path.dirname(path), os.path.basename(path)],
                timeout=600
            )

            # Backup database
            if include_db:
                db_backup = os.path.join(backup_path, 'database.sql')
                result = cls.wp_cli(path, ['db', 'export', db_backup])
                if not result['success']:
                    return {'success': False, 'error': f'Database backup failed: {result.get("error")}'}

            # Get backup size
            try:
                size = sum(os.path.getsize(os.path.join(backup_path, f))
                          for f in os.listdir(backup_path)
                          if os.path.isfile(os.path.join(backup_path, f)))
            except Exception:
                size = 0

            return {
                'success': True,
                'message': 'Backup created successfully',
                'backup_path': backup_path,
                'backup_name': backup_name,
                'size': size,
                'timestamp': timestamp
            }

        except Exception as e:
            return {'success': False, 'error': str(e)}

    @classmethod
    def list_backups(cls, site_name: str = None) -> List[Dict]:
        """List available backups."""
        backups = []

        if not os.path.exists(cls.BACKUP_DIR):
            return backups

        try:
            for name in os.listdir(cls.BACKUP_DIR):
                backup_path = os.path.join(cls.BACKUP_DIR, name)
                if os.path.isdir(backup_path):
                    if site_name and not name.startswith(site_name):
                        continue

                    # Get backup info
                    files_backup = os.path.join(backup_path, 'files.tar.gz')
                    db_backup = os.path.join(backup_path, 'database.sql')

                    size = 0
                    for f in [files_backup, db_backup]:
                        if os.path.exists(f):
                            size += os.path.getsize(f)

                    # Parse timestamp from name
                    parts = name.rsplit('_', 2)
                    if len(parts) >= 3:
                        timestamp = f'{parts[-2]}_{parts[-1]}'
                    else:
                        timestamp = 'unknown'

                    backups.append({
                        'name': name,
                        'path': backup_path,
                        'has_files': os.path.exists(files_backup),
                        'has_database': os.path.exists(db_backup),
                        'size': size,
                        'timestamp': timestamp
                    })
        except Exception:
            pass

        return sorted(backups, key=lambda x: x['timestamp'], reverse=True)

    @classmethod
    def restore_backup(cls, backup_name: str, target_path: str) -> Dict:
        """Restore a WordPress backup."""
        backup_path = os.path.join(cls.BACKUP_DIR, backup_name)

        if not os.path.exists(backup_path):
            return {'success': False, 'error': 'Backup not found'}

        try:
            files_backup = os.path.join(backup_path, 'files.tar.gz')
            db_backup = os.path.join(backup_path, 'database.sql')

            # Restore files
            if os.path.exists(files_backup):
                # Remove existing files
                if os.path.exists(target_path):
                    run_privileged(['rm', '-rf', target_path])

                # Extract backup
                run_privileged(
                    ['tar', '-xzf', files_backup, '-C', os.path.dirname(target_path)],
                    timeout=600
                )

            # Restore database
            if os.path.exists(db_backup):
                result = cls.wp_cli(target_path, ['db', 'import', db_backup])
                if not result['success']:
                    return {'success': False, 'error': f'Database restore failed: {result.get("error")}'}

            # Fix permissions
            cls._set_permissions(target_path)

            return {'success': True, 'message': 'Backup restored successfully'}

        except Exception as e:
            return {'success': False, 'error': str(e)}

    @classmethod
    def delete_backup(cls, backup_name: str) -> Dict:
        """Delete a backup."""
        backup_path = os.path.join(cls.BACKUP_DIR, backup_name)

        if not os.path.exists(backup_path):
            return {'success': False, 'error': 'Backup not found'}

        try:
            run_privileged(['rm', '-rf', backup_path])
            return {'success': True, 'message': 'Backup deleted'}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    @classmethod
    def _wait_for_wp_ready(cls, path: str, timeout: int = 60) -> bool:
        """Poll the WP container (via the Docker-aware wp_cli bridge) until
        WordPress core files + DB are reachable so `wp` commands can run.

        Returns True once `wp core version` succeeds, else False on timeout.
        """
        import time as _time
        deadline = _time.time() + timeout
        while _time.time() < deadline:
            check = cls.wp_cli(path, ['core', 'version'])
            if check.get('success'):
                return True
            _time.sleep(3)
        return False

    @classmethod
    def _harden_docker_site(cls, path: str) -> List[str]:
        """Apply container-valid security hardening via the Docker-aware wp_cli
        bridge. Filesystem hardening (chmod/.htaccess) does NOT apply to the
        named-volume Docker model and is intentionally skipped. FORCE_SSL_ADMIN
        is also skipped (these sites are http://localhost:PORT with no TLS).
        """
        actions = []
        if cls.wp_cli(path, ['config', 'set', 'DISALLOW_FILE_EDIT', 'true', '--raw']).get('success'):
            actions.append('Disabled in-admin file editing')
        if cls.wp_cli(path, ['config', 'set', 'XMLRPC_REQUEST', 'false', '--raw']).get('success'):
            actions.append('Disabled XML-RPC')
        if cls.wp_cli(path, ['config', 'shuffle-salts']).get('success'):
            actions.append('Regenerated security keys')
        return actions

    @classmethod
    def harden_wordpress(cls, path: str) -> Dict:
        """Apply security hardening to WordPress."""
        results = []

        try:
            # Disable file editing in admin
            cls.wp_cli(path, ['config', 'set', 'DISALLOW_FILE_EDIT', 'true', '--raw'])
            results.append('Disabled file editing')

            # Force SSL for admin
            cls.wp_cli(path, ['config', 'set', 'FORCE_SSL_ADMIN', 'true', '--raw'])
            results.append('Enabled SSL for admin')

            # Disable XML-RPC (common attack vector)
            cls.wp_cli(path, ['config', 'set', 'XMLRPC_REQUEST', 'false', '--raw'])
            results.append('Disabled XML-RPC')

            # Set secure file permissions
            cls._set_permissions(path)
            results.append('Set secure file permissions')

            # Create .htaccess security rules
            cls._create_htaccess_security(path)
            results.append('Added .htaccess security rules')

            # Regenerate security keys
            cls.wp_cli(path, ['config', 'shuffle-salts'])
            results.append('Regenerated security keys')

            return {'success': True, 'message': 'Security hardening applied', 'actions': results}

        except Exception as e:
            return {'success': False, 'error': str(e), 'partial_actions': results}

    @classmethod
    def _set_permissions(cls, path: str):
        """Set secure file permissions for WordPress."""
        try:
            # Set ownership
            run_privileged(['chown', '-R', 'www-data:www-data', path])

            # Set directory permissions
            run_privileged(
                ['find', path, '-type', 'd', '-exec', 'chmod', '755', '{}', ';']
            )

            # Set file permissions
            run_privileged(
                ['find', path, '-type', 'f', '-exec', 'chmod', '644', '{}', ';']
            )

            # Protect wp-config.php
            wp_config = os.path.join(path, 'wp-config.php')
            if os.path.exists(wp_config):
                run_privileged(['chmod', '600', wp_config])

        except Exception:
            pass

    @classmethod
    def _create_htaccess_security(cls, path: str):
        """Create security rules in .htaccess."""
        htaccess_path = os.path.join(path, '.htaccess')

        security_rules = '''
# ServerKit Security Rules
# Protect wp-config.php
<files wp-config.php>
order allow,deny
deny from all
</files>

# Protect .htaccess
<files .htaccess>
order allow,deny
deny from all
</files>

# Disable directory browsing
Options -Indexes

# Block access to sensitive files
<FilesMatch "^(wp-config\\.php|\\.htaccess|readme\\.html|license\\.txt)$">
Order allow,deny
Deny from all
</FilesMatch>

# Block PHP execution in uploads
<IfModule mod_rewrite.c>
RewriteEngine On
RewriteRule ^wp-content/uploads/.*\\.php$ - [F]
</IfModule>
'''

        try:
            # Read existing htaccess
            existing = ''
            if os.path.exists(htaccess_path):
                with open(htaccess_path, 'r') as f:
                    existing = f.read()

            # Only add if not already present
            if '# ServerKit Security Rules' not in existing:
                new_content = security_rules + '\n' + existing
                run_privileged(
                    ['tee', htaccess_path],
                    input=new_content
                )
        except Exception:
            pass

    @classmethod
    def search_replace(cls, path: str, search: str, replace: str, dry_run: bool = False) -> Dict:
        """Search and replace in WordPress database."""
        cmd = ['search-replace', search, replace, '--all-tables']

        if dry_run:
            cmd.append('--dry-run')

        result = cls.wp_cli(path, cmd)
        return result

    # ── URL swap tool ────────────────────────────────────────────────────────
    # Changing a WordPress site's URL is not a single UPDATE: the URL is embedded
    # across wp_options, post content, and PHP-serialized blobs whose byte-length
    # prefixes break under a naive REPLACE. WP-CLI `search-replace` is
    # serialization-safe, so it is the engine here (the pure-SQL path in
    # db_sync_service is the fallback for offline dumps only). We dry-run first,
    # back up before mutating, and roll back on failure.

    @staticmethod
    def _normalize_url(url: str) -> Optional[str]:
        """Canonicalise a user-supplied URL to ``scheme://host[/path]`` with no
        trailing slash. Returns None if it isn't a usable http(s) URL."""
        import re
        from urllib.parse import urlparse
        if not url:
            return None
        url = url.strip().rstrip('/')
        if '://' not in url:
            url = 'http://' + url
        p = urlparse(url)
        if p.scheme not in ('http', 'https') or not p.netloc:
            return None
        # Reject obviously-invalid hosts (spaces, etc.); allow hostname[:port].
        if not re.match(r'^[A-Za-z0-9.\-]+(:\d+)?$', p.netloc):
            return None
        return f'{p.scheme}://{p.netloc}{p.path.rstrip("/")}'

    @staticmethod
    def _host_of(url: str) -> str:
        from urllib.parse import urlparse
        return urlparse(url).netloc

    @classmethod
    def _url_swap_pairs(cls, old_url: str, new_url: str) -> List[tuple]:
        """search→replace pairs for a URL change: the full URL (covers scheme
        changes) plus a host-only pair (covers protocol-relative and bare-host
        references) when the host actually changes."""
        pairs = [(old_url, new_url)]
        old_host, new_host = cls._host_of(old_url), cls._host_of(new_url)
        if old_host and new_host and old_host != new_host:
            pairs.append((old_host, new_host))
        return pairs

    @staticmethod
    def _parse_sr_count(output: str) -> int:
        """Pull the replacement total out of WP-CLI search-replace output
        ('Success: 12 replacements to be made.' / 'Success: Made 12 replacements.')."""
        import re
        if not output:
            return 0
        for line in output.splitlines():
            if 'Success' in line:
                m = re.search(r'(\d[\d,]*)\s+replacement', line)
                if m:
                    return int(m.group(1).replace(',', ''))
        return 0

    @classmethod
    def _site_current_url(cls, app) -> Optional[str]:
        """The site's live URL: prefer WordPress's own stored siteurl (source of
        truth for what must be search-replaced), else the canonical domain/port."""
        if app and app.root_path:
            res = cls.wp_cli(app.root_path, ['option', 'get', 'siteurl'])
            if res.get('success') and (res.get('output') or '').strip():
                return cls._normalize_url(res['output'].strip())
        return cls._canonical_site_url(app) if app else None

    @classmethod
    def preview_url_change(cls, app, new_url: str) -> Dict:
        """Dry-run a URL change: per-pair replacement counts, no mutation."""
        if not app or not app.root_path:
            return {'success': False, 'error': 'Site has no application/root path'}
        new_url = cls._normalize_url(new_url)
        if not new_url:
            return {'success': False, 'error': 'A valid new URL (including http:// or https://) is required'}
        old_url = cls._site_current_url(app)
        if not old_url:
            return {'success': False, 'error': 'Could not determine the current site URL'}
        if new_url == old_url:
            return {'success': False, 'error': 'The new URL is the same as the current one'}

        rows, total = [], 0
        for search, replace in cls._url_swap_pairs(old_url, new_url):
            res = cls.wp_cli(app.root_path, ['search-replace', search, replace,
                                             '--all-tables', '--skip-columns=guid',
                                             '--dry-run', '--report-changed-only'])
            if not res.get('success'):
                return {'success': False, 'error': res.get('error') or 'Preview failed',
                        'current_url': old_url, 'new_url': new_url}
            count = cls._parse_sr_count(res.get('output'))
            total += count
            rows.append({'search': search, 'replace': replace, 'replacements': count})
        return {'success': True, 'current_url': old_url, 'new_url': new_url,
                'pairs': rows, 'total': total}

    @classmethod
    def change_site_url(cls, app, new_url: str, keep_old_redirect: bool = True) -> Dict:
        """Change a site's URL end to end: back up, serialization-safe DB rewrite,
        update home/siteurl, flush caches, then re-point the Domain row + nginx
        vhost. Rolls the database back from the backup if the rewrite fails.

        With ``keep_old_redirect`` the previous host keeps resolving (its vhost
        entry stays) so WordPress 301s it to the new canonical URL.
        """
        if not app or not app.root_path:
            return {'success': False, 'error': 'Site has no application/root path'}
        new_url = cls._normalize_url(new_url)
        if not new_url:
            return {'success': False, 'error': 'A valid new URL (including http:// or https://) is required'}
        old_url = cls._site_current_url(app)
        if not old_url:
            return {'success': False, 'error': 'Could not determine the current site URL'}
        if new_url == old_url:
            return {'success': False, 'error': 'The new URL is the same as the current one'}

        # 1) Backup first — this is the rollback point.
        backup = cls.backup_wordpress(app.root_path, include_db=True)
        if not backup.get('success'):
            return {'success': False, 'error': f"Backup failed, aborting URL change: {backup.get('error')}"}

        # 2) Serialization-safe DB rewrite, then finalize options + caches.
        total = 0
        try:
            for search, replace in cls._url_swap_pairs(old_url, new_url):
                res = cls.wp_cli(app.root_path, ['search-replace', search, replace,
                                                 '--all-tables', '--skip-columns=guid'])
                if not res.get('success'):
                    raise RuntimeError(res.get('error') or 'search-replace failed')
                total += cls._parse_sr_count(res.get('output'))
            cls.wp_cli(app.root_path, ['option', 'update', 'home', new_url])
            cls.wp_cli(app.root_path, ['option', 'update', 'siteurl', new_url])
            cls.wp_cli(app.root_path, ['cache', 'flush'])
            cls.wp_cli(app.root_path, ['rewrite', 'flush'])
        except Exception as e:
            restore = cls.restore_backup(backup['backup_name'], app.root_path)
            return {'success': False,
                    'error': f'URL change failed and the database was rolled back: {e}',
                    'rolled_back': restore.get('success', False),
                    'backup': backup['backup_name']}

        # 3) Re-point routing (best-effort; the DB change has already succeeded).
        warnings = []
        new_host = cls._host_of(new_url)
        rp = cls._repoint_primary_domain(app, new_host, keep_old=keep_old_redirect)
        if rp:
            warnings.append(rp)
        vhost = cls._write_app_vhost(app)
        if vhost.get('warning'):
            warnings.append(vhost['warning'])

        return {'success': True, 'old_url': old_url, 'new_url': new_url,
                'replacements': total, 'backup': backup['backup_name'],
                'kept_old_host': keep_old_redirect,
                'warning': '; '.join(warnings) if warnings else None}

    @classmethod
    def _repoint_primary_domain(cls, app, new_host: str, keep_old: bool = True) -> Optional[str]:
        """Make ``new_host`` the app's primary Domain. With ``keep_old`` the other
        host rows are demoted (kept, so they still resolve); otherwise removed.
        Returns a warning string on failure, else None."""
        from app import db
        from app.models.domain import Domain
        if not new_host:
            return None
        try:
            found_new = False
            for d in Domain.query.filter_by(application_id=app.id).all():
                if d.name == new_host:
                    d.is_primary = True
                    found_new = True
                elif keep_old:
                    d.is_primary = False
                else:
                    db.session.delete(d)
            if not found_new:
                db.session.add(Domain(name=new_host, is_primary=True, application_id=app.id))
            db.session.commit()
            return None
        except Exception as e:
            db.session.rollback()
            return f'could not update domain rows: {e}'

    @classmethod
    def attach_custom_domain(cls, app, domain: str, migrate: bool = True,
                             issue_ssl: bool = False, email: str = None) -> Dict:
        """Point a user-owned domain at a site, end to end.

        Auto-creates the domain's A record via a connected DNS provider (or
        returns the record to add manually), optionally obtains a Let's Encrypt
        certificate, then migrates the site URL to the domain by reusing
        ``change_site_url``. External steps (DNS, SSL) degrade to warnings rather
        than failing the attach; only a requested migration that errors aborts.
        """
        from app import db
        from app.models.domain import Domain
        from app.services.site_domain_service import SiteDomainService
        from app.services.dns_provider_service import DNSProviderService

        if not app or not app.root_path:
            return {'success': False, 'error': 'Site has no application/root path'}

        # Accept a bare host or a full URL; reduce to the host.
        host = cls._host_of(cls._normalize_url(domain) or '') or (domain or '').strip().lower().rstrip('/')
        if not host or '.' not in host:
            return {'success': False, 'error': 'A valid custom domain (e.g. example.com) is required'}

        # 1) DNS: auto-create the A record, or report what to add manually.
        dns = DNSProviderService.ensure_a_record(host, SiteDomainService.server_ip())

        # 2) Optional HTTPS. certbot --nginx validates over the host's :80 vhost,
        #    so the host must already be served before the cert is requested.
        ssl_result = None
        use_https = False
        if issue_ssl:
            from app.services.ssl_service import SSLService
            if not Domain.query.filter_by(name=host).first():
                db.session.add(Domain(name=host, is_primary=False, application_id=app.id))
                db.session.commit()
            cls._write_app_vhost(app)
            ssl_result = SSLService.obtain_certificate([host], email or f'admin@{host}')
            use_https = bool(ssl_result and ssl_result.get('success'))

        # 3) Migrate the site URL to the domain (single rewrite to the final scheme).
        scheme = 'https' if use_https else 'http'
        migration = None
        if migrate:
            migration = cls.change_site_url(app, f'{scheme}://{host}', keep_old_redirect=True)
            if not migration.get('success'):
                return {'success': False,
                        'error': f"DNS handled but moving the site to {host} failed: {migration.get('error')}",
                        'dns': dns, 'ssl': ssl_result, 'migration': migration}
        else:
            # Attach the domain (primary + vhost) without rewriting WordPress.
            cls._repoint_primary_domain(app, host, keep_old=True)
            cls._write_app_vhost(app)

        warnings = []
        if not dns.get('created'):
            warnings.append(dns.get('message') or 'Add the DNS record manually.')
        if issue_ssl and not use_https:
            warnings.append('HTTPS is not set up yet — enable SSL once DNS has propagated to this server.')
        if migration and migration.get('warning'):
            warnings.append(migration['warning'])

        return {
            'success': True,
            'domain': host,
            'url': (migration or {}).get('new_url') or f'{scheme}://{host}',
            'dns': dns,
            'ssl': ssl_result,
            'migration': migration,
            'warning': '; '.join(warnings) if warnings else None,
        }

    @classmethod
    def optimize_database(cls, path: str) -> Dict:
        """Optimize WordPress database."""
        result = cls.wp_cli(path, ['db', 'optimize'])
        return result

    PAGE_CACHE_PLUGIN = 'cache-enabler'

    @classmethod
    def get_page_cache_status(cls, path: str) -> Dict:
        """Report whether the full-page cache plugin is installed/active."""
        res = cls.wp_cli(path, ['plugin', 'get', cls.PAGE_CACHE_PLUGIN, '--field=status'])
        status = (res.get('output') or '').strip() if res.get('success') else ''
        return {
            'success': True,
            'plugin': cls.PAGE_CACHE_PLUGIN,
            'installed': res.get('success', False),
            'active': status == 'active',
            'status': status,
        }

    @classmethod
    def enable_page_cache(cls, path: str) -> Dict:
        """Install + activate a full-page disk cache plugin with WP-aware skip rules."""
        inst = cls.install_plugin(path, cls.PAGE_CACHE_PLUGIN, activate=True)
        if not inst.get('success'):
            return {'success': False, 'error': 'Failed to install page-cache plugin: ' + (inst.get('error') or '')}
        opts = {
            'cache_expires': 1,
            'clear_on_upgrade': 1,
            'excl_regexp': '/(wp-admin|wp-login|cart|checkout|my-account)/',
            'excl_cookies': 'comment_author|wordpress_logged_in|wp-postpass|woocommerce_cart_hash|woocommerce_items_in_cart',
        }
        cls.wp_cli(path, ['option', 'update', cls.PAGE_CACHE_PLUGIN, json.dumps(opts), '--format=json'])
        cls.wp_cli(path, ['rewrite', 'flush'])
        return {'success': True, 'message': 'Page cache enabled', 'plugin': cls.PAGE_CACHE_PLUGIN}

    @classmethod
    def disable_page_cache(cls, path: str) -> Dict:
        """Purge then deactivate the page-cache plugin."""
        cls.purge_page_cache(path)
        res = cls.deactivate_plugin(path, cls.PAGE_CACHE_PLUGIN)
        if res.get('success'):
            return {'success': True, 'message': 'Page cache disabled'}
        return {'success': False, 'error': res.get('error') or 'Failed to disable page cache'}

    @classmethod
    def purge_page_cache(cls, path: str) -> bool:
        """Best-effort full-page cache purge. Never raises."""
        try:
            res = cls.wp_cli(path, ['cache-enabler', 'clear'])
            if res.get('success'):
                return True
            res = cls.wp_cli(path, ['eval', 'if (function_exists("cache_enabler_clear_complete_cache")) cache_enabler_clear_complete_cache();'])
            return bool(res.get('success'))
        except Exception:
            return False

    @classmethod
    def _ensure_redis_in_stack(cls, path: str) -> Dict:
        """Ensure the site's compose stack has a redis service, recreating the
        stack (additive compose up -d, no downtime) if one had to be injected.
        Idempotent — short-circuits when redis already present.
        """
        import yaml
        compose_file = os.path.join(path, 'docker-compose.yml')
        if not os.path.exists(compose_file):
            return {'success': False, 'error': 'Not a Docker-stack site (no docker-compose.yml)'}
        try:
            with open(compose_file, 'r') as f:
                compose = yaml.safe_load(f) or {}
            services = compose.setdefault('services', {})
            if 'redis' in services:
                return {'success': True, 'created': False}
            app_name = os.path.basename(path)
            from app.models import Application
            app = Application.query.filter_by(root_path=path).first()
            if app:
                app_name = app.name
            services['redis'] = {
                'image': 'redis:7-alpine',
                'container_name': f'{app_name}-redis',
                'restart': 'unless-stopped',
            }
            wp = services.get('wordpress')
            if isinstance(wp, dict):
                deps = wp.get('depends_on') or []
                if isinstance(deps, list) and 'redis' not in deps:
                    deps.append('redis')
                    wp['depends_on'] = deps
            with open(compose_file, 'w') as f:
                yaml.dump(compose, f, default_flow_style=False, sort_keys=False)
            from app.services.docker_service import DockerService
            up = DockerService.compose_up(path, detach=True)
            if not up.get('success'):
                return {'success': False, 'error': 'Failed to recreate stack with redis: ' + (up.get('error') or '')}
            cls._wait_for_wp_ready(path)
            return {'success': True, 'created': True}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    @classmethod
    def enable_object_cache(cls, path: str) -> Dict:
        """Enable a Redis object cache: ensure a redis container, install+activate
        the redis-cache plugin, point WP at redis, and turn the drop-in on.
        """
        ensure = cls._ensure_redis_in_stack(path)
        if not ensure.get('success'):
            return ensure
        actions = []
        if ensure.get('created'):
            actions.append('Added redis container to stack')
        inst = cls.wp_cli(path, ['plugin', 'install', 'redis-cache', '--activate'])
        if not inst.get('success'):
            return {'success': False, 'error': 'Failed to install redis-cache plugin: ' + (inst.get('error') or '')}
        actions.append('Installed redis-cache plugin')
        cls.wp_cli(path, ['config', 'set', 'WP_REDIS_HOST', 'redis'])
        cls.wp_cli(path, ['config', 'set', 'WP_REDIS_PORT', '6379', '--raw'])
        enable = cls.wp_cli(path, ['redis', 'enable'])
        if not enable.get('success'):
            return {'success': False, 'error': 'Plugin installed but enabling the drop-in failed: ' + (enable.get('error') or ''), 'actions': actions}
        actions.append('Enabled Redis object cache drop-in')
        return {'success': True, 'message': 'Redis object cache enabled', 'actions': actions, 'status': cls.object_cache_status(path)}

    @classmethod
    def disable_object_cache(cls, path: str) -> Dict:
        """Turn the Redis object-cache drop-in off (keeps the container + plugin)."""
        res = cls.wp_cli(path, ['redis', 'disable'])
        if res.get('success'):
            return {'success': True, 'message': 'Redis object cache disabled'}
        return {'success': False, 'error': res.get('error') or 'Failed to disable object cache'}

    @classmethod
    def object_cache_status(cls, path: str) -> Dict:
        """Report object-cache state via `wp redis status`. Never raises."""
        compose_file = os.path.join(path, 'docker-compose.yml')
        if not os.path.exists(compose_file):
            return {'enabled': False, 'available': False, 'reason': 'not a Docker-stack site'}
        res = cls.wp_cli(path, ['redis', 'status'])
        if not res.get('success'):
            return {'enabled': False, 'available': False}
        out = (res.get('output') or '').lower()
        return {'enabled': 'connected' in out, 'available': True, 'raw': res.get('output', '').strip()}

    @classmethod
    def flush_cache(cls, path: str) -> Dict:
        """Flush WordPress cache."""
        results = []

        # Flush rewrite rules
        cls.wp_cli(path, ['rewrite', 'flush'])
        results.append('Flushed rewrite rules')

        # Flush transients
        cls.wp_cli(path, ['transient', 'delete', '--all'])
        results.append('Deleted transients')

        # Flush object cache if available
        cache_result = cls.wp_cli(path, ['cache', 'flush'])
        if cache_result['success']:
            results.append('Flushed object cache')

        # Flush the Redis object-cache drop-in if the plugin is active (Roadmap #23)
        redis_flush = cls.wp_cli(path, ['redis', 'flush'])
        if redis_flush.get('success'):
            results.append('Flushed Redis object cache')

        # Purge the full-page cache plugin if present (Roadmap #22)
        if cls.purge_page_cache(path):
            results.append('Purged page cache')

        return {'success': True, 'message': 'Cache flushed', 'actions': results}

    @classmethod
    def create_user(cls, path: str, username: str, email: str, role: str = 'subscriber', password: str = None) -> Dict:
        """Create a new WordPress user."""
        if not password:
            password = cls._generate_password()

        result = cls.wp_cli(path, [
            'user', 'create', username, email,
            f'--role={role}',
            f'--user_pass={password}'
        ])

        if result['success']:
            return {
                'success': True,
                'message': f'User {username} created',
                'password': password
            }
        return result

    @classmethod
    def reset_password(cls, path: str, user: str, password: str = None) -> Dict:
        """Reset a user's password."""
        if not password:
            password = cls._generate_password()

        result = cls.wp_cli(path, ['user', 'update', user, f'--user_pass={password}'])

        if result['success']:
            return {'success': True, 'message': 'Password reset', 'password': password}
        return result

    @classmethod
    def _get_login_url_slug(cls, path: str) -> str:
        """Return the site's real login URL (avoids hardcoding /wp-admin)."""
        res = cls.wp_cli(path, ['eval', 'echo wp_login_url();'])
        if res.get('success') and res.get('output', '').strip():
            return res['output'].strip()
        return ''

    @classmethod
    def _ensure_login_package(cls, path: str) -> Dict:
        """Make the wp-cli-login command + its launcher available, idempotently."""
        have = cls.wp_cli(path, ['login', '--help'])
        if not have.get('success'):
            inst = cls.wp_cli(path, ['package', 'install', 'aaemnnosttv/wp-cli-login-command'])
            if not inst.get('success'):
                return {'success': False, 'error': 'Failed to install wp-cli-login package: ' + (inst.get('error') or '')}
        # Ensure the companion launcher plugin is present AND active (idempotent).
        # Without --activate the plugin installs but stays inactive, and the
        # subsequent `wp login create` fails with "requires the companion plugin
        # to be installed and active".
        cls.wp_cli(path, ['login', 'install', '--activate', '--yes'])
        return {'success': True}

    @classmethod
    def create_login_url(cls, path: str, user: str) -> Dict:
        """Mint a one-time passwordless wp-admin login URL for ``user``."""
        pkg = cls._ensure_login_package(path)
        if not pkg.get('success'):
            return pkg
        res = cls.wp_cli(path, ['login', 'create', user, '--url-only'])
        if res.get('success'):
            url = (res.get('output') or '').strip()
            if not url:
                return {'success': False, 'error': 'Login URL was empty'}
            return {'success': True, 'url': url, 'login_slug': cls._get_login_url_slug(path)}
        return res

    @staticmethod
    def _generate_password(length: int = 16) -> str:
        """Generate a secure random password."""
        alphabet = string.ascii_letters + string.digits + '!@#$%^&*'
        return ''.join(secrets.choice(alphabet) for _ in range(length))

    @staticmethod
    def _read_env_value(root_path: str, key: str) -> Optional[str]:
        """Read a single KEY from a Docker stack's <root>/.env (None if absent)."""
        env_path = os.path.join(root_path, '.env')
        if not os.path.exists(env_path):
            return None
        try:
            with open(env_path, 'r') as f:
                for line in f:
                    line = line.strip()
                    if line.startswith(f'{key}='):
                        return line.split('=', 1)[1]
        except Exception:
            pass
        return None

    @classmethod
    def _copy_wp_content_between_containers(cls, source_container: str, target_container: str) -> Dict:
        """Best-effort copy of /var/www/html/wp-content from source to target
        WordPress container using `docker cp` via a host tmp dir. Never raises.
        """
        import tempfile
        try:
            tmp = tempfile.mkdtemp(prefix='wpclone_')
            staged = os.path.join(tmp, 'wp-content')
            cp_out = subprocess.run(
                ['docker', 'cp', f'{source_container}:/var/www/html/wp-content', staged],
                capture_output=True, text=True, timeout=600,
            )
            if cp_out.returncode != 0:
                shutil.rmtree(tmp, ignore_errors=True)
                return {'success': False, 'error': cp_out.stderr}
            cp_in = subprocess.run(
                ['docker', 'cp', f'{staged}/.', f'{target_container}:/var/www/html/wp-content'],
                capture_output=True, text=True, timeout=600,
            )
            shutil.rmtree(tmp, ignore_errors=True)
            if cp_in.returncode != 0:
                return {'success': False, 'error': cp_in.stderr}
            return {'success': True}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    @staticmethod
    def _safe_extract_zip(zip_path: str, dest_dir: str) -> Dict:
        """Extract a zip into dest_dir, rejecting any member whose path would
        escape it (zip-slip / absolute-path / `..` traversal). Returns {success}.
        """
        import zipfile
        try:
            dest_abs = os.path.abspath(dest_dir)
            with zipfile.ZipFile(zip_path) as zf:
                for member in zf.namelist():
                    target = os.path.abspath(os.path.join(dest_abs, member))
                    if target != dest_abs and not target.startswith(dest_abs + os.sep):
                        return {'success': False, 'error': f'Unsafe path in archive: {member}'}
                zf.extractall(dest_abs)
            return {'success': True}
        except zipfile.BadZipFile:
            return {'success': False, 'error': 'Not a valid zip archive'}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    @staticmethod
    def _resolve_wp_content_dir(extracted_dir: str) -> Optional[str]:
        """Locate the wp-content directory inside an extracted archive — handles a
        zip OF wp-content, a full-site zip, or a single wrapper folder. Returns the
        path to use as wp-content, or None if none is recognizable."""
        markers = {'plugins', 'themes', 'uploads', 'mu-plugins'}
        candidates = [extracted_dir]
        try:
            for entry in os.listdir(extracted_dir):
                p = os.path.join(extracted_dir, entry)
                if os.path.isdir(p):
                    candidates.append(p)
        except OSError:
            pass
        # 1) An explicit wp-content dir at the root or one level down.
        for base in candidates:
            wpc = os.path.join(base, 'wp-content')
            if os.path.isdir(wpc):
                return wpc
        # 2) The root (or a wrapper dir) IS wp-content (has plugins/themes/uploads).
        for base in candidates:
            try:
                if set(os.listdir(base)) & markers:
                    return base
            except OSError:
                continue
        return None

    @classmethod
    def _import_wp_content_zip(cls, zip_path: str, target_container: str) -> Dict:
        """Extract an uploaded wp-content/full-site zip (zip-slip-guarded) and copy
        its wp-content into the target WordPress container via `docker cp`, then
        hand the files to the web user. Never raises."""
        import tempfile
        tmp = tempfile.mkdtemp(prefix='wpimport_')
        try:
            ext = cls._safe_extract_zip(zip_path, tmp)
            if not ext.get('success'):
                return ext
            wpc = cls._resolve_wp_content_dir(tmp)
            if not wpc:
                return {'success': False, 'error': 'No wp-content found in the archive'}
            cp = subprocess.run(
                ['docker', 'cp', f'{wpc}/.', f'{target_container}:/var/www/html/wp-content'],
                capture_output=True, text=True, timeout=600,
            )
            if cp.returncode != 0:
                return {'success': False, 'error': cp.stderr or 'docker cp failed'}
            # Imported files land root-owned; hand wp-content to the web user.
            subprocess.run(
                ['docker', 'exec', target_container, 'chown', '-R', 'www-data:www-data',
                 '/var/www/html/wp-content'],
                capture_output=True, text=True, timeout=300,
            )
            return {'success': True}
        except Exception as e:
            return {'success': False, 'error': str(e)}
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    # ========================================
    # WORDPRESS STANDALONE (DOCKER) MANAGEMENT
    # ========================================

    WP_APP_NAME = 'serverkit-wordpress'
    WP_CONFIG_DIR = paths.SERVERKIT_CONFIG_DIR
    WP_CONFIG_FILE = os.path.join(WP_CONFIG_DIR, 'wordpress.json')

    @classmethod
    def get_wordpress_standalone_status(cls) -> Dict:
        """Check if standalone WordPress is installed and running."""
        from app.models import Application

        app = Application.query.filter_by(name=cls.WP_APP_NAME).first()

        if not app:
            return {
                'installed': False,
                'running': False,
                'http_port': None,
                'url': None,
                'url_path': None
            }

        running = cls._is_wordpress_running()
        config = cls._load_wp_config()

        # Prefer the panel's canonical origin so the link works through a domain
        # and Cloudflare; fall back to the local port only when no domain is set.
        from app.services.site_domain_service import SiteDomainService
        panel_origin = SiteDomainService.panel_origin()
        if panel_origin:
            public_url = f"{panel_origin}/wordpress"
        elif app.port:
            public_url = f"http://localhost:{app.port}"
        else:
            public_url = None

        return {
            'installed': True,
            'running': running,
            'http_port': app.port or config.get('http_port'),
            'url_path': '/wordpress',
            'url': public_url,
            'app_id': app.id,
            'version': config.get('version', '6.4')
        }

    @classmethod
    def _is_wordpress_running(cls) -> bool:
        """Check if WordPress container is running."""
        try:
            result = subprocess.run(
                ['docker', 'ps', '--filter', f'name={cls.WP_APP_NAME}', '--format', '{{.Names}}'],
                capture_output=True,
                text=True,
                timeout=10
            )
            return cls.WP_APP_NAME in result.stdout
        except Exception:
            return False

    @classmethod
    def _load_wp_config(cls) -> Dict:
        """Load WordPress standalone configuration."""
        if os.path.exists(cls.WP_CONFIG_FILE):
            try:
                with open(cls.WP_CONFIG_FILE, 'r') as f:
                    return json.load(f)
            except Exception:
                pass
        return {}

    @classmethod
    def _save_wp_config(cls, config: Dict) -> bool:
        """Save WordPress standalone configuration."""
        try:
            os.makedirs(cls.WP_CONFIG_DIR, exist_ok=True)
            with open(cls.WP_CONFIG_FILE, 'w') as f:
                json.dump(config, f, indent=2)
            return True
        except Exception:
            return False

    @classmethod
    def get_wordpress_resource_requirements(cls) -> Dict:
        """Get resource requirements for WordPress installation."""
        return {
            'memory_min': '512MB',
            'memory_recommended': '1GB',
            'storage_min': '2GB',
            'storage_recommended': '10GB',
            'components': [
                {'name': 'WordPress', 'memory': '~256MB', 'storage': '~500MB'},
                {'name': 'MySQL 8.0', 'memory': '~256MB', 'storage': '~1GB'}
            ],
            'warning': 'Installation will spin up a MySQL database container'
        }

    @classmethod
    def install_wordpress_standalone(cls, admin_email: str = None) -> Dict:
        """Install WordPress as integrated ServerKit service via Docker."""
        from app.services.template_service import TemplateService
        from app.services.nginx_service import NginxService

        status = cls.get_wordpress_standalone_status()
        if status['installed']:
            return {'success': False, 'error': 'WordPress is already installed'}

        try:
            result = TemplateService.install_template(
                template_id='wordpress',
                app_name=cls.WP_APP_NAME,
                user_variables={},
                user_id=1
            )

            if not result.get('success'):
                return result

            variables = result.get('variables', {})
            http_port = variables.get('HTTP_PORT')

            # Create nginx config for /wordpress path
            nginx_result = NginxService.create_wordpress_config(int(http_port))
            if not nginx_result.get('success'):
                print(f"Warning: Failed to create WordPress nginx config: {nginx_result.get('error')}")

            config = {
                'admin_email': admin_email,
                'http_port': http_port,
                'db_password': variables.get('DB_PASSWORD'),
                'wp_db_password': variables.get('WP_DB_PASSWORD'),
                'installed_at': datetime.now().isoformat(),
                'version': '6.4',
                'url_path': '/wordpress'
            }
            cls._save_wp_config(config)

            return {
                'success': True,
                'message': 'WordPress installed successfully',
                'http_port': http_port,
                'url_path': '/wordpress'
            }

        except Exception as e:
            return {'success': False, 'error': str(e)}

    @classmethod
    def uninstall_wordpress_standalone(cls, remove_data: bool = False) -> Dict:
        """Uninstall standalone WordPress."""
        from app import db
        from app.models import Application
        from app.services.docker_service import DockerService
        from app.services.nginx_service import NginxService

        app = Application.query.filter_by(name=cls.WP_APP_NAME).first()
        if not app:
            return {'success': False, 'error': 'WordPress is not installed'}

        try:
            NginxService.remove_wordpress_config()

            if app.root_path and os.path.exists(app.root_path):
                DockerService.compose_down(app.root_path, remove_volumes=remove_data)

                if remove_data:
                    shutil.rmtree(app.root_path, ignore_errors=True)

            db.session.delete(app)
            db.session.commit()

            if os.path.exists(cls.WP_CONFIG_FILE):
                os.remove(cls.WP_CONFIG_FILE)

            return {
                'success': True,
                'message': 'WordPress uninstalled successfully',
                'data_removed': remove_data
            }

        except Exception as e:
            return {'success': False, 'error': str(e)}

    @classmethod
    def start_wordpress_standalone(cls) -> Dict:
        """Start WordPress containers."""
        from app import db
        from app.models import Application
        from app.services.docker_service import DockerService

        app = Application.query.filter_by(name=cls.WP_APP_NAME).first()
        if not app:
            return {'success': False, 'error': 'WordPress is not installed'}

        if not app.root_path or not os.path.exists(app.root_path):
            return {'success': False, 'error': 'WordPress installation path not found'}

        try:
            result = DockerService.compose_up(app.root_path, detach=True)
            if result.get('success'):
                app.status = 'running'
                db.session.commit()
                return {'success': True, 'message': 'WordPress started'}
            return result
        except Exception as e:
            return {'success': False, 'error': str(e)}

    @classmethod
    def stop_wordpress_standalone(cls) -> Dict:
        """Stop WordPress containers."""
        from app import db
        from app.models import Application
        from app.services.docker_service import DockerService

        app = Application.query.filter_by(name=cls.WP_APP_NAME).first()
        if not app:
            return {'success': False, 'error': 'WordPress is not installed'}

        if not app.root_path or not os.path.exists(app.root_path):
            return {'success': False, 'error': 'WordPress installation path not found'}

        try:
            result = DockerService.compose_stop(app.root_path)
            if result.get('success'):
                app.status = 'stopped'
                db.session.commit()
                return {'success': True, 'message': 'WordPress stopped'}
            return result
        except Exception as e:
            return {'success': False, 'error': str(e)}

    @classmethod
    def restart_wordpress_standalone(cls) -> Dict:
        """Restart WordPress containers."""
        stop_result = cls.stop_wordpress_standalone()
        if not stop_result.get('success'):
            return stop_result
        return cls.start_wordpress_standalone()

    # ========================================
    # WORDPRESS SITES HUB (MULTI-SITE MANAGEMENT)
    # ========================================

    @classmethod
    def _enrich_site_data(cls, site, site_data: Dict) -> Dict:
        """Add runtime info (status, name, port, url) to site data dict."""
        if site.application:
            site_data['name'] = site.application.name
            site_data['port'] = site.application.port
            running = cls._check_container_running(site.application.name)
            if running and site.application.status != 'running':
                site.application.status = 'running'
            elif not running and site.application.status == 'running':
                site.application.status = 'stopped'
            site_data['status'] = site.application.status

            # Build access URL: prefer the primary domain, fall back to localhost:port
            domains = site.application.domains
            primary = next((d for d in domains if d.is_primary), None)
            if primary is None and domains:
                primary = domains[0]
            if primary is not None:
                scheme = 'https' if primary.ssl_enabled else 'http'
                site_data['url'] = f"{scheme}://{primary.name}"
            elif site.application.port:
                site_data['url'] = f"http://localhost:{site.application.port}"
        return site_data

    @classmethod
    def get_sites(cls, workspace_id=None) -> Dict:
        """Get all production WordPress sites with environment counts.

        Workspace scoping (#33): when workspace_id is given, only sites whose
        Application belongs to that workspace are returned (join-based, since WP
        sites carry no workspace_id of their own — they inherit their app's). The
        hub is global today, so with no workspace context this is unchanged.
        """
        from app.models import WordPressSite, Application

        query = WordPressSite.query.filter_by(is_production=True)
        if workspace_id is not None:
            query = query.join(Application, WordPressSite.application_id == Application.id) \
                         .filter(Application.workspace_id == workspace_id)
        sites = query.all()
        result = []

        for site in sites:
            site_data = site.to_dict()
            env_count = WordPressSite.query.filter_by(production_site_id=site.id).count()
            site_data['environment_count'] = env_count
            cls._enrich_site_data(site, site_data)
            result.append(site_data)

        return {'sites': result}

    @classmethod
    def get_site(cls, site_id: int) -> Dict:
        """Get a single WordPress site with its environments."""
        from app.models import WordPressSite

        site = WordPressSite.query.get(site_id)
        if not site:
            return {'error': 'Site not found'}

        site_data = site.to_dict(include_environments=True)
        cls._enrich_site_data(site, site_data)

        # Refresh the multisite flag from reality (single-site detail only;
        # never added to the hot list endpoint get_sites). One cheap wp_cli probe.
        if site.application and site.application.root_path:
            detected = cls.is_multisite(site.application.root_path)
            if detected != site.multisite:
                site.multisite = detected
                from app import db
                db.session.commit()
            site_data['multisite'] = detected

        # Also enrich environment data
        if 'environments' in site_data:
            for env_data in site_data['environments']:
                env = WordPressSite.query.get(env_data.get('id'))
                if env:
                    cls._enrich_site_data(env, env_data)

        return {'site': site_data}

    @classmethod
    def import_site(cls, name: str, admin_email: str, user_id: int, sql_path: str,
                    old_url: str, wp_content_zip_path: str = None) -> Dict:
        """Import an existing WordPress site from a SQL dump into a fresh Docker stack.

        Stands up a normal blank stack via create_site (reusing the full Docker
        provisioning + Application/WordPressSite rows), then OVERWRITES its DB
        with the uploaded dump and rewrites the site URL to the new localhost
        port. ``sql_path`` is a host-side temp file owned by the caller.
        """
        from app import db
        from app.models import WordPressSite
        from app.services.db_sync_service import DatabaseSyncService

        # 1) Stand up a fresh stack (reuses all Docker provisioning + rows).
        result = cls.create_site(name, admin_email, user_id)
        if not result.get('success'):
            return result
        http_port = result.get('http_port')
        wp_site = WordPressSite.query.get(result['site']['id'])
        root_path = wp_site.application.root_path
        compose_file = os.path.join(root_path, 'docker-compose.yml')

        try:
            # 2) Overwrite the fresh DB with the user's dump. Root user, since a
            #    real dump issues DROP/CREATE on the wordpress DB.
            db_password = cls._read_env_value(root_path, 'DB_PASSWORD')
            imp = DatabaseSyncService.import_to_container(
                compose_path=compose_file,
                snapshot_path=sql_path,
                db_name='wordpress',
                db_user='root',
                db_password=db_password,
            )
            if not imp.get('success'):
                return {'success': False,
                        'error': 'Database import failed: ' + (imp.get('error') or ''),
                        'site': wp_site.to_dict(), 'http_port': http_port}

            # 3) Rewrite the site URL to this server's localhost address.
            new_url = f'http://localhost:{http_port}' if http_port else 'http://localhost'
            cls.wp_cli(root_path, ['option', 'update', 'home', new_url])
            cls.wp_cli(root_path, ['option', 'update', 'siteurl', new_url])
            sr = cls.search_replace(root_path, old_url, new_url, dry_run=False)

            warnings = []
            if not sr.get('success'):
                warnings.append('Search-replace reported an issue; verify links inside wp-admin.')

            # 3.5) Optionally import wp-content (plugins/themes/uploads) from a zip.
            wp_content_imported = False
            if wp_content_zip_path:
                wpc = cls._import_wp_content_zip(wp_content_zip_path, wp_site.application.name)
                if wpc.get('success'):
                    wp_content_imported = True
                else:
                    warnings.append('Database imported, but wp-content import failed: '
                                    + (wpc.get('error') or 'unknown error'))

            cls.wp_cli(root_path, ['cache', 'flush'])
            cls.wp_cli(root_path, ['rewrite', 'flush'])

            # 4) The imported DB carries the source's users, so the create-time
            #    admin no longer matches; clear it and re-detect multisite.
            wp_site.admin_user = None
            wp_site.multisite = cls.is_multisite(root_path)
            db.session.commit()

            out = {
                'success': True,
                'message': 'WordPress site imported successfully',
                'site': wp_site.to_dict(),
                'http_port': http_port,
                'old_url': old_url,
                'new_url': new_url,
                'wp_content_imported': wp_content_imported,
            }
            if warnings:
                out['warning'] = '; '.join(warnings)
            return out
        except Exception as e:
            return {'success': False, 'error': str(e),
                    'site': wp_site.to_dict(), 'http_port': http_port}

    # WordPress core line baked into every managed stack's image tag. Kept in sync
    # with the template default (backend/templates/wordpress.yaml) and wp_version below.
    WP_CORE = '6.4'

    @classmethod
    def create_site(cls, name: str, admin_email: str, user_id: int, admin_user: str = 'admin',
                    php_version: str = None, enable_page_cache: bool = False,
                    enable_object_cache: bool = False, domain: str = None,
                    base_domain: str = None) -> Dict:
        """Create a new WordPress site via Docker.

        One-click orchestration: provision the Docker stack on a chosen PHP version,
        finalize + harden the install, then optionally enable the full-page and/or
        Redis object cache — all in a single call. Cache enablement is best-effort
        and never fails the create. The generated admin password is returned ONCE.
        """
        from app import db
        from app.models import Application, WordPressSite
        from app.services.template_service import TemplateService
        from app.services.site_domain_service import SiteDomainService

        # Sanitize name for Docker
        safe_name = name.lower().replace(' ', '-')
        safe_name = ''.join(c for c in safe_name if c.isalnum() or c == '-')

        # Check for duplicate name
        existing = Application.query.filter_by(name=safe_name).first()
        if existing:
            return {'success': False, 'error': f'A site with name "{safe_name}" already exists'}

        # Bake the chosen PHP version into the initial image tag so the site is
        # created on the right PHP from the start (no post-create container recreate).
        # Invalid/empty values fall through to the template default (WP_CORE-apache).
        user_variables = {}
        if php_version and php_version in cls.get_available_php_versions():
            user_variables['VERSION'] = f'{cls.WP_CORE}-php{php_version}-apache'

        try:
            result = TemplateService.install_template(
                template_id='wordpress',
                app_name=safe_name,
                user_variables=user_variables,
                user_id=user_id
            )

            if not result.get('success'):
                return result

            variables = result.get('variables', {})
            http_port = variables.get('HTTP_PORT')

            # Find the Application record created by TemplateService
            app = Application.query.filter_by(name=safe_name).first()
            if not app:
                return {'success': False, 'error': 'Application record not created'}

            # Finalize the WordPress install inside the container: the official
            # wordpress image only generates wp-config from env vars; it does NOT
            # run the install, so no admin user exists. Do it via the Docker-aware
            # wp_cli bridge (host-filesystem hardening does not apply to volumes).
            admin_password = cls._generate_password()
            # Publish at a real hostname (<slug>.<base_domain>) instead of
            # localhost:<port>. WordPress bakes whatever --url we pass in as its
            # canonical home/siteurl, so this is what makes the site usable as an
            # actual website. Falls back to localhost when no base domain is set
            # (e.g. an unconfigured production install).
            site_host = SiteDomainService.subdomain_for(safe_name, base=base_domain)
            if site_host:
                base_used = SiteDomainService.covering_base(site_host)
                site_url = SiteDomainService.site_url(
                    site_host, ssl=SiteDomainService.https_enabled(base_used))
            else:
                site_url = f'http://localhost:{http_port}' if http_port else 'http://localhost'
            wp_warning = None
            harden_actions = []
            cache_actions = []
            cache_warnings = []
            page_cache_on = False
            if cls._wait_for_wp_ready(app.root_path):
                install_res = cls.wp_cli(app.root_path, [
                    'core', 'install',
                    f'--url={site_url}',
                    f'--title={name}',
                    f'--admin_user={admin_user}',
                    f'--admin_password={admin_password}',
                    f'--admin_email={admin_email}',
                    '--skip-email',
                ])
                if install_res.get('success'):
                    harden_actions = cls._harden_docker_site(app.root_path)
                    # Optional caches (best-effort; never fail the create). These are
                    # wp_cli calls inside the now-running container, so they must run
                    # AFTER the core install has finalized.
                    if enable_object_cache:
                        oc = cls.enable_object_cache(app.root_path)
                        # Record whatever work succeeded — the helper returns its partial
                        # 'actions' even on failure (e.g. redis added + plugin installed
                        # but the drop-in enable failed) — then note any failure non-fatally.
                        cache_actions.extend(oc.get('actions') or [])
                        if not oc.get('success'):
                            cache_warnings.append('object cache: ' + (oc.get('error') or 'unknown error'))
                    if enable_page_cache:
                        pc = cls.enable_page_cache(app.root_path)
                        if pc.get('success'):
                            cache_actions.append('Enabled full-page cache')
                            page_cache_on = True
                        else:
                            cache_warnings.append('page cache: ' + (pc.get('error') or 'unknown error'))
                else:
                    admin_password = None
                    wp_warning = (
                        'WordPress container did not accept the automated install; '
                        'complete setup via the WordPress wizard. '
                        + (install_res.get('error') or '')
                    ).strip()
            else:
                admin_password = None
                wp_warning = (
                    'WordPress container was not ready in time; the install was not '
                    'finalized. Complete setup via the WordPress wizard.'
                )

            # Detect multisite from the freshly installed site (cheap one-shot;
            # only meaningful if the automated install finalized).
            multisite = cls.is_multisite(app.root_path) if admin_password else False

            # Publish the site at its hostname: a Domain row + nginx reverse-proxy
            # vhost so <slug>.<base_domain> reaches the container. Best-effort — a
            # box without nginx (local dev) degrades to a warning, never failing
            # the create.
            routing = cls._provision_routing(app, site_host)
            if routing.get('warning'):
                wp_warning = (wp_warning + ' ' + routing['warning']) if wp_warning else routing['warning']

            # Surface any best-effort cache failures without failing the create.
            if cache_warnings:
                note = 'Site created, but some caches could not be enabled — ' + '; '.join(cache_warnings) + '.'
                wp_warning = (wp_warning + ' ' + note) if wp_warning else note

            # Create WordPressSite record. Persist the page-cache flag in sync_config
            # to mirror the per-site page-cache route (object cache + PHP are read live).
            wp_site = WordPressSite(
                application_id=app.id,
                admin_user=admin_user if admin_password else None,
                admin_email=admin_email,
                is_production=True,
                environment_type='production',
                wp_version=cls.WP_CORE,
                compose_project_name=safe_name,
                multisite=multisite,
                sync_config=json.dumps({'page_cache_enabled': True}) if page_cache_on else None,
            )
            db.session.add(wp_site)
            db.session.commit()

            try:
                from app.services.event_service import EventService
                EventService.emit_wp('wordpress.created', wp_site, php_version=php_version)
            except Exception:
                pass

            # If the caller supplied a custom domain, attach it and migrate the
            # WordPress site URL away from localhost:<port> / base subdomain.
            if domain:
                attach_res = cls.attach_custom_domain(
                    app, domain, migrate=True, issue_ssl=False
                )
                if attach_res.get('success'):
                    site_url = attach_res.get('url') or site_url
                    site_host = attach_res.get('domain') or site_host
                    if attach_res.get('warning'):
                        wp_warning = (wp_warning + ' ' + attach_res['warning']) if wp_warning else attach_res['warning']
                else:
                    attach_err = attach_res.get('error') or 'Custom domain could not be attached'
                    wp_warning = (wp_warning + ' ' + attach_err) if wp_warning else attach_err

            # Nudge admins (in-app) if the site landed on localhost or the
            # base-domain/HTTPS/DNS config is only partly set up. Best-effort —
            # never let a notification failure affect the create result.
            try:
                SiteDomainService.notify_publishing_gaps()
            except Exception:
                pass

            result = {
                'success': True,
                'message': 'WordPress site created successfully',
                'site': wp_site.to_dict(),
                'http_port': http_port,
                'url': site_url,
                'domain': site_host,
                'admin_user': admin_user if admin_password else None,
                'admin_password': admin_password,
                'hardening': harden_actions,
                'cache': cache_actions,
            }
            if wp_warning:
                result['warning'] = wp_warning
            return result

        except Exception as e:
            db.session.rollback()
            return {'success': False, 'error': str(e)}

    @classmethod
    def _provision_routing(cls, app, site_host) -> Dict:
        """Publish a managed site at ``site_host`` via a primary Domain row + an
        nginx reverse-proxy vhost to the container's published port.

        Best-effort and never raises: a box without nginx (e.g. local Windows
        dev) records the Domain and returns a warning rather than failing site
        creation. Returns ``{'domain', 'nginx', 'warning'}``.
        """
        from app import db
        from app.models.domain import Domain
        from app.services.site_domain_service import SiteDomainService

        if not site_host:
            return {'domain': None, 'nginx': None, 'warning': None}

        warning = None
        try:
            if not Domain.query.filter_by(name=site_host).first():
                Domain.query.filter_by(application_id=app.id, is_primary=True).update({'is_primary': False})
                db.session.add(Domain(name=site_host, is_primary=True, application_id=app.id))
                db.session.commit()
        except Exception as e:
            db.session.rollback()
            warning = f'could not record domain {site_host}: {e}'

        # Per-site DNS mode: auto-create this site's A record via a connected
        # provider (wildcard mode relies on the single *.<base> record instead).
        dns = SiteDomainService.ensure_site_dns(site_host)
        if dns and not dns.get('skipped') and not dns.get('created') and dns.get('message'):
            warning = (warning + '; ' + dns['message']) if warning else dns['message']

        v = cls._write_app_vhost(app)
        if v.get('warning'):
            warning = (warning + '; ' + v['warning']) if warning else v['warning']

        # Brute-force protection is on by default: now that the per-site vhost (and
        # therefore its access log) exists, stand up the WP-login Fail2ban jail.
        # Best-effort and never fatal — a host without fail2ban (e.g. Windows dev)
        # is silently skipped; only a real failure (e.g. reload error) warns.
        try:
            from app.services.fail2ban_jail_service import Fail2banJailService
            jail = Fail2banJailService.enable_wp_jail(app)
        except Exception as e:
            jail = {'success': False, 'error': str(e)}
        if jail and not jail.get('success') and not jail.get('skipped') and jail.get('error'):
            msg = f"brute-force jail: {jail['error']}"
            warning = (warning + '; ' + msg) if warning else msg

        return {'domain': site_host, 'nginx': v.get('nginx'), 'warning': warning}

    @classmethod
    def _write_app_vhost(cls, app) -> Dict:
        """Write + enable the nginx reverse-proxy vhost for a WordPress site from
        its current Domain rows (server_name = every domain). Best-effort and
        never raises; returns ``{'nginx', 'warning'}``.

        Delegates to the shared ``SiteDomainService.write_app_vhost`` writer,
        forcing the docker proxy template: a managed WP site is always served by
        proxying to its container, never via the stock php-fpm ``wordpress``
        template. A portless site is a silent no-op (nothing to proxy to)."""
        from app.services.site_domain_service import SiteDomainService

        if not app.port:
            return {'nginx': None, 'warning': None}
        return SiteDomainService.write_app_vhost(app, force_type='docker')

    @classmethod
    def _canonical_site_url(cls, app) -> str:
        """The URL WordPress actually serves under — its primary domain if one
        exists, else the legacy localhost:<port> address it was installed with.
        Used to build correct search-replace pairs when cloning or swapping URLs,
        so it must reflect what's baked into the DB, not the panel's origin."""
        from app.models.domain import Domain
        d = (Domain.query.filter_by(application_id=app.id, is_primary=True).first()
             or Domain.query.filter_by(application_id=app.id).first())
        if d:
            scheme = 'https' if d.ssl_enabled else 'http'
            return f'{scheme}://{d.name}'
        if app.port:
            return f'http://localhost:{app.port}'
        return None

    @classmethod
    def clone_site(cls, source_site_id: int, new_name: str, user_id: int) -> Dict:
        """Clone an existing Docker WordPress site into a NEW independent top-level
        site (is_production=True, no production_site_id) with FRESH admin creds.

        (1) stand up a brand-new stack via create_site; (2) container-to-container
        clone the source DB into it with a URL search-replace to the new localhost
        URL; (3) best-effort copy wp-content between containers; (4) create a fresh
        admin user (new generated password) so the clone does NOT share the
        source's credentials. Returns the new admin_password ONCE.
        """
        from app import db
        from app.models import WordPressSite
        from app.services.db_sync_service import DatabaseSyncService

        source = WordPressSite.query.get(source_site_id)
        if not source:
            return {'success': False, 'error': 'Source site not found'}
        if not source.application or not source.application.root_path:
            return {'success': False, 'error': 'Source site has no application/root path'}
        source_root = source.application.root_path
        source_compose = os.path.join(source_root, 'docker-compose.yml')
        if not os.path.exists(source_compose):
            return {'success': False, 'error': 'Source is not a Docker-stack site (no docker-compose.yml)'}

        # 1) Stand up a NEW independent stack (fresh install + an admin we will replace).
        admin_email = source.admin_email or ''
        create_res = cls.create_site(new_name, admin_email, user_id)
        if not create_res.get('success'):
            return create_res
        new_site = WordPressSite.query.get(create_res['site']['id'])
        new_root = new_site.application.root_path
        new_compose = os.path.join(new_root, 'docker-compose.yml')
        http_port = create_res.get('http_port')
        new_url = create_res.get('url') or (f'http://localhost:{http_port}' if http_port else 'http://localhost')

        try:
            source_url = cls._canonical_site_url(source.application)

            # 2) Clone the source DB into the new stack (root user for a clean overwrite;
            #    both stacks use db name 'wordpress'; root pw lives in each .env DB_PASSWORD).
            src_pw = cls._read_env_value(source_root, 'DB_PASSWORD')
            new_pw = cls._read_env_value(new_root, 'DB_PASSWORD')
            clone_options = {
                'truncate_tables': ['actionscheduler_actions', 'actionscheduler_logs'],
            }
            if source_url and new_url and source_url != new_url:
                # Rewrite the source's URL to the clone's, both with and without
                # scheme so host-only and serialized references are covered.
                sr = {source_url: new_url}
                src_host = source_url.split('://', 1)[-1]
                new_host = new_url.split('://', 1)[-1]
                if src_host != new_host:
                    sr[src_host] = new_host
                clone_options['search_replace'] = sr
            clone_res = DatabaseSyncService.clone_between_containers(
                source_compose_path=source_compose,
                target_compose_path=new_compose,
                source_db='wordpress', target_db='wordpress',
                source_user='root', target_user='root',
                source_password=src_pw, target_password=new_pw,
                options=clone_options,
            )
            if not clone_res.get('success'):
                return {'success': False, 'error': f"Database clone failed: {clone_res.get('error')}"}

            # 3) Best-effort copy wp-content from source container to the new one.
            cls._copy_wp_content_between_containers(source.application.name, new_site.application.name)

            # 4) Fresh admin: the DB import replaced users with the SOURCE users, so
            #    create a brand-new administrator with a generated password.
            new_admin_user = 'admin'
            new_admin_pass = cls._generate_password()
            exists = cls.wp_cli(new_root, ['user', 'get', new_admin_user, '--field=ID'])
            if exists.get('success'):
                new_admin_user = f'admin_{new_site.id}'
            cu = cls.create_user(new_root, new_admin_user, admin_email or f'{new_admin_user}@example.com',
                                 role='administrator', password=new_admin_pass)
            if not cu.get('success'):
                return {'success': False, 'error': f"Failed to create fresh admin: {cu.get('error')}"}

            new_site.admin_user = new_admin_user
            if admin_email:
                new_site.admin_email = admin_email
            db.session.commit()

            return {
                'success': True,
                'message': f'Site cloned from "{source.application.name}" successfully',
                'site': new_site.to_dict(),
                'http_port': http_port,
                'admin_user': new_admin_user,
                'admin_password': new_admin_pass,
            }
        except Exception as e:
            db.session.rollback()
            return {'success': False, 'error': str(e)}

    @classmethod
    def delete_site(cls, site_id: int, create_backup: bool = True) -> Dict:
        """Delete a WordPress site and all its environments.

        By default a final files + database backup of the production site is
        captured to ``BACKUP_DIR`` before anything is torn down, so a deleted
        site stays restorable. The backup lives outside the site root, so it
        survives the filesystem teardown. Pass ``create_backup=False`` to skip.
        """
        from app import db
        from app.models import WordPressSite

        site = WordPressSite.query.get(site_id)
        if not site:
            return {'success': False, 'error': 'Site not found'}

        if not site.is_production:
            return {'success': False, 'error': 'Can only delete production sites from this endpoint. Use delete_environment for non-production.'}

        # Capture a final backup BEFORE any destructive action, while the
        # containers are still up (wp db export runs inside the running stack).
        backup_info = None
        if create_backup and site.application and site.application.root_path:
            backup_result = cls.backup_wordpress(site.application.root_path, include_db=True)
            if backup_result.get('success'):
                backup_info = {
                    'backup_name': backup_result.get('backup_name'),
                    'backup_path': backup_result.get('backup_path'),
                    'size': backup_result.get('size'),
                }

        try:
            # Delete all child environments first
            environments = WordPressSite.query.filter_by(production_site_id=site.id).all()
            for env in environments:
                cls._teardown_wp_site(env)

            # Delete the production site
            cls._teardown_wp_site(site)

            db.session.commit()
            return {
                'success': True,
                'message': 'Site and all environments deleted',
                'backup': backup_info,
            }

        except Exception as e:
            db.session.rollback()
            return {'success': False, 'error': str(e)}

    @classmethod
    def archive_site(cls, site_id: int) -> Dict:
        """Archive a site: stop its stack but keep all data (volumes + files).

        Unlike delete, archiving is fully reversible via ``unarchive_site`` —
        the Docker volumes (database) and files are preserved, and a final
        backup is captured for safety. Applies to the production site and all
        of its child environments.
        """
        from app import db
        from app.models import WordPressSite
        from app.services.docker_service import DockerService

        site = WordPressSite.query.get(site_id)
        if not site:
            return {'success': False, 'error': 'Site not found'}

        if not site.is_production:
            return {'success': False, 'error': 'Only production sites can be archived'}

        # Best-effort safety backup (archiving keeps the data either way).
        backup_info = None
        if site.application and site.application.root_path:
            backup_result = cls.backup_wordpress(site.application.root_path, include_db=True)
            if backup_result.get('success'):
                backup_info = backup_result.get('backup_name')

        try:
            targets = [site] + WordPressSite.query.filter_by(production_site_id=site.id).all()
            for wp in targets:
                if (wp.application and wp.application.root_path
                        and os.path.exists(wp.application.root_path)):
                    # Keep volumes so the database/files survive.
                    DockerService.compose_down(wp.application.root_path, volumes=False)
                if wp.application:
                    wp.application.status = 'archived'

            db.session.commit()
            return {'success': True, 'message': 'Site archived', 'backup': backup_info}

        except Exception as e:
            db.session.rollback()
            return {'success': False, 'error': str(e)}

    @classmethod
    def unarchive_site(cls, site_id: int) -> Dict:
        """Bring an archived site back online by starting its stack again."""
        from app import db
        from app.models import WordPressSite
        from app.services.docker_service import DockerService

        site = WordPressSite.query.get(site_id)
        if not site:
            return {'success': False, 'error': 'Site not found'}

        if not site.is_production:
            return {'success': False, 'error': 'Only production sites can be unarchived'}

        try:
            targets = [site] + WordPressSite.query.filter_by(production_site_id=site.id).all()
            for wp in targets:
                if (wp.application and wp.application.root_path
                        and os.path.exists(wp.application.root_path)):
                    DockerService.compose_up(wp.application.root_path)
                if wp.application:
                    wp.application.status = 'running'

            db.session.commit()
            return {'success': True, 'message': 'Site restored from archive'}

        except Exception as e:
            db.session.rollback()
            return {'success': False, 'error': str(e)}

    @classmethod
    def get_environments(cls, site_id: int) -> Dict:
        """Get all environments for a production WordPress site."""
        from app.models import WordPressSite

        site = WordPressSite.query.get(site_id)
        if not site:
            return {'error': 'Site not found'}

        if not site.is_production:
            return {'error': 'Not a production site'}

        # Production env first
        prod_data = site.to_dict()
        cls._enrich_site_data(site, prod_data)
        environments = [prod_data]

        # Child environments
        children = WordPressSite.query.filter_by(production_site_id=site.id).all()
        for child in children:
            env_data = child.to_dict()
            cls._enrich_site_data(child, env_data)
            environments.append(env_data)

        return {'environments': environments}

    @classmethod
    def create_environment(cls, site_id: int, env_type: str, user_id: int = 1) -> Dict:
        """Create a staging or development environment for a site."""
        from app import db
        from app.models import WordPressSite, Application
        from app.services.template_service import TemplateService

        site = WordPressSite.query.get(site_id)
        if not site:
            return {'success': False, 'error': 'Site not found'}

        if not site.is_production:
            return {'success': False, 'error': 'Can only create environments from a production site'}

        if env_type not in ('staging', 'development'):
            return {'success': False, 'error': 'Environment type must be staging or development'}

        # Check if this environment type already exists
        existing = WordPressSite.query.filter_by(
            production_site_id=site.id,
            environment_type=env_type
        ).first()
        if existing:
            return {'success': False, 'error': f'{env_type.capitalize()} environment already exists'}

        # Build name from parent
        parent_name = site.application.name if site.application else f'wp-site-{site.id}'
        env_name = f'{parent_name}-{env_type[:3]}'  # e.g., mysite-sta, mysite-dev

        try:
            result = TemplateService.install_template(
                template_id='wordpress',
                app_name=env_name,
                user_variables={},
                user_id=user_id
            )

            if not result.get('success'):
                return result

            variables = result.get('variables', {})
            http_port = variables.get('HTTP_PORT')

            app = Application.query.filter_by(name=env_name).first()
            if not app:
                return {'success': False, 'error': 'Application record not created'}

            wp_env = WordPressSite(
                application_id=app.id,
                admin_email=site.admin_email,
                is_production=False,
                production_site_id=site.id,
                environment_type=env_type,
                wp_version=site.wp_version or '6.4',
                compose_project_name=env_name
            )
            db.session.add(wp_env)
            db.session.commit()

            return {
                'success': True,
                'message': f'{env_type.capitalize()} environment created',
                'environment': wp_env.to_dict(),
                'http_port': http_port
            }

        except Exception as e:
            db.session.rollback()
            return {'success': False, 'error': str(e)}

    @classmethod
    def delete_environment(cls, env_id: int) -> Dict:
        """Delete a non-production environment."""
        from app import db
        from app.models import WordPressSite

        env = WordPressSite.query.get(env_id)
        if not env:
            return {'success': False, 'error': 'Environment not found'}

        if env.is_production:
            return {'success': False, 'error': 'Cannot delete production environment. Delete the site instead.'}

        try:
            cls._teardown_wp_site(env)
            db.session.commit()
            return {'success': True, 'message': 'Environment deleted'}
        except Exception as e:
            db.session.rollback()
            return {'success': False, 'error': str(e)}

    @classmethod
    def _teardown_wp_site(cls, wp_site, remove_volumes: bool = True) -> None:
        """Tear down Docker stack and delete records for a WordPressSite."""
        from app import db
        from app.services.docker_service import DockerService
        from app.services.nginx_service import NginxService

        if wp_site.application and wp_site.application.root_path:
            root_path = wp_site.application.root_path
            if os.path.exists(root_path):
                DockerService.compose_down(root_path, volumes=remove_volumes)
                shutil.rmtree(root_path, ignore_errors=True)

        if wp_site.application:
            # Remove the reverse-proxy vhost we provisioned so a deleted site
            # doesn't leave dangling nginx config. The Domain rows cascade-delete
            # with the Application (Application.domains is delete-orphan).
            try:
                NginxService.delete_site(wp_site.application.name)
            except Exception:
                pass
            # Remove the per-site brute-force jail too, so a deleted site leaves no
            # dangling Fail2ban config. Best-effort (no-op without fail2ban).
            try:
                from app.services.fail2ban_jail_service import Fail2banJailService
                Fail2banJailService.disable_jail(wp_site.application)
            except Exception:
                pass
            db.session.delete(wp_site.application)

        db.session.delete(wp_site)

    @classmethod
    def _check_container_running(cls, app_name: str) -> bool:
        """Check if a Docker container is running by app name."""
        try:
            import subprocess
            result = subprocess.run(
                ['docker', 'ps', '--filter', f'name={app_name}', '--format', '{{.Names}}'],
                capture_output=True,
                text=True,
                timeout=10
            )
            return app_name in result.stdout
        except Exception:
            return False

    # ── PR Preview Environments (best-effort) ─────────────────────────────────
    # Hooks driven by PreviewService when a PR opens/closes against a WordPress
    # site. Cloning a full WordPress stack needs Docker + a DB; both may be
    # absent in dev/test, so every step is guarded and a missing dependency
    # degrades to "recorded but not provisioned" rather than raising.

    @classmethod
    def _preview_db_name(cls, site, pr_number: int) -> str:
        """Temporary DB name for a PR preview: ``wp_preview_<pr>`` (scoped per
        site so two sites' PR #1 previews don't collide)."""
        base = (getattr(site, 'db_name', None) or 'wp').strip() or 'wp'
        return f'{base}_preview_{int(pr_number)}'

    @classmethod
    def create_preview_instance(cls, site, pr_number, domain=None, branch=None) -> Dict:
        """Spin up an isolated preview of a WordPress site for a PR.

        Best-effort: clone the site files into a preview directory, create a
        temporary database copy (``wp_preview_<pr>``), and rewrite the site URL
        to the preview ``domain``. Never raises — returns a result dict with
        ``success`` reflecting how much could actually be provisioned. In an
        environment without WP-CLI/Docker this is a no-op that still reports the
        intended preview so the row can flip to running.
        """
        result = {'success': True, 'pr_number': int(pr_number) if pr_number is not None else None,
                  'domain': domain, 'db_name': None, 'preview_path': None,
                  'container_ids': [], 'provisioned': False, 'warnings': []}
        try:
            app = getattr(site, 'application', None)
            src_path = getattr(app, 'root_path', None) if app else None
            preview_db = cls._preview_db_name(site, pr_number)
            result['db_name'] = preview_db

            # 1) Clone files into a sibling preview directory (best-effort).
            if src_path and os.path.isdir(src_path):
                preview_path = f'{src_path.rstrip("/")}-preview-pr-{int(pr_number)}'
                result['preview_path'] = preview_path
                try:
                    if not os.path.exists(preview_path):
                        shutil.copytree(src_path, preview_path, symlinks=True)
                    result['provisioned'] = True
                except Exception as exc:
                    result['warnings'].append(f'file clone skipped: {exc}')
            else:
                result['warnings'].append('source path unavailable; files not cloned')

            # 2) Best-effort temp DB copy via WP-CLI (export from source, import
            #    into the preview db). Both halves are guarded; failure leaves the
            #    preview file-only.
            if result.get('preview_path') and src_path:
                try:
                    cls.wp_cli(src_path, ['db', 'export', f'/tmp/{preview_db}.sql'])
                    cls.wp_cli(result['preview_path'], ['db', 'create'])
                    cls.wp_cli(result['preview_path'], ['db', 'import', f'/tmp/{preview_db}.sql'])
                except Exception as exc:
                    result['warnings'].append(f'db copy skipped: {exc}')

            # 3) Rewrite the preview's site URL to the temporary domain.
            if domain and result.get('preview_path'):
                try:
                    new_url = f'https://{domain}'
                    cls.search_replace(result['preview_path'],
                                       cls._site_current_url(app) or '', new_url)
                    cls.wp_cli(result['preview_path'], ['option', 'update', 'home', new_url])
                    cls.wp_cli(result['preview_path'], ['option', 'update', 'siteurl', new_url])
                except Exception as exc:
                    result['warnings'].append(f'url rewrite skipped: {exc}')

            return result
        except Exception as exc:
            # Never break the caller — record the failure and move on.
            return {'success': False, 'error': str(exc),
                    'pr_number': int(pr_number) if pr_number is not None else None,
                    'container_ids': []}

    @classmethod
    def destroy_preview_instance(cls, site, pr_number) -> Dict:
        """Tear down a WordPress PR preview: drop the temp DB and remove the
        cloned preview directory. Best-effort; never raises."""
        result = {'success': True, 'pr_number': int(pr_number) if pr_number is not None else None,
                  'warnings': []}
        try:
            app = getattr(site, 'application', None)
            src_path = getattr(app, 'root_path', None) if app else None
            if src_path:
                preview_path = f'{src_path.rstrip("/")}-preview-pr-{int(pr_number)}'
                # Drop the temp DB first (uses the preview's own wp-config).
                if os.path.isdir(preview_path):
                    try:
                        cls.wp_cli(preview_path, ['db', 'drop', '--yes'])
                    except Exception as exc:
                        result['warnings'].append(f'db drop skipped: {exc}')
                    try:
                        shutil.rmtree(preview_path, ignore_errors=True)
                    except Exception as exc:
                        result['warnings'].append(f'dir removal skipped: {exc}')
            return result
        except Exception as exc:
            return {'success': False, 'error': str(exc),
                    'pr_number': int(pr_number) if pr_number is not None else None}
