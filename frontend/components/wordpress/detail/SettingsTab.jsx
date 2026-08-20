import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Plus, Globe, Copy, Settings, RefreshCw, Archive, GitBranch, Lock, Shield, ShieldCheck, ShieldAlert, FileBarChart, Trash2 } from 'lucide-react';
import wordpressApi from '../../../services/wordpress';
import { useToast } from 'serverkit-sdk';
import { useConfirm } from 'serverkit-sdk';
import { DangerZone } from 'serverkit-sdk';
import { Modal } from 'serverkit-sdk';
import { Button } from 'serverkit-sdk';
import { Input } from 'serverkit-sdk';
import { Label } from 'serverkit-sdk';
import { SiteSSLPanel } from './wpDetailShared';
import PhpTab from './PhpTab';
import UpdatesTab from './UpdatesTab';
import BackupsTab from './BackupsTab';
import GitTab from './GitTab';
import SecurityTab from './SecurityTab';
import VulnerabilitiesTab from './VulnerabilitiesTab';
import ReportsTab from './ReportsTab';
import { useTranslation } from 'serverkit-sdk';

// Search & Replace Modal (DB string replacement, guarded by dry-run)
export const SearchReplaceModal = ({ onClose, onSubmit }) => {
    const { t } = useTranslation();
    const [search, setSearch] = useState('');
    const [replace, setReplace] = useState('');
    const [loading, setLoading] = useState(false);

    async function run(dryRun) {
        if (!search.trim() || !replace.trim()) return;
        setLoading(true);
        try {
            await onSubmit({ search: search.trim(), replace: replace.trim(), dry_run: dryRun });
        } finally {
            setLoading(false);
        }
    }

    return (
        <Modal open onClose={onClose} title={t('wp.settingsTab.searchReplace', 'Search & Replace')}>
            <form onSubmit={(e) => { e.preventDefault(); run(false); }}>
                <p className="hint">{t('wp.settingsTab.replacesAStringAcrossAllDatabase', 'Replaces a string across all database tables (e.g. an old domain). Always preview with a dry run first.')}</p>

                <div className="form-group">
                    <Label>{t('wp.settingsTab.searchFor', 'Search for *')}</Label>
                    <Input
                        type="text"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="https://old-domain.com"
                        required
                    />
                </div>

                <div className="form-group">
                    <Label>{t('wp.settingsTab.replaceWith', 'Replace with *')}</Label>
                    <Input
                        type="text"
                        value={replace}
                        onChange={(e) => setReplace(e.target.value)}
                        placeholder="https://new-domain.com"
                        required
                    />
                </div>

                <div className="modal-actions">
                    <Button type="button" variant="outline" onClick={onClose}>
                        {t('wp.settingsTab.cancel', 'Cancel')}
                    </Button>
                    <Button type="button" variant="outline" onClick={() => run(true)} disabled={loading || !search.trim() || !replace.trim()}>
                        {loading ? 'Running...' : 'Dry Run'}
                    </Button>
                    <Button type="submit" disabled={loading || !search.trim() || !replace.trim()}>
                        {loading ? 'Running...' : 'Run Replace'}
                    </Button>
                </div>
            </form>
        </Modal>
    );
};

