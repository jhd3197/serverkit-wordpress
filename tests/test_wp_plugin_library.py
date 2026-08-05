"""Tests for the WordPress global plugin library service + API."""
# --- standalone-repo harness (plan 52 Phase 5) ------------------------------
# This suite moved out of the panel with the extension. It runs inside a
# ServerKit checkout (symlinked — see tests/README.md); _wp_support loads the
# extension backend from this repo and mounts it on each test app.
import os as _os
import sys as _sys

import pytest as _pytest

_sys.path.insert(0, _os.path.dirname(_os.path.realpath(__file__)))
import _wp_support  # noqa: E402

_wp_support.load_ext()


@_pytest.fixture(autouse=True)
def _wp_plugin(app):
    """Mount the extension (row + blueprints + core hooks) on the test app."""
    _wp_support.ensure_plugin(app)
# ----------------------------------------------------------------------------
import os
import shutil

import pytest

from app.services import wordpress_bridge


PLUGIN_PHP = """<?php
/*
 * Plugin Name: My Custom Plugin
 * Description: Does a very custom thing.
 * Version: 1.2.3
 * Author: Acme Corp
 */
"""


def _make_local_plugin(tmp_path, slug='my-plugin', body=PLUGIN_PHP):
    """Create a local plugin source folder with a header PHP file."""
    src = tmp_path / f'src-{slug}'
    src.mkdir()
    (src / f'{slug}.php').write_text(body, encoding='utf-8')
    return str(src)


def _fake_privileged(cmd, *args, **kwargs):
    """Minimal python implementation of the shell verbs the service shells out to."""
    if cmd[:2] == ['rm', '-rf']:
        shutil.rmtree(cmd[2], ignore_errors=True)
    elif cmd[:2] == ['mkdir', '-p']:
        os.makedirs(cmd[2], exist_ok=True)
    elif cmd[:2] == ['cp', '-a']:
        src, dst = cmd[2], cmd[3]
        if os.path.isdir(src):
            shutil.copytree(src, dst, dirs_exist_ok=True)
        else:
            shutil.copy2(src, dst)
    # chown is a no-op off Linux
    return {'success': True}


# --------------------------------------------------------------------------
# Pure helpers
# --------------------------------------------------------------------------
def test_slug_validation():
    S = wordpress_bridge.get('wordpress_plugin_library_service', 'WordPressPluginLibraryService')
    PluginLibraryError = wordpress_bridge.get('wordpress_plugin_library_service', 'PluginLibraryError')
    assert S.validate_slug('my-plugin') == 'my-plugin'
    assert S.slugify('My Cool Plugin!') == 'my-cool-plugin'
    with pytest.raises(PluginLibraryError):
        S.validate_slug('Bad Slug')
    with pytest.raises(PluginLibraryError):
        S.validate_slug('')


def test_version_behind():
    S = wordpress_bridge.get('wordpress_plugin_library_service', 'WordPressPluginLibraryService')
    assert S._version_behind('1.0.0', '1.0.1') is True
    assert S._version_behind('1.2.0', '1.10.0') is True
    assert S._version_behind('2.0.0', '1.9.9') is False
    assert S._version_behind('1.2.3', '1.2.3') is False
    assert S._version_behind(None, '1.0.0') is False
    assert S._version_behind('1.0.0', None) is False


def test_parse_plugin_header(tmp_path):
    S = wordpress_bridge.get('wordpress_plugin_library_service', 'WordPressPluginLibraryService')
    src = _make_local_plugin(tmp_path, 'my-plugin')
    header = S.parse_plugin_header(src, 'my-plugin')
    assert header['name'] == 'My Custom Plugin'
    assert header['version'] == '1.2.3'
    assert header['author'] == 'Acme Corp'
    assert header['description'] == 'Does a very custom thing.'


def test_parse_plugin_header_falls_back_to_first_php(tmp_path):
    S = wordpress_bridge.get('wordpress_plugin_library_service', 'WordPressPluginLibraryService')
    src = tmp_path / 'src'
    src.mkdir()
    (src / 'main.php').write_text(PLUGIN_PHP, encoding='utf-8')
    header = S.parse_plugin_header(str(src), 'mismatched-slug')
    assert header['version'] == '1.2.3'


