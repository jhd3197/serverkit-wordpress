"""WordPress-over-SSH pull importer (Panel Improvements #3).

Point the panel at any live WordPress site reachable over SSH and rebuild it as
a managed site: probe the box (host-key fingerprint + wp-config facts), then a
background job pulls the docroot with ``tar`` streamed over SSH, dumps the DB
through the same tunnel, and hands everything to the extension's existing
``WordPressService.import_site`` flow (fresh Docker stack + DB overwrite +
URL search-replace + wp-content copy).

Security posture:

* **Host-key pinning** — the SHA256 fingerprint captured at probe time must be
  re-presented for the import; every later SSH connection re-scans the host and
  refuses to proceed on any mismatch (StrictHostKeyChecking=yes against a
  known_hosts file we write from the verified scan — never the user's).
* **SSRF guard** — the target host is resolved before any connection and
  rejected when it lands on loopback, link-local (incl. the 169.254.169.254
  cloud metadata endpoint), unspecified or multicast space. Explicit private
  RFC1918/ULA addresses are ALLOWED on purpose: LAN-to-panel migrations are a
  legitimate use; only metadata/loopback tricks are blocked (assumption logged).
* **No secrets on command lines or in logs** — the SSH key goes through a
  0600 temp file, passwords through ``sshpass -e`` (env), the remote MySQL
  password through the remote process' stdin. Job step logs carry no secrets,
  and the job payload is scrubbed of credentials when the job finishes.
* **Traversal-guarded extraction** — the pulled docroot tarball is unpacked
  with an explicit member filter (no absolute paths, no ``..``, no links that
  escape the destination, no device nodes).

All process execution funnels through ``_run`` / ``_ssh_exec`` choke-points so
the test suite can stub the remote side entirely.
"""
import base64
import hashlib
import ipaddress
import logging
import os
import re
import shutil
import socket
import subprocess
import tarfile
import tempfile
import zipfile
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

JOB_KIND = 'wordpress.ssh_import.run'

# Preferred host-key algorithms for the pinned fingerprint, best first.
_KEY_PREFERENCE = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384',
                   'ecdsa-sha2-nistp521', 'rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa']

_HOST_RE = re.compile(r'^[A-Za-z0-9._:\-\[\]]+$')
_USER_RE = re.compile(r'^[A-Za-z0-9._\-]+$')


class WpSshImportError(Exception):
    """Operator-facing failure (message is safe to surface)."""


