"""Safe WordPress update manager (#29).

Runs updates with a safety net, all via the Docker-aware WP-CLI bridge:
  1. record the current core/plugin/theme versions
  2. snapshot the DB (wp db export to a container-local /tmp path)
  3. apply the requested updates (honouring an exclusion list)
  4. health-check the site (EnvironmentHealthService)
  5. if the update broke a previously-healthy site, AUTO-ROLLBACK: version-pin
     each updated component back (wp <type> update --version=<old> --force) and
     re-import the DB snapshot, then re-check health
  6. persist a WordPressUpdateRun record (the report)

The run executes in a background thread (updates are slow) so the single worker
never blocks; the UI polls get_runs() for status.

Deferred: staging-first promotion (update a staging env via the promote pipeline,
validate, then promote to production) — needs a staging env + the full env
pipeline orchestration; revisit on top of #15/#18.
"""

import json
import logging
import threading
from datetime import datetime, timedelta

logger = logging.getLogger(__name__)


class WpUpdateService:
    STALE_RUN_MINUTES = 30   # a 'running' row older than this is treated as crashed
    DB_TIMEOUT = 600         # generous wall-clock for db export/import (never truncate a restore)
    MAX_CONCURRENT = 2       # bound simultaneous heavy updates (scheduler stampede protection)
    _run_semaphore = threading.Semaphore(MAX_CONCURRENT)

    # ---------- public API ----------

    @classmethod
    def get_runs(cls, site, limit=20):
        from app.models.wordpress_site import WordPressUpdateRun
        rows = (WordPressUpdateRun.query.filter_by(site_id=site.id)
                .order_by(WordPressUpdateRun.started_at.desc()).limit(limit).all())
        running = any(r.status == 'running' and not cls._is_stale(r) for r in rows)
        return {'success': True, 'runs': [r.to_dict() for r in rows], 'running': running}

    @classmethod
    def start_update(cls, site, targets=None, exclude=None, trigger='manual'):
        from flask import current_app
        from app import db
        from app.models.wordpress_site import WordPressUpdateRun
        existing = (WordPressUpdateRun.query.filter_by(site_id=site.id, status='running')
                    .order_by(WordPressUpdateRun.started_at.desc()).first())
        if existing and not cls._is_stale(existing):
            return {'success': True, 'status': 'running', 'run_id': existing.id}

        targets = targets or {'core': True, 'plugins': True, 'themes': True}
        exclude = exclude or []
        run = WordPressUpdateRun(
            site_id=site.id, status='running', trigger=trigger,
            details=json.dumps({'targets': targets, 'excluded': exclude}),
        )
        db.session.add(run)
        db.session.commit()
        run_id = run.id
        app = current_app._get_current_object()
        path = site.application.root_path if site.application else None
        threading.Thread(
            target=cls._run, args=(app, site.id, run_id, path, targets, exclude),
            daemon=True, name=f'wp-update-{site.id}'
        ).start()
        return {'success': True, 'status': 'running', 'run_id': run_id}

    @staticmethod
    def _is_stale(run):
        if not run.started_at:
            return False
        return (datetime.utcnow() - run.started_at) > timedelta(minutes=WpUpdateService.STALE_RUN_MINUTES)

    # ---------- worker ----------

    @classmethod
    def _run(cls, app, site_id, run_id, path, targets, exclude):
        with app.app_context():
            from app import db
            from app.models.wordpress_site import WordPressSite, WordPressUpdateRun
            from .wordpress_service import WordPressService
            run = WordPressUpdateRun.query.get(run_id)
            details = json.loads(run.details) if run and run.details else {}
            snapshot = f'/tmp/wp-preupdate-{run_id}.sql'
            keep_snapshot = False
            # Bound concurrency so a shared 3am cron doesn't stampede the host.
            with cls._run_semaphore:
                try:
                    if not path:
                        raise RuntimeError('Site has no root path')
                    site = WordPressSite.query.get(site_id)
                    port = site.application.port if site and site.application else None

                    health_before = cls._site_status(path, port)
                    pre = cls._versions(path)

                    # "Safe" requires a DB net — abort BEFORE touching anything if the
                    # snapshot can't be taken (large DBs use a generous timeout).
                    export = WordPressService.wp_cli(path, ['db', 'export', snapshot], timeout=cls.DB_TIMEOUT)
                    if not export.get('success'):
                        raise RuntimeError('Could not snapshot the database; aborting to stay safe. '
                                           + (export.get('error') or ''))

                    cls._apply_updates(path, targets, exclude)

                    post = cls._versions(path)
                    updated = cls._diff(pre, post)
                    health_after = cls._site_status(path, port)

                    # Roll back if the update regressed a previously-healthy site
                    # (degraded counts: a 5xx after an update is a regression).
                    rolled_back = False
                    if health_before == 'healthy' and health_after in ('unhealthy', 'degraded') and updated:
                        cls._rollback(path, updated, snapshot)
                        rolled_back = True
                        health_after = cls._site_status(path, port)

                    warning = None
                    if health_before != 'healthy':
                        warning = 'Baseline health could not be confirmed healthy, so auto-rollback was not attempted.'
                        keep_snapshot = True
                    if health_after != 'healthy':
                        warning = ((warning + ' ') if warning else '') + \
                            'Site is not healthy after the update; the pre-update DB snapshot was kept for manual restore.'
                        keep_snapshot = True

                    details.update({
                        'updated': updated,
                        'health_before': health_before,
                        'health_after': health_after,
                        'rolled_back': rolled_back,
                        'warning': warning,
                    })
                    run.status = 'rolled_back' if rolled_back else 'completed'
                    run.details = json.dumps(details)
                    run.finished_at = datetime.utcnow()
                    db.session.commit()
                    try:
                        from app.services.event_service import EventService
                        evt = 'wordpress.update_rolled_back' if rolled_back else 'wordpress.updated'
                        EventService.emit_wp(evt, site, updated=updated, health_after=health_after)
                    except Exception:
                        pass
                except Exception as e:
                    logger.error(f'Safe update failed for site {site_id}: {e}')
                    keep_snapshot = True  # leave the snapshot for recovery
                    try:
                        if run is not None:
                            run.status = 'failed'
                            run.error = str(e)
                            run.details = json.dumps(details)
                            run.finished_at = datetime.utcnow()
                            db.session.commit()
                    except Exception:
                        db.session.rollback()
                finally:
                    # Only drop the snapshot when the site ended verified-healthy.
                    if path and not keep_snapshot:
                        try:
                            WordPressService.wp_cli(path, ['eval', f"@unlink('{snapshot}');"])
                        except Exception:
                            pass

    # ---------- steps ----------

    @staticmethod
    def _versions(path):
        from .wordpress_service import WordPressService
        core = WordPressService.wp_cli(path, ['core', 'version'])
        return {
            'core': (core.get('output') or '').strip() if core.get('success') else None,
            'plugins': {p.get('name'): p.get('version')
                        for p in (WordPressService.get_plugins(path) or []) if p.get('name')},
            'themes': {t.get('name'): t.get('version')
                       for t in (WordPressService.get_themes(path) or []) if t.get('name')},
        }

    @staticmethod
    def _site_status(path, port):
        """A quiet, SIDE-EFFECT-FREE liveness check (does NOT write health_status
        or fire #27 transition alerts, unlike EnvironmentHealthService.check_health
        — so an auto-rollback never pages on-call with spurious down/up). `wp eval`
        loads WP incl. plugins so a PHP fatal is caught; the HTTP probe catches a
        5xx/connection regression. Returns healthy | degraded | unhealthy | unknown."""
        from .wordpress_service import WordPressService
        from app.services.environment_health_service import EnvironmentHealthService
        wp_ok = WordPressService.wp_cli(path, ['eval', "echo 'OK';"]).get('success', False)
        http_status = 'unknown'
        if port:
            http_status = (EnvironmentHealthService._check_wordpress_http(port) or {}).get('status', 'unknown')
        if not wp_ok or http_status == 'unhealthy':
            return 'unhealthy'
        if http_status == 'degraded':
            return 'degraded'
        if wp_ok and http_status in ('healthy', 'unknown'):
            return 'healthy'
        return 'unknown'

    @classmethod
    def _apply_updates(cls, path, targets, exclude):
        from .wordpress_service import WordPressService
        ex = set(exclude or [])
        if targets.get('core'):
            WordPressService.update_wordpress(path)
        if targets.get('plugins'):
            avail = [p.get('name') for p in (WordPressService.get_plugins(path) or [])
                     if p.get('update') == 'available' and p.get('name') and p.get('name') not in ex]
            if avail:
                WordPressService.update_plugins(path, plugins=avail)
        if targets.get('themes'):
            avail = [t.get('name') for t in (WordPressService.get_themes(path) or [])
                     if t.get('update') == 'available' and t.get('name') and t.get('name') not in ex]
            if avail:
                WordPressService.update_themes(path, themes=avail)

    @staticmethod
    def _diff(pre, post):
        updated = []
        if pre.get('core') and post.get('core') and pre['core'] != post['core']:
            updated.append({'type': 'core', 'slug': 'wordpress', 'from': pre['core'], 'to': post['core']})
        for kind in ('plugins', 'themes'):
            for slug, newv in (post.get(kind) or {}).items():
                oldv = (pre.get(kind) or {}).get(slug)
                if oldv and newv and oldv != newv:
                    updated.append({'type': kind[:-1], 'slug': slug, 'from': oldv, 'to': newv})
        return updated

    @classmethod
    def _rollback(cls, path, updated, snapshot):
        """Version-pin each updated component back to its pre-update version, then
        re-import the DB snapshot. --skip-plugins/--skip-themes so the downgrade
        runs even if a bad update left the site fatally broken (a loaded plugin
        would otherwise crash wp-cli). Best-effort (a component not on
        wordpress.org can't be version-downgraded; the DB snapshot is the net)."""
        from .wordpress_service import WordPressService
        skip = ['--skip-plugins', '--skip-themes']
        for u in updated:
            t, slug, old = u.get('type'), u.get('slug'), u.get('from')
            if t == 'core':
                WordPressService.wp_cli(path, ['core', 'update', f'--version={old}', '--force'] + skip)
                WordPressService.wp_cli(path, ['core', 'update-db'] + skip)
            elif t == 'plugin':
                WordPressService.wp_cli(path, ['plugin', 'update', slug, f'--version={old}', '--force'] + skip)
            elif t == 'theme':
                WordPressService.wp_cli(path, ['theme', 'update', slug, f'--version={old}', '--force'] + skip)
        if snapshot:
            WordPressService.wp_cli(path, ['db', 'import', snapshot] + skip, timeout=cls.DB_TIMEOUT)