# --------------------------------------------------------------------------
# Service: sync + CRUD (local source)
# --------------------------------------------------------------------------
def test_add_and_sync_local_plugin(app, tmp_path, monkeypatch):
    mod = wordpress_bridge.load('wordpress_plugin_library_service')
    S = wordpress_bridge.get('wordpress_plugin_library_service', 'WordPressPluginLibraryService')

    monkeypatch.setattr(S, 'CACHE_DIR', str(tmp_path / 'cache'))
    src = _make_local_plugin(tmp_path, 'my-plugin')

    result = S.add_plugin({'source_type': 'local', 'source_url': src, 'slug': 'my-plugin'})
    assert result['slug'] == 'my-plugin'
    assert result['version'] == '1.2.3'
    assert result['name'] == 'My Custom Plugin'

    # Cache snapshot exists and is a copy (not the source path)
    cache = S.cache_path('my-plugin')
    assert os.path.isfile(os.path.join(cache, 'my-plugin.php'))

    # Duplicate slug rejected
    PluginLibraryError = wordpress_bridge.get('wordpress_plugin_library_service', 'PluginLibraryError')
    with pytest.raises(PluginLibraryError):
        S.add_plugin({'source_type': 'local', 'source_url': src, 'slug': 'my-plugin'})


def test_sync_reparses_updated_version(app, tmp_path, monkeypatch):
    S = wordpress_bridge.get('wordpress_plugin_library_service', 'WordPressPluginLibraryService')
    monkeypatch.setattr(S, 'CACHE_DIR', str(tmp_path / 'cache'))
    src_dir = tmp_path / 'src'
    src_dir.mkdir()
    php = src_dir / 'my-plugin.php'
    php.write_text(PLUGIN_PHP, encoding='utf-8')

    added = S.add_plugin({'source_type': 'local', 'source_url': str(src_dir), 'slug': 'my-plugin'})
    assert added['version'] == '1.2.3'

    # Bump the source version and re-sync
    php.write_text(PLUGIN_PHP.replace('1.2.3', '2.0.0'), encoding='utf-8')
    from app.models import WordPressCustomPlugin
    plugin = WordPressCustomPlugin.query.get(added['id'])
    res = S.sync_plugin(plugin)
    assert res['success'] is True
    assert plugin.version == '2.0.0'


# --------------------------------------------------------------------------
# Service: install on a site + scan
# --------------------------------------------------------------------------
def _make_site(app, tmp_path, name='acme'):
    from app import db
    from app.models import Application, WordPressSite, User
    from werkzeug.security import generate_password_hash
    user = User.query.filter_by(username=f'owner-{name}').first()
    if not user:
        user = User(email=f'{name}@test.local', username=f'owner-{name}',
                    password_hash=generate_password_hash('x'),
                    role=User.ROLE_ADMIN, is_active=True)
        db.session.add(user)
        db.session.commit()
    root = tmp_path / f'site-{name}'
    (root / 'wp-content' / 'plugins').mkdir(parents=True)
    app_row = Application(name=name, app_type='wordpress', user_id=user.id, root_path=str(root))
    db.session.add(app_row)
    db.session.commit()
    site = WordPressSite(application_id=app_row.id, wp_version='6.5')
    db.session.add(site)
    db.session.commit()
    return app_row, site


def test_install_on_site_copies_and_records(app, tmp_path, monkeypatch):
    mod = wordpress_bridge.load('wordpress_plugin_library_service')
    S = wordpress_bridge.get('wordpress_plugin_library_service', 'WordPressPluginLibraryService')
    WordPressService = wordpress_bridge.get('wordpress_service', 'WordPressService')
    from app.models import WordPressSitePlugin

    monkeypatch.setattr(S, 'CACHE_DIR', str(tmp_path / 'cache'))
    monkeypatch.setattr(mod, 'run_privileged', _fake_privileged)
    calls = []
    monkeypatch.setattr(WordPressService, 'wp_cli',
                        classmethod(lambda cls, path, cmd, **kw: (calls.append(cmd) or {'success': True})))

    src = _make_local_plugin(tmp_path, 'my-plugin')
    added = S.add_plugin({'source_type': 'local', 'source_url': src, 'slug': 'my-plugin'})

    from app.models import WordPressCustomPlugin
    plugin = WordPressCustomPlugin.query.get(added['id'])
    _, site = _make_site(app, tmp_path)

    res = S.install_on_site(plugin, site, activate=True)
    assert res['success'] is True
    assert res['status'] == 'active'

    # File landed in the site's wp-content/plugins/<slug>
    target = os.path.join(site.application.root_path, 'wp-content', 'plugins', 'my-plugin', 'my-plugin.php')
    assert os.path.isfile(target)

    # Installation row recorded
    row = WordPressSitePlugin.query.filter_by(
        wordpress_site_id=site.id, custom_plugin_id=plugin.id).first()
    assert row is not None and row.status == 'active'
    assert ['plugin', 'activate', 'my-plugin'] in calls


