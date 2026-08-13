"""Install-by-slug alias regression (plan 73 item 2).

The detail-page PluginsTab/ThemesTab POSTed ``{slug: ...}`` while the
install routes required ``plugin``/``theme`` — every free-text slug install
400ed with "plugin is required" / "theme is required". The routes now accept
both keys; these tests pin the alias, the canonical key, and the 400 when
neither is present.
"""
# --- standalone-repo harness (see tests/README.md) --------------------------
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

from app import db
from app.models import Application, User, WordPressSite
from app.services import wordpress_bridge


@pytest.fixture
def wp_site(app):
    """A minimal WordPress site to install plugins/themes into."""
    with app.app_context():
        admin = User.query.filter_by(username='testadmin').first()
        application = Application(name='wp-slug-alias', app_type='wordpress',
                                  status='running', root_path='/srv/wp-slug-alias',
                                  user_id=admin.id)
        db.session.add(application)
        db.session.commit()
        site = WordPressSite(application_id=application.id, wp_version='6.5')
        db.session.add(site)
        db.session.commit()
        return site.id


@pytest.fixture
def wp_service(monkeypatch):
    """WordPressService with install_plugin/install_theme stubbed; records calls."""
    WordPressService = wordpress_bridge.get('wordpress_service', 'WordPressService')
    calls = {}
    monkeypatch.setattr(
        WordPressService, 'install_plugin',
        classmethod(lambda cls, path, plugin, activate=True:
                    calls.update(plugin=plugin, activate=activate) or {'success': True}))
    monkeypatch.setattr(
        WordPressService, 'install_theme',
        classmethod(lambda cls, path, theme, activate=False:
                    calls.update(theme=theme, activate=activate) or {'success': True}))
    return calls


def test_install_plugin_accepts_slug_alias(client, auth_headers, wp_site, wp_service):
    r = client.post(f'/api/v1/wordpress/sites/{wp_site}/plugins',
                    json={'slug': 'akismet'}, headers=auth_headers)
    assert r.status_code == 200
    assert wp_service['plugin'] == 'akismet'


def test_install_plugin_accepts_canonical_key(client, auth_headers, wp_site, wp_service):
    r = client.post(f'/api/v1/wordpress/sites/{wp_site}/plugins',
                    json={'plugin': 'akismet'}, headers=auth_headers)
    assert r.status_code == 200
    assert wp_service['plugin'] == 'akismet'


def test_install_plugin_still_400s_without_either_key(client, auth_headers, wp_site, wp_service):
    r = client.post(f'/api/v1/wordpress/sites/{wp_site}/plugins',
                    json={}, headers=auth_headers)
    assert r.status_code == 400
    assert r.get_json()['error'] == 'plugin is required'


def test_install_plugin_400s_on_blank_slug(client, auth_headers, wp_site, wp_service):
    """A whitespace-only slug is not a plugin name — reject it, don't shell out."""
    r = client.post(f'/api/v1/wordpress/sites/{wp_site}/plugins',
                    json={'slug': '   '}, headers=auth_headers)
    assert r.status_code == 400
    assert 'plugin' not in wp_service


def test_install_theme_accepts_slug_alias(client, auth_headers, wp_site, wp_service):
    r = client.post(f'/api/v1/wordpress/sites/{wp_site}/themes',
                    json={'slug': 'twentytwentyfive'}, headers=auth_headers)
    assert r.status_code == 200
    assert wp_service['theme'] == 'twentytwentyfive'


def test_install_theme_accepts_canonical_key(client, auth_headers, wp_site, wp_service):
    r = client.post(f'/api/v1/wordpress/sites/{wp_site}/themes',
                    json={'theme': 'twentytwentyfive'}, headers=auth_headers)
    assert r.status_code == 200
    assert wp_service['theme'] == 'twentytwentyfive'


def test_install_theme_still_400s_without_either_key(client, auth_headers, wp_site, wp_service):
    r = client.post(f'/api/v1/wordpress/sites/{wp_site}/themes',
                    json={}, headers=auth_headers)
    assert r.status_code == 400
    assert r.get_json()['error'] == 'theme is required'


def test_install_theme_400s_on_blank_slug(client, auth_headers, wp_site, wp_service):
    """A whitespace-only slug is not a theme name — reject it, don't shell out."""
    r = client.post(f'/api/v1/wordpress/sites/{wp_site}/themes',
                    json={'slug': '   '}, headers=auth_headers)
    assert r.status_code == 400
    assert 'theme' not in wp_service
