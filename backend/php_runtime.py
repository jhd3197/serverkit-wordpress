"""Verified container PHP updates for managed WordPress sites.

Security floor: https://www.php.net/releases/8_3_36.php (2026-10-21).
The image supplies PHP; existing WordPress files remain in their mounted volume.
"""
import json
import os
import re
import tempfile
import threading
import uuid
from pathlib import Path

import yaml

from app.services.docker_service import DockerService


MINIMUM_PHP = {'8.2': '8.2.35', '8.3': '8.3.36'}
WORDPRESS_CORE = '7.1.3'
_update_lock = threading.Lock()


def runtime_dockerfile(version):
    minimum = MINIMUM_PHP[version]
    return f'''FROM wordpress:{WORDPRESS_CORE}-php{version}-apache
RUN php -r 'exit(version_compare(PHP_VERSION, "{minimum}", ">=") ? 0 : 1);' \\
 && docker-php-ext-install pdo_mysql \\
 && php -r 'exit(extension_loaded("pdo_mysql") ? 0 : 1);'
RUN printf 'session.upload_progress.enabled=0\\n' > /usr/local/etc/php/conf.d/zz-serverkit-security.ini \\
 && printf 'php_admin_flag session.upload_progress.enabled Off\\n' > /etc/apache2/conf-available/serverkit-php-security.conf \\
 && a2enconf serverkit-php-security
'''


def _replace(path, content):
    """Same-directory atomic replacement; never leave a half-written compose."""
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.php-update-')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            stream.write(content)
        if os.name != 'nt':
            os.chmod(temporary, path.stat().st_mode & 0o777)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _up(path):
    cmd = DockerService._compose_cmd_with_overlay(path) + [
        'up', '-d', '--no-deps', '--force-recreate', 'wordpress']
    return DockerService.run_compose(cmd, cwd=path)


def repair_runtime(service, path, version):
    if not isinstance(version, str) or version not in MINIMUM_PHP:
        return {'success': False, 'error': 'Choose a supported PHP version: 8.2 or 8.3'}
    if not _update_lock.acquire(blocking=False):
        return {'success': False, 'error': 'A PHP update is already running; retry when it finishes'}
    try:
        return _repair_runtime(service, path, version)
    except Exception as exc:
        return {'success': False, 'error': str(exc)}
    finally:
        _update_lock.release()


