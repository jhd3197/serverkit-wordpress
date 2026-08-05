"""Monthly client reports for managed WordPress sites (#33 — agency-scale slice).

Aggregates the per-site signals that already accrue elsewhere in the panel into
a single, client-presentable monthly report and persists it (see the docstring
on the WordPressReport model for *why* it's persisted rather than computed live).

Data-source honesty (this is the whole point of the feature):
  * Uptime % + incidents (#26)  -> TRUE month history, re-aggregated from the
    retained HealthCheck samples (90-day retention) for the exact month.
  * Update runs (#29)           -> TRUE month history (WordPressUpdateRun rows).
  * Database snapshots/backups   -> TRUE month history (DatabaseSnapshot rows).
  * Vulnerabilities (#28)        -> CURRENT posture only (findings are
    deleted-and-replaced each scan), captured as-of generation time.
  * Health / disk                -> CURRENT values, captured as-of generation.
  * Traffic (#25) / on-demand security scans (#30) -> point-in-time, omitted
    from monthly history (and a note says so).

Generation is synchronous: it is pure DB aggregation (no WP-CLI, no external
HTTP), so unlike the scan/update services it needs no background thread.
"""

import calendar
import json
from datetime import datetime, timedelta


class WpReportsService:
    """Build + persist + fetch monthly client reports for a WordPress site."""

    # ---- public API -------------------------------------------------------

    @classmethod
    def get_reports(cls, site):
        """Return all persisted reports for a site, newest month first."""
        from app.models.wordpress_site import WordPressReport
        rows = (WordPressReport.query
                .filter_by(site_id=site.id)
                .order_by(WordPressReport.period_start.desc())
                .all())
        return {'success': True, 'reports': [r.to_dict() for r in rows]}

    @classmethod
    def generate(cls, site, year=None, month=None):
        """Compute + upsert the report for one calendar month (default: the
        current UTC month). Regenerating the same month replaces its row so the
        latest posture is captured. Returns {'success', 'report'} or an error."""
        from app import db
        from app.models.wordpress_site import WordPressReport

        now = datetime.utcnow()
        year = int(year) if year else now.year
        month = int(month) if month else now.month
        if month < 1 or month > 12:
            return {'success': False, 'error': 'Invalid month'}
        # Guard against generating a report for a future month (no data exists).
        if (year, month) > (now.year, now.month):
            return {'success': False, 'error': 'Cannot generate a report for a future month'}

        start, end = cls._month_bounds(year, month)
        label = f'{year:04d}-{month:02d}'
        data = cls._build(site, start, end, label)

        row = WordPressReport.query.filter_by(site_id=site.id, period_label=label).first()
        if row is None:
            row = WordPressReport(site_id=site.id, period_label=label,
                                  period_start=start, period_end=end)
            db.session.add(row)
        row.period_start = start
        row.period_end = end
        row.data = json.dumps(data)
        row.generated_at = now
        db.session.commit()
        return {'success': True, 'report': row.to_dict()}

    @classmethod
    def delete(cls, site, report_id):
        """Delete one persisted report belonging to this site."""
        from app import db
        from app.models.wordpress_site import WordPressReport
        row = WordPressReport.query.filter_by(id=report_id, site_id=site.id).first()
        if row is None:
            return {'success': False, 'error': 'Report not found'}
        db.session.delete(row)
        db.session.commit()
        return {'success': True}

    # ---- report builder ---------------------------------------------------

    @classmethod
    def _build(cls, site, start, end, label):
        now = datetime.utcnow()
        tags = []
        try:
            tags = json.loads(site.tags) if site.tags else []
        except (ValueError, TypeError):
            tags = []

        uptime, daily, incidents = cls._uptime_and_incidents(site, start, end, now)
        report = {
            'period': {
                'label': label,
                'start': start.isoformat(),
                'end': end.isoformat(),
                'month_name': f'{calendar.month_name[start.month]} {start.year}',
            },
            'generated_at': now.isoformat(),
            'site': {
                'id': site.id,
                'name': site.application.name if site.application else f'site-{site.id}',
                'url': cls._site_url(site),
                'wp_version': site.wp_version,
                'multisite': bool(site.multisite),
                'tags': tags,
                'client': cls._client_from_tags(tags),
            },
            'uptime': uptime,
            'uptime_daily': daily,
            'incidents': incidents,
            'incident_count': len(incidents),
            'updates': cls._updates(site, start, end),
            'backups': cls._backups(site, start, end),
            'vulnerabilities': cls._vuln_posture(site),
            'health': cls._health(site),
            'notes': cls._notes(uptime),
        }
        return report

    # ---- sections ---------------------------------------------------------

    @classmethod
    def _uptime_and_incidents(cls, site, start, end, now):
        """Re-aggregate the month's uptime % + a daily series + the incidents that
        overlapped the month, from the bound status-page component's samples (#26).
        Returns (uptime_dict, daily_list, incidents_list)."""
        from app.models.status_page import StatusComponent, HealthCheck, StatusIncident
        from sqlalchemy import or_

        comp = StatusComponent.query.filter_by(wordpress_site_id=site.id).first()
        if comp is None:
            return ({'bound': False, 'percent': None, 'samples': 0,
                     'checks_up': 0, 'checks_down': 0, 'checks_degraded': 0,
                     'rolling_30d': None}, [], [])

        checks = (HealthCheck.query
                  .filter(HealthCheck.component_id == comp.id,
                          HealthCheck.checked_at >= start,
                          HealthCheck.checked_at < end)
                  .all())
        total = len(checks)
        up = sum(1 for c in checks if c.status == 'up')
        down = sum(1 for c in checks if c.status == 'down')
        degraded = sum(1 for c in checks if c.status == 'degraded')
        uptime = {
            'bound': True,
            'percent': round(up / total * 100, 2) if total else None,
            'samples': total,
            'checks_up': up,
            'checks_down': down,
            'checks_degraded': degraded,
            'rolling_30d': comp.uptime_30d,
        }

        # Daily uptime series — only the up/total ratio per calendar day. Uses the
        # same "only 'up' counts" rule as recompute_uptime, so degraded reduces it.
        buckets = {}
        for c in checks:
            key = c.checked_at.date().isoformat()
            b = buckets.setdefault(key, {'up': 0, 'total': 0})
            b['total'] += 1
            if c.status == 'up':
                b['up'] += 1
        daily = []
        day = start
        # Stop at the end of *today* (today is included as a partial day) and never
        # emit a future day. Truncate `now` to its date first — otherwise its
        # time-of-day pushes the bound past tomorrow's midnight for a to-date month.
        today_end = datetime(now.year, now.month, now.day) + timedelta(days=1)
        last = min(end, today_end)
        while day < last:
            key = day.date().isoformat()
            b = buckets.get(key)
            daily.append({
                'date': key,
                'percent': round(b['up'] / b['total'] * 100, 2) if b and b['total'] else None,
                'samples': b['total'] if b else 0,
            })
            day += timedelta(days=1)

        incident_rows = (StatusIncident.query
                         .filter(StatusIncident.component_id == comp.id,
                                 StatusIncident.created_at < end,
                                 or_(StatusIncident.resolved_at.is_(None),
                                     StatusIncident.resolved_at >= start))
                         .order_by(StatusIncident.created_at.desc())
                         .all())
        incidents = []
        for inc in incident_rows:
            resolved = inc.resolved_at
            # Attribute only the in-month portion of the incident to this report:
            # clamp the window to [start, min(end, now)] so a still-open or
            # cross-month incident doesn't bleed its full elapsed time into the
            # month it's reported under. created_at/resolved_at below stay raw.
            if inc.created_at:
                ref_start = max(inc.created_at, start)
                ref_end = min(resolved or now, end, now)
                minutes = max(0, int((ref_end - ref_start).total_seconds() // 60))
            else:
                minutes = 0
            incidents.append({
                'id': inc.id,
                'title': inc.title,
                'impact': inc.impact,
                'status': inc.status,
                'ongoing': resolved is None,
                'created_at': inc.created_at.isoformat() if inc.created_at else None,
                'resolved_at': resolved.isoformat() if resolved else None,
                'duration_minutes': minutes,
            })
        return uptime, daily, incidents

    @classmethod
    def _updates(cls, site, start, end):
        from app.models.wordpress_site import WordPressUpdateRun
        runs = (WordPressUpdateRun.query
                .filter(WordPressUpdateRun.site_id == site.id,
                        WordPressUpdateRun.started_at >= start,
                        WordPressUpdateRun.started_at < end)
                .order_by(WordPressUpdateRun.started_at.desc())
                .all())
        out = {'total_runs': len(runs), 'completed': 0, 'rolled_back': 0,
               'failed': 0, 'components_updated': 0, 'runs': []}
        for r in runs:
            if r.status in out:
                out[r.status] += 1
            try:
                details = json.loads(r.details) if r.details else {}
            except (ValueError, TypeError):
                details = {}
            updated = details.get('updated') or []
            out['components_updated'] += len(updated)
            out['runs'].append({
                'id': r.id,
                'status': r.status,
                'trigger': r.trigger,
                'started_at': r.started_at.isoformat() if r.started_at else None,
                'finished_at': r.finished_at.isoformat() if r.finished_at else None,
                'updated': updated,
                'rolled_back': bool(details.get('rolled_back')),
                'error': r.error,
            })
        return out

    @classmethod
    def _backups(cls, site, start, end):
        from app.models.wordpress_site import DatabaseSnapshot
        snaps = (DatabaseSnapshot.query
                 .filter(DatabaseSnapshot.site_id == site.id,
                         DatabaseSnapshot.created_at >= start,
                         DatabaseSnapshot.created_at < end)
                 .order_by(DatabaseSnapshot.created_at.desc())
                 .all())
        total_bytes = sum((s.size_bytes or 0) for s in snaps)
        return {
            'count': len(snaps),
            'total_bytes': total_bytes,
            'total_bytes_human': DatabaseSnapshot._format_size(total_bytes),
            'snapshots': [{
                'id': s.id,
                'name': s.name,
                'tag': s.tag,
                'status': s.status,
                'size_bytes': s.size_bytes,
                'size_human': DatabaseSnapshot._format_size(s.size_bytes),
                'created_at': s.created_at.isoformat() if s.created_at else None,
            } for s in snaps],
        }

    @classmethod
    def _vuln_posture(cls, site):
        """Current open-vulnerability posture as-of the last scan. NOT month
        history — findings are overwritten on each scan (see #28)."""
        from app.models.wordpress_site import WordPressVulnerability
        vulns = WordPressVulnerability.query.filter_by(site_id=site.id).all()
        by_sev = {'critical': 0, 'high': 0, 'medium': 0, 'low': 0, 'unknown': 0}
        items = []
        for v in vulns:
            sev = v.severity if v.severity in by_sev else 'unknown'
            by_sev[sev] += 1
            items.append({
                'source': v.source,
                'slug': v.slug,
                'name': v.name,
                'installed_version': v.installed_version,
                'severity': v.severity,
                'advisory_id': v.advisory_id,
                'fixed_in': v.fixed_in,
                'reference_url': v.reference_url,
            })
        return {
            'as_of': site.last_vuln_scan_at.isoformat() if site.last_vuln_scan_at else None,
            'total': len(items),
            'by_severity': by_sev,
            'items': items,
        }

    @classmethod
    def _health(cls, site):
        from app.models.wordpress_site import DatabaseSnapshot
        return {
            'status': site.health_status,
            'checked_at': site.last_health_check.isoformat() if site.last_health_check else None,
            'disk_usage_bytes': site.disk_usage_bytes,
            'disk_usage_human': (DatabaseSnapshot._format_size(site.disk_usage_bytes)
                                 if site.disk_usage_bytes else None),
        }

    @classmethod
    def _notes(cls, uptime):
        notes = [
            'Vulnerability posture is the current snapshot as of the last scan, '
            'not month-historical — findings are overwritten on each scan.',
            'Traffic analytics and on-demand security scans are point-in-time and '
            'are not included in monthly history.',
        ]
        if not uptime.get('bound'):
            notes.append('Uptime history is unavailable for this period — attach the '
                         'site to a status page (Uptime tab) so uptime % can accrue.')
        return notes

    # ---- helpers ----------------------------------------------------------

    @staticmethod
    def _month_bounds(year, month):
        """First-of-month .. first-of-next-month (exclusive), naive UTC."""
        start = datetime(year, month, 1)
        if month == 12:
            end = datetime(year + 1, 1, 1)
        else:
            end = datetime(year, month + 1, 1)
        return start, end

    @staticmethod
    def _client_from_tags(tags):
        """Derive a client name from a `client-<name>` / `client:<name>` tag (#20)."""
        for t in tags or []:
            if not isinstance(t, str):
                continue
            low = t.lower()
            if low.startswith('client-'):
                return t[len('client-'):] or None
            if low.startswith('client:'):
                return t[len('client:'):] or None
        return None

    @staticmethod
    def _site_url(site):
        app = site.application
        domains = list(getattr(app, 'domains', None) or []) if app else []
        if not domains:
            return None
        primary = next((d for d in domains if getattr(d, 'is_primary', False)), domains[0])
        scheme = 'https' if getattr(primary, 'ssl_enabled', False) else 'http'
        return f'{scheme}://{primary.name}'
