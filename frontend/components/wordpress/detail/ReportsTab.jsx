import React, { useState, useEffect } from 'react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { Printer, Download, Trash2 } from 'lucide-react';
import wordpressApi from '../../../services/wordpress';
import { useToast } from 'serverkit-sdk';
import { useConfirm } from 'serverkit-sdk';
import { Pill } from 'serverkit-sdk';
import { Button } from 'serverkit-sdk';
import { SkeletonBoundary } from 'serverkit-sdk';
import { OverviewGridSkeleton } from './wpDetailShared';

// Reports Tab — monthly client reports (#33 agency slice). Aggregates the
// per-site signals that already accrue (uptime/incidents #26, update runs #29,
// backups, vulnerability posture #28) into a persisted, printable monthly report.
const ReportsTab = ({ siteId }) => {
    const toast = useToast();
    const { confirm } = useConfirm();
    const [reports, setReports] = useState([]);
    const [selectedId, setSelectedId] = useState(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);

    // Last 12 months (current first) as {value:'YYYY-MM', label, year, month}.
    const monthOptions = React.useMemo(() => {
        const opts = [];
        const d = new Date();
        d.setDate(1);
        for (let i = 0; i < 12; i++) {
            const year = d.getFullYear();
            const month = d.getMonth() + 1;
            opts.push({
                value: `${year}-${String(month).padStart(2, '0')}`,
                label: d.toLocaleString([], { month: 'long', year: 'numeric' }),
                year, month,
            });
            d.setMonth(d.getMonth() - 1);
        }
        return opts;
    }, []);
    const [genMonth, setGenMonth] = useState(monthOptions[0].value);

    const load = React.useCallback(async (preferLabel) => {
        try {
            const res = await wordpressApi.getReports(siteId);
            const list = res.reports || [];
            setReports(list);
            setSelectedId(prev => {
                if (preferLabel) {
                    const match = list.find(r => r.period_label === preferLabel);
                    if (match) return match.id;
                }
                if (prev && list.some(r => r.id === prev)) return prev;
                return list.length ? list[0].id : null;
            });
        } catch (err) {
            toast.error(err.message || 'Failed to load reports');
        } finally {
            setLoading(false);
        }
    }, [siteId, toast]);

    useEffect(() => { load(); }, [load]);

    async function handleGenerate() {
        const opt = monthOptions.find(o => o.value === genMonth) || monthOptions[0];
        setBusy(true);
        try {
            // The API client throws on a non-2xx (e.g. the future-month guard's 400),
            // so a resolved call means success; failures surface via catch.
            await wordpressApi.generateReport(siteId, { year: opt.year, month: opt.month });
            toast.success(`Report generated for ${opt.label}`);
            await load(opt.value);
        } catch (err) {
            toast.error(err.message || 'Failed to generate report');
        } finally {
            setBusy(false);
        }
    }

    async function handleDelete(report) {
        const ok = await confirm({
            title: 'Delete report',
            message: `Delete the report for ${report.data?.period?.month_name || report.period_label}? This cannot be undone.`,
            confirmText: 'Delete',
            variant: 'danger',
        });
        if (!ok) return;
        try {
            await wordpressApi.deleteReport(siteId, report.id);
            toast.success('Report deleted');
            await load();
        } catch (err) {
            toast.error(err.message || 'Failed to delete report');
        }
    }

    function handleDownload(report) {
        const blob = new Blob([JSON.stringify(report.data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `wp-report-${siteId}-${report.period_label}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }

    function handlePrint() {
        document.body.classList.add('wp-report-printing');
        // Clean up on whichever signal fires first: `afterprint` (most engines) or
        // the window regaining focus when the dialog closes (fallback for webviews
        // that don't dispatch afterprint). cleanup is idempotent.
        const cleanup = () => {
            document.body.classList.remove('wp-report-printing');
            window.removeEventListener('afterprint', cleanup);
            window.removeEventListener('focus', cleanup);
        };
        window.addEventListener('afterprint', cleanup);
        window.addEventListener('focus', cleanup, { once: true });
        window.print();
    }

    if (loading) return <SkeletonBoundary loading skeleton={<OverviewGridSkeleton panels={2} />} />;

    const selected = reports.find(r => r.id === selectedId) || null;

    return (
        <div className="app-overview-grid">
            <div className="app-overview-left">
                <div className="app-panel wp-report-no-print">
                    <div className="app-panel-header">Generate monthly report</div>
                    <div className="app-panel-body">
                        <p className="hint">Snapshots this site&apos;s uptime, incidents, update runs, backups, and current security posture for a calendar month into a printable client report.</p>
                        <div className="app-detail-actions">
                            <select value={genMonth} onChange={e => setGenMonth(e.target.value)} disabled={busy}>
                                {monthOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </select>
                            <Button size="sm" onClick={handleGenerate} disabled={busy}>
                                {busy ? 'Generating…' : 'Generate'}
                            </Button>
                        </div>
                        {reports.length > 0 && (
                            <div className="app-detail-actions wp-report-month-list">
                                {reports.map(r => (
                                    <Button
                                        key={r.id}
                                        variant={r.id === selectedId ? 'default' : 'outline'}
                                        size="sm"
                                        onClick={() => setSelectedId(r.id)}
                                    >
                                        {r.data?.period?.month_name || r.period_label}
                                    </Button>
                                ))}
                            </div>
                        )}
                    </div>
                </div>

                {!selected ? (
                    <div className="app-panel wp-report-no-print">
                        <div className="app-panel-body">
                            <p className="hint">No reports yet — pick a month above and click Generate.</p>
                        </div>
                    </div>
                ) : (
                    <ReportView report={selected} onPrint={handlePrint} onDownload={() => handleDownload(selected)} onDelete={() => handleDelete(selected)} />
                )}
            </div>
        </div>
    );
};

// The printable rendering of a single monthly report. Wrapped in
// .wp-report-printable so the print stylesheet can isolate it from the app chrome.
const ReportView = ({ report, onPrint, onDownload, onDelete }) => {
    const d = report.data || {};
    const period = d.period || {};
    const site = d.site || {};
    const uptime = d.uptime || {};
    const updates = d.updates || {};
    const backups = d.backups || {};
    const vulns = d.vulnerabilities || {};
    const health = d.health || {};
    const sev = vulns.by_severity || {};
    const sevTone = (s) => ({ critical: 'red', high: 'red', medium: 'amber', low: 'cyan' }[s] || 'gray');
    const impactTone = (i) => ({ critical: 'red', major: 'red', minor: 'amber' }[i] || 'gray');
    const fmt = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
    const fmtDay = (key) => {
        if (!key) return '';
        const parts = key.split('-');
        return parts.length === 3 ? Number(parts[2]).toString() : key;
    };
    const dailyHasData = (d.uptime_daily || []).some(x => x.percent !== null);

    return (
        <div className="wp-report-printable">
            <div className="app-panel">
                <div className="app-panel-header">
                    Report — {period.month_name || report.period_label}
                    <span className="wp-report-actions wp-report-no-print">
                        <Button variant="outline" size="sm" onClick={onPrint}><Printer size={14} /> Print</Button>
                        <Button variant="outline" size="sm" onClick={onDownload}><Download size={14} /> JSON</Button>
                        <Button variant="outline" size="sm" onClick={onDelete}><Trash2 size={14} /> Delete</Button>
                    </span>
                </div>
                <div className="app-panel-body">
                    <div className="app-info-grid">
                        <div className="app-info-item"><span className="app-info-label">Site</span><span className="app-info-value">{site.name || '—'}</span></div>
                        {site.client && <div className="app-info-item"><span className="app-info-label">Client</span><span className="app-info-value">{site.client}</span></div>}
                        <div className="app-info-item"><span className="app-info-label">URL</span><span className="app-info-value">{site.url ? <a href={site.url} target="_blank" rel="noopener noreferrer">{site.url}</a> : '—'}</span></div>
                        <div className="app-info-item"><span className="app-info-label">WordPress</span><span className="app-info-value">{site.wp_version || '—'}{site.multisite ? ' · multisite' : ''}</span></div>
                        <div className="app-info-item"><span className="app-info-label">Generated</span><span className="app-info-value">{fmt(d.generated_at)}</span></div>
                    </div>
                </div>
            </div>

            <div className="app-panel">
                <div className="app-panel-header">Summary</div>
                <div className="app-panel-body">
                    <div className="app-info-grid">
                        <div className="app-info-item"><span className="app-info-label">Uptime</span><span className="app-info-value">{uptime.percent !== null && uptime.percent !== undefined ? `${uptime.percent}%` : 'N/A'}</span></div>
                        <div className="app-info-item"><span className="app-info-label">Incidents</span><span className="app-info-value">{d.incident_count ?? 0}</span></div>
                        <div className="app-info-item"><span className="app-info-label">Update runs</span><span className="app-info-value">{updates.total_runs ?? 0}</span></div>
                        <div className="app-info-item"><span className="app-info-label">Components updated</span><span className="app-info-value">{updates.components_updated ?? 0}</span></div>
                        <div className="app-info-item"><span className="app-info-label">Backups</span><span className="app-info-value">{backups.count ?? 0}{backups.count ? ` · ${backups.total_bytes_human}` : ''}</span></div>
                        <div className="app-info-item"><span className="app-info-label">Open vulnerabilities</span><span className="app-info-value">{vulns.total ?? 0}</span></div>
                        <div className="app-info-item"><span className="app-info-label">Current health</span><span className="app-info-value">{health.status || 'unknown'}</span></div>
                        <div className="app-info-item"><span className="app-info-label">Disk usage</span><span className="app-info-value">{health.disk_usage_human || '—'}</span></div>
                    </div>
                    {(updates.rolled_back > 0 || updates.failed > 0) && (
                        <div className="app-detail-actions">
                            {updates.completed > 0 && <Pill kind="green">{updates.completed} completed</Pill>}
                            {updates.rolled_back > 0 && <Pill kind="amber">{updates.rolled_back} rolled back</Pill>}
                            {updates.failed > 0 && <Pill kind="red">{updates.failed} failed</Pill>}
                        </div>
                    )}
                </div>
            </div>

            {uptime.bound && dailyHasData && (
                <div className="app-panel">
                    <div className="app-panel-header">Daily uptime</div>
                    <div className="app-panel-body">
                        <ResponsiveContainer width="100%" height={200}>
                            <AreaChart data={d.uptime_daily || []} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                                <defs>
                                    <linearGradient id="wpUptime" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor="#3ddc97" stopOpacity={0.35} />
                                        <stop offset="95%" stopColor="#3ddc97" stopOpacity={0} />
                                    </linearGradient>
                                </defs>
                                <CartesianGrid strokeDasharray="3 3" stroke="#888" strokeOpacity={0.15} />
                                <XAxis dataKey="date" tickFormatter={fmtDay} tick={{ fontSize: 11, fill: '#888' }} minTickGap={16} axisLine={false} tickLine={false} />
                                <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: '#888' }} width={36} axisLine={false} tickLine={false} />
                                <Tooltip formatter={(v) => (v === null ? 'no data' : `${v}%`)} />
                                <Area connectNulls type="monotone" dataKey="percent" name="Uptime %" stroke="#3ddc97" fill="url(#wpUptime)" strokeWidth={2} />
                            </AreaChart>
                        </ResponsiveContainer>
                        <p className="hint">Uptime recomputed from recorded health-check samples ({uptime.samples} this month). Rolling 30-day: {uptime.rolling_30d ?? '—'}%.</p>
                    </div>
                </div>
            )}

            {(d.incidents || []).length > 0 && (
                <div className="app-panel">
                    <div className="app-panel-header">Incidents</div>
                    <div className="app-panel-body">
                        {d.incidents.map(inc => (
                            <div className="wp-run-row" key={inc.id}>
                                <div className="wp-run-row-head">
                                    <Pill kind={impactTone(inc.impact)}>{inc.impact}</Pill>
                                    <strong>{inc.title}</strong>
                                </div>
                                <span className="form-hint">
                                    {fmt(inc.created_at)} → {inc.ongoing ? 'ongoing' : fmt(inc.resolved_at)} · {inc.duration_minutes} min · {inc.status}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {(updates.runs || []).length > 0 && (
                <div className="app-panel">
                    <div className="app-panel-header">Update runs</div>
                    <div className="app-panel-body">
                        {updates.runs.map(r => {
                            const n = (r.updated || []).length;
                            const kind = ({ completed: 'green', rolled_back: 'amber', failed: 'red', running: 'cyan' }[r.status] || 'gray');
                            return (
                                <div className="wp-run-row" key={r.id}>
                                    <div className="wp-run-row-head">
                                        <Pill kind={kind}>{r.status.replace('_', ' ')}</Pill>
                                        <span className="wp-run-row-meta">{fmt(r.started_at)} · {r.trigger}</span>
                                    </div>
                                    <span className="form-hint">
                                        {n === 0 ? 'No components needed updating' : `${n} component${n === 1 ? '' : 's'} updated`}
                                        {r.rolled_back ? ' · auto-rolled back' : ''}
                                        {r.error ? ` · ${r.error}` : ''}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {(backups.snapshots || []).length > 0 && (
                <div className="app-panel">
                    <div className="app-panel-header">Backups</div>
                    <div className="app-panel-body">
                        {backups.snapshots.map(s => (
                            <div className="app-info-item" key={s.id}>
                                <span className="app-info-label">{fmt(s.created_at)}{s.tag ? ` · ${s.tag}` : ''}</span>
                                <span className="app-info-value">{s.size_human} · {s.status}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            <div className="app-panel">
                <div className="app-panel-header">Security posture {vulns.as_of ? `(as of ${fmt(vulns.as_of)})` : ''}</div>
                <div className="app-panel-body">
                    {vulns.total > 0 ? (
                        <>
                            <div className="app-detail-actions">
                                {sev.critical > 0 && <Pill kind="red">{sev.critical} critical</Pill>}
                                {sev.high > 0 && <Pill kind="red">{sev.high} high</Pill>}
                                {sev.medium > 0 && <Pill kind="amber">{sev.medium} medium</Pill>}
                                {sev.low > 0 && <Pill kind="cyan">{sev.low} low</Pill>}
                                {sev.unknown > 0 && <Pill kind="gray">{sev.unknown} unrated</Pill>}
                            </div>
                            {(vulns.items || []).map((v, i) => (
                                <div className="wp-run-row" key={i}>
                                    <div className="wp-run-row-head"><Pill kind={sevTone(v.severity)}>{v.severity}</Pill><strong>{v.name}</strong></div>
                                    <span className="form-hint">
                                        {v.source}{v.slug ? ` · ${v.slug}` : ''} · installed {v.installed_version}
                                        {v.fixed_in ? ` · fixed in ${v.fixed_in}` : ' · no fix yet'}
                                        {v.advisory_id ? ` · ${v.advisory_id}` : ''}
                                    </span>
                                </div>
                            ))}
                        </>
                    ) : (
                        <p className="hint">{vulns.as_of ? 'No known vulnerabilities at last scan.' : 'No vulnerability scan has run for this site yet.'}</p>
                    )}
                </div>
            </div>

            {(d.notes || []).length > 0 && (
                <div className="app-panel">
                    <div className="app-panel-body">
                        {d.notes.map((n, i) => <p className="hint" key={i}>{n}</p>)}
                    </div>
                </div>
            )}
        </div>
    );
};

export default ReportsTab;
