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

// Analytics Tab — per-site traffic + error analytics (#25), parsed on-demand from
// the apache container access log. PHP fatals, response time, and cache hit ratio
// are not in the default access log (deferred to #30 / #22-#23).
const AnalyticsTab = ({ siteId }) => {
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
            toast.error(err.message || 'Failed to load analytics');
        } finally {
            setLoading(false);
        }
    }, [siteId, hours, toast]);

    useEffect(() => { load(); }, [load]);

    if (loading) return <SkeletonBoundary loading skeleton={<OverviewGridSkeleton panels={3} />} />;

    const fmtHour = (iso) => {
        const d = new Date(iso);
        return hours <= 24
            ? d.toLocaleTimeString([], { hour: '2-digit', hour12: false })
            : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
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
                            <strong>Analytics is installed.</strong>
                            <span> Add this site there for persistent, cookieless visitor tracking with a full dashboard. The view below is parsed on demand from access logs.</span>
                        </div>
                        <Link to="/analytics/sites" className="wp-analytics-banner__link">
                            Open Analytics <ExternalLink size={13} />
                        </Link>
                    </div>
                )}
                <div className="wp-analytics-head">
                    <h3 className="wp-eyebrow">Traffic · {hours <= 24 ? 'last 24 hours' : 'last 7 days'}</h3>
                    <SegControl
                        options={ANALYTICS_PERIODS.map(p => ({ value: p.hours, label: p.label }))}
                        value={hours}
                        onChange={setHours}
                    />
                </div>
                {data?.note && <p className="hint">{data.note}</p>}
                <div className="wp-kpis">
                    <MetricCard icon={<BarChart3 size={16} />} tone="accent" value={(data?.requests ?? 0).toLocaleString()} label="Requests" />
                    <MetricCard icon={<Globe size={16} />} tone="cyan" value={(data?.unique_visitors ?? 0).toLocaleString()} label="Unique visitors" />
                    <MetricCard icon={<HardDrive size={16} />} tone="violet" value={data?.bytes_human || '0 B'} label="Bandwidth" />
                    <MetricCard icon={<AlertTriangle size={16} />} tone={(data?.error_rate ?? 0) > 5 ? 'red' : 'amber'} value={`${data?.error_rate ?? 0}%`} label="Error rate" />
                    <MetricCard icon={<Activity size={16} />} tone="green" value={`${data?.bot_pct ?? 0}%`} label="Bot traffic" />
                    <MetricCard icon={<FileText size={16} />} tone="red" value={(data?.not_found ?? 0).toLocaleString()} label="404s" />
                </div>

                <div className="app-panel">
                    <div className="app-panel-header">Requests over time</div>
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
                    <div className="app-panel-header">Status codes</div>
                    <div className="app-panel-body">
                        <div className="app-info-grid">
                            <div className="app-info-item"><span className="app-info-label">2xx</span><span className="app-info-value">{(s['2xx'] ?? 0).toLocaleString()}</span></div>
                            <div className="app-info-item"><span className="app-info-label">3xx</span><span className="app-info-value">{(s['3xx'] ?? 0).toLocaleString()}</span></div>
                            <div className="app-info-item"><span className="app-info-label">4xx</span><span className="app-info-value">{(s['4xx'] ?? 0).toLocaleString()}</span></div>
                            <div className="app-info-item"><span className="app-info-label">5xx</span><span className="app-info-value">{(s['5xx'] ?? 0).toLocaleString()}</span></div>
                        </div>
                    </div>
                </div>

                {data?.top_paths?.length > 0 && (
                    <div className="app-panel">
                        <div className="app-panel-header">Top URLs</div>
                        <div className="app-panel-body">
                            <div className="app-info-grid">
                                {data.top_paths.map((row, i) => (
                                    <div className="app-info-item" key={i}>
                                        <span className="app-info-label" title={row.path}>{clip(row.path)}</span>
                                        <span className="app-info-value">{row.count.toLocaleString()}</span>
                                    </div>
                                ))}
                            </div>
                            <p className="hint">Read live from the container access log; response-time metrics are not captured by the default log.</p>
                        </div>
                    </div>
                )}

                {phpErr && (
                    <div className="app-panel">
                        <div className="app-panel-header">PHP errors</div>
                        <div className="app-panel-body">
                            {!phpErr.available ? (
                                <p className="hint">{phpErr.note || 'PHP error logging is off.'}</p>
                            ) : (
                                <>
                                    <div className="app-info-grid">
                                        <div className="app-info-item"><span className="app-info-label">Fatal</span><span className="app-info-value">{(phpErr.counts?.fatal ?? 0).toLocaleString()}</span></div>
                                        <div className="app-info-item"><span className="app-info-label">Warning</span><span className="app-info-value">{(phpErr.counts?.warning ?? 0).toLocaleString()}</span></div>
                                        <div className="app-info-item"><span className="app-info-label">Notice</span><span className="app-info-value">{(phpErr.counts?.notice ?? 0).toLocaleString()}</span></div>
                                        <div className="app-info-item"><span className="app-info-label">Deprecated</span><span className="app-info-value">{(phpErr.counts?.deprecated ?? 0).toLocaleString()}</span></div>
                                    </div>
                                    {phpErr.recent?.length > 0 ? (
                                        <div className="app-info-grid">
                                            {phpErr.recent.map((e, i) => (
                                                <div className="app-info-item" key={i}>
                                                    <span className="app-info-label" title={e.message}>{e.level}: {clipMsg(e.message)}</span>
                                                    <span className="app-info-value">{e.time}</span>
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <p className="hint">{phpErr.note || 'No PHP errors recorded.'}</p>
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
