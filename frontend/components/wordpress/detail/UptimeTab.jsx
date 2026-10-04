import React, { useState, useEffect } from 'react';
import { Activity } from 'lucide-react';
import wordpressApi from '../../../services/wordpress';
import { useToast } from 'serverkit-sdk';
import { HealthDot } from '../HealthStatusPanel';
import { MetricCard } from 'serverkit-sdk';
import { Button } from 'serverkit-sdk';
import { Label } from 'serverkit-sdk';
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from 'serverkit-sdk';
import { SkeletonBoundary } from 'serverkit-sdk';
import { OverviewGridSkeleton } from './wpDetailShared';
import { InfoList, InfoItem } from 'serverkit-sdk';
import { useTranslation, useFormat } from 'serverkit-sdk';

// Uptime Tab — per-site health + uptime % via a bound status-page component (#26).
// Health is polled server-side every 5 min; outages auto-open incidents and alert
// the configured notification channels.
const UptimeTab = ({ siteId }) => {
    const { t } = useTranslation();
    const { formatDateTime } = useFormat();
    const toast = useToast();
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [pageId, setPageId] = useState('');
    const [busy, setBusy] = useState(false);

    const load = React.useCallback(async () => {
        setLoading(true);
        try {
            const res = await wordpressApi.getSiteStatusPage(siteId);
            setData(res);
        } catch (err) {
            toast.error(err.message || t('wp.uptimeTab.failedToLoadUptimeInfo', 'Failed to load uptime info'));
        } finally {
            setLoading(false);
        }
    }, [siteId, toast]);

    useEffect(() => { load(); }, [load]);
    useEffect(() => {
        if (data?.pages?.length) setPageId(prev => prev || String(data.pages[0].id));
    }, [data]);

    async function handleAttach() {
        if (!pageId) { toast.error(t('wp.uptimeTab.chooseAStatusPage', 'Choose a status page')); return; }
        setBusy(true);
        try {
            await wordpressApi.attachStatusPage(siteId, Number(pageId));
            toast.success(t('wp.uptimeTab.addedToStatusPage', 'Added to status page'));
            await load();
        } catch (err) {
            toast.error(err.message || t('wp.uptimeTab.failedToAddToStatusPage', 'Failed to add to status page'));
        } finally { setBusy(false); }
    }

    async function handleDetach() {
        if (!window.confirm(t('wp.uptimeTab.removeThisSiteFromItsStatus', 'Remove this site from its status page? Its uptime history and component will be deleted.'))) return;
        setBusy(true);
        try {
            await wordpressApi.detachStatusPage(siteId);
            toast.success(t('wp.uptimeTab.removedFromStatusPage', 'Removed from status page'));
            await load();
        } catch (err) {
            toast.error(err.message || t('wp.uptimeTab.failedToRemoveFromStatusPage', 'Failed to remove from status page'));
        } finally { setBusy(false); }
    }

    if (loading) return <SkeletonBoundary loading skeleton={<OverviewGridSkeleton panels={2} />} />;

    const comp = data?.component;
    const pages = data?.pages || [];
    const pct = (v) => (v != null ? `${v.toFixed(2)}%` : '—');

    return (
        <div className="app-overview-grid">
            <div className="app-overview-left">
                <div className="app-panel">
                    <div className="app-panel-header">{t('wp.uptimeTab.health', 'Health')}</div>
                    <div className="app-panel-body">
                        <InfoList>
                            <InfoItem label={t('wp.uptimeTab.currentStatus', 'Current Status')} value={<><HealthDot status={data?.health_status} /> {data?.health_status || 'unknown'}</>} />
                            <InfoItem label={t('wp.uptimeTab.lastChecked', 'Last Checked')} value={data?.last_health_check ? formatDateTime(data.last_health_check) : 'Never'} />
                        </InfoList>
                        <p className="hint">{t('wp.uptimeTab.healthIsPolledAutomaticallyEvery5', 'Health is polled automatically every 5 minutes. Outages and recoveries alert your configured notification channels.')}</p>
                    </div>
                </div>

                {comp ? (
                    <div className="app-panel">
                        <div className="app-panel-header">{t('wp.uptimeTab.uptime', 'Uptime')}</div>
                        <div className="app-panel-body">
                            {comp.last_check_at ? (
                                <div className="wp-kpis">
                                    <MetricCard icon={<Activity size={16} />} tone="green" value={pct(comp.uptime_24h)} label={t('wp.uptimeTab.uptime24Hours', 'Uptime · 24 hours')} />
                                    <MetricCard icon={<Activity size={16} />} tone="green" value={pct(comp.uptime_7d)} label={t('wp.uptimeTab.uptime7Days', 'Uptime · 7 days')} />
                                    <MetricCard icon={<Activity size={16} />} tone="cyan" value={pct(comp.uptime_30d)} label={t('wp.uptimeTab.uptime30Days', 'Uptime · 30 days')} />
                                    <MetricCard icon={<Activity size={16} />} tone="cyan" value={pct(comp.uptime_90d)} label={t('wp.uptimeTab.uptime90Days', 'Uptime · 90 days')} />
                                </div>
                            ) : (
                                <p className="hint">{t('wp.uptimeTab.awaitingTheFirstHealthCheckRuns', 'Awaiting the first health check (runs within 5 minutes).')}</p>
                            )}
                            <p className="hint">{t('wp.uptimeTab.uptimeAccruesFromThe5Minute', 'Uptime accrues from the 5-minute health checks; only fully-healthy checks count, so degraded periods reduce it. This site appears on its status page and auto-opens an incident on an outage (auto-resolved on recovery).')}</p>
                            <div className="app-detail-actions">
                                <Button variant="outline" size="sm" disabled={busy} onClick={handleDetach}>{t('wp.uptimeTab.removeFromStatusPage', 'Remove from status page')}</Button>
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="app-panel">
                        <div className="app-panel-header">{t('wp.uptimeTab.addToStatusPage', 'Add to status page')}</div>
                        <div className="app-panel-body">
                            {pages.length === 0 ? (
                                <p className="hint">{t('wp.uptimeTab.noStatusPagesExistYetCreate', 'No status pages exist yet. Create one under Status Pages first, then add this site to track its uptime and auto-open incidents on outages.')}</p>
                            ) : (
                                <>
                                    <p className="hint">{t('wp.uptimeTab.trackUptimeForThisSiteOn', 'Track uptime for this site on a status page. It accrues a real uptime % and auto-opens/resolves incidents on outages.')}</p>
                                    <div className="form-group">
                                        <Label htmlFor="wp-uptime-page">{t('wp.uptimeTab.statusPage', 'Status Page')}</Label>
                                        <Select value={pageId} onValueChange={setPageId} disabled={busy}>
                                            <SelectTrigger id="wp-uptime-page"><SelectValue /></SelectTrigger>
                                            <SelectContent>
                                                {pages.map(p => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
                                            </SelectContent>
                                        </Select>
                                    </div>
                                    <div className="app-detail-actions">
                                        <Button size="sm" disabled={busy} onClick={handleAttach}>{t('wp.uptimeTab.addToStatusPage2', 'Add to status page')}</Button>
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default UptimeTab;
