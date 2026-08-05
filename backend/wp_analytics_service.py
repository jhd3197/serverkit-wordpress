"""Per-site WordPress traffic + error analytics (#25).

Docker-correct: managed WP sites are official ``wordpress:*-apache`` containers
that send the Apache *combined* access log to the container's stdout, so
``docker logs <container>`` is the source (the in-container access.log is a
symlink to stdout — exec-cat'ing it yields nothing). Analytics is computed
**on demand** over a recent window; there is no separate store, so history is
bounded by the container's retained log (it resets when the container is
recreated, e.g. on a PHP-version switch — see #24).

PHP fatals/warnings are sourced separately from the WP_DEBUG log
(``/tmp/wp-debug.log``), populated only once the per-site WP_DEBUG toggle (#30)
is on — see ``get_php_errors`` (they are not in the access log).

Still NOT derived (deferred):
- per-request response time / slow pages — need a ``%D`` LogFormat the official
  image does not emit.
- cache hit ratio — a cache-plugin concern surfaced by #22/#23, not the access log.
"""

import re
import subprocess
from collections import Counter
from datetime import datetime, timedelta, timezone

from app.utils.formatting import format_bytes


# Apache "combined" CustomLog (the official wordpress:*-apache default to stdout):
#   %h %l %u %t "%r" %>s %b "%{Referer}i" "%{User-Agent}i"
_ACCESS_RE = re.compile(
    r'^(?P<ip>\S+) \S+ \S+ \[(?P<time>[^\]]+)\] '
    r'"(?P<request>[^"]*)" (?P<status>\d{3}) (?P<bytes>\S+) '
    r'"(?P<referer>[^"]*)" "(?P<ua>[^"]*)"'
)
_BOT_RE = re.compile(
    r'bot|crawl|spider|slurp|mediapartners|facebookexternalhit|embedly|bingpreview|monitor|wget|curl|python-requests',
    re.IGNORECASE,
)
_APACHE_TIME_FMT = '%d/%b/%Y:%H:%M:%S %z'


