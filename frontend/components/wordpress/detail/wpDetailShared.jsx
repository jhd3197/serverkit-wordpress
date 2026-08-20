import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, Check, Lock, Globe, Shield, CircleCheck, CircleX } from 'lucide-react';
import { api } from 'serverkit-sdk';
import wordpressApi from '../../../services/wordpress';
import { useToast } from 'serverkit-sdk';
import { Pill } from 'serverkit-sdk';
import { Button } from 'serverkit-sdk';
import { Input } from 'serverkit-sdk';
import { Label } from 'serverkit-sdk';
import { useTranslation, useFormat } from 'serverkit-sdk';

// Detail Page Skeleton for initial loading
// Mirrors the real page chrome (top bar, identity, repo pill, tabs) and the
// Overview tab layout (KPIs, quick-actions + traffic grid, activity feed).
export const DetailPageSkeleton = () => (
    <div className="wp-detail-page wp-detail-page--skeleton">
        {/* Top bar chrome */}
        <div className="sk-topbar-skeleton">
            <div className="sk-topbar-skeleton__icon" />
            <div className="sk-topbar-skeleton__title" />
            <div className="sk-topbar-skeleton__spacer" />
            <div className="sk-topbar-skeleton__actions">
                <div className="sk-topbar-skeleton__btn" />
                <div className="sk-topbar-skeleton__btn" />
                <div className="sk-topbar-skeleton__btn sk-topbar-skeleton__btn--primary" />
            </div>
        </div>

        <div className="app-detail-body">
            {/* Identity header */}
            <div className="app-detail-header">
                <div className="app-detail-icon wp-icon skeleton" style={{ width: 52, height: 52, borderRadius: 13 }} />
                <div className="app-detail-title-block">
                    <div className="skeleton" style={{ width: 260, height: 24, marginBottom: 10 }} />
                    <div className="skeleton" style={{ width: 340, height: 14 }} />
                </div>
            </div>

            {/* Repo pill placeholder */}
            <div className="wp-detail__repo-bar">
                <div className="wp-detail-skeleton-repo" />
            </div>

            {/* Tab strip */}
            <div className="app-detail-tabs">
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map(i => (
                    <div key={i} className="skeleton app-detail-tab-skeleton" />
                ))}
            </div>

            {/* Overview tab content placeholder */}
            <div className="app-detail-content">
                <div className="wp-overview wp-overview--skeleton">
                    {/* KPI row */}
                    <div className="wp-kpis wp-kpis--skeleton">
                        {[1, 2, 3, 4].map(i => (
                            <div key={i} className="wp-detail-skeleton-kpi">
                                <div className="wp-detail-skeleton-kpi__label" />
                                <div className="wp-detail-skeleton-kpi__value" />
                            </div>
                        ))}
                    </div>

                    {/* Quick actions + traffic grid */}
                    <div className="wp-overview-main">
                        <div className="app-panel wp-detail-skeleton-panel">
                            <div className="app-panel-header">
                                <div className="skeleton" style={{ width: 100, height: 12 }} />
                            </div>
                            <div className="app-panel-body">
                                <div className="quick-actions-grid">
                                    {[1, 2, 3, 4, 5, 6, 7, 8].map(i => (
                                        <div key={i} className="skeleton" style={{ height: 38, borderRadius: 8 }} />
                                    ))}
                                </div>
                            </div>
                        </div>

                        <div className="app-panel wp-detail-skeleton-panel wp-traffic-panel">
                            <div className="app-panel-header">
                                <div className="skeleton" style={{ width: 80, height: 12, marginBottom: 4 }} />
                                <div className="skeleton" style={{ width: 140, height: 10 }} />
                            </div>
                            <div className="app-panel-body">
                                <div className="wp-detail-skeleton-chart" />
                            </div>
                        </div>
                    </div>

                    {/* Recent activity panel */}
                    <div className="app-panel wp-detail-skeleton-panel wp-activity-panel">
                        <div className="app-panel-header">
                            <div className="skeleton" style={{ width: 110, height: 12 }} />
                        </div>
                        <div className="app-panel-body">
                            <div className="wp-detail-skeleton-activity">
                                {[1, 2, 3, 4].map(i => (
                                    <div key={i} className="wp-detail-skeleton-activity__row">
                                        <div className="skeleton" style={{ width: 32, height: 32, borderRadius: '50%' }} />
                                        <div className="wp-detail-skeleton-activity__lines">
                                            <div className="skeleton" style={{ width: '40%', height: 12, marginBottom: 6 }} />
                                            <div className="skeleton" style={{ width: '65%', height: 10 }} />
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
);

// Environment-type → dot tint for the header environment switcher.
export const ENV_DOT_COLORS = {
    production: 'var(--green)',
    staging: 'var(--amber)',
    development: 'var(--cyan)',
    multidev: 'var(--violet)',
};

// Short label for an environment type tag (PROD / STAGING / DEV).
export const envTagLabel = (type) => (
    type === 'production' ? 'PROD' : type === 'staging' ? 'STAGING' : 'DEV'
);

export const ENV_TYPE_LABELS = { production: 'Production', staging: 'Staging', development: 'Development', multidev: 'Multidev' };

// Compact header environment switcher — navigates between the environment
// site ids already present in the loaded payload (no extra fetches).
export const EnvSwitcher = ({ options, onSelect }) => {
    const { t } = useTranslation();
    const { formatDate } = useFormat();
    const [open, setOpen] = useState(false);

    useEffect(() => {
        if (!open) return undefined;
        const close = () => setOpen(false);
        window.addEventListener('click', close);
        return () => window.removeEventListener('click', close);
    }, [open]);

    const current = options.find(o => o.current) || options[0];

    return (
        <div className="wp-envswitch-wrap">
            <button
                type="button"
                className={`wp-envswitch ${open ? 'open' : ''}`}
                onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
                title={t('wp.wpDetailShared.switchEnvironment', 'Switch environment')}
            >
                <span className="ed" style={{ background: ENV_DOT_COLORS[current.type] || 'var(--text-faint)' }} />
                {ENV_TYPE_LABELS[current.type] || current.name}
                <ChevronDown size={13} className="chev" />
            </button>
            {open && (
                <div className="wp-envswitch-menu" onClick={e => e.stopPropagation()}>
                    <div className="wp-envswitch-head">{t('wp.wpDetailShared.switchEnvironment2', 'Switch environment')}</div>
                    {options.map(o => (
                        <button
                            type="button"
                            className="wp-envswitch-opt"
                            key={o.id}
                            onClick={() => { setOpen(false); if (!o.current) onSelect(o.id); }}
                        >
                            <span className="ed" style={{ background: ENV_DOT_COLORS[o.type] || 'var(--text-faint)' }} />
                            <span className="wp-envswitch-opt-body">
                                <span className="nm">{o.name}</span>
                                <span className="meta">
                                    {envTagLabel(o.type)}
                                    {o.url ? ` · ${o.url.replace(/^https?:\/\//, '')}` : ''}
                                </span>
                            </span>
                            {o.current && <Check size={14} className="check" />}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
};

// Header alert that nags the operator to secure the site when the primary
// URL is not HTTPS. Clicking it jumps to SSL settings so the user can enable
// HTTPS in one click (or see why it can't be issued yet, e.g. localhost).
export const SSLAlert = ({ site }) => {
    const { t } = useTranslation();
    const isHttps = (site.url || '').startsWith('https://');

    if (!site.url || isHttps) return null;

    return (
        <Link
            to={`/wordpress/${site.id}/settings/ssl`}
            className="sk-pill sk-pill--amber"
        >
            <span className="sk-pill__dot" />
            {t('wp.wpDetailShared.notSecured', 'Not Secured')}
        </Link>
    );
};

// Friendly labels for the editable php.ini directives (#24 limits panel).
export const PHP_LIMIT_LABELS = {
    memory_limit: 'Memory Limit',
    upload_max_filesize: 'Upload Max Filesize',
    post_max_size: 'Post Max Size',
    max_execution_time: 'Max Execution Time',
    max_input_time: 'Max Input Time',
    max_input_vars: 'Max Input Vars',
};

// Updates Tab — safe update schedule options (#29).
export const UPDATE_SCHEDULES = [
    { labelKey: 'wp.wpDetailShared.off', label: 'Off', value: '' },
    { labelKey: 'wp.wpDetailShared.weeklySun3am', label: 'Weekly (Sun 3am)', value: '0 3 * * 0' },
    { labelKey: 'wp.wpDetailShared.daily3am', label: 'Daily (3am)', value: '0 3 * * *' },
];

// Analytics Tab — period options (#25).
export const ANALYTICS_PERIODS = [{ label: '24h', hours: 24 }, { label: '7d', hours: 168 }];

// SSL Certificate panel — guided one-click SSL that walks the user through the
// prerequisites (public domain, DNS, admin email) and then issues the cert.
export const SiteSSLPanel = ({ site, onUpdate }) => {
    const { t } = useTranslation();
    const toast = useToast();
    const domains = site.application?.domains || [];
    const primaryDomain = (domains.find(d => d.is_primary) || domains[0])?.name || null;
    // localhost / private-IP / no-domain sites cannot get a public certificate.
    const isPublicDomain = !!primaryDomain
        && !/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(primaryDomain)
        && primaryDomain.includes('.');
    const hasAdminEmail = !!site.admin_email;
    const [health, setHealth] = useState(null);
    const [checking, setChecking] = useState(true);
    const [issuing, setIssuing] = useState(false);

    // Inline domain attach state (replaces the modal for the SSL flow).
    const [attachDomain, setAttachDomain] = useState('');
    const [attaching, setAttaching] = useState(false);
    const [attachResult, setAttachResult] = useState(null);

    // Connected DNS providers + ServerKit domains so the SSL panel feels linked
    // to the rest of the app.
    const [dnsProviders, setDnsProviders] = useState([]);
    const [serverkitDomains, setServerkitDomains] = useState([]);
    const [contextLoading, setContextLoading] = useState(true);

    useEffect(() => {
        if (!primaryDomain) { setChecking(false); return; }
        let cancelled = false;
        (async () => {
            setChecking(true);
            try {
                const res = await api.getSSLHealth(primaryDomain);
                if (!cancelled) setHealth(res);
            } catch (err) {
                if (!cancelled) setHealth({ valid: false, error: err.message });
            } finally {
                if (!cancelled) setChecking(false);
            }
        })();
        return () => { cancelled = true; };
    }, [primaryDomain]);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setContextLoading(true);
            try {
                const [providersRes, domainsRes] = await Promise.all([
                    api.getEmailDNSProviders().then(d => d.providers || []).catch(() => []),
                    api.getDomains().then(d => d.domains || []).catch(() => []),
                ]);
                if (!cancelled) {
                    setDnsProviders(providersRes);
                    setServerkitDomains(domainsRes);
                }
            } finally {
                if (!cancelled) setContextLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [site.id]);

    async function handleEnableSSL() {
        if (!primaryDomain || !site.admin_email) return;
        setIssuing(true);
        toast.info(t('wp.wpDetailShared.requestingCertificateFor', 'Requesting certificate for {{primaryDomain}}...', { primaryDomain: primaryDomain }), { duration: 4000 });
        try {
            const res = await api.obtainCertificate({ domains: [primaryDomain], email: site.admin_email, use_nginx: true });
            if (res.success) {
                toast.success(res.message || t('wp.wpDetailShared.certificateIssued', 'Certificate issued'));
                const updated = await api.getSSLHealth(primaryDomain);
                setHealth(updated);
            } else {
                toast.error(res.error || t('wp.wpDetailShared.certificateRequestFailed', 'Certificate request failed'));
            }
        } catch (err) {
            toast.error(err.message || t('wp.wpDetailShared.certificateRequestFailed2', 'Certificate request failed'));
        } finally {
            setIssuing(false);
        }
    }

    async function handleAttachDomain(e) {
        e?.preventDefault();
        const domain = attachDomain.trim();
        if (!domain || attaching) return;
        setAttaching(true);
        toast.info(t('wp.wpDetailShared.attachingDomainCreatingDnsAndMoving', 'Attaching domain — creating DNS and moving the site…'), { duration: 5000 });
        try {
            const res = await wordpressApi.attachDomain(site.id, { domain, issueSsl: true });
            if (res.success) {
                setAttachResult(res);
                if (res.dns?.created) toast.success(t('wp.wpDetailShared.dnsARecordCreatedVia', 'DNS A record created via {{provider}}', { provider: res.dns.provider }));
                else toast.warning(t('wp.wpDetailShared.domainAttachedAddTheDnsRecord', 'Domain attached — add the DNS record shown to finish.'), { duration: 7000 });
                onUpdate?.();
            } else {
                toast.error(res.error || t('wp.wpDetailShared.failedToAttachDomain', 'Failed to attach domain'));
            }
        } catch (err) {
            toast.error(err.message || t('wp.wpDetailShared.failedToAttachDomain2', 'Failed to attach domain'));
        } finally {
            setAttaching(false);
        }
    }

    const issued = health?.valid;
    const attachValid = /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(attachDomain.trim());

    const CheckItem = ({ ok, label }) => (
        <div className="ssl-check-item">
            {ok ? <CircleCheck size={14} className="ssl-check-icon ssl-check-icon--ok" /> : <CircleX size={14} className="ssl-check-icon ssl-check-icon--missing" />}
            <span className={ok ? 'ssl-check-label ssl-check-label--ok' : 'ssl-check-label'}>{label}</span>
        </div>
    );

    const rec = attachResult?.dns?.record;

    return (
        <div className="app-panel">
            <div className="app-panel-header"><Lock size={16} /> {t('wp.wpDetailShared.sslCertificate', 'SSL Certificate')}</div>
            <div className="app-panel-body">
                <div className="app-info-grid">
                    <div className="app-info-item">
                        <span className="app-info-label">{t('wp.wpDetailShared.primaryDomain', 'Primary Domain')}</span>
                        <span className="app-info-value mono">{primaryDomain || 'None configured'}</span>
                    </div>
                    <div className="app-info-item">
                        <span className="app-info-label">{t('wp.wpDetailShared.status', 'Status')}</span>
                        <span className="app-info-value">
                            <Pill kind={checking ? 'gray' : issued ? 'green' : 'amber'}>
                                {checking ? 'Checking...' : issued ? `Active (${health.grade})` : 'Not Secured'}
                            </Pill>
                        </span>
                    </div>
                    {issued && health.expires_at && (
                        <div className="app-info-item">
                            <span className="app-info-label">{t('wp.wpDetailShared.expires', 'Expires')}</span>
                            <span className="app-info-value">
                                {formatDate(health.expires_at)}
                                {typeof health.days_remaining === 'number' ? ` (${health.days_remaining}d)` : ''}
                            </span>
                        </div>
                    )}
                    {issued && health.issuer && (
                        <div className="app-info-item">
                            <span className="app-info-label">{t('wp.wpDetailShared.issuer', 'Issuer')}</span>
                            <span className="app-info-value">{health.issuer}</span>
                        </div>
                    )}
                </div>

                {!isPublicDomain ? (
                    <div className="ssl-guide">
                        <p className="hint">{t('wp.wpDetailShared.sslRequiresAPublicDomainPointed', 'SSL requires a public domain pointed at this server. This site is on')} <code>{primaryDomain || 'localhost'}</code>{t('wp.wpDetailShared.soACertificateCannotBeIssued', ', so a certificate cannot be issued here.')}</p>
                        <div className="ssl-checklist">
                            <CheckItem ok={false} label={t('wp.wpDetailShared.publicDomainMappedToThisSite', 'Public domain mapped to this site')} />
                            <CheckItem ok={hasAdminEmail} label={t('wp.wpDetailShared.adminEmailSetForCertificateExpiry', 'Admin email set for certificate expiry notices')} />
                        </div>

                        {!attachResult ? (
                            <form className="ssl-inline-attach" onSubmit={handleAttachDomain}>
                                {contextLoading ? (
                                    <p className="hint">{t('wp.wpDetailShared.loadingDomainConnections', 'Loading domain connections…')}</p>
                                ) : (
                                    <div className="ssl-context">
                                        {dnsProviders.length > 0 ? (
                                            <div className="ssl-provider-status ssl-provider-status--ok">
                                                <CircleCheck size={14} />
                                                {t('wp.wpDetailShared.dnsAutoManagedVia', 'DNS auto-managed via')} {dnsProviders.map(p => p.name || p.provider).join(', ')}
                                            </div>
                                        ) : (
                                            <div className="ssl-provider-status ssl-provider-status--missing">
                                                <CircleX size={14} />
                                                {t('wp.wpDetailShared.noDnsProviderConnectedAddCloudflare', 'No DNS provider connected — add Cloudflare/Route53/etc. for automatic records, or add the DNS record manually after attaching.')}
                                            </div>
                                        )}
                                        <div className="ssl-context-links">
                                            <Link to="/settings/connections">{t('wp.wpDetailShared.dnsConnections', 'DNS connections')}</Link>
                                            <span>·</span>
                                            <Link to="/domains">{t('wp.wpDetailShared.manageDomains', 'Manage domains')}</Link>
                                        </div>
                                    </div>
                                )}

                                <div className="form-group">
                                    <Label>{t('wp.wpDetailShared.domain', 'Domain')}</Label>
                                    <Input
                                        type="text"
                                        value={attachDomain}
                                        onChange={(e) => setAttachDomain(e.target.value)}
                                        placeholder="example.com"
                                        disabled={attaching}
                                        list="ssl-existing-domains"
                                    />
                                    <datalist id="ssl-existing-domains">
                                        {serverkitDomains
                                            .filter(d => !domains.some(ad => ad.name === d.name))
                                            .map(d => (
                                                <option key={d.id} value={d.name}>
                                                    {d.ssl_enabled ? 'SSL enabled' : 'No SSL'}
                                                </option>
                                            ))}
                                    </datalist>
                                    <span className="form-hint">{t('wp.wpDetailShared.pickAnExistingServerkitDomainOr', 'Pick an existing ServerKit domain or type one you control, without http://')}</span>
                                </div>
                                <div className="app-detail-actions">
                                    <Button type="submit" disabled={!attachValid || attaching}>
                                        <Globe size={14} />
                                        {attaching ? 'Attaching…' : 'Attach Domain & Enable SSL'}
                                    </Button>
                                </div>
                            </form>
                        ) : (
                            <div className="ssl-attach-result">
                                <div className="ssl-attach-result__success">
                                    <CircleCheck size={16} />
                                    {t('wp.wpDetailShared.siteIsNowAt', 'Site is now at')} <code>{attachResult.url}</code>
                                </div>
                                {attachResult.dns?.created ? (
                                    <p className="hint">{t('wp.wpDetailShared.dnsARecordCreatedAutomaticallyVia', 'DNS A record created automatically via')} {attachResult.dns.provider}{attachResult.dns.zone ? ` (zone ${attachResult.dns.zone})` : ''}.</p>
                                ) : (
                                    <div className="ssl-attach-result__manual">
                                        <strong>{t('wp.wpDetailShared.addThisDnsRecordToFinish', 'Add this DNS record to finish:')}</strong>
                                        {rec?.value ? (
                                            <code className="ssl-attach-result__record">{rec.type}&nbsp;&nbsp;{rec.name}&nbsp;→&nbsp;{rec.value}</code>
                                        ) : (
                                            <p className="hint">{attachResult.dns?.message}</p>
                                        )}
                                    </div>
                                )}
                                {attachResult.warning && <p className="hint">{attachResult.warning}</p>}
                            </div>
                        )}
                    </div>
                ) : !hasAdminEmail ? (
                    <div className="ssl-guide">
                        <p className="hint">{t('wp.wpDetailShared.aPublicDomainIsConfiguredBut', 'A public domain is configured, but an admin email is required before requesting a certificate.')}</p>
                        <div className="ssl-checklist">
                            <CheckItem ok label={t('wp.wpDetailShared.domainConfigured', 'Domain {{primaryDomain}} configured', { primaryDomain: primaryDomain })} />
                            <CheckItem ok={false} label={t('wp.wpDetailShared.adminEmailSet', 'Admin email set')} />
                        </div>
                        <p className="hint">{t('wp.wpDetailShared.updateTheSiteSAdminEmail', 'Update the site\'s admin email in Settings → General, then return here to enable SSL.')}</p>
                    </div>
                ) : (
                    <div className="ssl-guide">
                        {issued ? (
                            <p className="hint">{t('wp.wpDetailShared.thisSiteIsSecuredWithA', 'This site is secured with a valid SSL certificate. You can re-issue it if needed.')}</p>
                        ) : (
                            <>
                                <p className="hint">{t('wp.wpDetailShared.everythingIsReadyOneClickWill', 'Everything is ready. One click will request a free certificate from Let\'s Encrypt and configure the server.')}</p>
                                <div className="ssl-checklist">
                                    <CheckItem ok label={t('wp.wpDetailShared.domainConfigured2', 'Domain {{primaryDomain}} configured', { primaryDomain: primaryDomain })} />
                                    <CheckItem ok label={t('wp.wpDetailShared.adminEmailSet2', 'Admin email set')} />
                                </div>
                            </>
                        )}
                        <div className="app-detail-actions">
                            <Button onClick={handleEnableSSL} disabled={issuing}>
                                {issued ? <Shield size={14} /> : <Lock size={14} />}
                                {issuing ? 'Requesting...' : issued ? 'Re-issue Certificate' : 'Enable SSL'}
                            </Button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

// Reusable Skeleton Components for Tabs
export const EnvironmentCardSkeleton = () => (
    <div className="wp-env-card-skeleton">
        <div className="wp-env-card-skeleton-header">
            <div className="wp-env-card-skeleton-badge" />
            <div className="wp-env-card-skeleton-status" />
        </div>
        <div className="wp-env-card-skeleton-body">
            <div className="wp-env-card-skeleton-url" />
            <div className="wp-env-card-skeleton-meta">
                <div className="wp-env-card-skeleton-meta-item">
                    <div className="skeleton-label" />
                    <div className="skeleton-value" />
                </div>
                <div className="wp-env-card-skeleton-meta-item">
                    <div className="skeleton-label" />
                    <div className="skeleton-value" />
                </div>
            </div>
        </div>
        <div className="wp-env-card-skeleton-footer">
            <div className="skeleton" style={{ flex: 1, height: 28, borderRadius: 4 }} />
            <div className="skeleton" style={{ flex: 1, height: 28, borderRadius: 4 }} />
        </div>
    </div>
);

export const ListItemSkeleton = () => (
    <div className="skeleton" style={{ height: 48, borderRadius: 6, marginBottom: 8 }} />
);

// Generic panel skeleton — matches .app-panel + .app-panel-header + .app-panel-body
export const PanelSkeleton = ({ headerWidth = 100, rows = 3, children }) => (
    <div className="app-panel wp-detail-skeleton-panel">
        <div className="app-panel-header">
            <div className="skeleton" style={{ width: headerWidth, height: 12 }} />
        </div>
        <div className="app-panel-body">
            {children || (
                <div className="wp-detail-skeleton-rows">
                    {Array.from({ length: rows }).map((_, i) => (
                        <div key={i} className="wp-detail-skeleton-row">
                            <div className="skeleton" style={{ width: '35%', height: 10 }} />
                            <div className="skeleton" style={{ width: '55%', height: 14 }} />
                        </div>
                    ))}
                </div>
            )}
        </div>
    </div>
);

// Skeleton used by tabs that render inside .app-overview-grid > .app-overview-left
export const OverviewGridSkeleton = ({ panels = 2 }) => (
    <div className="app-overview-grid">
        <div className="app-overview-left">
            {Array.from({ length: panels }).map((_, i) => (
                <PanelSkeleton key={i} headerWidth={i === 0 ? 120 : 160} />
            ))}
        </div>
    </div>
);
