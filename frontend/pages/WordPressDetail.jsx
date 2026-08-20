import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Settings, Database, GitBranch, Package, Palette, FolderOpen, FileText, Lock, Activity, Globe, BarChart3, LayoutDashboard, Layers } from 'lucide-react';
import { useTabParam } from 'serverkit-sdk';
import wordpressApi from '../services/wordpress';
import { useToast } from 'serverkit-sdk';
import { useLogsDrawer } from 'serverkit-sdk';
import ChangeUrlModal from '../components/wordpress/ChangeUrlModal';
import AttachDomainModal from '../components/wordpress/AttachDomainModal';
import { Pill, EnvTag, PageTopbar } from 'serverkit-sdk';
import { ErrorBoundary } from 'serverkit-sdk';
import { EmptyState } from 'serverkit-sdk';
import { PluginSlot } from 'serverkit-sdk';
import { SkeletonBoundary } from 'serverkit-sdk';
import { Modal } from 'serverkit-sdk';
import { Button } from 'serverkit-sdk';
import { Input } from 'serverkit-sdk';
import { Label } from 'serverkit-sdk';
import {
    DetailPageSkeleton,
    EnvSwitcher,
    SSLAlert,
    envTagLabel,
} from '../components/wordpress/detail/wpDetailShared';
import OverviewTab from '../components/wordpress/detail/OverviewTab';
import EnvironmentsTab from '../components/wordpress/detail/EnvironmentsTab';
import DatabaseTab from '../components/wordpress/detail/DatabaseTab';
import PluginsTab from '../components/wordpress/detail/PluginsTab';
import ThemesTab from '../components/wordpress/detail/ThemesTab';
import GitTab from '../components/wordpress/detail/GitTab';
import BackupsTab from '../components/wordpress/detail/BackupsTab';
import UptimeTab from '../components/wordpress/detail/UptimeTab';
import AnalyticsTab from '../components/wordpress/detail/AnalyticsTab';
import VulnerabilitiesTab from '../components/wordpress/detail/VulnerabilitiesTab';
import SecurityTab from '../components/wordpress/detail/SecurityTab';
import UpdatesTab from '../components/wordpress/detail/UpdatesTab';
import PhpTab from '../components/wordpress/detail/PhpTab';
import ReportsTab from '../components/wordpress/detail/ReportsTab';
import SettingsTab from '../components/wordpress/detail/SettingsTab';
import { useTranslation } from 'serverkit-sdk';

// 'php' and 'updates' no longer have their own top-level tab — they live inside
// the Settings tab's left nav — but stay valid so existing deep links still work.
const VALID_TABS = ['overview', 'environments', 'database', 'plugins', 'themes', 'git', 'backups', 'uptime', 'analytics', 'vulnerabilities', 'security', 'updates', 'php', 'reports', 'settings'];