// Delete Site Modal (typed confirmation + optional final backup)
const DeleteSiteModal = ({ siteName, onClose, onConfirm }) => {
    const { t } = useTranslation();
    const [createBackup, setCreateBackup] = useState(true);
    const [typed, setTyped] = useState('');
    const [loading, setLoading] = useState(false);
    const canDelete = typed.trim() === siteName;

    async function handleSubmit(e) {
        e.preventDefault();
        if (!canDelete) return;
        setLoading(true);
        try {
            await onConfirm(createBackup);
        } finally {
            setLoading(false);
        }
    }

    return (
        <Modal open onClose={onClose} title={t('wp.settingsTab.deleteSite', 'Delete Site')}>
            <form onSubmit={handleSubmit}>
                <p className="hint">{t('wp.settingsTab.thisPermanentlyDeletes', 'This permanently deletes')} <strong>{siteName}</strong>{t('wp.settingsTab.allItsEnvironmentsFilesAndDatabases', ', all its environments, files and databases. This cannot be undone.')}</p>
                <div className="form-group">
                    <label className="checkbox-label">
                        <input
                            type="checkbox"
                            checked={createBackup}
                            onChange={(e) => setCreateBackup(e.target.checked)}
                        />
                        <span>{t('wp.settingsTab.createAFinalFilesDatabaseBackup', 'Create a final files + database backup before deleting')}</span>
                    </label>
                </div>
                <div className="form-group">
                    <Label>{t('wp.settingsTab.type', 'Type')} <strong>{siteName}</strong> {t('wp.settingsTab.toConfirm', 'to confirm *')}</Label>
                    <Input
                        type="text"
                        value={typed}
                        onChange={(e) => setTyped(e.target.value)}
                        placeholder={siteName}
                        autoFocus
                    />
                </div>
                <div className="modal-actions">
                    <Button type="button" variant="outline" onClick={onClose} disabled={loading}>
                        {t('wp.settingsTab.cancel2', 'Cancel')}
                    </Button>
                    <Button type="submit" variant="destructive" disabled={loading || !canDelete}>
                        {loading ? 'Deleting...' : 'Delete Site'}
                    </Button>
                </div>
            </form>
        </Modal>
    );
};

// Settings tab — a left sub-nav that consolidates per-site configuration which
// used to be its own top-level tabs (PHP, safe Updates, …). Each section just
// reuses the existing tab component, so behavior is unchanged — only the home
// moves. Defined last so the section components above are already in scope.
// General settings — site-level actions that don't warrant an everyday top-bar
// button (point a domain, change the URL, clone the site). They open the modals
// that already live in WordPressDetail, via handlers passed down through ctx.
const GeneralSettings = ({ onAddDomain, onChangeUrl, onClone }) => (
    <div className="app-overview-grid">
        <div className="app-overview-left">
            <div className="app-panel">
                <div className="app-panel-header">{t('wp.settingsTab.domainsUrl', 'Domains & URL')}</div>
                <div className="app-panel-body">
                    <p className="hint">{t('wp.settingsTab.pointACustomDomainYouOwn', 'Point a custom domain you own at this site (auto-DNS + migrate), or change its primary URL with a serialization-safe database rewrite.')}</p>
                    <div className="app-detail-actions">
                        <Button variant="outline" size="sm" onClick={onAddDomain}>
                            <Plus size={15} /> {t('wp.settingsTab.addDomain', 'Add Domain')}
                        </Button>
                        <Button variant="outline" size="sm" onClick={onChangeUrl}>
                            <Globe size={15} /> {t('wp.settingsTab.changeUrl', 'Change URL')}
                        </Button>
                    </div>
                </div>
            </div>
            <div className="app-panel">
                <div className="app-panel-header">{t('wp.settingsTab.duplicateSite', 'Duplicate site')}</div>
                <div className="app-panel-body">
                    <p className="hint">{t('wp.settingsTab.cloneThisSiteAsABrand', 'Clone this site as a brand-new independent site (its own Docker stack and database) with fresh admin credentials.')}</p>
                    <div className="app-detail-actions">
                        <Button variant="outline" size="sm" onClick={onClone}>
                            <Copy size={15} /> {t('wp.settingsTab.cloneSite', 'Clone site')}
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    </div>
);

