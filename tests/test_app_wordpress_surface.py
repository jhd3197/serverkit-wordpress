"""§7 unification — WordPress reachable through the generic /apps surface.

A WordPress site is a 1:1 extension of an Application. These additive routes
expose the linkage (/apps/:id/wordpress) and the WP DB snapshots
(/apps/:id/db-snapshots) under the app id WITHOUT changing app_type, so the
docker-compose paths that key on app_type=='docker' are unaffected.
"""
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
import pytest

from app.services import wordpress_bridge


def _seed_app(app, *, wordpress=True):
    from app import db
    from app.models import User
    from app.models.application import Application
    from app.models.wordpress_site import WordPressSite
    with app.app_context():
        admin = User.query.filter_by(username='testadmin').first()
        a = Application(name='wp-app', app_type='docker', status='running',
                        root_path='/srv/wp', user_id=admin.id if admin else 1)
        db.session.add(a)
        db.session.commit()
        site_id = None
        if wordpress:
            site = WordPressSite(application_id=a.id, db_name='wpdb', db_user='wpuser',
                                 db_host='localhost', is_production=True,
                                 environment_type='production', wp_version='6.5')
            db.session.add(site)
            db.session.commit()
            site_id = site.id
        return a.id, site_id


def test_app_wordpress_info_true(app, client, auth_headers):
    app_id, site_id = _seed_app(app, wordpress=True)
    res = client.get(f'/api/v1/apps/{app_id}/wordpress', headers=auth_headers)
    assert res.status_code == 200
    body = res.get_json()
    assert body['is_wordpress'] is True
    assert body['site_id'] == site_id
    assert body['is_production'] is True


def test_app_wordpress_info_false_for_plain_app(app, client, auth_headers):
    app_id, _ = _seed_app(app, wordpress=False)
    res = client.get(f'/api/v1/apps/{app_id}/wordpress', headers=auth_headers)
    assert res.status_code == 200
    assert res.get_json()['is_wordpress'] is False


def test_db_snapshots_rejects_non_wordpress(app, client, auth_headers):
    app_id, _ = _seed_app(app, wordpress=False)
    res = client.get(f'/api/v1/apps/{app_id}/db-snapshots', headers=auth_headers)
    assert res.status_code == 400


def test_db_snapshots_list_empty(app, client, auth_headers):
    app_id, _ = _seed_app(app, wordpress=True)
    res = client.get(f'/api/v1/apps/{app_id}/db-snapshots', headers=auth_headers)
    assert res.status_code == 200
    assert res.get_json()['snapshots'] == []


def test_db_snapshot_create_and_delete(app, client, auth_headers, monkeypatch):
    from app.services.db_sync_service import DatabaseSyncService
    WordPressEnvService = wordpress_bridge.get('wordpress_env_service', 'WordPressEnvService')

    monkeypatch.setattr(WordPressEnvService, '_get_db_password', staticmethod(lambda site: 'pw'))
    monkeypatch.setattr(DatabaseSyncService, 'create_snapshot', staticmethod(
        lambda **kw: {'success': True, 'snapshot': {
            'name': kw.get('name'), 'file_path': '/var/backups/snap.sql.gz',
            'size_bytes': 1234, 'compressed': True, 'tables': ['wp_posts'], 'row_count': 10,
        }}))
    monkeypatch.setattr(DatabaseSyncService, 'upload_snapshot_offsite', staticmethod(lambda p: None))
    monkeypatch.setattr(DatabaseSyncService, 'delete_snapshot', staticmethod(lambda p: True))

    app_id, _ = _seed_app(app, wordpress=True)
    created = client.post(f'/api/v1/apps/{app_id}/db-snapshots',
                          json={'name': 'nightly', 'tag': 'manual'}, headers=auth_headers)
    assert created.status_code == 201, created.get_json()
    snap_id = created.get_json()['snapshot']['id']

    listed = client.get(f'/api/v1/apps/{app_id}/db-snapshots', headers=auth_headers)
    assert listed.get_json()['total'] == 1

    deleted = client.delete(f'/api/v1/apps/{app_id}/db-snapshots/{snap_id}', headers=auth_headers)
    assert deleted.status_code == 200
    assert client.get(f'/api/v1/apps/{app_id}/db-snapshots', headers=auth_headers).get_json()['total'] == 0
