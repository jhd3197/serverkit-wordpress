import React, { useState, useEffect } from 'react';
import wordpressApi from '../../../services/wordpress';
import { useToast } from 'serverkit-sdk';
import { Pill, ScoreGauge } from 'serverkit-sdk';
import { Button } from 'serverkit-sdk';
import { SkeletonBoundary } from 'serverkit-sdk';
import { OverviewGridSkeleton } from './wpDetailShared';

// Security Tab — per-site security depth (#30): file-integrity verification,
// WP_DEBUG toggle, and WP-Cron management, all via the Docker-aware WP-CLI bridge.
const SecurityTab = ({ siteId }) => {
    const toast = useToast();
    const [integrity, setIntegrity] = useState(null);
    const [debug, setDebug] = useState(null);
    const [cron, setCron] = useState(null);
    const [vulns, setVulns] = useState(null);
    const [brute, setBrute] = useState(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);

    const loadAll = React.useCallback(async () => {
        try {
            const [i, d, c, v, b] = await Promise.all([
                wordpressApi.getIntegrity(siteId).catch(() => null),
                wordpressApi.getDebug(siteId).catch(() => null),
                wordpressApi.getCron(siteId).catch(() => null),
                wordpressApi.getVulnerabilities(siteId).catch(() => null),
                wordpressApi.getBruteForce(siteId).catch(() => null),
            ]);
            setIntegrity(i); setDebug(d); setCron(c); setVulns(v); setBrute(b);
        } finally {
            setLoading(false);
        }
    }, [siteId]);

    useEffect(() => { loadAll(); }, [loadAll]);
    useEffect(() => {
        if (integrity?.status !== 'running') return undefined;
        const t = setTimeout(() => {
            wordpressApi.getIntegrity(siteId).then(setIntegrity).catch(() => {});
        }, 2500);
        return () => clearTimeout(t);
    }, [integrity, siteId]);

    async function runIntegrity() {
        try {
            await wordpressApi.scanIntegrity(siteId);
            setIntegrity(await wordpressApi.getIntegrity(siteId));
        } catch (err) { toast.error(err.message || 'Failed to start check'); }
    }
    async function toggleDebug() {
        setBusy(true);
        try {
            const res = await wordpressApi.setDebug(siteId, !debug?.enabled);
            if (res.success === false) { toast.error(res.error || 'Failed to update debug setting'); return; }
            setDebug(res);
            toast.success('Debug setting updated');
        } catch (err) { toast.error(err.message || 'Failed to update debug setting'); }
        finally { setBusy(false); }
    }
    async function runCron() {
        setBusy(true);
        try {
            const r = await wordpressApi.runCron(siteId);
            toast[r.success ? 'success' : 'error'](r.success ? 'Ran due events' : (r.error || 'Failed to run cron'));
            setCron(await wordpressApi.getCron(siteId));
        } catch (err) { toast.error(err.message || 'Failed to run cron'); }
        finally { setBusy(false); }
    }
    async function toggleCron() {
        setBusy(true);
        try { setCron(await wordpressApi.setCronDisabled(siteId, !cron?.disabled)); }
        catch (err) { toast.error(err.message || 'Failed to update WP-Cron'); }
        finally { setBusy(false); }
    }
    async function toggleBrute() {
        const wasEnabled = brute?.enabled;
        setBusy(true);
        try {
            const res = await wordpressApi.setBruteForce(siteId, !wasEnabled);
            if (res.success === false) { toast.error(res.error || 'Failed to update protection'); return; }
            setBrute(await wordpressApi.getBruteForce(siteId));
            toast.success(wasEnabled ? 'Brute-force protection disabled' : 'Brute-force protection enabled');
        } catch (err) { toast.error(err.message || 'Failed to update protection'); }
        finally { setBusy(false); }
    }
    async function unbanIp(ip) {
        setBusy(true);
        try {
            const res = await wordpressApi.unbanBruteForceIp(siteId, ip);
            toast[res.success ? 'success' : 'error'](res.success ? `Unbanned ${ip}` : (res.error || 'Failed to unban'));
            setBrute(await wordpressApi.getBruteForce(siteId));
        } catch (err) { toast.error(err.message || 'Failed to unban'); }
        finally { setBusy(false); }
    }

    if (loading) return <SkeletonBoundary loading skeleton={<OverviewGridSkeleton panels={2} />} />;

    const intRunning = integrity?.status === 'running';
    const issues = integrity?.issues || [];

    // Posture checks — real signals only; checks that haven't run yet stay out
    // of the score (demo's posture ring, computed client-side).
    const vsum = vulns?.summary || {};
    const checks = [
        {
            label: 'Core & plugin files verified',
            state: integrity?.status === 'completed' ? (issues.length === 0 ? 'pass' : 'fail') : 'unknown',
            detail: integrity?.status === 'completed'
                ? (issues.length === 0 ? 'checksums clean' : `${issues.length} issue${issues.length === 1 ? '' : 's'}`)
                : 'not checked yet',
        },
        {
            label: 'WP_DEBUG disabled',
            state: debug ? (debug.debug?.WP_DEBUG ? 'fail' : 'pass') : 'unknown',
            detail: debug ? (debug.debug?.WP_DEBUG ? 'debug is on' : 'off') : 'unavailable',
        },
        {
            label: 'No critical / high vulnerabilities',
            state: vulns?.scanned_at ? (((vsum.critical ?? 0) + (vsum.high ?? 0)) === 0 ? 'pass' : 'fail') : 'unknown',
            detail: vulns?.scanned_at
                ? `${(vsum.critical ?? 0) + (vsum.high ?? 0)} found`
                : 'no scan yet',
        },
        {
            label: 'Login brute-force protection',
            state: brute?.available === false ? 'unknown' : (brute?.enabled ? 'pass' : 'fail'),
            detail: brute?.available === false ? 'fail2ban unavailable' : (brute?.enabled ? 'jail active' : 'not protected'),
        },
    ];
    const scored = checks.filter(c => c.state !== 'unknown');
    const score = scored.length ? Math.round(scored.filter(c => c.state === 'pass').length / scored.length * 100) : null;
    const scoreColor = score >= 80 ? 'var(--green)' : score >= 50 ? 'var(--amber)' : 'var(--red)';
    const CHECK_PILL = { pass: 'green', fail: 'red', unknown: 'gray' };

    return (
        <div className="app-overview-grid">
            <div className="app-overview-left">
                <div className="app-panel">
                    <div className="app-panel-header">Security posture</div>
                    <div className="app-panel-body wp-posture">
                        {score !== null ? (
                            <ScoreGauge value={score} size={110} stroke={9} color={scoreColor} label="posture" />
                        ) : (
                            <p className="hint">Run the checks below to compute a posture score.</p>
                        )}
                        <div className="wp-posture__checks">
                            {checks.map(c => (
                                <div key={c.label} className="wp-posture__check">
                                    <span className="wp-posture__label">{c.label}</span>
                                    <span className="wp-posture__detail">{c.detail}</span>
                                    <Pill kind={CHECK_PILL[c.state]}>{c.state === 'unknown' ? 'pending' : c.state}</Pill>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>

                <div className="app-panel">
                    <div className="app-panel-header">File integrity</div>
                    <div className="app-panel-body">
                        <div className="app-detail-actions">
                            <Button size="sm" onClick={runIntegrity} disabled={intRunning}>{intRunning ? 'Checking…' : 'Verify checksums'}</Button>
                        </div>
                        {(!integrity || integrity.status === 'idle') && <p className="hint">Verifies WordPress core and wordpress.org plugins against official checksums to detect tampered or unexpected files.</p>}
                        {integrity?.status === 'error' && <p className="hint">Check failed: {integrity.error}</p>}
                        {integrity?.status === 'completed' && (
                            issues.length === 0
                                ? <p className="hint">All core and plugin files verify against official checksums.</p>
                                : <>
                                    <div className="app-detail-actions"><Pill kind="red">{issues.length} issue{issues.length === 1 ? '' : 's'}</Pill></div>
                                    <div className="wp-code-list">
                                        {issues.slice(0, 50).map((line, i) => <div key={i}>{line}</div>)}
                                    </div>
                                </>
                        )}
                    </div>
                </div>

                <div className="app-panel">
                    <div className="app-panel-header">Debug mode</div>
                    <div className="app-panel-body">
                        <div className="app-info-grid">
                            <div className="app-info-item"><span className="app-info-label">WP_DEBUG</span><span className="app-info-value"><Pill kind={debug?.debug?.WP_DEBUG ? 'amber' : 'gray'}>{debug?.debug?.WP_DEBUG ? 'on' : 'off'}</Pill></span></div>
                            <div className="app-info-item"><span className="app-info-label">Debug log</span><span className="app-info-value">{debug?.debug?.WP_DEBUG_LOG ? 'on' : 'off'}</span></div>
                            <div className="app-info-item"><span className="app-info-label">Script debug</span><span className="app-info-value">{debug?.debug?.SCRIPT_DEBUG ? 'on' : 'off'}</span></div>
                        </div>
                        <div className="app-detail-actions">
                            <Button variant="outline" size="sm" onClick={toggleDebug} disabled={busy}>{debug?.enabled ? 'Disable debugging' : 'Enable debugging'}</Button>
                        </div>
                        <p className="hint">Logs errors to a private file outside the web root (never to the page or a public URL). Enable to capture PHP fatals; disable in production.</p>
                    </div>
                </div>

                <div className="app-panel">
                    <div className="app-panel-header">WP-Cron</div>
                    <div className="app-panel-body">
                        <div className="app-info-grid">
                            <div className="app-info-item"><span className="app-info-label">Pseudo-cron</span><span className="app-info-value">{cron?.disabled ? 'disabled' : 'enabled'}</span></div>
                            <div className="app-info-item"><span className="app-info-label">Scheduled events</span><span className="app-info-value">{(cron?.events || []).length}</span></div>
                        </div>
                        <div className="app-detail-actions">
                            <Button variant="outline" size="sm" onClick={runCron} disabled={busy}>Run due events</Button>
                            <Button variant="outline" size="sm" onClick={toggleCron} disabled={busy}>{cron?.disabled ? 'Enable WP-Cron' : 'Disable WP-Cron'}</Button>
                        </div>
                        <p className="hint">Disable WP-Cron only if a real system cron hits wp-cron.php — otherwise scheduled tasks (publishing, updates) will not run.</p>
                    </div>
                </div>

                <div className="app-panel">
                    <div className="app-panel-header">Brute-force protection</div>
                    <div className="app-panel-body">
                        {brute?.available === false ? (
                            <p className="hint">Fail2ban isn’t installed on this server, so login brute-force protection is inactive. Install it from the <strong>Security → Fail2ban</strong> page to enable per-site jails.</p>
                        ) : (
                            <>
                                <div className="app-info-grid">
                                    <div className="app-info-item"><span className="app-info-label">Login jail</span><span className="app-info-value"><Pill kind={brute?.enabled ? 'green' : 'gray'}>{brute?.enabled ? 'active' : 'off'}</Pill></span></div>
                                    <div className="app-info-item"><span className="app-info-label">Currently banned</span><span className="app-info-value">{brute?.currently_banned ?? 0}</span></div>
                                    <div className="app-info-item"><span className="app-info-label">Total bans</span><span className="app-info-value">{brute?.total_banned ?? 0}</span></div>
                                </div>
                                <div className="app-detail-actions">
                                    <Button variant="outline" size="sm" onClick={toggleBrute} disabled={busy}>{brute?.enabled ? 'Disable protection' : 'Enable protection'}</Button>
                                </div>
                                {(brute?.banned_ips?.length > 0) && (
                                    <div className="wp-banlist">
                                        {brute.banned_ips.map(ip => (
                                            <div key={ip} className="wp-banlist__row">
                                                <span className="wp-banlist__ip">{ip}</span>
                                                <Button variant="ghost" size="sm" onClick={() => unbanIp(ip)} disabled={busy}>Unban</Button>
                                            </div>
                                        ))}
                                    </div>
                                )}
                                <p className="hint">
                                    Bans IPs that repeatedly POST to <code>wp-login.php</code> or <code>xmlrpc.php</code>
                                    {brute?.thresholds ? ` (${brute.thresholds.maxretry} attempts / ${Math.round(brute.thresholds.findtime / 60)} min → ${Math.round(brute.thresholds.bantime / 60)} min ban)` : ''}.
                                    {brute?.available && brute?.fail2ban_running === false ? ' Fail2ban is installed but not running — start it on the Security page.' : ''}
                                </p>
                            </>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default SecurityTab;
