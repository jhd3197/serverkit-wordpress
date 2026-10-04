"""Create-site honours a typed subdomain label.

The shared DomainField lets the user edit the label in <label>.<base>; the
route used to ignore it and always publish at the site-name slug.
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
import inspect

import pytest


@pytest.fixture
def captured(app, monkeypatch):
    """Record what the route hands WordPressService.create_site."""
    calls = []
    view = inspect.unwrap(app.view_functions['wordpress.create_site'])
    service = view.__globals__['WordPressService']

    def fake_create_site(name, admin_email, user_id, **kwargs):
        calls.append({'name': name, **kwargs})
        return {'success': True}

    monkeypatch.setattr(service, 'create_site', staticmethod(fake_create_site))
    return calls


def test_typed_label_is_passed_through(client, auth_headers, captured):
    r = client.post('/api/v1/wordpress/sites', headers=auth_headers, json={
        'name': 'Acme Blog', 'baseDomain': 'acme.dev', 'subdomain': 'news',
    })
    assert r.status_code == 201
    assert captured[0]['subdomain'] == 'news'
    assert captured[0]['base_domain'] == 'acme.dev'


def test_no_label_falls_back_to_the_name_slug(client, auth_headers, captured):
    r = client.post('/api/v1/wordpress/sites', headers=auth_headers, json={
        'name': 'Acme Blog', 'baseDomain': 'acme.dev',
    })
    assert r.status_code == 201
    assert captured[0]['subdomain'] is None
