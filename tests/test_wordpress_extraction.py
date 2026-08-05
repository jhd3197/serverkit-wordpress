"""Prove the serverkit-wordpress standalone extraction (plan 52 Phase 5).

WordPress left the ServerKit tree into its own repository. This suite runs
inside a ServerKit checkout (symlinked — see tests/README.md) and proves the
post-extraction contract from the EXTENSION side:

* the WordPress services are gone from ``app.services`` (physical move);
* this repo's backend loads as the dashed package
  ``app.plugins.serverkit-wordpress`` and the panel's lazy bridge resolves
  through it;
* the manifest's blueprint mounts (entry_point + extra_blueprints, D3 —
  prefixes unchanged) register on a test app, including the ``/projects``
  and ``/pipelines`` dual mounts;
* models come from CORE (D1 — ``app.models.wordpress_site``), not from any
  extension-owned table mechanism;
* the manifest passes the panel's validator and its job/core_hooks refs
  resolve against backend/.
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

import importlib
import json
import os

import pytest

from app.services import plugin_service, wordpress_bridge

SLUG = _wp_support.SLUG
EXT_DIR = _wp_support.EXT_DIR


def test_wordpress_services_left_core():
    """The WordPress service files no longer exist under app.services."""
    for mod in ('wordpress_service', 'git_wordpress_service',
                'wordpress_env_service', 'wp_update_service'):
        with pytest.raises(ModuleNotFoundError):
            importlib.import_module(f'app.services.{mod}')


def test_wordpress_left_the_panel_tree():
    """No in-tree builtin copy remains — this repo is the only source."""
    builtin = os.path.join(plugin_service.BUILTIN_EXTENSIONS_DIR, SLUG)
    assert not os.path.isdir(builtin), \
        'the builtin-extensions copy should be gone after Phase 5'


def test_bridge_resolves_from_this_repo():
    """The bridge loads WordPressService from the dashed extension package."""
    WordPressService = wordpress_bridge.wordpress_service()
    assert WordPressService.__name__ == 'WordPressService'
    assert WordPressService.__module__.startswith(f'app.plugins.{SLUG}')


def test_models_come_from_core():
    """D1: the schema is core Alembic tables, imported — never owned here."""
    from app.models.wordpress_site import WordPressSite
    assert WordPressSite.__tablename__ == 'wordpress_sites'
    assert WordPressSite.__module__ == 'app.models.wordpress_site'
    # The extension ships no models module and declares no models: entry —
    # its tables are the core seam, not ext_<slug>_* tables.
    import importlib
    with pytest.raises(ModuleNotFoundError):
        importlib.import_module(f'app.plugins.{SLUG}.models')
    with open(os.path.join(EXT_DIR, 'plugin.json'), encoding='utf-8') as f:
        assert 'models' not in json.load(f)


def test_wordpress_blueprints_registered(app):
    rules = [r.rule for r in app.url_map.iter_rules()]
    wp_rules = [r for r in rules if r.startswith('/api/v1/wordpress')]
    assert wp_rules, 'WordPress API should be registered from the extension'
    # D3: the /projects and /pipelines (alias) mounts both survive the move.
    assert any(r.startswith('/api/v1/wordpress/projects') for r in wp_rules)
    assert any(r.startswith('/api/v1/wordpress/pipelines') for r in wp_rules)


def test_wordpress_api_responds_not_404_or_503(app, client, auth_headers):
    resp = client.get('/api/v1/wordpress/sites', headers=auth_headers)
    assert resp.status_code not in (404, 503), resp.status_code


def test_manifest_passes_validator():
    with open(os.path.join(EXT_DIR, 'plugin.json'), encoding='utf-8') as f:
        m = json.load(f)
    assert plugin_service._validate_manifest(m) is True
    assert m['name'] == SLUG
    assert m['entry_point'] == 'wordpress:wordpress_bp'
    assert m['url_prefix'] == '/api/v1/wordpress'
    assert m['frontend_entry'] == 'dist/index.mjs'
    assert m['sdk_version']
    nav = m['contributions']['nav'][0]
    assert nav['route'] == '/wordpress' and nav['id'] == 'wordpress'


def test_manifest_refs_resolve():
    """jobs + core_hooks handlers resolve against this repo's backend."""
    with open(os.path.join(EXT_DIR, 'plugin.json'), encoding='utf-8') as f:
        m = json.load(f)
    mods = _wp_support.load_ext()
    for job in m.get('jobs', []):
        module_name, func_name = job['handler'].split(':')
        assert callable(getattr(mods[module_name], func_name, None)), job['handler']
    hooks_mod, hooks_fn = m['core_hooks'].split(':')
    assert callable(getattr(mods[hooks_mod], hooks_fn, None))


def test_sdk_version_satisfies_panel():
    from app.utils.sdk import SDK_VERSION, sdk_version_satisfies
    with open(os.path.join(EXT_DIR, 'plugin.json'), encoding='utf-8') as f:
        m = json.load(f)
    assert sdk_version_satisfies(m['sdk_version'], SDK_VERSION)


def test_frontend_entry_exports_route_component():
    with open(os.path.join(EXT_DIR, 'frontend', 'runtime-entry.jsx'),
              encoding='utf-8') as f:
        src = f.read()
    assert 'WordPressExtension' in src
    # No default export — PluginLoader auto-renders plugin default exports.
    assert 'export default' not in src
