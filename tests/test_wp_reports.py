"""Tests for the WordPress monthly client reports service + API (#33 slice)."""
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
from datetime import datetime, timedelta

import pytest

from app.services import wordpress_bridge


def _mk_user(db, username='owner'):
    from app.models import User
    from werkzeug.security import generate_password_hash
    u = User(email=f'{username}@test.local', username=username,
             password_hash=generate_password_hash('x'),
             role=User.ROLE_ADMIN, is_active=True)
    db.session.add(u)
    db.session.commit()
    return u


def _mk_site(db, user_id, name='acme-prod', tags=None):
    import json
    from app.models import Application, WordPressSite
    app_row = Application(name=name, app_type='wordpress', user_id=user_id, root_path='/srv/x')
    db.session.add(app_row)
    db.session.commit()
    site = WordPressSite(application_id=app_row.id, wp_version='6.4',
                         tags=json.dumps(tags) if tags else None,
                         health_status='healthy', last_health_check=datetime.utcnow())
    db.session.add(site)
    db.session.commit()
    return app_row, site


def _current_month():
    now = datetime.utcnow()
    return now.year, now.month, now


# ---- pure helpers ---------------------------------------------------------

def test_month_bounds_normal_and_december():
    WpReportsService = wordpress_bridge.get('wp_reports_service', 'WpReportsService')
    start, end = WpReportsService._month_bounds(2026, 5)
    assert start == datetime(2026, 5, 1)
    assert end == datetime(2026, 6, 1)
    # December must roll over the year, not crash.
    start, end = WpReportsService._month_bounds(2026, 12)
    assert start == datetime(2026, 12, 1)
    assert end == datetime(2027, 1, 1)


def test_client_from_tags():
    WpReportsService = wordpress_bridge.get('wp_reports_service', 'WpReportsService')
    assert WpReportsService._client_from_tags(['retainer', 'client-acme']) == 'acme'
    assert WpReportsService._client_from_tags(['client:Globex']) == 'Globex'
    assert WpReportsService._client_from_tags(['php8', 'retainer']) is None
    assert WpReportsService._client_from_tags(None) is None


# ---- end-to-end aggregation ----------------------------------------------

def test_generate_aggregates_bound_site(app):
    import json
    from app import db
    WpReportsService = wordpress_bridge.get('wp_reports_service', 'WpReportsService')
    from app.models.status_page import StatusPage, StatusComponent, HealthCheck
    from app.models.wordpress_site import WordPressUpdateRun, DatabaseSnapshot, WordPressVulnerability

    user = _mk_user(db)
    _, site = _mk_site(db, user.id, tags=['client-acme', 'retainer'])
    year, month, now = _current_month()

    # Bound status-page component + 10 health checks (8 up, 1 degraded, 1 down) -> 80% uptime.
    page = StatusPage(name='Status', slug='status')
    db.session.add(page)
    db.session.commit()
    comp = StatusComponent(page_id=page.id, name='acme', wordpress_site_id=site.id, uptime_30d=88.5)
    db.session.add(comp)
    db.session.commit()
    statuses = ['up'] * 8 + ['degraded', 'down']
    for s in statuses:
        db.session.add(HealthCheck(component_id=comp.id, status=s, checked_at=now))
    # Update runs in-month: 1 completed (2 comps), 1 rolled_back (1 comp), 1 failed.
    db.session.add(WordPressUpdateRun(site_id=site.id, status='completed', trigger='manual',
                                      started_at=now, details=json.dumps({'updated': [{'type': 'plugin', 'slug': 'a', 'from': '1', 'to': '2'}, {'type': 'theme', 'slug': 'b', 'from': '1', 'to': '2'}]})))
    db.session.add(WordPressUpdateRun(site_id=site.id, status='rolled_back', trigger='scheduled',
                                      started_at=now, details=json.dumps({'updated': [{'type': 'plugin', 'slug': 'c', 'from': '1', 'to': '2'}], 'rolled_back': True})))
    db.session.add(WordPressUpdateRun(site_id=site.id, status='failed', trigger='manual',
                                      started_at=now, details=None, error='boom'))
    # Backups in-month.
    db.session.add(DatabaseSnapshot(site_id=site.id, name='snap1', file_path='/x/1.sql', size_bytes=100, tag='pre-deploy', created_at=now))
    db.session.add(DatabaseSnapshot(site_id=site.id, name='snap2', file_path='/x/2.sql', size_bytes=200, created_at=now))
    # Current vuln posture.
    db.session.add(WordPressVulnerability(site_id=site.id, source='plugin', slug='a', name='Plugin A', severity='high'))
    db.session.add(WordPressVulnerability(site_id=site.id, source='core', slug='', name='WP', severity='medium'))
    site.last_vuln_scan_at = now
    db.session.commit()

    res = WpReportsService.generate(site, year=year, month=month)
    assert res['success'] is True
    data = res['report']['data']

    assert data['site']['client'] == 'acme'
    assert data['uptime']['bound'] is True
    assert data['uptime']['samples'] == 10
    assert data['uptime']['percent'] == 80.0
    assert data['uptime']['rolling_30d'] == 88.5

    u = data['updates']
    assert u['total_runs'] == 3
    assert u['completed'] == 1 and u['rolled_back'] == 1 and u['failed'] == 1
    assert u['components_updated'] == 3

    assert data['backups']['count'] == 2
    assert data['backups']['total_bytes'] == 300

    assert data['vulnerabilities']['total'] == 2
    assert data['vulnerabilities']['by_severity']['high'] == 1
    assert data['vulnerabilities']['by_severity']['medium'] == 1
    assert data['vulnerabilities']['as_of'] is not None

    # A daily series spanning the month, with at least one populated day.
    assert any(d['samples'] > 0 for d in data['uptime_daily'])