const WordPressDetail = () => {
    const { t } = useTranslation();
    const { id } = useParams();
    const navigate = useNavigate();
    const toast = useToast();
    const { openDrawer } = useLogsDrawer();
    const [site, setSite] = useState(null);
    const [loading, setLoading] = useState(true);
    const [activeTab, setActiveTab] = useTabParam(`/wordpress/${id}`, VALID_TABS);
    const [autoLoggingIn, setAutoLoggingIn] = useState(false);
    const [showCloneModal, setShowCloneModal] = useState(false);
    const [showChangeUrl, setShowChangeUrl] = useState(false);
    const [showAddDomain, setShowAddDomain] = useState(false);
    const [cloning, setCloning] = useState(false);
    const [cloneName, setCloneName] = useState('');
    const [clonedCreds, setClonedCreds] = useState(null);
    const [gitStatus, setGitStatus] = useState(null);

    useEffect(() => {
        // Show the skeleton again when navigating between environment site ids
        // (env switcher / "Open new site") so stale data never renders.
        setLoading(true);
        loadSite();
    }, [id]);

    useEffect(() => {
        // Load Git connection summary so we can surface a repo pill in the header,
        // matching the Service detail page's "Connect a repository" affordance.
        if (!id) return;
        wordpressApi.getGitStatus(id)
            .then(setGitStatus)
            .catch(() => setGitStatus(null));
    }, [id]);

    async function loadSite() {
        try {
            const data = await wordpressApi.getSite(id);
            setSite(data.site || data);
        } catch (err) {
            console.error('Failed to load site:', err);
            toast.error(t('wp.wordPressDetail.failedToLoadWordpressSite', 'Failed to load WordPress site'));
        } finally {
            setLoading(false);
        }
    }

    async function handleClone() {
        if (!cloneName.trim()) {
            toast.error(t('wp.wordPressDetail.newSiteNameIsRequired', 'New site name is required'));
            return;
        }
        setCloning(true);
        toast.info(t('wp.wordPressDetail.cloningSiteThisSpinsUpA', 'Cloning site... this spins up a new stack and may take a minute.'), { duration: 6000 });
        try {
            const res = await wordpressApi.cloneSite(site.id, { name: cloneName.trim() });
            if (res.success) {
                setShowCloneModal(false);
                setCloneName('');
                if (res.admin_password) {
                    setClonedCreds({ user: res.admin_user || 'admin', password: res.admin_password, id: res.site?.id });
                }
                toast.success(t('wp.wordPressDetail.siteClonedSuccessfully', 'Site cloned successfully'));
            } else {
                toast.error(res.error || t('wp.wordPressDetail.failedToCloneSite', 'Failed to clone site'));
            }
        } catch (err) {
            toast.error(err.message || t('wp.wordPressDetail.failedToCloneSite2', 'Failed to clone site'));
        } finally {
            setCloning(false);
        }
    }

    async function handleAutoLogin() {
        setAutoLoggingIn(true);
        toast.info(t('wp.wordPressDetail.creatingOneTimeLoginLink', 'Creating one-time login link...'), { duration: 3000 });
        try {
            const res = await wordpressApi.autoLogin(site.id);
            if (res && res.url) {
                window.open(res.url, '_blank', 'noopener,noreferrer');
            } else {
                toast.error(t('wp.wordPressDetail.noLoginUrlReturned', 'No login URL returned'));
            }
        } catch (err) {
            toast.error(err.message || t('wp.wordPressDetail.failedToCreateLoginLink', 'Failed to create login link'));
        } finally {
            setAutoLoggingIn(false);
        }
    }

    if (loading) {
        return <SkeletonBoundary loading skeleton={<DetailPageSkeleton />} />;
    }

    if (!site) {
        return (
            <EmptyState
                icon={Globe}
                title={t('wp.wordPressDetail.siteNotFound', 'Site not found')}
                description={t('wp.wordPressDetail.thisWordpressSiteDoesNotExist', 'This WordPress site does not exist or has been removed.')}
                action={<Button onClick={() => navigate('/wordpress')}>{t('wp.wordPressDetail.backToWordpressSites', 'Back to WordPress Sites')}</Button>}
            />
        );
    }

    const isRunning = site.status === 'running';

    // Environment switcher options from data already in the payload:
    // production sites carry `environments`; child envs carry `production_site_id`.
    let envOptions = null;
    if (site.is_production && (site.environments || []).length > 0) {
        envOptions = [
            { id: site.id, name: site.name, type: 'production', url: site.url, current: true },
            ...site.environments.map(e => ({
                id: e.id,
                name: e.name || e.environment_type || `Environment ${e.id}`,
                type: e.environment_type || 'development',
                url: e.url,
                current: false,
            })),
        ];
    } else if (!site.is_production && site.production_site_id) {
        envOptions = [
            { id: site.production_site_id, name: 'Production', type: 'production', current: false },
            { id: site.id, name: site.name, type: site.environment_type || 'development', url: site.url, current: true },
        ];
    }

    return (
        <div className="app-detail-page app-detail-page--wide wp-detail-page">
            {/* One-time cloned-admin credentials banner */}
            {clonedCreds && (
                <div className="wp-creds-banner">
                    <div className="wp-creds-banner-text">
                        <strong>{t('wp.wordPressDetail.newSiteCreatedSaveTheseAdmin', 'New site created — save these admin credentials, shown only once.')}</strong>
                        <span>{t('wp.wordPressDetail.username', 'Username:')} <code>{clonedCreds.user}</code></span>
                        <span>{t('wp.wordPressDetail.password', 'Password:')} <code>{clonedCreds.password}</code></span>
                        {clonedCreds.id && (
                            <Button variant="ghost" onClick={() => navigate(`/wordpress/${clonedCreds.id}`)}>{t('wp.wordPressDetail.openNewSite', 'Open new site')}</Button>
                        )}
                    </div>
                    <Button variant="ghost" onClick={() => setClonedCreds(null)}>{t('wp.wordPressDetail.dismiss', 'Dismiss')}</Button>
                </div>
            )}

            {/* Top bar — the canonical PageTopbar (.sk-topbar): the SAME chrome as
                the WordPress LIST page and every other page, so the top menu is
                consistent. Breadcrumb in the title slot, actions on the right. */}
            <PageTopbar
                className="wp-detail-topbar"
                icon={<Globe size={18} />}
                title={(
                    <span className="wp-crumbs">
                        <Link to="/wordpress">{t('wp.wordPressDetail.wordpress', 'WordPress')}</Link>
                        <span className="wp-crumbs__sep">/</span>
                        <span className="wp-crumbs__cur">{site.name}</span>
                    </span>
                )}
                actions={(
                    <>
                    <Button
                        variant="ghost"
                        onClick={() => navigate(`/files?path=${encodeURIComponent(site.application?.root_path || '/')}`)}
                        disabled={!site.application?.root_path}
                        title={site.application?.root_path ? t('wp.wordPressDetail.openInTheFileManager', 'Open {{rootpath}} in the File Manager', { rootpath: site.application.root_path }) : t('wp.wordPressDetail.noRootPathConfiguredForThis', 'No root path configured for this site')}
                    >
                        <FolderOpen size={16} />
                        {t('wp.wordPressDetail.openFiles', 'Open Files')}
                    </Button>
                    {site.db_name && (
                        <Button
                            variant="ghost"
                            onClick={() => navigate(`/databases/mysql?db=${encodeURIComponent(site.db_name)}`)}
                            title={t('wp.wordPressDetail.openInTheDatabaseManager', 'Open {{dbname}} in the Database manager', { dbname: site.db_name })}
                        >
                            <Database size={16} />
                            {t('wp.wordPressDetail.openDatabase', 'Open Database')}
                        </Button>
                    )}
                    <Button
                        variant="ghost"
                        onClick={() => openDrawer({ name: site.name, containerId: site.application_id, appType: 'docker' })}
                        title={t('wp.wordPressDetail.viewLiveContainerLogs', 'View live container logs')}
                    >
                        <FileText size={16} />
                        {t('wp.wordPressDetail.viewLogs', 'View Logs')}
                    </Button>
                    {site.url && (
                        <Button variant="ghost" asChild>
                            <a
                                href={`${site.url}/wp-admin`}
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                <Settings size={16} />
                                {t('wp.wordPressDetail.dashboard', 'Dashboard')}
                            </a>
                        </Button>
                    )}
                    <Button
                        variant="default"
                        onClick={handleAutoLogin}
                        disabled={autoLoggingIn}
                        title={t('wp.wordPressDetail.openWpAdminLoggedInNo', 'Open wp-admin logged in, no password (one-time link)')}
                    >
                        <Lock size={16} />
                        {autoLoggingIn ? 'Signing in...' : 'Auto Login'}
                    </Button>
                    </>
                )}
            />

            {/* Everything below the full-bleed top bar is padded by .app-detail-body
                (the top bar itself spans edge-to-edge like the list page). */}
            <div className="app-detail-body">
            {/* Identity — icon + name + status + environment + version (no actions). */}
            <div className="app-detail-header">
                <div className="app-detail-icon wp-icon">
                    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="8" />
                    </svg>
                    <span className={`wp-head-dot ${isRunning ? 'running' : 'stopped'}`} />
                </div>
                <div className="app-detail-title-block">
                    <h1>
                        {site.name}
                        <Pill kind={isRunning ? 'green' : 'gray'}>{isRunning ? 'Running' : 'Stopped'}</Pill>
                        {site.is_production ? (
                            <EnvTag env="PROD" />
                        ) : site.production_site_id ? (
                            <EnvTag env={envTagLabel(site.environment_type)} />
                        ) : null}
                        {envOptions && envOptions.length > 1 && (
                            <EnvSwitcher options={envOptions} onSelect={(envId) => navigate(`/wordpress/${envId}`)} />
                        )}
                        <SSLAlert site={site} />
                    </h1>
                    <div className="app-detail-subtitle">
                        <span>{t('wp.wordPressDetail.wordpress2', 'WordPress')} {site.wp_version || '—'}</span>
                        {site.application?.php_version && (
                            <>
                                <span className="separator">·</span>
                                <span>PHP {site.application.php_version}</span>
                            </>
                        )}
                        {site.url && (
                            <>
                                <span className="separator">·</span>
                                <a href={site.url} target="_blank" rel="noopener noreferrer">{site.url}</a>
                            </>
                        )}
                        {site.multisite && (
                            <>
                                <span className="separator">·</span>
                                <span>multisite</span>
                            </>
                        )}
                    </div>
                </div>
            </div>

            {/* Repo Connection Pill — same prominent affordance as the service detail page. */}
            <div className="wp-detail__repo-bar">
                {gitStatus?.connected ? (
                    <div
                        className="wp-detail__repo-pill"
                        onClick={() => navigate(`/wordpress/${id}/settings/git`)}
                        title={t('wp.wordPressDetail.repositoryConnectedOpenGitSettings', 'Repository connected — open Git settings')}
                    >
                        <GitBranch size={14} />
                        <span className="wp-detail__repo-url">{extractRepoDisplay(gitStatus.repo_url)}</span>
                        <span className="wp-detail__repo-arrow">→</span>
                        <span className="wp-detail__repo-branch">{gitStatus.branch || 'main'}</span>
                        {gitStatus.auto_deploy && (
                            <span className="wp-detail__auto-deploy-badge">{t('wp.wordPressDetail.auto', 'Auto')}</span>
                        )}
                    </div>
                ) : (
                    <button type="button"
                        className="wp-detail__connect-repo"
                        onClick={() => navigate(`/wordpress/${id}/settings/git`)}
                    >
                        <GitBranch size={14} />
                        {t('wp.wordPressDetail.connectARepository', 'Connect a repository')}
                    </button>
                )}
            </div>

            {/* Tabs */}
            <div className="app-detail-tabs">
                <div
                    className={`app-detail-tab ${activeTab === 'overview' ? 'active' : ''}`}
                    onClick={() => setActiveTab('overview')}
                >
                    <LayoutDashboard size={14} /> {t('wp.wordPressDetail.overview', 'Overview')}
                </div>
                <div
                    className={`app-detail-tab ${activeTab === 'environments' ? 'active' : ''}`}
                    onClick={() => setActiveTab('environments')}
                >
                    <Layers size={14} /> {t('wp.wordPressDetail.env', 'Env')}
                </div>
                <div
                    className={`app-detail-tab ${activeTab === 'database' ? 'active' : ''}`}
                    onClick={() => setActiveTab('database')}
                >
                    <Database size={14} /> {t('wp.wordPressDetail.database', 'Database')}
                </div>
                <div
                    className={`app-detail-tab ${activeTab === 'plugins' ? 'active' : ''}`}
                    onClick={() => setActiveTab('plugins')}
                >
                    <Package size={14} /> {t('wp.wordPressDetail.plugins', 'Plugins')}
                </div>
                <div
                    className={`app-detail-tab ${activeTab === 'themes' ? 'active' : ''}`}
                    onClick={() => setActiveTab('themes')}
                >
                    <Palette size={14} /> {t('wp.wordPressDetail.themes', 'Themes')}
                </div>
                <div
                    className={`app-detail-tab ${activeTab === 'uptime' ? 'active' : ''}`}
                    onClick={() => setActiveTab('uptime')}
                >
                    <Activity size={14} /> {t('wp.wordPressDetail.uptime', 'Uptime')}
                </div>
                <div
                    className={`app-detail-tab ${activeTab === 'analytics' ? 'active' : ''}`}
                    onClick={() => setActiveTab('analytics')}
                >
                    <BarChart3 size={14} /> {t('wp.wordPressDetail.analytics', 'Analytics')}
                </div>
                <div
                    className={`app-detail-tab app-detail-tab--end ${activeTab === 'settings' ? 'active' : ''}`}
                    onClick={() => setActiveTab('settings')}
                >
                    <Settings size={14} /> {t('wp.wordPressDetail.settings', 'Settings')}
                </div>
            </div>

            {showChangeUrl && (
                <ChangeUrlModal
                    site={site}
                    onClose={() => setShowChangeUrl(false)}
                    onChanged={loadSite}
                />
            )}

            {showAddDomain && (
                <AttachDomainModal
                    site={site}
                    onClose={() => setShowAddDomain(false)}
                    onChanged={loadSite}
                />
            )}

            {/* Clone Site Modal */}
            <Modal open={showCloneModal} onClose={() => !cloning && setShowCloneModal(false)} title={t('wp.wordPressDetail.cloneSite', 'Clone Site')}>
                <form onSubmit={(e) => { e.preventDefault(); handleClone(); }}>
                    <p className="hint">{t('wp.wordPressDetail.createsABrandNewIndependentWordpress', 'Creates a brand-new independent WordPress site (its own Docker stack and database) seeded from')} <strong>{site.name}</strong>{t('wp.wordPressDetail.withFreshAdminCredentialsShownOnce', ', with fresh admin credentials shown once.')}</p>
                    <div className="form-group">
                        <Label>{t('wp.wordPressDetail.newSiteName', 'New Site Name *')}</Label>
                        <Input
                            type="text"
                            value={cloneName}
                            onChange={(e) => setCloneName(e.target.value)}
                            placeholder={`${site.name}-copy`}
                            autoFocus
                            disabled={cloning}
                        />
                    </div>
                    <div className="modal-actions">
                        <Button type="button" variant="outline" onClick={() => setShowCloneModal(false)} disabled={cloning}>{t('wp.wordPressDetail.cancel', 'Cancel')}</Button>
                        <Button type="submit" disabled={cloning || !cloneName.trim()}>{cloning ? 'Cloning...' : 'Clone Site'}</Button>
                    </div>
                </form>
            </Modal>

            {/* Tab Content */}
            <div className="app-detail-content">
                <ErrorBoundary key={activeTab} onRetry={loadSite}>
                    {activeTab === 'overview' && <OverviewTab site={site} onUpdate={loadSite} />}
                    {activeTab === 'environments' && <EnvironmentsTab siteId={site.id} site={site} onUpdate={loadSite} />}
                    {activeTab === 'database' && <DatabaseTab siteId={site.id} site={site} />}
                    {activeTab === 'plugins' && <PluginsTab siteId={site.id} />}
                    {activeTab === 'themes' && <ThemesTab siteId={site.id} />}
                    {activeTab === 'git' && <GitTab siteId={site.id} site={site} onUpdate={loadSite} />}
                    {activeTab === 'backups' && <BackupsTab siteId={site.id} site={site} />}
                    {activeTab === 'uptime' && <UptimeTab siteId={site.id} />}
                    {activeTab === 'analytics' && <AnalyticsTab siteId={site.id} />}
                    {activeTab === 'vulnerabilities' && <VulnerabilitiesTab siteId={site.id} />}
                    {activeTab === 'security' && <SecurityTab siteId={site.id} />}
                    {activeTab === 'updates' && <UpdatesTab siteId={site.id} />}
                    {activeTab === 'php' && <PhpTab siteId={site.id} />}
                    {activeTab === 'reports' && <ReportsTab siteId={site.id} />}
                    {activeTab === 'settings' && (
                        <SettingsTab
                            siteId={site.id}
                            site={site}
                            onUpdate={loadSite}
                            onAddDomain={() => setShowAddDomain(true)}
                            onChangeUrl={() => setShowChangeUrl(true)}
                            onClone={() => setShowCloneModal(true)}
                        />
                    )}
                </ErrorBoundary>
            </div>

            {/* Extension slot: widgets contributed to the WordPress detail page */}
            <PluginSlot name="wordpress.detail.panel" context={{ site }} />
            </div>
        </div>
    );
};

function extractRepoDisplay(url) {
    if (!url) return '';
    try {
        const cleaned = url.replace(/\.git$/, '').replace(/^https?:\/\/[^@]+@/, 'https://');
        const parts = cleaned.split(/[/:]/).filter(Boolean);
        return parts.slice(-2).join('/');
    } catch {
        return url;
    }
}

export default WordPressDetail;
