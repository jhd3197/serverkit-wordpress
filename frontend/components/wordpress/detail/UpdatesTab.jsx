import React, { useState, useEffect } from 'react';
import wordpressApi from '../../../services/wordpress';
import { useToast } from 'serverkit-sdk';
import { Pill } from 'serverkit-sdk';
import { Button } from 'serverkit-sdk';
import { Input } from 'serverkit-sdk';
import { Label } from 'serverkit-sdk';
import { SkeletonBoundary } from 'serverkit-sdk';
import { OverviewGridSkeleton, UPDATE_SCHEDULES } from './wpDetailShared';

// Updates Tab — safe update manager (#29): snapshot -> update -> health-check ->
// auto-rollback, plus a per-site schedule and a run-history report.
const UpdatesTab = ({ siteId }) => {
    const toast = useToast();
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [schedule, setSchedule] = useState('');
    const [excludeText, setExcludeText] = useState('');

    const load = React.useCallback(async () => {
        try {
            const res = await wordpressApi.getUpdates(siteId);
            setData(res);
            setSchedule(res.schedule || '');
            setExcludeText((res.exclude || []).join(', '));
        } catch (err) {
            toast.error(err.message || 'Failed to load updates');
        } finally {
            setLoading(false);
        }
    }, [siteId, toast]);

    useEffect(() => { load(); }, [load]);
    useEffect(() => {
        if (!data?.running) return undefined;
        const t = setTimeout(() => { wordpressApi.getUpdates(siteId).then(setData).catch(() => {}); }, 3000);
        return () => clearTimeout(t);
    }, [data, siteId]);

    const toList = (s) => s.split(',').map(x => x.trim()).filter(Boolean);

    async function runUpdate() {
        if (!window.confirm('Run a safe update now? A database snapshot is taken first and the site auto-rolls-back if the update breaks it.')) return;
        setBusy(true);
        try {
            await wordpressApi.runUpdates(siteId, { exclude: toList(excludeText) });
            toast.info('Safe update started…');
            setData(await wordpressApi.getUpdates(siteId));
        } catch (err) { toast.error(err.message || 'Failed to start update'); }
        finally { setBusy(false); }
    }
    async function saveSchedule() {
        setBusy(true);
        try {
            await wordpressApi.setUpdateSchedule(siteId, { schedule, exclude: toList(excludeText) });
            toast.success('Schedule saved');
            await load();
        } catch (err) { toast.error(err.message || 'Failed to save schedule'); }
        finally { setBusy(false); }
    }

    if (loading) return <SkeletonBoundary loading skeleton={<OverviewGridSkeleton panels={2} />} />;

    const runs = data?.runs || [];
    const running = data?.running;
    const statusPill = (s) => ({ completed: 'green', rolled_back: 'amber', failed: 'red', running: 'cyan' }[s] || 'gray');

    return (
        <div className="app-overview-grid">
            <div className="app-overview-left">
                <div className="app-panel">
                    <div className="app-panel-header">Safe update</div>
                    <div className="app-panel-body">
                        <p className="hint">Snapshots the database, updates core + plugins + themes, health-checks the site, and automatically rolls back (version-pin + DB restore) if the update breaks it.</p>
                        <div className="form-group">
                            <Label>Exclude (skip) plugins/themes</Label>
                            <Input value={excludeText} onChange={e => setExcludeText(e.target.value)} placeholder="e.g. woocommerce, my-custom-plugin" />
                            <span className="form-hint">Comma-separated slugs to never auto-update.</span>
                        </div>
                        <div className="app-detail-actions">
                            <Button size="sm" onClick={runUpdate} disabled={busy || running}>{running ? 'Updating…' : 'Run safe update now'}</Button>
                        </div>
                    </div>
                </div>

                <div className="app-panel">
                    <div className="app-panel-header">Schedule</div>
                    <div className="app-panel-body">
                        <div className="form-group">
                            <Label>Automatic safe updates</Label>
                            <select value={schedule} onChange={e => setSchedule(e.target.value)} disabled={busy}>
                                {UPDATE_SCHEDULES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                                {schedule && !UPDATE_SCHEDULES.some(s => s.value === schedule) && <option value={schedule}>{schedule}</option>}
                            </select>
                            <span className="form-hint">Runs the same safe update (with auto-rollback) on a schedule.</span>
                        </div>
                        <div className="app-detail-actions">
                            <Button variant="outline" size="sm" onClick={saveSchedule} disabled={busy}>Save schedule</Button>
                        </div>
                    </div>
                </div>

                <div className="app-panel">
                    <div className="app-panel-header">Update history</div>
                    <div className="app-panel-body">
                        {runs.length === 0 ? (
                            <p className="hint">No updates have run yet.</p>
                        ) : runs.map(r => {
                            const d = r.details || {};
                            const n = (d.updated || []).length;
                            return (
                                <div className="wp-run-row" key={r.id}>
                                    <div className="wp-run-row-head">
                                        <Pill kind={statusPill(r.status)}>{r.status.replace('_', ' ')}</Pill>
                                        <span className="wp-run-row-meta">{r.started_at ? new Date(r.started_at).toLocaleString() : ''} · {r.trigger}</span>
                                    </div>
                                    <span className="form-hint">
                                        {n === 0 ? 'No components needed updating' : `${n} component${n === 1 ? '' : 's'} updated`}
                                        {d.rolled_back ? ' · auto-rolled back (update regressed the site)' : ''}
                                        {r.error ? ` · ${r.error}` : ''}
                                    </span>
                                    {d.warning && <span className="form-hint">⚠ {d.warning}</span>}
                                    {(d.updated || []).slice(0, 10).map((u, i) => (
                                        <span className="form-hint wp-run-component" key={i}>{u.type} {u.slug}: {u.from} → {u.to}</span>
                                    ))}
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default UpdatesTab;