def test_generate_unbound_site_has_no_uptime_history(app):
    from app import db
    WpReportsService = wordpress_bridge.get('wp_reports_service', 'WpReportsService')

    user = _mk_user(db, 'owner2')
    _, site = _mk_site(db, user.id, name='nobound')
    year, month, _ = _current_month()

    res = WpReportsService.generate(site, year=year, month=month)
    assert res['success'] is True
    data = res['report']['data']
    assert data['uptime']['bound'] is False
    assert data['uptime']['percent'] is None
    # The "attach to a status page" note must be present so the gap is explained.
    assert any('Uptime history is unavailable' in n for n in data['notes'])


def test_generate_is_upsert(app):
    from app import db
    WpReportsService = wordpress_bridge.get('wp_reports_service', 'WpReportsService')
    from app.models.wordpress_site import WordPressReport

    user = _mk_user(db, 'owner3')
    _, site = _mk_site(db, user.id, name='upsert')
    year, month, _ = _current_month()

    WpReportsService.generate(site, year=year, month=month)
    WpReportsService.generate(site, year=year, month=month)
    rows = WordPressReport.query.filter_by(site_id=site.id).all()
    assert len(rows) == 1  # regenerating the same month replaces, not duplicates


def test_generate_rejects_future_month(app):
    from app import db
    WpReportsService = wordpress_bridge.get('wp_reports_service', 'WpReportsService')

    user = _mk_user(db, 'owner4')
    _, site = _mk_site(db, user.id, name='future')
    now = datetime.utcnow()
    res = WpReportsService.generate(site, year=now.year + 1, month=1)
    assert res['success'] is False
    assert 'future' in res['error'].lower()


def test_daily_series_never_emits_a_future_day(app):
    """Regression: the to-date daily series must stop at today, not tomorrow."""
    from app import db
    WpReportsService = wordpress_bridge.get('wp_reports_service', 'WpReportsService')
    from app.models.status_page import StatusPage, StatusComponent

    user = _mk_user(db, 'owner5')
    _, site = _mk_site(db, user.id, name='daily')
    page = StatusPage(name='S', slug='s-daily')
    db.session.add(page)
    db.session.commit()
    db.session.add(StatusComponent(page_id=page.id, name='c', wordpress_site_id=site.id))
    db.session.commit()

    year, month, now = _current_month()
    res = WpReportsService.generate(site, year=year, month=month)
    daily = res['report']['data']['uptime_daily']
    assert daily, 'a bound site should produce a daily series'
    today = now.date().isoformat()
    assert all(d['date'] <= today for d in daily)
    assert daily[-1]['date'] == today  # today is included as a partial day


def test_ongoing_incident_duration_is_clamped_to_the_month(app):
    """Regression: a still-open incident in a PAST-month report must not bleed
    its full elapsed time (up to now) into that month's attributed duration."""
    from datetime import datetime, timedelta
    from app import db
    WpReportsService = wordpress_bridge.get('wp_reports_service', 'WpReportsService')
    from app.models.status_page import StatusPage, StatusComponent, StatusIncident

    now = datetime.utcnow()
    first_this = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    prev_start = (first_this - timedelta(days=1)).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    prev_end = first_this

    user = _mk_user(db, 'owner6')
    _, site = _mk_site(db, user.id, name='inc')
    page = StatusPage(name='S', slug='s-inc')
    db.session.add(page)
    db.session.commit()
    comp = StatusComponent(page_id=page.id, name='c', wordpress_site_id=site.id)
    db.session.add(comp)
    db.session.commit()
    # An incident opened early in the previous month and never resolved.
    created = prev_start + timedelta(days=1)
    db.session.add(StatusIncident(page_id=page.id, component_id=comp.id, title='down',
                                  impact='major', created_at=created, resolved_at=None))
    db.session.commit()

    res = WpReportsService.generate(site, year=prev_start.year, month=prev_start.month)
    incidents = res['report']['data']['incidents']
    assert len(incidents) == 1
    inc = incidents[0]
    assert inc['ongoing'] is True
    # Duration is capped at the month boundary, NOT (now - created).
    in_month_cap = int((prev_end - created).total_seconds() // 60)
    full_elapsed = int((now - created).total_seconds() // 60)
    assert inc['duration_minutes'] <= in_month_cap
    assert inc['duration_minutes'] < full_elapsed


# ---- API route ------------------------------------------------------------

def test_reports_api_roundtrip(app, client, auth_headers):
    from app import db
    from app.models import User

    admin = User.query.filter_by(username='testadmin').first()
    _, site = _mk_site(db, admin.id, name='api-site')
    year, month, _ = _current_month()

    # Empty before generation.
    r = client.get(f'/api/v1/wordpress/sites/{site.id}/reports', headers=auth_headers)
    assert r.status_code == 200
    assert r.get_json()['reports'] == []

    # Generate the current month.
    r = client.post(f'/api/v1/wordpress/sites/{site.id}/reports/generate',
                    json={'year': year, 'month': month}, headers=auth_headers)
    assert r.status_code == 200
    body = r.get_json()
    assert body['success'] is True
    report_id = body['report']['id']

    # Now listed.
    r = client.get(f'/api/v1/wordpress/sites/{site.id}/reports', headers=auth_headers)
    assert len(r.get_json()['reports']) == 1

    # Delete it.
    r = client.delete(f'/api/v1/wordpress/sites/{site.id}/reports/{report_id}', headers=auth_headers)
    assert r.status_code == 200
    r = client.get(f'/api/v1/wordpress/sites/{site.id}/reports', headers=auth_headers)
    assert r.get_json()['reports'] == []
