"""WordPress promotion runs as a deployment (kind ``wordpress.promote``).

Promotion used to run in the request thread: no console, no log stream, no
retry, and a page that could only show a progress bar it had to keep alive
itself. It is now a registered deployment kind, so it gets all of that from the
platform — while the PromotionJob rows stay exactly where they were, because
they carry ``pre_promotion_snapshot_id``, the pointer a rollback needs.
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

import pytest

from app import db
from app.models.application import Application
from app.models.deployment_job import DeploymentJob, DeploymentJobLog
from app.models.promotion_job import PromotionJob
from app.models.wordpress_site import WordPressSite
from app.services import deploy_kind_registry, wordpress_bridge
from app.services.deployment_job_service import DeploymentJobService
from app.services.environment_pipeline_service import EnvironmentPipelineService


@pytest.fixture
def pipeline_module():
    """The extension blueprint module, re-contributing its deployment kind.

    The registry is a process-wide singleton that other suites clear, and the
    module only registers on first import — so re-register explicitly rather
    than depending on which test file ran first.
    """
    module = wordpress_bridge.load('environment_pipeline')
    module.register_deploy_kinds()
    return module


@pytest.fixture
def sites(app, auth_headers):
    """A production site and a staging environment beneath it."""
    from app.models import User

    with app.app_context():
        admin = User.query.filter_by(username='testadmin').first()

        def _site(name, env_type, production_site_id=None):
            application = Application(name=name, app_type='docker', status='running',
                                      root_path=f'/srv/{name}', user_id=admin.id)
            db.session.add(application)
            db.session.commit()
            site = WordPressSite(
                application_id=application.id, db_name=f'{name}_db', db_user='wp',
                db_host='localhost', environment_type=env_type,
                is_production=(env_type == 'production'),
                production_site_id=production_site_id,
            )
            db.session.add(site)
            db.session.commit()
            return site.id

        prod_id = _site('wp-prod', 'production')
        staging_id = _site('wp-staging', 'staging', production_site_id=prod_id)
        return {'prod': prod_id, 'staging': staging_id}


def _promote(client, auth_headers, sites, promotion_type='code', config=None):
    return client.post(
        f'/api/v1/wordpress/pipelines/{sites["prod"]}/promote',
        json={
            'source_env_id': sites['staging'],
            'target_env_id': sites['prod'],
            'type': promotion_type,
            'config': config or {},
        },
        headers=auth_headers,
    )


class TestEndpoint:
    def test_promote_queues_a_deployment_and_returns_its_id(
            self, app, client, auth_headers, sites, pipeline_module, monkeypatch):
        calls = []
        monkeypatch.setattr(EnvironmentPipelineService, 'promote_code',
                            classmethod(lambda cls, *a, **kw: calls.append(kw) or {'success': True}))

        res = _promote(client, auth_headers, sites)

        assert res.status_code == 202
        body = res.get_json()
        assert body['queued'] is True
        job_id = body['job_id']

        with app.app_context():
            job = DeploymentJob.query.get(job_id)
            assert job.kind == 'wordpress.promote'
            assert job.status == 'pending'
            plan = job.get_plan()
            assert plan['source_env_id'] == sites['staging']
            assert plan['target_env_id'] == sites['prod']
            assert plan['promotion_type'] == 'code'
            # The console reads its heading from the plan, so an unknown kind
            # still gets a sentence instead of "Deployment · wordpress.promote".
            assert plan['title'] == 'Promoting code from staging to production'
            assert [s['name'] for s in plan['steps']] == pipeline_module.PROMOTION_STEPS['code']

        # The point of the change: the request no longer does the promoting.
        assert calls == []

    def test_full_promotion_plans_both_halves(
            self, app, client, auth_headers, sites, pipeline_module):
        res = _promote(client, auth_headers, sites, promotion_type='full')
        assert res.status_code == 202

        with app.app_context():
            job = DeploymentJob.query.get(res.get_json()['job_id'])
            names = [s['name'] for s in job.get_plan()['steps']]
            assert len(names) == 10
            assert names[0].startswith('Code · ')
            assert names[5].startswith('Database · ')

    def test_unknown_promotion_type_is_still_rejected(
            self, client, auth_headers, sites, pipeline_module):
        res = _promote(client, auth_headers, sites, promotion_type='everything')
        assert res.status_code == 400

    def test_a_locked_environment_is_refused_before_anything_is_queued(
            self, app, client, auth_headers, sites, pipeline_module):
        # Queueing first would send the user to a console that fails a second
        # later; the answer is knowable now.
        with app.app_context():
            site = WordPressSite.query.get(sites['prod'])
            site.is_locked = True
            site.locked_reason = 'Sync in progress'
            db.session.commit()

        res = _promote(client, auth_headers, sites)

        assert res.status_code == 400
        assert 'locked' in res.get_json()['error']
        with app.app_context():
            assert DeploymentJob.query.filter_by(kind='wordpress.promote').count() == 0


class TestHandler:
    def _run(self, client, auth_headers, sites, promotion_type='code'):
        res = _promote(client, auth_headers, sites, promotion_type=promotion_type)
        assert res.status_code == 202
        job_id = res.get_json()['job_id']
        return job_id, DeploymentJobService.run_job(job_id)

    def test_promotion_succeeds_and_walks_the_console_steps(
            self, app, client, auth_headers, sites, pipeline_module, monkeypatch):
        def fake_promote(cls, source_id, target_id, config=None, user_id=None,
                         progress_callback=None):
            for step, message in enumerate(
                    ['Locking environments...', 'Creating pre-promotion snapshot...',
                     'Syncing code files...', 'Flushing caches...', 'Complete'], start=1):
                EnvironmentPipelineService._emit_progress(progress_callback, step, 5, message)
            return {'success': True, 'message': 'Code promoted from staging to production'}

        monkeypatch.setattr(EnvironmentPipelineService, 'promote_code',
                            classmethod(fake_promote))

        job_id, result = self._run(client, auth_headers, sites)
        assert result['success'] is True

        with app.app_context():
            job = DeploymentJob.query.get(job_id)
            assert job.status == 'succeeded'
            assert job.current_step == 5
            # Timings are what the console's step strip renders its durations
            # from; they only survive because the handler and the runner share
            # one log stream.
            assert len(job.get_result()['step_timings']) == 5
            messages = [row.message for row in
                        DeploymentJobLog.query.filter_by(job_id=job_id).all()]
            assert 'Syncing code files...' in messages

    def test_full_promotion_progress_never_goes_backwards(
            self, app, client, auth_headers, sites, pipeline_module, monkeypatch):
        # promote_full runs two five-step halves and restarts its own numbering
        # at 1 for the second — the console must not rewind to step 1 halfway.
        def fake_full(cls, source_id, target_id, config=None, user_id=None,
                      progress_callback=None):
            for _half in range(2):
                for step in range(1, 6):
                    EnvironmentPipelineService._emit_progress(
                        progress_callback, step, 5, f'Step {step}')
            return {'success': True, 'message': 'Full promotion completed'}

        monkeypatch.setattr(EnvironmentPipelineService, 'promote_full',
                            classmethod(fake_full))

        job_id, result = self._run(client, auth_headers, sites, promotion_type='full')
        assert result['success'] is True

        with app.app_context():
            job = DeploymentJob.query.get(job_id)
            assert job.current_step == 10
            assert job.status == 'succeeded'

    def test_failed_promotion_fails_the_job_with_the_reason_in_the_console(
            self, app, client, auth_headers, sites, pipeline_module, monkeypatch):
        monkeypatch.setattr(
            EnvironmentPipelineService, 'promote_code',
            classmethod(lambda cls, *a, **kw: {'success': False, 'error': 'rsync refused'}))

        job_id, result = self._run(client, auth_headers, sites)
        assert result['success'] is False

        with app.app_context():
            job = DeploymentJob.query.get(job_id)
            assert job.status == 'failed'
            assert job.error_message == 'rsync refused'
            messages = [row.message for row in
                        DeploymentJobLog.query.filter_by(job_id=job_id).all()]
            assert 'rsync refused' in messages

    def test_promotion_rows_are_linked_even_when_the_promotion_fails(
            self, app, client, auth_headers, sites, pipeline_module, monkeypatch):
        # The rollback pointer lives on PromotionJob, and a failed promotion is
        # precisely when someone needs it — so the link can't come from the
        # service's success-only return value.
        def fake_promote(cls, source_id, target_id, config=None, user_id=None,
                         progress_callback=None):
            row = PromotionJob(source_site_id=source_id, target_site_id=target_id,
                               promotion_type='code', status='failed')
            db.session.add(row)
            db.session.commit()
            return {'success': False, 'error': 'died halfway'}

        monkeypatch.setattr(EnvironmentPipelineService, 'promote_code',
                            classmethod(fake_promote))

        job_id, _ = self._run(client, auth_headers, sites)

        with app.app_context():
            job = DeploymentJob.query.get(job_id)
            linked = job.get_result()['promotion_job_ids']
            assert len(linked) == 1
            assert PromotionJob.query.get(linked[0]).status == 'failed'

    def test_a_raising_promotion_still_ends_the_job(
            self, app, client, auth_headers, sites, pipeline_module, monkeypatch):
        def explode(cls, *args, **kwargs):
            raise RuntimeError('docker went away')

        monkeypatch.setattr(EnvironmentPipelineService, 'promote_code',
                            classmethod(explode))

        job_id, result = self._run(client, auth_headers, sites)
        assert result['success'] is False

        with app.app_context():
            job = DeploymentJob.query.get(job_id)
            assert job.status == 'failed'
            assert 'docker went away' in job.error_message


def test_promotion_kind_is_contributed_by_the_extension(pipeline_module):
    assert deploy_kind_registry.get('wordpress.promote') is pipeline_module.run_promotion
    # Namespaced, so it can never shadow a core deployment kind.
    assert 'wordpress.promote' in deploy_kind_registry.kinds()
