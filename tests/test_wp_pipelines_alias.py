"""§2 unification: /api/v1/wordpress/pipelines aliases /wordpress/projects.

"WordPress Projects" was renamed to "Pipelines" to end the collision with the
generic /projects surface. The environment-pipeline blueprint is mounted under
both prefixes, so every route resolves identically during the deprecation
window.
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


def test_pipelines_alias_matches_projects_list(client, auth_headers):
    projects_res = client.get('/api/v1/wordpress/projects', headers=auth_headers)
    pipelines_res = client.get('/api/v1/wordpress/pipelines', headers=auth_headers)

    assert projects_res.status_code == 200
    assert pipelines_res.status_code == 200
    assert pipelines_res.get_json() == projects_res.get_json()


def test_both_pipeline_prefixes_registered():
    from app import create_app

    application = create_app('testing')
    _wp_support.ensure_plugin(application)
    rules = {r.rule for r in application.url_map.iter_rules()}
    has_projects = any(r.startswith('/api/v1/wordpress/projects') for r in rules)
    has_pipelines = any(r.startswith('/api/v1/wordpress/pipelines') for r in rules)
    assert has_projects
    assert has_pipelines