// Danger Zone settings — destructive site-level actions moved out of the
// Overview tab into Settings so the daily dashboard isn't dominated by them.
const DangerZoneSettings = ({ site, onUpdate }) => {
    const { t } = useTranslation();
    const toast = useToast();
    const navigate = useNavigate();
    const { confirm } = useConfirm();
    const [archiving, setArchiving] = useState(false);
    const [showDeleteModal, setShowDeleteModal] = useState(false);

    async function handleArchive() {
        const ok = await confirm({
            title: t('wp.settingsTab.archiveSite', 'Archive Site'),
            message: t('wp.settingsTab.stopAndArchiveContainersAreStopped', 'Stop and archive "{{name}}"? Containers are stopped but all files and the database are kept. You can unarchive it later.', { name: site.name }),
            confirmText: t('wp.settingsTab.archive', 'Archive'),
            variant: 'warning',
        });
        if (!ok) return;
        setArchiving(true);
        toast.info(t('wp.settingsTab.archivingSite', 'Archiving site...'), { duration: 3000 });
        try {
            await wordpressApi.archiveSite(site.id);
            toast.success(t('wp.settingsTab.siteArchived', 'Site archived'));
            onUpdate?.();
        } catch (err) {
            toast.error(err.message || t('wp.settingsTab.failedToArchiveSite', 'Failed to archive site'));
        } finally {
            setArchiving(false);
        }
    }

    async function handleUnarchive() {
        setArchiving(true);
        toast.info(t('wp.settingsTab.unarchivingSite', 'Unarchiving site...'), { duration: 3000 });
        try {
            await wordpressApi.unarchiveSite(site.id);
            toast.success(t('wp.settingsTab.siteUnarchived', 'Site unarchived'));
            onUpdate?.();
        } catch (err) {
            toast.error(err.message || t('wp.settingsTab.failedToUnarchiveSite', 'Failed to unarchive site'));
        } finally {
            setArchiving(false);
        }
    }

    async function handleDelete(createBackup) {
        toast.info(createBackup ? t('wp.settingsTab.creatingFinalBackupAndDeletingSite', 'Creating final backup and deleting site...') : t('wp.settingsTab.deletingSite', 'Deleting site...'), { duration: 5000 });
        try {
            await wordpressApi.deleteSite(site.id, { createBackup });
            toast.success(t('wp.settingsTab.siteDeleted', 'Site deleted'));
            setShowDeleteModal(false);
            navigate('/wordpress');
        } catch (err) {
            toast.error(err.message || t('wp.settingsTab.failedToDeleteSite', 'Failed to delete site'));
        }
    }

    return (
        <>
            {showDeleteModal && (
                <DeleteSiteModal
                    siteName={site.name}
                    onClose={() => setShowDeleteModal(false)}
                    onConfirm={handleDelete}
                />
            )}
            <div className="app-overview-grid">
                <div className="app-overview-left">
                    <div className="app-panel danger-zone-panel">
                        <div className="app-panel-header">{t('wp.settingsTab.dangerZone', 'Danger Zone')}</div>
                        <div className="app-panel-body danger-zone-body">
                            {site.status === 'archived' ? (
                                <DangerZone
                                    title={t('wp.settingsTab.unarchiveSite', 'Unarchive Site')}
                                    description={t('wp.settingsTab.restartThisSiteSContainersAnd', 'Restart this site\'s containers and bring it back online.')}
                                    action={(
                                        <Button variant="outline" onClick={handleUnarchive} disabled={archiving}>
                                            <Archive size={16} />
                                            {archiving ? 'Unarchiving...' : 'Unarchive'}
                                        </Button>
                                    )}
                                />
                            ) : (
                                <DangerZone
                                    title={t('wp.settingsTab.archiveSite3', 'Archive Site')}
                                    description={t('wp.settingsTab.stopTheContainersButKeepAll', 'Stop the containers but keep all files and the database. Reversible.')}
                                    action={(
                                        <Button variant="outline" onClick={handleArchive} disabled={archiving}>
                                            <Archive size={16} />
                                            {archiving ? 'Archiving...' : 'Archive'}
                                        </Button>
                                    )}
                                />
                            )}
                            <DangerZone
                                title={t('wp.settingsTab.deleteSite2', 'Delete Site')}
                                description={t('wp.settingsTab.permanentlyRemoveThisSiteAllEnvironments', 'Permanently remove this site, all environments, files and databases. A final backup is taken by default.')}
                                action={(
                                    <Button variant="destructive" onClick={() => setShowDeleteModal(true)}>
                                        <Trash2 size={16} />
                                        {t('wp.settingsTab.deleteSite3', 'Delete Site')}
                                    </Button>
                                )}
                            />
                        </div>
                    </div>
                </div>
            </div>
        </>
    );
};

