"""Tests for the WordPress-over-SSH pull importer (Panel Improvements #3).

Covers: wp-config probe parsing, host-key fingerprint pinning (mismatch
rejection), the SSRF host guard (metadata/loopback), tar traversal guards, the
full job step sequence with every remote exec stubbed, and the admin API
(auth + happy path with the enqueue stubbed).
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
import io
import os
import tarfile

import pytest

from app.services import wordpress_bridge


def _svc():
    return wordpress_bridge.get('wp_ssh_import_service', 'WpSshImportService')


def _err():
    return wordpress_bridge.get('wp_ssh_import_service', 'WpSshImportError')


WP_CONFIG_FIXTURE = """<?php
define( 'DB_NAME', 'legacy_wp' );
define('DB_USER', 'legacy_user');
define("DB_PASSWORD", "s3cr3t-pw");
define( 'DB_HOST', 'localhost' );
define( 'WP_HOME', 'https://old.example.com' );
$table_prefix = 'lw_';
require_once ABSPATH . 'wp-settings.php';
"""


# ---- probe parsing ---------------------------------------------------------

def test_parse_wp_config_extracts_db_facts():
    svc = _svc()
    cfg = svc.parse_wp_config(WP_CONFIG_FIXTURE)
    assert cfg['db_name'] == 'legacy_wp'
    assert cfg['db_user'] == 'legacy_user'
    assert cfg['db_password'] == 's3cr3t-pw'
    assert cfg['db_host'] == 'localhost'
    assert cfg['wp_home'] == 'https://old.example.com'
    assert cfg['table_prefix'] == 'lw_'


def test_parse_wp_config_defaults_prefix():
    svc = _svc()
    cfg = svc.parse_wp_config("define('DB_NAME','x');")
    assert cfg['table_prefix'] == 'wp_'
    assert 'db_password' not in cfg


def test_fingerprint_of_is_openssh_sha256():
    import base64
    import hashlib
    svc = _svc()
    blob = b'\x00\x00\x00\x0bssh-ed25519' + b'\x00' * 32
    b64 = base64.b64encode(blob).decode()
    expected = 'SHA256:' + base64.b64encode(
        hashlib.sha256(blob).digest()).decode().rstrip('=')
    assert svc.fingerprint_of(b64) == expected


# ---- SSRF host guard -------------------------------------------------------

@pytest.mark.parametrize('host', [
    'localhost', '127.0.0.1', '::1', '169.254.169.254', '0.0.0.0', '',
    '-oProxyCommand=evil', 'bad host name',
])
def test_validate_host_rejects_dangerous_targets(host):
    svc, err = _svc(), _err()
    with pytest.raises(err):
        svc.validate_host(host)


def test_validate_host_allows_explicit_private_ip():
    # LAN migrations are legitimate: RFC1918 typed by the operator is allowed.
    svc = _svc()
    assert svc.validate_host('10.11.12.13') == '10.11.12.13'
    assert svc.validate_host('192.168.1.50') == '192.168.1.50'


# ---- host-key pinning ------------------------------------------------------

_KEYSCAN = [{'type': 'ssh-ed25519', 'key': 'QUJDREVGRw==',
             'line': 'h ssh-ed25519 QUJDREVGRw=='}]


def test_assert_pinned_rejects_mismatch(monkeypatch):
    svc, err = _svc(), _err()
    monkeypatch.setattr(svc, '_keyscan', lambda host, port: list(_KEYSCAN))
    good = svc.fingerprint_of(_KEYSCAN[0]['key'])
    scan = svc.assert_pinned('10.0.0.9', 22, good)
    assert scan['fingerprint'] == good and 'known_hosts' in scan
    with pytest.raises(err, match='mismatch'):
        svc.assert_pinned('10.0.0.9', 22, 'SHA256:not-the-pinned-key')


# ---- tar traversal guards --------------------------------------------------

def _make_tar(path, entries, link=None):
    with tarfile.open(path, 'w:gz') as tf:
        for name, content in entries.items():
            data = content.encode()
            info = tarfile.TarInfo(name=name)
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
        if link:
            info = tarfile.TarInfo(name=link[0])
            info.type = tarfile.SYMTYPE
            info.linkname = link[1]
            tf.addfile(info)


def test_safe_extract_tar_rejects_parent_traversal(tmp_path):
    svc = _svc()
    t = tmp_path / 'evil.tar.gz'
    _make_tar(str(t), {'../escape.txt': 'x', 'ok.txt': 'y'})
    dest = tmp_path / 'out'
    dest.mkdir()
    res = svc.safe_extract_tar(str(t), str(dest))
    assert res['success'] is False and 'Unsafe path' in res['error']
    assert not (tmp_path / 'escape.txt').exists()


def test_safe_extract_tar_rejects_absolute_paths(tmp_path):
    svc = _svc()
    t = tmp_path / 'abs.tar.gz'
    _make_tar(str(t), {'/etc/evil.txt': 'x'})
    dest = tmp_path / 'out2'
    dest.mkdir()
    res = svc.safe_extract_tar(str(t), str(dest))
    assert res['success'] is False


def test_safe_extract_tar_drops_escaping_symlink_and_extracts_rest(tmp_path):
    svc = _svc()
    t = tmp_path / 'link.tar.gz'
    _make_tar(str(t), {'wp-content/ok.txt': 'y'}, link=('evil-link', '/etc/passwd'))
    dest = tmp_path / 'out3'
    dest.mkdir()
    res = svc.safe_extract_tar(str(t), str(dest))
    assert res['success'] is True
    assert (dest / 'wp-content' / 'ok.txt').read_text() == 'y'
    assert not (dest / 'evil-link').exists()


def test_safe_extract_tar_rejects_garbage(tmp_path):
    svc = _svc()
    bad = tmp_path / 'not.tar.gz'
    bad.write_text('nope')
    dest = tmp_path / 'out4'
    dest.mkdir()
    res = svc.safe_extract_tar(str(bad), str(dest))
    assert res['success'] is False


# ---- job step sequence (remote exec fully stubbed) --------------------------

class FakeJob:
    id = 77

    def __init__(self, payload):
        self.payload = payload
        self.result = None

    def get_payload(self):
        return self.payload

    def set_payload(self, p):
        self.payload = p

    def set_result(self, r):
        self.result = r

    def get_result(self):
        return self.result


def _job_payload():
    return {
        'connection': {'host': '10.20.30.40', 'port': 22, 'username': 'root',
                       'auth': {'private_key': 'FAKE-KEY'}},
        'fingerprint': 'SHA256:pinned',
        'target': {'site_name': 'migrated-site', 'admin_email': 'a@b.co'},
        'options': {'wp_path': '/var/www/html', 'old_url': None},
        'user_id': 1,
    }


def _stub_remote(svc, monkeypatch, tmp_path, has_wp_cli=True):
    """Stub every SSH touchpoint; returns the list of remote commands run."""
    calls = []
    monkeypatch.setattr(svc, 'assert_pinned',
                        lambda host, port, fp: {'fingerprint': fp, 'key_type': 'ssh-ed25519',
                                                'known_hosts': 'h ssh-ed25519 AAAA\n'})

    def fake_ssh(conn, kh, cmd, input_bytes=None, timeout=None, stdout_path=None):
        calls.append(cmd)
        if 'wp-config.php' in cmd:
            return {'code': 0, 'stdout': WP_CONFIG_FIXTURE.encode(), 'stderr': b''}
        if 'command -v wp' in cmd:
            out = b'yes' if has_wp_cli else b'no'
            return {'code': 0, 'stdout': out, 'stderr': b''}
        if 'option get siteurl' in cmd:
            return {'code': 0, 'stdout': b'https://old.example.com\n', 'stderr': b''}
        if cmd.startswith('tar czf'):
            src = tmp_path / 'srcroot'
            (src / 'wp-content' / 'plugins').mkdir(parents=True, exist_ok=True)
            (src / 'wp-content' / 'plugins' / 'p.php').write_text('<?php')
            (src / 'index.php').write_text('<?php')
            with tarfile.open(stdout_path, 'w:gz') as tf:
                tf.add(str(src), arcname='.')
            return {'code': 0, 'stdout': b'', 'stderr': b''}
        if 'db export' in cmd or 'mysqldump' in cmd:
            with open(stdout_path, 'wb') as fh:
                fh.write(b'-- dump\nCREATE TABLE lw_options (x int);\n')
            return {'code': 0, 'stdout': b'', 'stderr': b''}
        return {'code': 0, 'stdout': b'', 'stderr': b''}

    monkeypatch.setattr(svc, '_ssh_exec', fake_ssh)
    return calls


def test_run_import_step_sequence(app, monkeypatch, tmp_path):
    svc = _svc()
    calls = _stub_remote(svc, monkeypatch, tmp_path)

    captured = {}

    def fake_import(**kwargs):
        captured.update(kwargs)
        return {'success': True, 'site': {'id': 5, 'name': 'migrated-site'},
                'http_port': 8123, 'new_url': 'http://localhost:8123',
                'wp_content_imported': True}

    monkeypatch.setattr(svc, '_import_into_panel', fake_import)
    monkeypatch.setattr(svc, '_check_homepage', lambda port: True)

    job = FakeJob(_job_payload())
    result = svc.run_import(job)

    steps = [s['step'] for s in result['steps']]
    assert steps == ['pin_check', 'read_config', 'pull_docroot', 'dump_db',
                     'rebuild_site', 'validate', 'done']
    assert result['success'] is True
    assert result['old_url'] == 'https://old.example.com'
    assert result['new_url'] == 'http://localhost:8123'
    assert result['homepage_ok'] is True

    # The rebuild reused the extension's import path with the pulled artifacts.
    assert captured['name'] == 'migrated-site'
    assert captured['old_url'] == 'https://old.example.com'
    assert captured['sql_path'] and os.path.basename(captured['sql_path']) == 'source.sql'
    assert captured['wp_content_zip_path'].endswith('wp-content.zip')

    # Secrets scrubbed from the persisted payload once the job ended.
    assert job.payload['connection']['auth'] == {'scrubbed': True}
    # No secrets in the step log.
    flat = str(result['steps'])
    assert 's3cr3t-pw' not in flat and 'FAKE-KEY' not in flat
    assert any('tar czf' in c for c in calls)


def test_run_import_pin_mismatch_aborts_before_any_pull(app, monkeypatch, tmp_path):
    svc, err = _svc(), _err()
    pulled = []
    monkeypatch.setattr(svc, 'assert_pinned',
                        lambda host, port, fp: (_ for _ in ()).throw(
                            err('Host key mismatch: nope')))
    monkeypatch.setattr(svc, '_ssh_exec',
                        lambda *a, **k: pulled.append(a) or {'code': 0, 'stdout': b'', 'stderr': b''})

    job = FakeJob(_job_payload())
    with pytest.raises(err, match='mismatch'):
        svc.run_import(job)
    assert pulled == []  # nothing touched the remote after the failed pin check
    assert (job.result or {}).get('steps') and job.result['steps'][-1]['step'] == 'failed'


# ---- API -------------------------------------------------------------------

def test_probe_requires_auth(client):
    r = client.post('/api/v1/wordpress/ssh-import/probe', json={'host': 'x'})
    assert r.status_code == 401


def test_probe_happy_path(client, auth_headers, monkeypatch):
    svc = _svc()
    monkeypatch.setattr(svc, 'probe',
                        lambda **kw: {'host_key_fingerprint': 'SHA256:abc',
                                      'db_name': 'legacy_wp', 'wp_version': '6.4',
                                      'site_url': 'https://old.example.com'})
    r = client.post('/api/v1/wordpress/ssh-import/probe', headers=auth_headers,
                    json={'host': '10.0.0.5', 'username': 'root',
                          'auth': {'password': 'x'}, 'wp_path': '/var/www/html'})
    assert r.status_code == 200
    body = r.get_json()
    assert body['host_key_fingerprint'] == 'SHA256:abc'
    assert 'db_password' not in body


def test_probe_rejects_metadata_host(client, auth_headers):
    r = client.post('/api/v1/wordpress/ssh-import/probe', headers=auth_headers,
                    json={'host': '169.254.169.254', 'username': 'root',
                          'auth': {'password': 'x'}, 'wp_path': '/var/www/html'})
    assert r.status_code == 400
    assert 'error' in r.get_json()


def test_start_import_enqueues_job(client, auth_headers, monkeypatch):
    svc = _svc()

    class J:
        id = 321
    monkeypatch.setattr(svc, 'enqueue_import',
                        lambda **kw: J() if kw['fingerprint'] == 'SHA256:abc' else None)
    r = client.post('/api/v1/wordpress/ssh-import', headers=auth_headers,
                    json={'connection': {'host': '10.0.0.5', 'username': 'root',
                                         'auth': {'password': 'x'}},
                          'fingerprint': 'SHA256:abc',
                          'target': {'site_name': 'migrated'},
                          'options': {'wp_path': '/var/www/html'}})
    assert r.status_code == 202
    assert r.get_json() == {'success': True, 'job_id': 321}


def test_start_import_requires_fingerprint(client, auth_headers):
    r = client.post('/api/v1/wordpress/ssh-import', headers=auth_headers,
                    json={'connection': {'host': '10.0.0.5', 'username': 'root',
                                         'auth': {'password': 'x'}},
                          'target': {'site_name': 'migrated'},
                          'options': {'wp_path': '/var/www/html'}})
    assert r.status_code == 400
    assert 'fingerprint' in r.get_json()['error']


def test_status_endpoint_reads_job(client, auth_headers, app):
    from app import db
    from app.jobs.models import Job
    mod = wordpress_bridge.load('wp_ssh_import_service')

    job = Job(kind=mod.JOB_KIND, status='running')
    job.set_payload({'connection': {'auth': {'password': 'never-echoed'}}})
    job.set_result({'steps': [{'step': 'pin_check', 'message': 'ok'}]})
    db.session.add(job)
    other = Job(kind='backup.policy.run', status='running')
    db.session.add(other)
    db.session.commit()

    r = client.get(f'/api/v1/wordpress/ssh-import/{job.id}', headers=auth_headers)
    assert r.status_code == 200
    body = r.get_json()
    assert body['status'] == 'running'
    assert body['steps'][0]['step'] == 'pin_check'
    assert 'never-echoed' not in r.get_data(as_text=True)  # payload never echoed

    r = client.get(f'/api/v1/wordpress/ssh-import/{other.id}', headers=auth_headers)
    assert r.status_code == 404


def test_job_kind_registered():
    from app.jobs import registry
    mod = wordpress_bridge.load('wp_ssh_import_service')
    mod.WpSshImportService.register_jobs()
    assert registry.is_registered(mod.JOB_KIND)