def test_scan_site_tags_managed(app, tmp_path, monkeypatch):
    S = wordpress_bridge.get('wordpress_plugin_library_service', 'WordPressPluginLibraryService')
    WordPressService = wordpress_bridge.get('wordpress_service', 'WordPressService')
    monkeypatch.setattr(S, 'CACHE_DIR', str(tmp_path / 'cache'))

    src = _make_local_plugin(tmp_path, 'my-plugin')
    added = S.add_plugin({'source_type': 'local', 'source_url': src, 'slug': 'my-plugin'})
    from app.models import WordPressCustomPlugin
    plugin = WordPressCustomPlugin.query.get(added['id'])
    _, site = _make_site(app, tmp_path)

    # WP-CLI reports the plugin installed & active, at an older version.
    monkeypatch.setattr(WordPressService, 'get_plugins', classmethod(lambda cls, path: [
        {'name': 'my-plugin', 'status': 'active', 'version': '1.0.0'},
        {'name': 'akismet', 'status': 'inactive', 'version': '5.0'},
    ]))

    res = S.scan_site(site)
    assert 'my-plugin' in res['managed_slugs']

    managed = S.managed_for_site(site)
    entry = next(m for m in managed if m['slug'] == 'my-plugin')
    assert entry['installed_version'] == '1.0.0'
    assert entry['library_version'] == '1.2.3'
    assert entry['update_available'] is True


# --------------------------------------------------------------------------
# API: CRUD + bulk update
# --------------------------------------------------------------------------
def test_api_library_crud(app, client, auth_headers, tmp_path, monkeypatch):
    S = wordpress_bridge.get('wordpress_plugin_library_service', 'WordPressPluginLibraryService')
    monkeypatch.setattr(S, 'CACHE_DIR', str(tmp_path / 'cache'))
    src = _make_local_plugin(tmp_path, 'api-plugin')

    # Create
    r = client.post('/api/v1/wordpress/plugins/library',
                    json={'source_type': 'local', 'source_url': src, 'slug': 'api-plugin'},
                    headers=auth_headers)
    assert r.status_code == 201, r.get_json()
    pid = r.get_json()['id']

    # List
    r = client.get('/api/v1/wordpress/plugins/library', headers=auth_headers)
    assert r.status_code == 200
    assert any(p['slug'] == 'api-plugin' for p in r.get_json()['plugins'])

    # Detail
    r = client.get(f'/api/v1/wordpress/plugins/library/{pid}', headers=auth_headers)
    assert r.status_code == 200
    assert r.get_json()['version'] == '1.2.3'

    # Delete
    r = client.delete(f'/api/v1/wordpress/plugins/library/{pid}', headers=auth_headers)
    assert r.status_code == 200
    r = client.get(f'/api/v1/wordpress/plugins/library/{pid}', headers=auth_headers)
    assert r.status_code == 404


def test_api_add_requires_source(app, client, auth_headers, tmp_path, monkeypatch):
    S = wordpress_bridge.get('wordpress_plugin_library_service', 'WordPressPluginLibraryService')
    monkeypatch.setattr(S, 'CACHE_DIR', str(tmp_path / 'cache'))
    r = client.post('/api/v1/wordpress/plugins/library',
                    json={'source_type': 'github'}, headers=auth_headers)
    assert r.status_code == 400


def test_api_bulk_update(app, client, auth_headers, tmp_path, monkeypatch):
    mod = wordpress_bridge.load('wordpress_plugin_library_service')
    S = wordpress_bridge.get('wordpress_plugin_library_service', 'WordPressPluginLibraryService')
    WordPressService = wordpress_bridge.get('wordpress_service', 'WordPressService')

    monkeypatch.setattr(S, 'CACHE_DIR', str(tmp_path / 'cache'))
    monkeypatch.setattr(mod, 'run_privileged', _fake_privileged)
    monkeypatch.setattr(WordPressService, 'wp_cli',
                        classmethod(lambda cls, path, cmd, **kw: {'success': True}))

    src = _make_local_plugin(tmp_path, 'bulk-plugin')
    added = S.add_plugin({'source_type': 'local', 'source_url': src, 'slug': 'bulk-plugin'})
    from app.models import WordPressCustomPlugin
    plugin = WordPressCustomPlugin.query.get(added['id'])
    _, site = _make_site(app, tmp_path, name='bulk-site')
    S.install_on_site(plugin, site, activate=False)

    r = client.post(f'/api/v1/wordpress/plugins/library/{added["id"]}/bulk-update',
                    headers=auth_headers)
    assert r.status_code == 200
    body = r.get_json()
    assert body['total'] == 1
    assert body['updated'] == 1
