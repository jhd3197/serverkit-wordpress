"""Tests for #25 PHP-fatals ingest — parsing the WP_DEBUG log (docker exec mocked)."""
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
from app.services import wordpress_bridge

_SAMPLE = (
    '__SK_WPDEBUG__\n'
    '[15-Jun-2026 12:00:01 UTC] PHP Fatal error:  Uncaught Error: Call to undefined '
    'function foo() in /var/www/html/wp-content/plugins/x/x.php:12\n'
    'Stack trace:\n'
    '#0 /var/www/html/index.php(17): require()\n'
    '#1 {main}\n'
    '  thrown in /var/www/html/wp-content/plugins/x/x.php on line 12\n'
    '[15-Jun-2026 12:05:00 UTC] PHP Warning:  Undefined array key "k" in /t/functions.php on line 5\n'
    '[15-Jun-2026 12:06:00 UTC] PHP Deprecated:  Function xyz() is deprecated in /x on line 1\n'
    '[15-Jun-2026 12:07:00 UTC] PHP Notice:  Undefined variable $z in /x on line 2\n'
)


class _Res:
    def __init__(self, rc, out):
        self.returncode = rc
        self.stdout = out
        self.stderr = ''


def _mock_run(monkeypatch, rc, out):
    mod = wordpress_bridge.load('wp_analytics_service')
    monkeypatch.setattr(mod.subprocess, 'run', lambda *a, **k: _Res(rc, out))


def test_classify_php_levels():
    W = wordpress_bridge.get('wp_analytics_service', 'WpAnalyticsService')
    assert W._classify_php('Fatal error') == 'fatal'
    assert W._classify_php('Parse error') == 'fatal'
    assert W._classify_php('Recoverable fatal error') == 'fatal'
    assert W._classify_php('Warning') == 'warning'
    assert W._classify_php('Deprecated') == 'deprecated'
    assert W._classify_php('Notice') == 'notice'
    assert W._classify_php('Strict standards') == 'other'


def test_get_php_errors_parses_and_skips_stack_traces(monkeypatch):
    WpAnalyticsService = wordpress_bridge.get('wp_analytics_service', 'WpAnalyticsService')
    _mock_run(monkeypatch, 0, _SAMPLE)
    out = WpAnalyticsService.get_php_errors('site')
    assert out['available'] is True and out['enabled'] is True
    assert out['total'] == 4  # stack-trace / "thrown in" lines are skipped
    assert out['counts'] == {'fatal': 1, 'warning': 1, 'notice': 1, 'deprecated': 1, 'other': 0}
    # Most-recent first: the Notice (12:07) leads.
    assert out['recent'][0]['severity'] == 'notice'
    assert 'Uncaught Error' in out['recent'][-1]['message']


def test_get_php_errors_logging_off(monkeypatch):
    WpAnalyticsService = wordpress_bridge.get('wp_analytics_service', 'WpAnalyticsService')
    _mock_run(monkeypatch, 0, '')  # no marker => log file absent
    out = WpAnalyticsService.get_php_errors('site')
    assert out['available'] is False
    assert 'logging is off' in out['note']


def test_get_php_errors_on_but_empty(monkeypatch):
    WpAnalyticsService = wordpress_bridge.get('wp_analytics_service', 'WpAnalyticsService')
    _mock_run(monkeypatch, 0, '__SK_WPDEBUG__\n')  # log exists, no entries
    out = WpAnalyticsService.get_php_errors('site')
    assert out['available'] is True and out['total'] == 0
    assert 'no PHP errors recorded' in out['note']


def test_get_php_errors_container_unavailable(monkeypatch):
    WpAnalyticsService = wordpress_bridge.get('wp_analytics_service', 'WpAnalyticsService')
    _mock_run(monkeypatch, 1, '')  # docker exec non-zero (stopped / missing)
    out = WpAnalyticsService.get_php_errors('site')
    assert out['available'] is False and 'unavailable' in out['note']


def test_get_php_errors_no_container():
    WpAnalyticsService = wordpress_bridge.get('wp_analytics_service', 'WpAnalyticsService')
    out = WpAnalyticsService.get_php_errors(None)
    assert out['available'] is False and out['total'] == 0


def test_message_truncation(monkeypatch):
    WpAnalyticsService = wordpress_bridge.get('wp_analytics_service', 'WpAnalyticsService')
    long = 'x' * 500
    _mock_run(monkeypatch, 0, f'__SK_WPDEBUG__\n[1 UTC] PHP Fatal error:  {long}\n')
    out = WpAnalyticsService.get_php_errors('site')
    assert out['counts']['fatal'] == 1
    assert len(out['recent'][0]['message']) == 300  # capped