class WpAnalyticsService:
    """On-demand per-site traffic/error analytics from the apache access log."""

    MAX_HOURS = 168       # cap the window at 7 days
    TAIL_CAP = 20000      # cap the docker-logs pull so a busy site can't blow up memory
    LOG_TIMEOUT = 15      # seconds; bound the synchronous docker-logs pull (single-worker safety)

    @classmethod
    def get_traffic(cls, container_name, hours=24):
        try:
            hours = int(hours)
        except (TypeError, ValueError):
            hours = 24
        hours = max(1, min(hours, cls.MAX_HOURS))

        result = cls._empty(hours)
        if not container_name:
            result['note'] = 'No container is resolved for this site.'
            return result

        # Pull the access log straight from the container's stdout with a hard
        # timeout so a busy site / hung daemon can't block the (single) worker.
        # Reading only stdout cleanly separates the access log from the error_log
        # (which Apache sends to stderr).
        try:
            proc = subprocess.run(
                ['docker', 'logs', '--tail', str(cls.TAIL_CAP), '--since', f'{hours}h', container_name],
                capture_output=True, text=True, timeout=cls.LOG_TIMEOUT,
            )
        except subprocess.TimeoutExpired:
            result['note'] = 'Traffic log timed out — the site may be under heavy load; try a shorter window.'
            return result
        except (FileNotFoundError, OSError):
            result['note'] = 'Traffic log is unavailable on this host (Docker is not reachable).'
            return result

        if proc.returncode != 0:
            # e.g. "Error: No such container" — stopped / removed / on a remote agent.
            result['note'] = 'Traffic log is unavailable — the container may be stopped or running on another host.'
            return result

        lines = (proc.stdout or '').splitlines()

        # Pre-seed continuous hourly buckets so the chart x-axis has no gaps.
        now_hour = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
        buckets = {now_hour - timedelta(hours=i): {'requests': 0, 'errors': 0}
                   for i in range(hours, -1, -1)}

        ips = set()
        total = 0
        bytes_total = 0
        bots = 0
        not_found = 0
        status_buckets = {'2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0}
        paths = Counter()

        for raw in lines:
            m = _ACCESS_RE.match(raw.strip())
            if not m:
                continue  # error_log / PHP / non-access lines won't match
            status = int(m.group('status'))
            total += 1
            ips.add(m.group('ip'))

            b = m.group('bytes')
            if b.isdigit():
                bytes_total += int(b)

            bucket = f'{status // 100}xx'
            if bucket in status_buckets:
                status_buckets[bucket] += 1
            if status == 404:
                not_found += 1
            if _BOT_RE.search(m.group('ua')):
                bots += 1

            req_parts = m.group('request').split(' ')
            path = req_parts[1] if len(req_parts) >= 2 else m.group('request')
            paths[path.split('?', 1)[0]] += 1  # group by route; drop query strings (may carry tokens)

            try:
                t = datetime.strptime(m.group('time'), _APACHE_TIME_FMT).astimezone(timezone.utc)
                hk = t.replace(minute=0, second=0, microsecond=0)
                if hk in buckets:
                    buckets[hk]['requests'] += 1
                    if status >= 400:
                        buckets[hk]['errors'] += 1
            except (ValueError, OverflowError):
                pass

        if total == 0:
            result['note'] = (
                f'No requests recorded in the last {hours}h — the site may be idle, '
                'stopped, or recently recreated (the access log resets on recreate).'
            )
            return result

        errors = status_buckets['4xx'] + status_buckets['5xx']
        result.update({
            'requests': total,
            'unique_visitors': len(ips),
            'bytes': bytes_total,
            'bytes_human': cls._human_bytes(bytes_total),
            'status': status_buckets,
            'not_found': not_found,
            'bot_requests': bots,
            'bot_pct': round(bots / total * 100, 1),
            'error_rate': round(errors / total * 100, 1),
            'top_paths': [{'path': p, 'count': c} for p, c in paths.most_common(10)],
            'series': [{'hour': k.isoformat(), 'requests': v['requests'], 'errors': v['errors']}
                       for k, v in sorted(buckets.items())],
            'note': None,
        })
        return result

    # --- PHP errors (#25 fatals) -------------------------------------------
    # Sourced from the WP_DEBUG log, NOT the access log. The log only exists once
    # the per-site WP_DEBUG toggle (#30) is on; its path is owned by WpSecurityService.
    DEBUG_LOG = '/tmp/wp-debug.log'
    PHP_ERR_TAIL = 200000   # bytes; bound the debug-log read so a noisy site can't blow up memory
    RECENT_CAP = 25         # most-recent entries returned

    # WP debug.log line: "[15-Jun-2026 12:34:56 UTC] PHP Fatal error:  <message>"
    _PHP_ERR_RE = re.compile(r'^\[(?P<time>[^\]]+)\]\s+PHP\s+(?P<level>[A-Za-z][A-Za-z ]*?):\s+(?P<msg>.*)$')

    @staticmethod
    def _classify_php(level):
        l = level.lower()
        if 'fatal' in l or 'parse error' in l:
            return 'fatal'
        if 'warning' in l:
            return 'warning'
        if 'deprecated' in l:
            return 'deprecated'
        if 'notice' in l:
            return 'notice'
        return 'other'

    @classmethod
    def get_php_errors(cls, container_name):
        """Parse PHP fatals/warnings/notices from the container's WP_DEBUG log
        (``/tmp/wp-debug.log``, written only once the #30 WP_DEBUG toggle is on).
        On-demand like get_traffic, with a bounded read + hard timeout so the
        single worker never blocks. Never raises."""
        out = {'available': False, 'enabled': False, 'total': 0,
               'counts': {'fatal': 0, 'warning': 0, 'notice': 0, 'deprecated': 0, 'other': 0},
               'recent': [], 'note': None}
        if not container_name:
            out['note'] = 'No container is resolved for this site.'
            return out

        # One exec: print a marker IFF the log exists, then its (size-capped) tail.
        # Empty output => no log => WP_DEBUG logging not enabled (or never errored).
        marker = '__SK_WPDEBUG__'
        script = (f'if [ -f {cls.DEBUG_LOG} ]; then echo {marker}; '
                  f'tail -c {cls.PHP_ERR_TAIL} {cls.DEBUG_LOG}; fi')
        try:
            proc = subprocess.run(
                ['docker', 'exec', container_name, 'sh', '-c', script],
                capture_output=True, text=True, timeout=cls.LOG_TIMEOUT,
            )
        except subprocess.TimeoutExpired:
            out['note'] = 'Debug log read timed out.'
            return out
        except (FileNotFoundError, OSError):
            out['note'] = 'Debug log is unavailable on this host (Docker is not reachable).'
            return out
        if proc.returncode != 0:
            out['note'] = 'Debug log is unavailable — the container may be stopped or on another host.'
            return out

        body = proc.stdout or ''
        if not body.startswith(marker):
            out['note'] = ('PHP error logging is off — enable WP_DEBUG logging on the '
                           'Security tab to collect PHP fatals and warnings.')
            return out
        out['available'] = True
        out['enabled'] = True
        content = body[len(marker):].lstrip('\n')

        recent = []
        for raw in content.splitlines():
            m = cls._PHP_ERR_RE.match(raw.strip())
            if not m:
                continue  # stack-trace / continuation lines won't match
            sev = cls._classify_php(m.group('level'))
            out['counts'][sev] += 1
            out['total'] += 1
            recent.append({'time': m.group('time'), 'level': m.group('level').strip(),
                           'severity': sev, 'message': m.group('msg').strip()[:300]})
        out['recent'] = list(reversed(recent))[:cls.RECENT_CAP]  # most-recent first
        if out['total'] == 0:
            out['note'] = 'WP_DEBUG logging is on; no PHP errors recorded yet.'
        return out

    @classmethod
    def _empty(cls, hours):
        now_hour = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
        series = [{'hour': (now_hour - timedelta(hours=i)).isoformat(), 'requests': 0, 'errors': 0}
                  for i in range(hours, -1, -1)]
        return {
            'success': True,
            'window_hours': hours,
            'requests': 0,
            'unique_visitors': 0,
            'bytes': 0,
            'bytes_human': '0 B',
            'status': {'2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0},
            'not_found': 0,
            'bot_requests': 0,
            'bot_pct': 0.0,
            'error_rate': 0.0,
            'top_paths': [],
            'series': series,
            'note': None,
        }

    @staticmethod
    def _human_bytes(n):
        return format_bytes(n, suffix_sep=' ')
