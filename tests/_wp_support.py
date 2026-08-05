"""Shared test support for the serverkit-wordpress suite.

Loads this repo's backend/ as the dashed package ``app.plugins.serverkit-
wordpress`` — the same way the panel loads an installed extension's backend —
and mounts its blueprints + core hooks on a test app, mirroring a real
install (plugin.json entry_point + extra_blueprints + core_hooks, D3: the
prefixes never change).

WordPress's MODELS are core (plan 52 D1: ``app.models.wordpress_site`` et
al.), so a panel checkout is required regardless — these tests run symlinked
into the panel's backend/tests/; ``os.path.realpath`` on the symlinked file
resolves back to THIS repo. When the files are copied instead of linked,
point SERVERKIT_WORDPRESS_DIR at the repo.
"""
import importlib
import importlib.util
import os
import sys

SLUG = 'serverkit-wordpress'
# realpath so a symlinked copy inside <panel>/backend/tests still resolves
# back to this repository root. SERVERKIT_WORDPRESS_DIR overrides when copied
# (not linked). Default sibling checkout: ../serverkit-wordpress next to the
# ServerKit repo.
def _default_ext_dir():
    here = os.path.dirname(os.path.realpath(__file__))
    return os.path.dirname(here)


EXT_DIR = os.environ.get('SERVERKIT_WORDPRESS_DIR', _default_ext_dir())

_PKG = f'app.plugins.{SLUG}'

# plugin.json's blueprint mounts, kept in one place so the tests exercise the
# same wiring the installer derives from the manifest (D3 — prefixes fixed).
BLUEPRINTS = (
    ('wordpress', 'wordpress_bp', '/api/v1/wordpress', None),
    ('wordpress_sites', 'wordpress_sites_bp', '/api/v1/wordpress', None),
    ('environment_pipeline', 'environment_pipeline_bp',
     '/api/v1/wordpress/projects', None),
    ('environment_pipeline', 'environment_pipeline_bp',
     '/api/v1/wordpress/pipelines', 'environment_pipeline_pipelines'),
    ('wp_ssh_import', 'wp_ssh_import_bp', '/api/v1/wordpress', None),
)

_MODULES = ('core_hooks', 'wordpress', 'wordpress_sites', 'environment_pipeline',
            'wordpress_service', 'wordpress_env_service', 'git_wordpress_service',
            'wordpress_plugin_library_service', 'wp_analytics_service',
            'wp_reports_service', 'wp_security_service', 'wp_ssh_import',
            'wp_ssh_import_service', 'wp_update_service', 'wp_vulnerability_service')


def load_ext():
    """Register this repo's backend/ as ``app.plugins.<slug>`` and import its
    modules. Idempotent — every test module calls this at import time."""
    if _PKG not in sys.modules:
        backend_dir = os.path.join(EXT_DIR, 'backend')
        assert os.path.isdir(backend_dir), f'extension backend not found at {backend_dir}'
        spec = importlib.util.spec_from_file_location(
            _PKG,
            os.path.join(backend_dir, '__init__.py'),
            submodule_search_locations=[backend_dir],
        )
        pkg = importlib.util.module_from_spec(spec)
        sys.modules[_PKG] = pkg
        spec.loader.exec_module(pkg)
    mods = {}
    for name in _MODULES:
        mods[name] = importlib.import_module(f'{_PKG}.{name}')
    return mods


def ensure_plugin(app):
    """Mirror a real install on a test app: active InstalledPlugin row, all
    blueprint mounts (entry_point + extra_blueprints), and the core_hooks
    seam registrations (backup target, event types, template provider, …)."""
    from app import db
    from app.models.plugin import InstalledPlugin
    if not InstalledPlugin.query.filter_by(slug=SLUG).first():
        db.session.add(InstalledPlugin(
            name=SLUG, display_name='WordPress', slug=SLUG, version='1.0.0',
            status=InstalledPlugin.STATUS_ACTIVE,
            has_backend=True, url_prefix='/api/v1/wordpress',
        ))
        db.session.commit()
    mods = load_ext()
    for module_name, attr, prefix, name in BLUEPRINTS:
        bp = getattr(mods[module_name], attr)
        reg_name = name or bp.name
        if reg_name not in app.blueprints:
            kwargs = {'url_prefix': prefix}
            if name:
                kwargs['name'] = name
            app.register_blueprint(bp, **kwargs)
    mods['core_hooks'].register()
    return mods