def _repair_runtime(service, path, version):
    compose = Path(path) / 'docker-compose.yml'
    if not compose.is_file():
        return {'success': False, 'error': 'Not a Docker-stack site (no docker-compose.yml)'}
    original = compose.read_text(encoding='utf-8')
    config = yaml.safe_load(original)
    wp = config.get('services', {}).get('wordpress', {})
    current = wp.get('image', '')
    if not re.fullmatch(r'(wordpress:[\w.\-]+|serverkit-wp-runtime:[\w.\-]+)', current):
        return {'success': False, 'error': 'Custom or unresolved WordPress image; manual runtime update required'}
    build = wp.get('build')
    managed_build = build == {'context': '.', 'dockerfile': 'Dockerfile.serverkit-php'}
    persistent_html = any(
        (isinstance(v, str) and len(v.split(':')) >= 2
         and v.split(':')[1].rstrip('/') == '/var/www/html' and v.split(':')[0])
        or (isinstance(v, dict) and v.get('target', '').rstrip('/') == '/var/www/html'
            and v.get('source')) for v in wp.get('volumes', []))
    if (build and not managed_build) or not persistent_html or wp.get('entrypoint') or wp.get('command'):
        return {'success': False, 'error': 'Custom build or missing persistent volumes; manual runtime update required'}
    # Resolve through Compose so overrides/project names are respected.
    base = DockerService._compose_cmd_with_overlay(path)
    old = DockerService.run_compose(base + ['ps', '-q', 'wordpress'], cwd=path)
    old_id = (old.get('output') or '').strip()
    if not old.get('success') or not re.fullmatch(r'[a-f0-9]{12,64}', old_id):
        return {'success': False, 'error': 'Could not identify the running WordPress container'}
    inspect = DockerService.run(['inspect', '--format', '{{.Image}}', old_id])
    old_image = (inspect.get('output') or '').strip()
    if not inspect.get('success') or not re.fullmatch(r'sha256:[a-f0-9]{64}', old_image):
        return {'success': False, 'error': 'Could not retain the previous runtime image'}
    # Give recovery its own local tag: mutable upstream tags may change on pull.
    token = uuid.uuid4().hex
    recovery_image = f'serverkit-wp-runtime:recovery-{token}'
    retained = DockerService.run(['tag', old_image, recovery_image])
    if not retained.get('success'):
        return {'success': False, 'error': retained.get('error') or 'Could not retain recovery image'}
    image = f'serverkit-wp-runtime:php{version}-{token}'
    with tempfile.TemporaryDirectory(prefix='serverkit-php-') as context:
        Path(context, 'Dockerfile').write_text(runtime_dockerfile(version), encoding='utf-8')
        built = DockerService.run(['build', '--pull', '-t', image, context], timeout=900)
    if not built.get('success'):
        return {'success': False, 'error': built.get('error') or 'Patched PHP image build failed; site unchanged'}
    backup = compose.with_name(f'docker-compose.pre-php-{token}.yml')
    backup.write_text(original, encoding='utf-8')
    if os.name != 'nt':
        os.chmod(backup, 0o600)
    wp['image'] = image
    wp.pop('build', None)
    # A registry pull policy cannot apply to this locally built, verified image.
    wp.pop('pull_policy', None)
    _replace(compose, yaml.safe_dump(config, sort_keys=False))
    try:
        result = _up(path)
        if not result.get('success'):
            raise RuntimeError(result.get('error') or 'WordPress container replacement failed')
        if not service._wait_for_wp_ready(path):
            raise RuntimeError('WordPress did not become ready after the PHP update')
        live = service.get_php_info(path).get('php_version', '')
        parsed = re.fullmatch(r'(\d+)\.(\d+)\.(\d+)', live)
        if (not parsed or '.'.join(parsed.groups()[:2]) != version
                or tuple(map(int, parsed.groups())) < tuple(map(int, MINIMUM_PHP[version].split('.')))):
            raise RuntimeError(f'PHP verification failed: expected >= {MINIMUM_PHP[version]}, received {live or "unknown"}')
        modules = service.wp_cli(path, ['eval',
            'echo json_encode([extension_loaded("pdo"), extension_loaded("pdo_mysql")]);'])
        if not modules.get('success') or json.loads(modules.get('output') or 'null') != [True, True]:
            raise RuntimeError('PDO/MySQL driver verification failed')
        # Check Apache, not just the CLI process. Do not follow redirects to an
        # external domain; a working canonical-URL redirect is a valid response.
        probe = DockerService.run_compose(base + ['exec', '-T', 'wordpress',
            'curl', '-sS', '--max-time', '20', '-o', '/dev/null', '-w', '%{http_code}',
            'http://127.0.0.1/'], cwd=path)
        if not probe.get('success') or not re.fullmatch(r'[23]\d\d', (probe.get('output') or '').strip()):
            raise RuntimeError('WordPress HTTP health check failed')
        return {'success': True, 'message': f'Updated and verified PHP {live} with PDO MySQL',
                'php_version': live, 'image_tag': image, 'compose_backup': str(backup)}
    except Exception as exc:
        # Recover availability using the exact old image, never a newly pulled tag.
        recovery = yaml.safe_load(original)
        recovery['services']['wordpress']['image'] = recovery_image
        recovery['services']['wordpress'].pop('build', None)
        recovery['services']['wordpress'].pop('pull_policy', None)
        _replace(compose, yaml.safe_dump(recovery, sort_keys=False))
        restored = _up(path)
        return {'success': False, 'error': str(exc), 'rollback_succeeded': restored.get('success', False),
                'compose_backup': str(backup),
                'warning': 'PHP security update was NOT applied. Previous runtime may remain vulnerable.'}
