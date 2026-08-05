"""Tests for #17 wp-content zip import — zip-slip safety, wp-content resolution,
and the container-copy flow (docker cp mocked; extraction/resolution is real)."""
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
import zipfile

from app.services import wordpress_bridge


def _make_zip(path, entries):
    """entries: {arcname: content_str}."""
    with zipfile.ZipFile(path, 'w') as zf:
        for arc, content in entries.items():
            zf.writestr(arc, content)


# ---- zip-slip safety -------------------------------------------------------

def test_safe_extract_rejects_parent_traversal(tmp_path):
    WordPressService = wordpress_bridge.get('wordpress_service', 'WordPressService')
    z = tmp_path / 'evil.zip'
    _make_zip(str(z), {'../escape.txt': 'x', 'wp-content/ok.txt': 'y'})
    dest = tmp_path / 'out'
    dest.mkdir()
    res = WordPressService._safe_extract_zip(str(z), str(dest))
    assert res['success'] is False and 'Unsafe path' in res['error']
    assert not (tmp_path / 'escape.txt').exists()  # nothing escaped the dest


def test_safe_extract_rejects_deep_traversal(tmp_path):
    WordPressService = wordpress_bridge.get('wordpress_service', 'WordPressService')
    z = tmp_path / 'evil2.zip'
    _make_zip(str(z), {'wp-content/../../../../tmp/evil.txt': 'x'})
    dest = tmp_path / 'out2'
    dest.mkdir()
    res = WordPressService._safe_extract_zip(str(z), str(dest))
    assert res['success'] is False


def test_safe_extract_ok(tmp_path):
    WordPressService = wordpress_bridge.get('wordpress_service', 'WordPressService')
    z = tmp_path / 'good.zip'
    _make_zip(str(z), {'wp-content/plugins/p/p.php': '<?php',
                       'wp-content/themes/t/style.css': 'body{}'})
    dest = tmp_path / 'out3'
    dest.mkdir()
    res = WordPressService._safe_extract_zip(str(z), str(dest))
    assert res['success'] is True
    assert (dest / 'wp-content' / 'plugins' / 'p' / 'p.php').exists()


def test_safe_extract_rejects_bad_zip(tmp_path):
    WordPressService = wordpress_bridge.get('wordpress_service', 'WordPressService')
    bad = tmp_path / 'notazip.zip'
    bad.write_text('this is not a zip')
    dest = tmp_path / 'out4'
    dest.mkdir()
    res = WordPressService._safe_extract_zip(str(bad), str(dest))
    assert res['success'] is False and 'valid zip' in res['error']


# ---- wp-content resolution (3 archive layouts) -----------------------------

def test_resolve_wp_content_at_root(tmp_path):
    WordPressService = wordpress_bridge.get('wordpress_service', 'WordPressService')
    (tmp_path / 'wp-content' / 'plugins').mkdir(parents=True)
    assert WordPressService._resolve_wp_content_dir(str(tmp_path)) == str(tmp_path / 'wp-content')


def test_resolve_full_site_wrapper_folder(tmp_path):
    WordPressService = wordpress_bridge.get('wordpress_service', 'WordPressService')
    (tmp_path / 'mysite' / 'wp-content' / 'themes').mkdir(parents=True)
    assert WordPressService._resolve_wp_content_dir(str(tmp_path)) == str(tmp_path / 'mysite' / 'wp-content')


def test_resolve_root_is_wp_content(tmp_path):
    WordPressService = wordpress_bridge.get('wordpress_service', 'WordPressService')
    (tmp_path / 'plugins').mkdir()
    (tmp_path / 'themes').mkdir()
    assert WordPressService._resolve_wp_content_dir(str(tmp_path)) == str(tmp_path)


def test_resolve_none_when_unrecognizable(tmp_path):
    WordPressService = wordpress_bridge.get('wordpress_service', 'WordPressService')
    (tmp_path / 'random').mkdir()
    assert WordPressService._resolve_wp_content_dir(str(tmp_path)) is None


# ---- container copy flow (docker cp mocked) --------------------------------

def test_import_wp_content_zip_issues_cp_and_chown(tmp_path, monkeypatch):
    WordPressService = wordpress_bridge.get('wordpress_service', 'WordPressService')
    wp_mod = wordpress_bridge.load('wordpress_service')
    z = tmp_path / 'c.zip'
    _make_zip(str(z), {'wp-content/plugins/p/p.php': '<?php'})

    calls = []

    class _Res:
        returncode = 0
        stderr = ''
        stdout = ''

    monkeypatch.setattr(wp_mod.subprocess, 'run', lambda cmd, **kw: (calls.append(list(cmd)), _Res())[1])
    res = WordPressService._import_wp_content_zip(str(z), 'mysite')
    assert res['success'] is True
    assert any(c[:2] == ['docker', 'cp'] for c in calls)
    assert any(c[:3] == ['docker', 'exec', 'mysite'] for c in calls)  # ownership fix


def test_import_wp_content_zip_propagates_cp_failure(tmp_path, monkeypatch):
    WordPressService = wordpress_bridge.get('wordpress_service', 'WordPressService')
    wp_mod = wordpress_bridge.load('wordpress_service')
    z = tmp_path / 'c.zip'
    _make_zip(str(z), {'wp-content/uploads/x.jpg': 'data'})

    class _Res:
        returncode = 1
        stderr = 'no such container'
        stdout = ''

    monkeypatch.setattr(wp_mod.subprocess, 'run', lambda cmd, **kw: _Res())
    res = WordPressService._import_wp_content_zip(str(z), 'ghost')
    assert res['success'] is False and 'no such container' in res['error']


def test_import_wp_content_zip_no_wp_content_found(tmp_path):
    WordPressService = wordpress_bridge.get('wordpress_service', 'WordPressService')
    z = tmp_path / 'empty.zip'
    _make_zip(str(z), {'readme.txt': 'hello'})
    # No subprocess mock needed: resolution fails before any docker call.
    res = WordPressService._import_wp_content_zip(str(z), 'site')
    assert res['success'] is False and 'No wp-content' in res['error']
