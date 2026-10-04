import { useState, useEffect } from 'react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { ExternalLink, Settings, RefreshCw, Plus, Database, Trash2, Replace, ShieldCheck, Zap, Activity, BarChart3, AlertTriangle, HardDrive } from 'lucide-react';
import wordpressApi from '../../../services/wordpress';
import { useToast } from 'serverkit-sdk';
import ActivityFeed from '../ActivityFeed';
import { MetricCard } from 'serverkit-sdk';
import { CreateEnvironmentModal } from './EnvironmentsTab';
import { SearchReplaceModal } from './SettingsTab';
import { useTranslation, useFormat } from 'serverkit-sdk';

// Overview Tab
const OverviewTab = ({ site, onUpdate }) => {
    const { t } = useTranslation();
    const { formatDate } = useFormat();
    const toast = useToast();
    const [creatingSnapshot, setCreatingSnapshot] = useState(false);
    const [showEnvModal, setShowEnvModal] = useState(false);
    const [syncingAll, setSyncingAll] = useState(false);
    const [flushingCache, setFlushingCache] = useState(false);
    const [hardening, setHardening] = useState(false);
    const [pageCacheActive, setPageCacheActive] = useState(false);
    const [togglingPageCache, setTogglingPageCache] = useState(false);
    const [objectCache, setObjectCache] = useState(null);
    const [togglingCache, setTogglingCache] = useState(false);
    const [showSearchReplace, setShowSearchReplace] = useState(false);
    const [analytics, setAnalytics] = useState(null);
    const [uptime, setUptime] = useState(null);

    // Overview KPI + traffic data: uptime (status page) + analytics (access log).
    // Both can be slow or unconfigured, so treat as best-effort (null → "—").
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const [analyticsRes, statusRes] = await Promise.all([
                wordpressApi.getSiteAnalytics(site.id, 168).catch(() => null),
                wordpressApi.getSiteStatusPage(site.id).catch(() => null),
            ]);
            if (cancelled) return;
            setAnalytics(analyticsRes);
            setUptime(statusRes?.component || null);
        })();
        return () => { cancelled = true; };
    }, [site.id]);

    async function handleQuickSnapshot() {
        setCreatingSnapshot(true);
        toast.info(t('wp.overviewTab.creatingSnapshot', 'Creating snapshot…'), { duration: 2000 });
        try {
            await wordpressApi.createSnapshot(site.id, {
                name: `Quick Snapshot ${formatDate(new Date())}`,
                tag: 'quick',
                descriptionKey: 'wp.overviewTab.createdFromOverviewQuickAction', description: 'Created from Overview quick action'
            });
            toast.success(t('wp.overviewTab.snapshotCreatedSuccessfully', 'Snapshot created'));
        } catch (err) {
            toast.error(err.message || t('wp.overviewTab.failedToCreateSnapshot', 'Failed to create snapshot'));
        } finally {
            setCreatingSnapshot(false);
        }
    }

    async function handleSyncAll() {
        if (!site.environments?.length) return;
        setSyncingAll(true);
        toast.info(t('wp.overviewTab.syncingEnvironmentS', 'Syncing {{length}} environment(s)…', { length: site.environments.length }), { duration: 3000 });
        try {
            // Sync each environment sequentially
            for (let i = 0; i < site.environments.length; i++) {
                const env = site.environments[i];
                await wordpressApi.syncEnvironment(site.id, { environment_id: env.id });
            }
            toast.success(t('wp.overviewTab.syncedEnvironmentSFromProduction', 'Synced {{length}} environment(s) from production', { length: site.environments.length }));
            onUpdate?.();
        } catch (err) {
            toast.error(err.message || t('wp.overviewTab.failedToSyncEnvironments', 'Failed to sync environments'));
        } finally {
            setSyncingAll(false);
        }
    }

    async function handleCreateEnvironment(data) {
        toast.info(t('wp.overviewTab.creatingEnvironmentThisMayTakeA', 'Creating environment… This may take a moment.'), { duration: 5000 });
        try {
            await wordpressApi.createEnvironment(site.id, data);
            toast.success(t('wp.overviewTab.environmentCreatedSuccessfully', 'Environment created'));
            setShowEnvModal(false);
            onUpdate?.();
        } catch (err) {
            toast.error(err.message || t('wp.overviewTab.failedToCreateEnvironment', 'Failed to create environment'));
        }
    }

    useEffect(() => {
        let active = true;
        wordpressApi.getPageCache(site.id)
            .then(r => { if (active) setPageCacheActive(Boolean(r?.active)); })
            .catch(() => { /* best-effort; control just shows Enable */ });
        wordpressApi.getObjectCacheStatus(site.id)
            .then(s => { if (active) setObjectCache(s); })
            .catch(() => {});
        return () => { active = false; };
    }, [site.id]);

    async function handleTogglePageCache() {
        setTogglingPageCache(true);
        const enabling = !pageCacheActive;
        toast.info(enabling ? t('wp.overviewTab.enablingPageCache', 'Enabling page cache…') : t('wp.overviewTab.disablingPageCache', 'Disabling page cache…'), { duration: 4000 });
        try {
            const res = enabling
                ? await wordpressApi.enablePageCache(site.id)
                : await wordpressApi.disablePageCache(site.id);
            if (res.success === false) {
                toast.error(res.error || t('wp.overviewTab.pageCacheChangeFailed', 'Page cache change failed'));
            } else {
                toast.success(res.message || (enabling ? t('wp.overviewTab.pageCacheEnabled', 'Page cache enabled') : t('wp.overviewTab.pageCacheDisabled', 'Page cache disabled')));
                setPageCacheActive(enabling);
            }
        } catch (err) {
            toast.error(err.message || t('wp.overviewTab.pageCacheChangeFailed2', 'Page cache change failed'));
        } finally {
            setTogglingPageCache(false);
        }
    }

    async function handleToggleObjectCache() {
        setTogglingCache(true);
        const enabling = !objectCache?.enabled;
        toast.info(enabling ? t('wp.overviewTab.enablingRedisObjectCache', 'Enabling Redis object cache…') : t('wp.overviewTab.disablingObjectCache', 'Disabling object cache…'), { duration: 4000 });
        try {
            const res = enabling
                ? await wordpressApi.enableObjectCache(site.id)
                : await wordpressApi.disableObjectCache(site.id);
            if (res.success === false) {
                toast.error(res.error || t('wp.overviewTab.objectCacheChangeFailed', 'Object cache change failed'));
            } else {
                toast.success(res.message || (enabling ? t('wp.overviewTab.objectCacheEnabled', 'Object cache enabled') : t('wp.overviewTab.objectCacheDisabled', 'Object cache disabled')));
                const fresh = await wordpressApi.getObjectCacheStatus(site.id).catch(() => null);
                if (fresh) setObjectCache(fresh);
            }
        } catch (err) {
            toast.error(err.message || t('wp.overviewTab.objectCacheChangeFailed2', 'Object cache change failed'));
        } finally {
            setTogglingCache(false);
        }
    }

    async function handleFlushCache() {
        setFlushingCache(true);
        toast.info(t('wp.overviewTab.flushingCache', 'Flushing cache…'), { duration: 2000 });
        try {
            const res = await wordpressApi.flushCache(site.id);
            toast.success(res.message || t('wp.overviewTab.cacheFlushed', 'Cache flushed'));
        } catch (err) {
            toast.error(err.message || t('wp.overviewTab.failedToFlushCache', 'Failed to flush cache'));
        } finally {
            setFlushingCache(false);
        }
    }

    async function handleHarden() {
        if (!window.confirm(t('wp.overviewTab.applySecurityHardeningThisDisablesFile', 'Apply security hardening? This disables file editing, the XML-RPC endpoint, forces SSL on wp-admin, tightens file permissions, and regenerates security keys (signs users out).'))) {
            return;
        }
        setHardening(true);
        toast.info(t('wp.overviewTab.applyingSecurityHardening', 'Applying security hardening…'), { duration: 4000 });
        try {
            const res = await wordpressApi.harden(site.id);
            toast.success(res.message || t('wp.overviewTab.securityHardeningApplied', 'Security hardening applied'));
        } catch (err) {
            toast.error(err.message || t('wp.overviewTab.failedToHardenSite', 'Failed to harden site'));
        } finally {
            setHardening(false);
        }
    }

    async function handleSearchReplace(data) {
        // data = { search, replace, dry_run }
        toast.info(data.dry_run ? t('wp.overviewTab.runningSearchReplacePreview', 'Running search-replace preview…') : t('wp.overviewTab.runningSearchReplace', 'Running search-replace…'), { duration: 3000 });
        try {
            const res = await wordpressApi.searchReplace(site.id, data);
            if (res.success === false) {
                toast.error(res.error || res.message || t('wp.overviewTab.searchReplaceFailed', 'Search-replace failed'));
                return;
            }
            toast.success(data.dry_run ? t('wp.overviewTab.dryRunCompleteNoChangesWritten', 'Dry run complete. No changes written.') : t('wp.overviewTab.searchReplaceComplete', 'Search-replace complete'));
            if (!data.dry_run) setShowSearchReplace(false);
        } catch (err) {
            toast.error(err.message || t('wp.overviewTab.searchReplaceFailed2', 'Search-replace failed'));
        }
    }

    // ---- Overview KPI + Site-info derivations (real data, honest fallbacks) ----
    const compactNum = (n) => {
        if (n == null) return '—';
        if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
        if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
        return `${n}`;
    };
    const [diskVal, diskUnit] = (site.disk_usage_human || '').split(' ');
    const trafficSeries = analytics?.series || [];
    const fmtTrafficTick = (iso) => formatDate(iso, { parts: { month: 'short', day: 'numeric' } });

    return (
        <div className="wp-overview">
            {/* KPI row — deliberately NON-redundant: status + version already live
                in the page header, so the tiles surface uptime, traffic, error
                rate, and storage instead. */}
            <div className="wp-kpis">
                <MetricCard
                    tone="green"
                    icon={<Activity size={16} />}
                    value={uptime?.uptime_30d != null ? uptime.uptime_30d.toFixed(2) : '—'}
                    unit={uptime?.uptime_30d != null ? '%' : undefined}
                    label={t('wp.overviewTab.uptime30d', 'Uptime (30d)')}
                />
                <MetricCard
                    tone="accent"
                    icon={<BarChart3 size={16} />}
                    value={analytics ? compactNum(analytics.unique_visitors ?? 0) : '—'}
                    label={t('wp.overviewTab.visitors7d', 'Visitors (7d)')}
                />
                <MetricCard
                    tone={(analytics?.error_rate ?? 0) > 5 ? 'red' : 'amber'}
                    icon={<AlertTriangle size={16} />}
                    value={analytics ? `${analytics.error_rate ?? 0}` : '—'}
                    unit={analytics ? '%' : undefined}
                    label={t('wp.overviewTab.errorRate7d', 'Error rate (7d)')}
                />
                <MetricCard
                    tone="cyan"
                    icon={<HardDrive size={16} />}
                    value={diskVal || '—'}
                    unit={diskUnit || undefined}
                    label={t('wp.overviewTab.diskUsed', 'Disk used')}
                />
            </div>

            <div className="wp-overview-main">
                <div className="app-panel">
                    <div className="app-panel-header">{t('wp.overviewTab.quickActions', 'Quick actions')}</div>
                    <div className="app-panel-body">
                        <div className="quick-actions-grid">
                            {site.url && (
                                <>
                                    <a
                                        href={site.url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="quick-action-btn"
                                    >
                                        <ExternalLink size={16} />
                                        {t('wp.overviewTab.visitSite', 'Visit site')}
                                    </a>
                                    <a
                                        href={`${site.url}/wp-admin`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="quick-action-btn"
                                    >
                                        <Settings size={16} />
                                        {t('wp.overviewTab.wpAdmin', 'WP Admin')}
                                    </a>
                                </>
                            )}
                            {site.is_production && (site.environments || []).length < 2 && (
                                <button type="button"
                                    className="quick-action-btn"
                                    onClick={() => setShowEnvModal(true)}
                                >
                                    <Plus size={16} />
                                    {t('wp.overviewTab.createEnvironment', 'New environment')}
                                </button>
                            )}
                            <button type="button"
                                className="quick-action-btn"
                                onClick={handleQuickSnapshot}
                                disabled={creatingSnapshot}
                            >
                                <Database size={16} />
                                {creatingSnapshot ? t('wp.overviewTab.creating', 'Creating…') : t('wp.overviewTab.createSnapshot', 'Create snapshot')}
                            </button>
                            {site.environments?.length > 0 && (
                                <button type="button"
                                    className="quick-action-btn"
                                    onClick={handleSyncAll}
                                    disabled={syncingAll}
                                >
                                    <RefreshCw size={16} className={syncingAll ? 'spinning' : ''} />
                                    {syncingAll ? t('wp.overviewTab.syncing', 'Syncing…') : t('wp.overviewTab.syncAllEnvironments', 'Sync all environments')}
                                </button>
                            )}
                            <button type="button"
                                className="quick-action-btn"
                                onClick={handleFlushCache}
                                disabled={flushingCache}
                            >
                                <Trash2 size={16} />
                                {flushingCache ? t('wp.overviewTab.purging', 'Purging…') : t('wp.overviewTab.purgeCache', 'Purge cache')}
                            </button>
                            <button type="button"
                                className="quick-action-btn"
                                onClick={handleTogglePageCache}
                                disabled={togglingPageCache}
                                title={pageCacheActive ? t('wp.overviewTab.fullPageCacheIsActive', 'Full-page cache is active') : t('wp.overviewTab.enableAFullPageCacheFor', 'Enable a full-page cache for this site')}
                            >
                                <Zap size={16} />
                                {togglingPageCache
                                    ? t('wp.overviewTab.working', 'Working…')
                                    : (pageCacheActive ? t('wp.overviewTab.pageCacheOn', 'Page cache: on') : t('wp.overviewTab.enablePageCache', 'Enable page cache'))}
                            </button>
                            <button type="button"
                                className="quick-action-btn"
                                onClick={() => setShowSearchReplace(true)}
                            >
                                <Replace size={16} />
                                {t('wp.overviewTab.searchReplace', 'Search and replace')}
                            </button>
                            <button type="button"
                                className="quick-action-btn"
                                onClick={handleHarden}
                                disabled={hardening}
                            >
                                <ShieldCheck size={16} />
                                {hardening ? t('wp.overviewTab.hardening', 'Hardening…') : t('wp.overviewTab.harden', 'Harden')}
                            </button>
                            <button type="button"
                                className="quick-action-btn"
                                onClick={handleToggleObjectCache}
                                disabled={togglingCache}
                                title={objectCache?.enabled ? t('wp.overviewTab.redisObjectCacheIsActive', 'Redis object cache is active') : t('wp.overviewTab.enableARedisObjectCacheFor', 'Enable a Redis object cache for this site')}
                            >
                                <Database size={16} />
                                {togglingCache
                                    ? (objectCache?.enabled ? t('wp.overviewTab.disabling', 'Disabling…') : t('wp.overviewTab.enabling', 'Enabling…'))
                                    : (objectCache?.enabled ? t('wp.overviewTab.objectCacheOn', 'Object cache: on') : t('wp.overviewTab.enableObjectCache', 'Enable object cache'))}
                            </button>
                        </div>
                    </div>
                </div>

                <div className="app-panel wp-traffic-panel">
                    <div className="app-panel-header">
                        {t('wp.overviewTab.traffic', 'Traffic')}
                        <span className="wp-panel-sub">{t('wp.overviewTab.last7DaysUniqueVisits', 'Last 7 days · unique visits')}</span>
                    </div>
                    <div className="app-panel-body">
                        {trafficSeries.length > 0 ? (
                            <ResponsiveContainer width="100%" height={250}>
                                <AreaChart data={trafficSeries} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                                    <defs>
                                        <linearGradient id="wpOvVisits" x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="5%" stopColor="#6d7cff" stopOpacity={0.35} />
                                            <stop offset="95%" stopColor="#6d7cff" stopOpacity={0} />
                                        </linearGradient>
                                    </defs>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#888" strokeOpacity={0.15} />
                                    <XAxis dataKey="hour" tickFormatter={fmtTrafficTick} tick={{ fontSize: 11, fill: '#888' }} minTickGap={28} axisLine={false} tickLine={false} />
                                    <YAxis allowDecimals={false} tickFormatter={(v) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : `${v}`)} tick={{ fontSize: 11, fill: '#888' }} width={34} axisLine={false} tickLine={false} />
                                    <Tooltip labelFormatter={fmtTrafficTick} />
                                    <Area type="monotone" dataKey="requests" name="Visits" stroke="#8b93ff" fill="url(#wpOvVisits)" strokeWidth={2} />
                                </AreaChart>
                            </ResponsiveContainer>
                        ) : (
                            <p className="hint">{t('wp.overviewTab.noTrafficRecordedForThisPeriod', "No traffic recorded for this period yet. It's parsed from the site's access log.")}</p>
                        )}
                    </div>
                </div>
            </div>

            <div className="app-panel wp-activity-panel">
                <div className="app-panel-header">{t('wp.overviewTab.recentActivity', 'Recent activity')}</div>
                <div className="app-panel-body">
                    <ActivityFeed projectId={site.id} limit={6} />
                </div>
            </div>

            {showEnvModal && (() => {
                const envs = site.environments || [];
                const modalHasStaging = envs.some(e => e.environment_type === 'staging');
                const modalHasDev = envs.some(e => e.environment_type === 'development');
                return (
                    <CreateEnvironmentModal
                        onClose={() => setShowEnvModal(false)}
                        onCreate={handleCreateEnvironment}
                        productionDomain={site.url}
                        hasStaging={modalHasStaging}
                        hasDev={modalHasDev}
                    />
                );
            })()}

            {showSearchReplace && (
                <SearchReplaceModal
                    onClose={() => setShowSearchReplace(false)}
                    onSubmit={handleSearchReplace}
                />
            )}
        </div>
    );
};

export default OverviewTab;
