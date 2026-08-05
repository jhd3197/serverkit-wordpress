"""Tests for #24 per-site PHP limit writes — validation + durable conf.d ini /
bind-mount. The Docker apply step is mocked (no Docker on the dev/CI host); the
file-rendering, compose-mutation, merge, and injection-rejection logic is real."""
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
import yaml

from app.services import wordpress_bridge


def _compose_site(tmp_path):
    """A minimal Docker-stack WP site dir with a docker-compose.yml."""
    (tmp_path / 'docker-compose.yml').write_text(
        "services:\n"
        "  wordpress:\n"
        "    image: wordpress:6.4-apache\n"
        "    volumes:\n"
        "      - wordpress_html:/var/www/html\n"
    )
    return str(tmp_path)


def _mock_docker(monkeypatch):
    WordPressService = wordpress_bridge.get('wordpress_service', 'WordPressService')
    from app.services.docker_service import DockerService
    monkeypatch.setattr(DockerService, 'compose_up', lambda *a, **k: {'success': True})
    monkeypatch.setattr(DockerService, 'compose_restart', lambda *a, **k: {'success': True})
    monkeypatch.setattr(WordPressService, '_wait_for_wp_ready', staticmethod(lambda p: None))
    monkeypatch.setattr(WordPressService, 'get_php_info', staticmethod(lambda p: {'limits': {}}))


# ---- validation / injection rejection (no Docker needed) -------------------

def test_rejects_unknown_directive(tmp_path):
    WordPressService = wordpress_bridge.get('wordpress_service', 'WordPressService')
    res = WordPressService.set_php_limits(_compose_site(tmp_path), {'evil_directive': '1'})
    assert res['success'] is False and 'Unknown PHP limit' in res['error']


def test_rejects_injection_value(tmp_path):
    WordPressService = wordpress_bridge.get('wordpress_service', 'WordPressService')
    # A newline-smuggled extra directive must not pass validation.
    res = WordPressService.set_php_limits(_compose_site(tmp_path),
                                          {'memory_limit': '256M\nevil = 1'})
    assert res['success'] is False and 'Invalid value' in res['error']
    # ...and nothing was written.
    assert not os.path.exists(os.path.join(_compose_site(tmp_path), 'php-conf', 'zz-serverkit.ini'))


def test_rejects_non_stack_site(tmp_path):
    WordPressService = wordpress_bridge.get('wordpress_service', 'WordPressService')
    res = WordPressService.set_php_limits(str(tmp_path), {'memory_limit': '256M'})
    assert res['success'] is False and 'Not a Docker-stack site' in res['error']


# ---- durable write + bind-mount (Docker mocked) ----------------------------

def test_writes_ini_and_injects_single_file_mount(tmp_path, monkeypatch):
    WordPressService = wordpress_bridge.get('wordpress_service', 'WordPressService')
    _mock_docker(monkeypatch)
    path = _compose_site(tmp_path)

    res = WordPressService.set_php_limits(path, {'memory_limit': '512M', 'max_execution_time': '120'})
    assert res['success'] is True

    ini = os.path.join(path, 'php-conf', 'zz-serverkit.ini')
    content = open(ini).read()
    assert 'memory_limit = 512M' in content
    assert 'max_execution_time = 120' in content

    vols = yaml.safe_load(open(os.path.join(path, 'docker-compose.yml')))['services']['wordpress']['volumes']
    assert any('php-conf/zz-serverkit.ini:/usr/local/etc/php/conf.d/zz-serverkit.ini' in v for v in vols)


def test_partial_update_merges_and_mount_not_duplicated(tmp_path, monkeypatch):
    WordPressService = wordpress_bridge.get('wordpress_service', 'WordPressService')
    _mock_docker(monkeypatch)
    path = _compose_site(tmp_path)

    WordPressService.set_php_limits(path, {'memory_limit': '256M'})
    res = WordPressService.set_php_limits(path, {'upload_max_filesize': '64M'})
    assert res['success'] is True
    # The second (partial) update keeps the first directive.
    assert res['limits']['memory_limit'] == '256M'
    assert res['limits']['upload_max_filesize'] == '64M'

    # The single-file mount is added once, not duplicated on the second call.
    vols = yaml.safe_load(open(os.path.join(path, 'docker-compose.yml')))['services']['wordpress']['volumes']
    assert len([v for v in vols if 'zz-serverkit.ini' in v]) == 1


def test_accepts_unlimited_and_size_suffixes(tmp_path, monkeypatch):
    WordPressService = wordpress_bridge.get('wordpress_service', 'WordPressService')
    _mock_docker(monkeypatch)
    path = _compose_site(tmp_path)
    res = WordPressService.set_php_limits(path, {'memory_limit': '-1', 'max_input_time': '-1',
                                                 'upload_max_filesize': '2G', 'max_input_vars': '5000'})
    assert res['success'] is True
    assert res['limits']['memory_limit'] == '-1'


# ---- ini parsing -----------------------------------------------------------

def test_read_php_ini_skips_comments_and_garbage(tmp_path):
    WordPressService = wordpress_bridge.get('wordpress_service', 'WordPressService')
    p = tmp_path / 'x.ini'
    p.write_text('; a comment\nmemory_limit = 128M\n\nno equals here\nmax_input_vars = 2000\n')
    assert WordPressService._read_php_ini(str(p)) == {'memory_limit': '128M', 'max_input_vars': '2000'}