class WpSshImportService:
    """Probe + pull-import a remote WordPress site over SSH."""

    CONNECT_TIMEOUT = 15
    EXEC_TIMEOUT = 60
    TRANSFER_TIMEOUT = 3600

    # ------------------------------------------------------------------ #
    # Choke-points (stubbed in tests)
    # ------------------------------------------------------------------ #

    @classmethod
    def _run(cls, cmd: List[str], input_bytes: bytes = None, timeout: int = None,
             env: Dict = None, stdout_path: str = None) -> Dict:
        """Run a local process. Returns {'code', 'stdout', 'stderr'} (bytes-safe).

        When ``stdout_path`` is given, stdout is streamed to that file instead
        of being buffered (used for docroot/DB pulls).
        """
        full_env = dict(os.environ)
        if env:
            full_env.update(env)
        try:
            if stdout_path:
                with open(stdout_path, 'wb') as out:
                    proc = subprocess.run(
                        cmd, input=input_bytes, stdout=out,
                        stderr=subprocess.PIPE, timeout=timeout or cls.EXEC_TIMEOUT,
                        env=full_env,
                    )
                return {'code': proc.returncode, 'stdout': b'',
                        'stderr': proc.stderr or b''}
            proc = subprocess.run(
                cmd, input=input_bytes, capture_output=True,
                timeout=timeout or cls.EXEC_TIMEOUT, env=full_env,
            )
            return {'code': proc.returncode, 'stdout': proc.stdout or b'',
                    'stderr': proc.stderr or b''}
        except subprocess.TimeoutExpired:
            return {'code': -1, 'stdout': b'', 'stderr': b'timed out'}
        except FileNotFoundError as e:
            return {'code': -1, 'stdout': b'', 'stderr': str(e).encode()}

    # ------------------------------------------------------------------ #
    # Host validation (SSRF guard)
    # ------------------------------------------------------------------ #

    @classmethod
    def validate_host(cls, host: str) -> str:
        """Return the cleaned host or raise WpSshImportError.

        Blocks loopback, link-local (incl. 169.254.169.254 metadata),
        unspecified and multicast targets. Private RFC1918/ULA addresses are
        allowed by design — LAN migrations are legitimate (logged).
        """
        host = (host or '').strip().strip('[]')
        if not host or host.startswith('-') or not _HOST_RE.match(host):
            raise WpSshImportError('Invalid host')
        if host.lower() in ('localhost', 'localhost.localdomain'):
            raise WpSshImportError('Refusing to import from loopback')
        try:
            infos = socket.getaddrinfo(host, 22, proto=socket.IPPROTO_TCP)
        except socket.gaierror:
            raise WpSshImportError(f'Host does not resolve: {host}')
        private_seen = False
        for info in infos:
            try:
                ip = ipaddress.ip_address(info[4][0])
            except ValueError:
                continue
            if ip.is_loopback or ip.is_unspecified or ip.is_multicast or ip.is_link_local:
                raise WpSshImportError(
                    f'Refusing to import from {ip} (loopback/link-local/metadata range)')
            if ip.is_private:
                private_seen = True
        if private_seen:
            logger.info('wp ssh-import: %s resolves to a private address; '
                        'allowing (LAN migration assumed)', host)
        return host

    @classmethod
    def _validate_conn(cls, conn: Dict) -> Dict:
        host = cls.validate_host(conn.get('host'))
        username = (conn.get('username') or '').strip()
        if not username or not _USER_RE.match(username):
            raise WpSshImportError('Invalid username')
        try:
            port = int(conn.get('port') or 22)
        except (TypeError, ValueError):
            raise WpSshImportError('Invalid port')
        if not 1 <= port <= 65535:
            raise WpSshImportError('Invalid port')
        auth = conn.get('auth') or {}
        if not (auth.get('password') or auth.get('private_key')):
            raise WpSshImportError('A password or private key is required')
        return {'host': host, 'port': port, 'username': username, 'auth': auth}

    # ------------------------------------------------------------------ #
    # Host-key scan + pinning
    # ------------------------------------------------------------------ #

    @staticmethod
    def fingerprint_of(key_b64: str) -> str:
        """OpenSSH-style SHA256 fingerprint of a base64 host key blob."""
        digest = hashlib.sha256(base64.b64decode(key_b64)).digest()
        return 'SHA256:' + base64.b64encode(digest).decode().rstrip('=')

    @classmethod
    def _keyscan(cls, host: str, port: int) -> List[Dict]:
        """ssh-keyscan the host. Returns [{'type','key','line'}], best-first."""
        res = cls._run(['ssh-keyscan', '-T', str(cls.CONNECT_TIMEOUT),
                        '-p', str(port), '--', host], timeout=cls.CONNECT_TIMEOUT + 10)
        keys = []
        for raw in (res.get('stdout') or b'').decode('utf-8', 'replace').splitlines():
            raw = raw.strip()
            if not raw or raw.startswith('#'):
                continue
            parts = raw.split()
            if len(parts) >= 3:
                keys.append({'type': parts[1], 'key': parts[2], 'line': raw})
        if not keys:
            raise WpSshImportError(f'Could not read an SSH host key from {host}:{port}')

        def rank(k):
            try:
                return _KEY_PREFERENCE.index(k['type'])
            except ValueError:
                return len(_KEY_PREFERENCE)
        keys.sort(key=rank)
        return keys

    @classmethod
    def scan_fingerprint(cls, host: str, port: int) -> Dict:
        """Scan and return {'fingerprint', 'key_type', 'known_hosts'} (all keys)."""
        keys = cls._keyscan(host, port)
        return {
            'fingerprint': cls.fingerprint_of(keys[0]['key']),
            'key_type': keys[0]['type'],
            'known_hosts': '\n'.join(k['line'] for k in keys) + '\n',
        }

    @classmethod
    def assert_pinned(cls, host: str, port: int, expected_fingerprint: str) -> Dict:
        """Re-scan the host and require the pinned fingerprint.

        The pin is satisfied if ANY of the host's current keys matches (a box
        legitimately offers several algorithms; what matters is that the key
        the operator confirmed is still presented). Returns
        {'fingerprint','key_type','known_hosts'} built from this fresh scan."""
        keys = cls._keyscan(host, port)
        fps = [cls.fingerprint_of(k['key']) for k in keys]
        if expected_fingerprint not in fps:
            raise WpSshImportError(
                'Host key mismatch: the server no longer presents the pinned '
                f'fingerprint {expected_fingerprint}. Refusing to connect.')
        return {
            'fingerprint': fps[0],
            'key_type': keys[0]['type'],
            'known_hosts': '\n'.join(k['line'] for k in keys) + '\n',
        }

    # ------------------------------------------------------------------ #
    # SSH exec
    # ------------------------------------------------------------------ #

    @classmethod
    def _ssh_exec(cls, conn: Dict, known_hosts: str, remote_cmd: str,
                  input_bytes: bytes = None, timeout: int = None,
                  stdout_path: str = None) -> Dict:
        """Run ``remote_cmd`` on the pinned host. All SSH goes through here."""
        tmpdir = tempfile.mkdtemp(prefix='wpsshimp_')
        try:
            kh_path = os.path.join(tmpdir, 'known_hosts')
            with open(kh_path, 'w') as fh:
                fh.write(known_hosts)
            auth = conn.get('auth') or {}
            cmd = ['ssh',
                   '-p', str(conn['port']),
                   '-o', 'StrictHostKeyChecking=yes',
                   '-o', f'UserKnownHostsFile={kh_path}',
                   '-o', f'ConnectTimeout={cls.CONNECT_TIMEOUT}',
                   '-o', 'NumberOfPasswordPrompts=1']
            env = None
            key_path = None
            if auth.get('private_key'):
                key_path = os.path.join(tmpdir, 'id_key')
                with open(key_path, 'w') as fh:
                    fh.write(auth['private_key'].rstrip() + '\n')
                if os.name != 'nt':
                    os.chmod(key_path, 0o600)
                cmd += ['-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
                        '-i', key_path]
            elif auth.get('password'):
                if not shutil.which('sshpass'):
                    raise WpSshImportError(
                        'Password authentication needs the "sshpass" package on '
                        'the panel host — install it, or use an SSH private key.')
                env = {'SSHPASS': auth['password']}
                cmd = ['sshpass', '-e'] + cmd + ['-o', 'PubkeyAuthentication=no']
            cmd += ['--', f"{conn['username']}@{conn['host']}", remote_cmd]
            return cls._run(cmd, input_bytes=input_bytes,
                            timeout=timeout or cls.EXEC_TIMEOUT,
                            env=env, stdout_path=stdout_path)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    # ------------------------------------------------------------------ #
    # wp-config parsing
    # ------------------------------------------------------------------ #

    _DEFINE_RE = r"define\s*\(\s*['\"]{name}['\"]\s*,\s*['\"](?P<val>[^'\"]*)['\"]\s*\)"

    @classmethod
    def parse_wp_config(cls, text: str) -> Dict:
        """Extract DB facts + table prefix from wp-config.php source."""
        out = {}
        for name, key in (('DB_NAME', 'db_name'), ('DB_USER', 'db_user'),
                          ('DB_PASSWORD', 'db_password'), ('DB_HOST', 'db_host'),
                          ('WP_HOME', 'wp_home'), ('WP_SITEURL', 'wp_siteurl')):
            m = re.search(cls._DEFINE_RE.format(name=name), text or '')
            if m:
                out[key] = m.group('val')
        m = re.search(r"\$table_prefix\s*=\s*['\"]([^'\"]+)['\"]", text or '')
        out['table_prefix'] = m.group(1) if m else 'wp_'
        return out

    # ------------------------------------------------------------------ #
    # Probe
    # ------------------------------------------------------------------ #

    @classmethod
    def probe(cls, host: str, port: int, username: str, auth: Dict,
              wp_path: str) -> Dict:
        """Connect, capture the host-key fingerprint and read site facts.

        Returns facts only — the remote DB password is intentionally NOT
        included (the import job re-reads wp-config itself)."""
        conn = cls._validate_conn({'host': host, 'port': port,
                                   'username': username, 'auth': auth})
        wp_path = cls._clean_remote_path(wp_path)
        scan = cls.scan_fingerprint(conn['host'], conn['port'])
        kh = scan['known_hosts']
        q = cls._shq(wp_path)

        cfg_res = cls._ssh_exec(conn, kh, f'cat {q}/wp-config.php')
        if cfg_res['code'] != 0:
            err = (cfg_res['stderr'] or b'').decode('utf-8', 'replace').strip()
            raise WpSshImportError(
                f'Could not read {wp_path}/wp-config.php over SSH'
                + (f': {err.splitlines()[-1]}' if err else ''))
        cfg = cls.parse_wp_config(cfg_res['stdout'].decode('utf-8', 'replace'))
        if not cfg.get('db_name'):
            raise WpSshImportError('wp-config.php found but DB_NAME could not be parsed')

        # wp-cli availability + version + siteurl (fallbacks: version.php / config).
        wp_cli = cls._ssh_exec(conn, kh, 'command -v wp >/dev/null 2>&1 && echo yes || echo no')
        has_wp_cli = b'yes' in (wp_cli.get('stdout') or b'')

        wp_version = None
        site_url = cfg.get('wp_home') or cfg.get('wp_siteurl')
        if has_wp_cli:
            r = cls._ssh_exec(conn, kh, f'wp core version --path={q} 2>/dev/null')
            if r['code'] == 0:
                wp_version = r['stdout'].decode('utf-8', 'replace').strip() or None
            r = cls._ssh_exec(conn, kh, f'wp option get siteurl --path={q} 2>/dev/null')
            if r['code'] == 0:
                site_url = r['stdout'].decode('utf-8', 'replace').strip() or site_url
        if not wp_version:
            r = cls._ssh_exec(conn, kh,
                              f"grep -oE \"wp_version = '[^']+'\" {q}/wp-includes/version.php 2>/dev/null")
            m = re.search(r"wp_version = '([^']+)'",
                          (r.get('stdout') or b'').decode('utf-8', 'replace'))
            if m:
                wp_version = m.group(1)

        size_kb = None
        r = cls._ssh_exec(conn, kh, f'du -sk {q} 2>/dev/null')
        m = re.match(r'^(\d+)', (r.get('stdout') or b'').decode('utf-8', 'replace').strip())
        if m:
            size_kb = int(m.group(1))

        return {
            'host_key_fingerprint': scan['fingerprint'],
            'host_key_type': scan['key_type'],
            'wp_version': wp_version,
            'site_url': site_url,
            'db_name': cfg['db_name'],
            'db_user': cfg.get('db_user'),
            'db_host': cfg.get('db_host') or 'localhost',
            'table_prefix': cfg.get('table_prefix', 'wp_'),
            'docroot_size_kb': size_kb,
            'has_wp_cli': has_wp_cli,
        }

    # ------------------------------------------------------------------ #
    # Safe tar extraction
    # ------------------------------------------------------------------ #

    @staticmethod
    def safe_extract_tar(tar_path: str, dest: str) -> Dict:
        """Extract a tarball rejecting traversal, links out of dest, devices."""
        dest_real = os.path.realpath(dest)
        try:
            with tarfile.open(tar_path, 'r:*') as tf:
                for member in tf:
                    name = member.name
                    if name.startswith(('/', '\\')) or os.path.isabs(name) \
                            or '..' in name.replace('\\', '/').split('/'):
                        return {'success': False,
                                'error': f'Unsafe path in archive: {name}'}
                    target = os.path.realpath(os.path.join(dest_real, name))
                    if target != dest_real and not target.startswith(dest_real + os.sep):
                        return {'success': False,
                                'error': f'Unsafe path in archive: {name}'}
                    if member.isdev():
                        continue  # never extract device/fifo nodes
                    if member.issym() or member.islnk():
                        link = member.linkname
                        base = os.path.dirname(os.path.join(dest_real, name))
                        link_target = os.path.realpath(
                            link if os.path.isabs(link) else os.path.join(base, link))
                        if not link_target.startswith(dest_real):
                            continue  # drop links escaping the destination
                    tf.extract(member, dest_real)
            return {'success': True}
        except (tarfile.TarError, EOFError, OSError) as e:
            return {'success': False, 'error': f'Not a valid tar archive: {e}'}

    # ------------------------------------------------------------------ #
    # Import job
    # ------------------------------------------------------------------ #

    @classmethod
    def enqueue_import(cls, connection: Dict, fingerprint: str, target: Dict,
                       options: Dict, user_id: int):
        """Validate inputs and enqueue the import job. Returns the Job row."""
        from app.jobs.service import JobService
        conn = cls._validate_conn(connection or {})
        if not fingerprint:
            raise WpSshImportError('The probed host_key_fingerprint is required '
                                   '(probe first, then confirm the host key)')
        target = target or {}
        if not (target.get('site_name') or '').strip():
            raise WpSshImportError('target.site_name is required')
        payload = {
            'connection': conn,
            'fingerprint': fingerprint,
            'target': {
                'site_name': target['site_name'].strip(),
                'admin_email': (target.get('admin_email') or '').strip(),
            },
            'options': {
                'wp_path': cls._clean_remote_path((options or {}).get('wp_path')),
                'old_url': ((options or {}).get('old_url') or '').strip() or None,
            },
            'user_id': user_id,
        }
        return JobService.enqueue(JOB_KIND, payload=payload, max_attempts=1,
                                  owner_type='wordpress_ssh_import', owner_id=user_id)

    @classmethod
    def run_import(cls, job) -> Dict:
        """Job handler for ``wordpress.ssh_import.run``. Steps are appended to
        the job result as it goes so the UI can poll progress."""
        payload = job.get_payload() or {}
        state = {'steps': []}
        workdir = tempfile.mkdtemp(prefix='wpsshimport_')
        try:
            result = cls._run_import_steps(job, payload, state, workdir)
            state.update(result)
            state['success'] = True
            return state
        except WpSshImportError as e:
            cls._step(job, state, 'failed', str(e))
            state['success'] = False
            state['error'] = str(e)
            raise
        finally:
            shutil.rmtree(workdir, ignore_errors=True)
            cls._scrub_job_secrets(job)

    @classmethod
    def _run_import_steps(cls, job, payload: Dict, state: Dict, workdir: str) -> Dict:
        conn = cls._validate_conn(payload.get('connection') or {})
        fingerprint = payload.get('fingerprint')
        target = payload.get('target') or {}
        options = payload.get('options') or {}
        wp_path = cls._clean_remote_path(options.get('wp_path'))
        user_id = payload.get('user_id')
        q = cls._shq(wp_path)

        # 1) Host-key pin check.
        cls._step(job, state, 'pin_check', f'Verifying pinned host key for {conn["host"]}')
        scan = cls.assert_pinned(conn['host'], conn['port'], fingerprint)
        kh = scan['known_hosts']

        # 2) Read remote facts (creds never leave this process).
        cls._step(job, state, 'read_config', 'Reading remote wp-config.php')
        cfg_res = cls._ssh_exec(conn, kh, f'cat {q}/wp-config.php')
        if cfg_res['code'] != 0:
            raise WpSshImportError('Could not read wp-config.php on the source host')
        cfg = cls.parse_wp_config(cfg_res['stdout'].decode('utf-8', 'replace'))
        if not cfg.get('db_name'):
            raise WpSshImportError('DB_NAME could not be parsed from wp-config.php')
        has_wp_cli = b'yes' in (cls._ssh_exec(
            conn, kh, 'command -v wp >/dev/null 2>&1 && echo yes || echo no'
        ).get('stdout') or b'')

        old_url = options.get('old_url')
        if not old_url and has_wp_cli:
            r = cls._ssh_exec(conn, kh, f'wp option get siteurl --path={q} 2>/dev/null')
            if r['code'] == 0:
                old_url = r['stdout'].decode('utf-8', 'replace').strip() or None
        if not old_url:
            old_url = cfg.get('wp_home') or cfg.get('wp_siteurl')
        if not old_url:
            raise WpSshImportError(
                'Could not determine the source site URL — pass options.old_url')

        # 3) Pull the docroot as a tar stream (no rsync dependency).
        cls._step(job, state, 'pull_docroot', 'Pulling the docroot over SSH (tar stream)')
        tar_path = os.path.join(workdir, 'docroot.tar.gz')
        pull = cls._ssh_exec(conn, kh, f'tar czf - -C {q} .',
                             timeout=cls.TRANSFER_TIMEOUT, stdout_path=tar_path)
        if pull['code'] != 0 or not os.path.getsize(tar_path):
            err = (pull.get('stderr') or b'').decode('utf-8', 'replace').strip()
            raise WpSshImportError('Docroot pull failed'
                                   + (f': {err.splitlines()[-1]}' if err else ''))
        extract_dir = os.path.join(workdir, 'docroot')
        os.makedirs(extract_dir, exist_ok=True)
        ext = cls.safe_extract_tar(tar_path, extract_dir)
        if not ext.get('success'):
            raise WpSshImportError(ext.get('error') or 'Docroot extraction failed')

        # Repack wp-content only: core files come from the managed image, and
        # the source wp-config must never override the managed stack's.
        wp_content_src = os.path.join(extract_dir, 'wp-content')
        wp_content_zip = None
        if os.path.isdir(wp_content_src):
            wp_content_zip = os.path.join(workdir, 'wp-content.zip')
            cls._zip_dir(wp_content_src, wp_content_zip, arc_root='wp-content')
        else:
            cls._step(job, state, 'pull_docroot',
                      'No wp-content directory found in the pulled docroot; '
                      'importing database only')

        # 4) Dump the DB through the tunnel (no remote temp files, no creds on argv).
        cls._step(job, state, 'dump_db', 'Dumping the source database over SSH')
        sql_path = os.path.join(workdir, 'source.sql')
        if has_wp_cli:
            dump = cls._ssh_exec(conn, kh, f'wp db export - --path={q} --single-transaction',
                                 timeout=cls.TRANSFER_TIMEOUT, stdout_path=sql_path)
        else:
            db_host = cfg.get('db_host') or 'localhost'
            host_part = db_host.split(':')[0] or 'localhost'
            remote = ('read -r MYSQL_PWD; export MYSQL_PWD; '
                      f'exec mysqldump --single-transaction -h {cls._shq(host_part)} '
                      f'-u {cls._shq(cfg.get("db_user") or "root")} '
                      f'{cls._shq(cfg["db_name"])}')
            dump = cls._ssh_exec(conn, kh, remote,
                                 input_bytes=(cfg.get('db_password') or '').encode() + b'\n',
                                 timeout=cls.TRANSFER_TIMEOUT, stdout_path=sql_path)
        if dump['code'] != 0 or not os.path.getsize(sql_path):
            err = (dump.get('stderr') or b'').decode('utf-8', 'replace').strip()
            raise WpSshImportError('Database dump failed'
                                   + (f': {err.splitlines()[-1]}' if err else ''))

        # 5-7) Rebuild as a managed site: create stack, import DB, search-replace
        # old URL -> new URL, copy wp-content, flush caches — all via the
        # extension's existing import path.
        cls._step(job, state, 'rebuild_site',
                  f'Creating managed site "{target.get("site_name")}" and importing')
        site_result = cls._import_into_panel(
            name=target.get('site_name'),
            admin_email=target.get('admin_email') or '',
            user_id=user_id,
            sql_path=sql_path,
            old_url=old_url,
            wp_content_zip_path=wp_content_zip,
        )
        if not site_result.get('success'):
            raise WpSshImportError(site_result.get('error') or 'Site rebuild failed')

        # 8) Validate: fetch the homepage via the local port (best-effort).
        cls._step(job, state, 'validate', 'Validating the imported site')
        http_port = site_result.get('http_port')
        homepage_ok = cls._check_homepage(http_port) if http_port else None

        cls._step(job, state, 'done', 'Import finished')
        out = {
            'site': site_result.get('site'),
            'http_port': http_port,
            'old_url': old_url,
            'new_url': site_result.get('new_url'),
            'wp_content_imported': bool(site_result.get('wp_content_imported')),
            'homepage_ok': homepage_ok,
        }
        if site_result.get('warning'):
            out['warning'] = site_result['warning']
        return out

    # ------------------------------------------------------------------ #
    # Helpers
    # ------------------------------------------------------------------ #

    @classmethod
    def _import_into_panel(cls, **kwargs) -> Dict:
        """Indirection over WordPressService.import_site (stubbed in tests)."""
        from .wordpress_service import WordPressService
        return WordPressService.import_site(**kwargs)

    @classmethod
    def _check_homepage(cls, http_port) -> Optional[bool]:
        import urllib.request
        try:
            req = urllib.request.Request(f'http://localhost:{http_port}/',
                                         method='GET')
            with urllib.request.urlopen(req, timeout=15) as resp:
                return 200 <= resp.status < 500
        except Exception:
            return False

    @staticmethod
    def _zip_dir(src_dir: str, zip_path: str, arc_root: str = ''):
        with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
            for root, _dirs, files in os.walk(src_dir):
                for fname in files:
                    full = os.path.join(root, fname)
                    rel = os.path.relpath(full, src_dir)
                    arc = os.path.join(arc_root, rel) if arc_root else rel
                    zf.write(full, arc.replace(os.sep, '/'))

    @staticmethod
    def _shq(value: str) -> str:
        """Single-quote a value for the remote POSIX shell."""
        return "'" + str(value or '').replace("'", "'\\''") + "'"

    @staticmethod
    def _clean_remote_path(path: str) -> str:
        path = (path or '').strip()
        if not path:
            raise WpSshImportError('The remote WordPress path (wp_path) is required')
        if not path.startswith('/'):
            raise WpSshImportError('wp_path must be an absolute path')
        if '\n' in path or '\r' in path:
            raise WpSshImportError('Invalid wp_path')
        return path.rstrip('/') or '/'

    @classmethod
    def _step(cls, job, state: Dict, name: str, message: str):
        """Append a progress step to the job result and persist (best-effort)."""
        from datetime import datetime
        entry = {'step': name, 'message': message,
                 'at': datetime.utcnow().isoformat() + 'Z'}
        state['steps'].append(entry)
        logger.info('wp ssh-import job %s: [%s] %s',
                    getattr(job, 'id', '?'), name, message)
        try:
            from app import db
            job.set_result(state)
            db.session.commit()
        except Exception:  # never let progress bookkeeping kill the import
            pass

    @classmethod
    def _scrub_job_secrets(cls, job):
        """Drop credentials from the persisted job payload once the job ends."""
        try:
            from app import db
            payload = job.get_payload() or {}
            conn = payload.get('connection') or {}
            if conn.get('auth'):
                conn['auth'] = {'scrubbed': True}
                payload['connection'] = conn
                job.set_payload(payload)
                db.session.commit()
        except Exception:
            pass

    # ------------------------------------------------------------------ #
    # Registration
    # ------------------------------------------------------------------ #

    @classmethod
    def register_jobs(cls):
        from app.jobs import registry
        registry.register(JOB_KIND, cls.run_import, replace=True)


def run_wp_ssh_import_job(job):
    """Module-level handler target for the manifest ``jobs`` declaration."""
    return WpSshImportService.run_import(job)


def register_jobs():
    WpSshImportService.register_jobs()