// Grouped left nav for the Settings tab. Each item just re-renders the existing
// per-feature component (passed a single `ctx`), so behavior is unchanged — only
// the home moves here to keep the top tab strip short. Groups give the nav
// structure (the user's "group section" idea) and room to grow.
const WP_SETTINGS_GROUPS = [
    { labelKey: 'wp.settingsTab.general', label: 'General', items: [
        { id: 'general', labelKey: 'wp.settingsTab.general2', label: 'General', icon: Globe, render: (ctx) => <GeneralSettings {...ctx} /> },
    ] },
    { labelKey: 'wp.settingsTab.configuration', label: 'Configuration', items: [
        { id: 'php', label: 'PHP', icon: Settings, render: (ctx) => <PhpTab siteId={ctx.siteId} /> },
        { id: 'updates', labelKey: 'wp.settingsTab.updates', label: 'Updates', icon: RefreshCw, render: (ctx) => <UpdatesTab siteId={ctx.siteId} /> },
    ] },
    { labelKey: 'wp.settingsTab.data', label: 'Data', items: [
        { id: 'backups', labelKey: 'wp.settingsTab.backups', label: 'Backups', icon: Archive, render: (ctx) => <BackupsTab siteId={ctx.siteId} site={ctx.site} /> },
    ] },
    { labelKey: 'wp.settingsTab.connections', label: 'Connections', items: [
        { id: 'git', labelKey: 'wp.settingsTab.git', label: 'Git', icon: GitBranch, render: (ctx) => <GitTab siteId={ctx.siteId} site={ctx.site} onUpdate={ctx.onUpdate} /> },
    ] },
    { labelKey: 'wp.settingsTab.security', label: 'Security', items: [
        { id: 'security', labelKey: 'wp.settingsTab.security2', label: 'Security', icon: Lock, render: (ctx) => <SecurityTab siteId={ctx.siteId} /> },
        { id: 'ssl', label: 'SSL', icon: Shield, render: (ctx) => <SiteSSLPanel site={ctx.site} onUpdate={ctx.onUpdate} /> },
        { id: 'vulnerabilities', labelKey: 'wp.settingsTab.vulnerabilities', label: 'Vulnerabilities', icon: ShieldCheck, render: (ctx) => <VulnerabilitiesTab siteId={ctx.siteId} /> },
    ] },
    { labelKey: 'wp.settingsTab.reports', label: 'Reports', items: [
        { id: 'reports', labelKey: 'wp.settingsTab.reports2', label: 'Reports', icon: FileBarChart, render: (ctx) => <ReportsTab siteId={ctx.siteId} /> },
    ] },
    { labelKey: 'wp.settingsTab.dangerZone2', label: 'Danger Zone', items: [
        { id: 'danger-zone', labelKey: 'wp.settingsTab.dangerZone3', label: 'Danger Zone', icon: ShieldAlert, render: (ctx) => <DangerZoneSettings site={ctx.site} onUpdate={ctx.onUpdate} /> },
    ] },
];

const WP_SETTINGS_ITEMS = WP_SETTINGS_GROUPS.flatMap((g) => g.items);

const SettingsTab = ({ siteId, site, onUpdate, onAddDomain, onChangeUrl, onClone }) => {
    const { t } = useTranslation();
    // Section lives in the URL (/wordpress/:id/settings/:section) so it's
    // shareable and survives a refresh, instead of resetting to General.
    const { id, section: sectionParam } = useParams();
    const navigate = useNavigate();
    const section = WP_SETTINGS_ITEMS.some((s) => s.id === sectionParam) ? sectionParam : 'general';
    const setSection = (s) => navigate(`/wordpress/${id}/settings/${s}`, { replace: true });
    const active = WP_SETTINGS_ITEMS.find((s) => s.id === section) || WP_SETTINGS_ITEMS[0];
    const ctx = { siteId, site, onUpdate, onAddDomain, onChangeUrl, onClone };
    return (
        <div className="wp-settings">
            <nav className="wp-settings__nav" aria-label={t('wp.settingsTab.wordpressSettingsSections', 'WordPress settings sections')}>
                {WP_SETTINGS_GROUPS.map((g) => (
                    <div className="wp-settings__group" key={g.label}>
                        <div className="wp-settings__grouplabel">{g.label}</div>
                        {g.items.map((s) => (
                            <button
                                type="button"
                                key={s.id}
                                className={`wp-settings__navitem ${section === s.id ? 'is-active' : ''}`}
                                onClick={() => setSection(s.id)}
                            >
                                <s.icon size={15} />
                                {s.label}
                            </button>
                        ))}
                    </div>
                ))}
            </nav>
            <div className="wp-settings__content">
                {active.render(ctx)}
            </div>
        </div>
    );
};

export default SettingsTab;
