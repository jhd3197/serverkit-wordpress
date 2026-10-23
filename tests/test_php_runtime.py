"""Runtime update failure boundaries; uses the panel's Python environment."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml

spec = importlib.util.spec_from_file_location(
    'php_runtime', Path(__file__).resolve().parents[1] / 'backend/php_runtime.py')
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


@pytest.fixture
def site(tmp_path, monkeypatch):
    config = {'services': {'wordpress': {'image': 'wordpress:6.4-php8.3-apache',
              'volumes': ['html:/var/www/html'], 'environment': {'KEEP': 'yes'}},
              'db': {'image': 'mysql:8.0'}}, 'volumes': {'html': None}}
    compose = tmp_path / 'docker-compose.yml'
    compose.write_text(yaml.safe_dump(config))
    calls = []
    def run(args, **kwargs):
        calls.append(args)
        output = 'sha256:' + 'a' * 64 if args[0] == 'inspect' else ''
        return {'success': True, 'output': output}
    def run_compose(args, **kwargs):
        calls.append(args)
        output = 'b' * 64 if 'ps' in args else '200' if 'exec' in args else ''
        return {'success': True, 'output': output}
    monkeypatch.setattr(runtime.DockerService, 'run', run)
    monkeypatch.setattr(runtime.DockerService, 'run_compose', run_compose)
    monkeypatch.setattr(runtime.DockerService, '_compose_cmd_with_overlay', lambda p: ['docker', 'compose'])
    service = SimpleNamespace(_wait_for_wp_ready=lambda p: True,
        get_php_info=lambda p: {'php_version': '8.3.36'},
        wp_cli=lambda *a: {'success': True, 'output': '[true,true]'})
    return tmp_path, compose, config, calls, service


def test_same_branch_update_builds_first_and_preserves_data(site):
    path, compose, original, calls, service = site
    result = runtime.repair_runtime(service, str(path), '8.3')
    assert result['success'], result
    config = yaml.safe_load(compose.read_text())
    assert config['services']['db'] == original['services']['db']
    assert config['services']['wordpress']['volumes'] == ['html:/var/www/html']
    assert config['services']['wordpress']['environment'] == {'KEEP': 'yes'}
    build = next(i for i, c in enumerate(calls) if c[0] == 'build')
    up = next(i for i, c in enumerate(calls) if 'up' in c)
    assert build < up
    assert '--pull' in calls[build]
    assert calls[up][-5:] == ['up', '-d', '--no-deps', '--force-recreate', 'wordpress']
    assert yaml.safe_load(Path(result['compose_backup']).read_text()) == original


def test_build_failure_never_replaces_container(site, monkeypatch):
    path, compose, original, calls, service = site
    run = runtime.DockerService.run
    monkeypatch.setattr(runtime.DockerService, 'run', lambda args, **kw:
        {'success': False, 'error': 'registry unavailable'} if args[0] == 'build' else run(args, **kw))
    result = runtime.repair_runtime(service, str(path), '8.3')
    assert not result['success']
    assert yaml.safe_load(compose.read_text()) == original
    assert not any('up' in c for c in calls)


@pytest.mark.parametrize('failure', ['old_php', 'unknown_php', 'pdo', 'readiness', 'http'])
def test_failed_verification_recovers_exact_previous_image(site, monkeypatch, failure):
    path, compose, original, calls, service = site
    if failure in ('old_php', 'unknown_php'):
        service.get_php_info = lambda p: {'php_version': '8.3.4' if failure == 'old_php' else ''}
    elif failure == 'pdo':
        service.wp_cli = lambda *a: {'success': True, 'output': '[true,false]'}
    elif failure == 'readiness':
        service._wait_for_wp_ready = lambda p: False
    else:
        run = runtime.DockerService.run_compose
        monkeypatch.setattr(runtime.DockerService, 'run_compose', lambda args, **kw:
            {'success': True, 'output': '500'} if 'exec' in args else run(args, **kw))
    result = runtime.repair_runtime(service, str(path), '8.3')
    assert result['success'] is False and result['rollback_succeeded'] is True
    config = yaml.safe_load(compose.read_text())
    assert config['services']['wordpress']['image'].startswith('serverkit-wp-runtime:recovery-')
    assert config['services']['db'] == original['services']['db']
    assert 'NOT applied' in result['warning']


def test_unsupported_version_cannot_run_docker(site):
    path, _, _, calls, service = site
    assert not runtime.repair_runtime(service, str(path), '8.1')['success']
    assert calls == []


def test_missing_html_volume_rejected(site):
    path, compose, config, calls, service = site
    config['services']['wordpress']['volumes'] = ['logs:/var/log']
    compose.write_text(yaml.safe_dump(config))
    assert not runtime.repair_runtime(service, str(path), '8.3')['success']
    assert calls == []
