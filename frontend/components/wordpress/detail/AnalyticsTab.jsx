import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { BarChart3, Globe, HardDrive, AlertTriangle, Activity, FileText, LineChart, ExternalLink } from 'lucide-react';
import wordpressApi from '../../../services/wordpress';
import { api } from 'serverkit-sdk';
import { useToast } from 'serverkit-sdk';
import { MetricCard, SegControl } from 'serverkit-sdk';
import { SkeletonBoundary } from 'serverkit-sdk';
import { OverviewGridSkeleton, ANALYTICS_PERIODS } from './wpDetailShared';
import { InfoList, InfoItem } from 'serverkit-sdk';
import { useTranslation, useFormat } from 'serverkit-sdk';

// Analytics Tab — per-site traffic + error analytics (#25), parsed on-demand from
// the apache container access log. PHP fatals, response time, and cache hit ratio
// are not in the default access log (deferred to #30 / #22-#23).
const AnalyticsTab = ({ siteId }) => {
    const { t } = useTranslation();
    const { formatDate, formatNumber, formatTime } = useFormat();
    const toast = useToast();
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [hours, setHours] = useState(24);
    // Feature-detect the serverkit-analytics extension so we can point users at
    // the persistent, privacy-first dashboard when it's installed. The on-demand
    // access-log view below stays as a complementary, always-available source.
    const [analyticsExt, setAnalyticsExt] = useState(false);

    useEffect(() => {
        let alive = true;
        api.getInstalledPlugins('active')
            .then((res) => {
                if (!alive) return;
                const on = (res?.plugins || []).some(
                    (p) => p.slug === 'serverkit-analytics' && p.status === 'active');
                setAnalyticsExt(on);
            })
            .catch(() => { /* extension absent — silently keep the log view */ });
        return () => { alive = false; };
    }, []);

    const load = React.useCallback(async () => {
        setLoading(true);
        try {
            const res = await wordpressApi.getSiteAnalytics(siteId, hours);
            setData(res);
        } catch (err) {
            toast.error(err.message || t('wp.analyticsTab.failedToLoadAnalytics', 'Failed to load analytics'));
        } finally {
            setLoading(false);
        }
    }, [siteId, hours, toast]);

    useEffect(() => { load(); }, [load]);

    if (loading) return <SkeletonBoundary loading skeleton={<OverviewGridSkeleton panels={3} />} />;

    const fmtHour = (iso) => {
        const d = new Date(iso);
        return hours <= 24
            ? formatTime(d, { parts: { hour: '2-digit', hour12: false } })
            : formatDate(d, { parts: { month: 'short', day: 'numeric' } });
    };
    const clip = (p) => (p && p.length > 48 ? `${p.slice(0, 48)}…` : p);
    const clipMsg = (m) => (m && m.length > 80 ? `${m.slice(0, 80)}…` : m);
    const s = data?.status || {};
    const phpErr = data?.php_errors;

    return (
        <div className="app-overview-grid">
            <div className="app-overview-left">
                {analyticsExt && (
                    <div className="wp-analytics-banner">
                        <LineChart size={16} />
                        <div className="wp-analytics-banner__text">
                            <strong>{t('wp.analyticsTab.analyticsIsInstalled', 'Analytics is installed.')}</strong>
                            <span> {t('wp.analyticsTab.addThisSiteThereForPersistent', 'Add this site there for persistent, cookieless visitor tracking with a full dashboard. The view below is parsed on demand from access logs.')}</span>
                        </div>
                        <Link to="/analytics/sites" className="wp-analytics-banner__link">
                            {t('wp.analyticsTab.openAnalytics', 'Open analytics')} <ExternalLink size={13} />
                        </Link>
                    </div>
                )}
                <div className="wp-analytics-head">
                    <h3 className="wp-eyebrow">{t('wp.analyticsTab.traffic', 'Traffic ·')} {hours <= 24 ? 'last 24 hours' : 'last 7 days'}</h3>
                    <SegControl
                        options={ANALYTICS_PERIODS.map(p => ({ value: p.hours, label: p.label }))}
                        value={hours}
                        onChange={setHours}
                    />
                </div>
                {data?.note && <p className="hint">{data.note}</p>}
                <div className="wp-kpis">
                    <MetricCard icon={<BarChart3 size={16} />} tone="accent" value={formatNumber(data?.requests ?? 0)} label={t('wp.analyticsTab.requests', 'Requests')} />
                    <MetricCard icon={<Globe size={16} />} tone="cyan" value={formatNumber(data?.unique_visitors ?? 0)} label={t('wp.analyticsTab.uniqueVisitors', 'Unique visitors')} />
                    <MetricCard icon={<HardDrive size={16} />} tone="violet" value={data?.bytes_human || '0 B'} label={t('wp.analyticsTab.bandwidth', 'Bandwidth')} />
                    <MetricCard icon={<AlertTriangle size={16} />} tone={(data?.error_rate ?? 0) > 5 ? 'red' : 'amber'} value={`${data?.error_rate ?? 0}%`} label={t('wp.analyticsTab.errorRate', 'Error rate')} />
                    <MetricCard icon={<Activity size={16} />} tone="green" value={`${data?.bot_pct ?? 0}%`} label={t('wp.analyticsTab.botTraffic', 'Bot traffic')} />
                    <MetricCard icon={<FileText size={16} />} tone="red" value={formatNumber(data?.not_found ?? 0)} label="404s" />
                </div>

                <div className="app-panel">
                    <div className="app-panel-header">{t('wp.analyticsTab.requestsOverTime', 'Requests over time')}</div>
                    <div className="app-panel-body">
                        <ResponsiveContainer width="100%" height={220}>
                            <AreaChart data={data?.series || []} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                                <defs>
                                    <linearGradient id="wpReq" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor="#6d7cff" stopOpacity={0.35} />
                                        <stop offset="95%" stopColor="#6d7cff" stopOpacity={0} />
                                    </linearGradient>
                                    <linearGradient id="wpErr" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor="#fb6f6f" stopOpacity={0.35} />
                                        <stop offset="95%" stopColor="#fb6f6f" stopOpacity={0} />
                                    </linearGradient>
                                </defs>
                                <CartesianGrid strokeDasharray="3 3" stroke="#888" strokeOpacity={0.15} />
                                <XAxis dataKey="hour" tickFormatter={fmtHour} tick={{ fontSize: 11, fill: '#888' }} minTickGap={24} axisLine={false} tickLine={false} />
                                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#888' }} width={36} axisLine={false} tickLine={false} />
                                <Tooltip labelFormatter={fmtHour} />
                                <Area type="monotone" dataKey="requests" name="Requests" stroke="#8b93ff" fill="url(#wpReq)" strokeWidth={2} />
                                <Area type="monotone" dataKey="errors" name="Errors" stroke="#fb6f6f" fill="url(#wpErr)" strokeWidth={2} />
                            </AreaChart>
                        </ResponsiveContainer>
                    </div>
                </div>

                <div className="app-panel">
                    <div className="app-panel-header">{t('wp.analyticsTab.statusCodes', 'Status codes')}</div>
                    <div className="app-panel-body">
                        <InfoList>
                            <InfoItem label="2xx" value={formatNumber(s['2xx'] ?? 0)} />
                            <InfoItem label="3xx" value={formatNumber(s['3xx'] ?? 0)} />
                            <InfoItem label="4xx" value={formatNumber(s['4xx'] ?? 0)} />
                            <InfoItem label="5xx" value={formatNumber(s['5xx'] ?? 0)} />
                        </InfoList>
                    </div>
                </div>

                {data?.top_paths?.length > 0 && (
                    <div className="app-panel">
                        <div className="app-panel-header">{t('wp.analyticsTab.topUrls', 'Top URLs')}</div>
                        <div className="app-panel-body">
                            <InfoList>
                                {data.top_paths.map((row, i) => (
                                    <InfoItem key={i} label={<span title={row.path}>{clip(row.path)}</span>} value={formatNumber(row.count)} />
                                ))}
                            </InfoList>
                            <p className="hint">{t('wp.analyticsTab.readLiveFromTheContainerAccess', 'Read live from the container access log; response-time metrics are not captured by the default log.')}</p>
                        </div>
                    </div>
                )}

                {phpErr && (
                    <div className="app-panel">
                        <div className="app-panel-header">{t('wp.analyticsTab.phpErrors', 'PHP errors')}</div>
                        <div className="app-panel-body">
                            {!phpErr.available ? (
                                <p className="hint">{phpErr.note || t('wp.analyticsTab.phpErrorLoggingIsOff', 'PHP error logging is off.')}</p>
                            ) : (
                                <>
                                    <InfoList>
                                        <InfoItem label={t('wp.analyticsTab.fatal', 'Fatal')} value={formatNumber(phpErr.counts?.fatal ?? 0)} />
                                        <InfoItem label={t('wp.analyticsTab.warning', 'Warning')} value={formatNumber(phpErr.counts?.warning ?? 0)} />
                                        <InfoItem label={t('wp.analyticsTab.notice', 'Notice')} value={formatNumber(phpErr.counts?.notice ?? 0)} />
                                        <InfoItem label={t('wp.analyticsTab.deprecated', 'Deprecated')} value={formatNumber(phpErr.counts?.deprecated ?? 0)} />
                                    </InfoList>
                                    {phpErr.recent?.length > 0 ? (
                                        <InfoList>
                                            {phpErr.recent.map((e, i) => (
                                                <InfoItem key={i} label={<span title={e.message}>{e.level}: {clipMsg(e.message)}</span>} value={e.time} />
                                            ))}
                                        </InfoList>
                                    ) : (
                                        <p className="hint">{phpErr.note || t('wp.analyticsTab.noPhpErrorsRecorded', 'No PHP errors recorded.')}</p>
                                    )}
                                </>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default AnalyticsTab;
