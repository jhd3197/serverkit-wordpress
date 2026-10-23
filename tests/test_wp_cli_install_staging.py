"""WP-CLI is downloaded into a private temp dir, never the working directory.

`curl -O` saved wp-cli.phar into the panel process's cwd (its backend/), and
when the privileged move failed the 7 MB file stayed there — it once got
committed to the panel repo.
"""
# --- standalone-repo harness (see tests/README.md) --------------------------
import os as _os
import sys as _sys

_sys.path.insert(0, _os.path.dirname(_os.path.realpath(__file__)))
import _wp_support  # noqa: E402

_wp_support.load_ext()
# ----------------------------------------------------------------------------
import os
import subprocess
from types import SimpleNamespace

import pytest

service_module = _wp_support.load_ext()['wordpress_service']
WordPressService = service_module.WordPressService


@pytest.fixture
def downloads(tmp_path, monkeypatch):
    """Fake curl/chmod that act on the paths they are given; record targets."""
    seen = {'phar': None}
    monkeypatch.chdir(tmp_path)

    def fake_run(cmd, **kwargs):
        if cmd[0] == 'curl':
            out = cmd[cmd.index('-o') + 1] if '-o' in cmd else os.path.join(os.getcwd(), 'wp-cli.phar')
            with open(out, 'wb') as f:
                f.write(b'phar')
            seen['phar'] = out
        return SimpleNamespace(returncode=0, stdout='', stderr='')

    monkeypatch.setattr(service_module.subprocess, 'run', fake_run)
    return tmp_path, seen


def test_failed_move_leaves_nothing_in_the_working_directory(downloads, monkeypatch):
    cwd, seen = downloads
    monkeypatch.setattr(service_module, 'run_privileged',
                        lambda cmd, **kw: SimpleNamespace(returncode=1, stdout='', stderr='sudo: no tty'))
    result = WordPressService.install_wp_cli()
    assert result == {'success': False, 'error': 'sudo: no tty'}
    assert list(cwd.iterdir()) == []
    assert not os.path.exists(os.path.dirname(seen['phar']))


def test_successful_install_moves_the_staged_file(downloads, monkeypatch):
    cwd, seen = downloads
    moved = []
    monkeypatch.setattr(service_module, 'run_privileged',
                        lambda cmd, **kw: moved.append(cmd) or SimpleNamespace(returncode=0, stdout='', stderr=''))
    assert WordPressService.install_wp_cli()['success']
    assert moved == [['mv', seen['phar'], WordPressService.WP_CLI_PATH]]
    assert not seen['phar'].startswith(str(cwd))
    assert list(cwd.iterdir()) == []
