import { useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import wordpressApi from '../services/wordpress';
import { useToast } from 'serverkit-sdk';
import { ResourceAdvisory } from 'serverkit-sdk';
import { Spinner } from 'serverkit-sdk';
import { ResourceListPage } from 'serverkit-sdk';
import { Globe, ChevronRight } from 'lucide-react';
import { Pill, ServiceTile, Drawer } from 'serverkit-sdk';
import { useTopbarActions } from 'serverkit-sdk';
import { Modal } from 'serverkit-sdk';
import { Button } from 'serverkit-sdk';
import { Input } from 'serverkit-sdk';
import { Label } from 'serverkit-sdk';
import { Checkbox } from 'serverkit-sdk';
import { useTranslation } from 'serverkit-sdk';
import { emitWalkthroughSignal } from 'serverkit-sdk';

// Mirror the backend slug rule (a-z, 0-9, single dashes) so the create modal can
// preview the exact <slug>.<base> host the site will be published at.
function slugifyPreview(name) {
    return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'site';
}

function WordPress() {
    const { t } = useTranslation();
    const [sites, setSites] = useState([]);
    const [loading, setLoading] = useState(true);
    const [activeTag, setActiveTag] = useState(null); // null = show all
    const [statusFilter, setStatusFilter] = useState('all'); // all | running | stopped
    const [siteSearch, setSiteSearch] = useState(''); // client-side name/title/domain filter
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [createLoading, setCreateLoading] = useState(false);
    const [createForm, setCreateForm] = useState({
        name: '', domain: '', adminEmail: '', phpVersion: '', enablePageCache: false, enableObjectCache: false,
        baseDomain: '',
    });
    // Base domains a new site can be published under (<slug>.<base>), loaded when
    // the create modal opens. Empty when site routing isn't configured.
    const [baseDomains, setBaseDomains] = useState([]);
    const [createdCreds, setCreatedCreds] = useState(null);
    // Where a freshly-created site is reachable, so we can tell the user it is
    // already live (at <slug>.<base>, HTTPS when the wildcard cert is set up)
    // rather than leaving them to wonder — or nudge them to set a base domain
    // when the site only came up on localhost.
    const [createdSite, setCreatedSite] = useState(null);
    const [showImportModal, setShowImportModal] = useState(false);
    const [importLoading, setImportLoading] = useState(false);
    const [importForm, setImportForm] = useState({ name: '', adminEmail: '', oldUrl: '' });
    const [importFile, setImportFile] = useState(null);
    const [wpContentFile, setWpContentFile] = useState(null);
    const [selectedIds, setSelectedIds] = useState(new Set());
    const [bulkLoading, setBulkLoading] = useState(false);

    const navigate = useNavigate();
    const location = useLocation();
    const toast = useToast();

    useEffect(() => {
        loadSites();
    }, []);

    useEffect(() => {
        const focus = new URLSearchParams(location.search).get('focus');
        if (focus === 'create:site') setShowCreateModal(true);
    }, [location.search]);

    // Load the available base domains when the create modal opens, and preselect
    // the default so the site publishes under it unless the user picks another.
    useEffect(() => {
        if (!showCreateModal) return;
        let cancelled = false;
        (async () => {
            try {
                const data = await wordpressApi.listBaseDomains();
                if (cancelled) return;
                const bases = data.base_domains || [];
                setBaseDomains(bases);
                setCreateForm(f => ({ ...f, baseDomain: f.baseDomain || data.default || '' }));
            } catch {
                if (!cancelled) setBaseDomains([]);
            }
        })();
        return () => { cancelled = true; };
    }, [showCreateModal]);

    const loadSites = async () => {
        setLoading(true);
        try {
            const data = await wordpressApi.getSites();
            setSites(data.sites || []);
        } catch (error) {
            console.error('Failed to load WordPress sites:', error);
            setSites([]);
        } finally {
            setLoading(false);
        }
    };

    const handleCreate = async () => {
        if (!createForm.name) {
            toast.error(t('wp.wordPress.siteNameIsRequired', 'Site name is required'));
            return;
        }

        setCreateLoading(true);
        try {
            const result = await wordpressApi.createSite(createForm);
            if (result.success) {
                if (result.admin_password) {
                    // The generated admin password is returned once — surface it.
                    setCreatedCreds({ user: result.admin_user || 'admin', password: result.admin_password });
                }
                if (result.url) {
                    setCreatedSite({ url: result.url, domain: result.domain || null });
                }
                if (result.warning) {
                    toast.info(result.warning, { duration: 8000 });
                }
                toast.success(t('wp.wordPress.wordpressSiteCreatedSuccessfully', 'WordPress site created successfully'));
                emitWalkthroughSignal('wordpress.site-created', { siteId: result.site?.id || result.site_id });
                setShowCreateModal(false);
                setCreateForm({ name: '', domain: '', adminEmail: '', phpVersion: '', enablePageCache: false, enableObjectCache: false, baseDomain: '' });
                await loadSites();
            } else {
                toast.error(result.error || t('wp.wordPress.failedToCreateSite', 'Failed to create site'));
            }
        } catch (error) {
            toast.error(t('wp.wordPress.failedToCreateSite2', 'Failed to create site: {{message}}', { message: error.message }));
        } finally {
            setCreateLoading(false);
        }
    };

    // Bulk ops fan out per-site (no bulk route yet — §5); `applies` filters the
    // selection to sites the action makes sense for.
    const bulkRun = async (label, fn, applies = () => true) => {
        const targets = sites.filter(s => selectedIds.has(s.id) && applies(s));
        if (targets.length === 0) {
            toast.info(t('wp.wordPress.noSelectedSitesNeed', 'No selected sites need "{{label}}"', { label: label }));
            return;
        }
        setBulkLoading(true);
        try {
            const results = await Promise.allSettled(targets.map(s => fn(s)));
            const failed = results.filter(r => r.status === 'rejected').length;
            if (failed) toast.error(t('wp.wordPress.ofFailed', '{{label}}: {{failed}} of {{length}} failed', { label: label, failed: failed, length: targets.length }));
            else toast.success(t('wp.wordPress.sentToSite', '{{label}} sent to {{length}} site{{value}}', { label: label, length: targets.length, value: targets.length === 1 ? '' : 's' }));
            setSelectedIds(new Set());
            await loadSites();
        } finally {
            setBulkLoading(false);
        }
    };

    const handleImport = async () => {
        if (!importForm.name) { toast.error(t('wp.wordPress.siteNameIsRequired2', 'Site name is required')); return; }
        if (!importForm.oldUrl) { toast.error(t('wp.wordPress.originalSiteUrlIsRequired', 'Original site URL is required')); return; }
        if (!importFile) { toast.error(t('wp.wordPress.aSqlOrSqlGzDump', 'A .sql or .sql.gz dump is required')); return; }
        setImportLoading(true);
        try {
            const result = await wordpressApi.importSite({
                name: importForm.name,
                adminEmail: importForm.adminEmail,
                oldUrl: importForm.oldUrl,
                sqlFile: importFile,
                wpContentFile: wpContentFile,
            });
            if (result.success) {
                toast.success(t('wp.wordPress.wordpressSiteImportedSuccessfully', 'WordPress site imported successfully'));
                if (result.wp_content_imported) toast.success(t('wp.wordPress.wpContentPluginsThemesUploadsImported', 'wp-content (plugins/themes/uploads) imported'));
                if (result.warning) toast.info(result.warning, { duration: 8000 });
                setShowImportModal(false);
                setImportForm({ name: '', adminEmail: '', oldUrl: '' });
                setImportFile(null);
                setWpContentFile(null);
                await loadSites();
            } else {
                toast.error(result.error || t('wp.wordPress.failedToImportSite', 'Failed to import site'));
            }
        } catch (error) {
            toast.error(t('wp.wordPress.failedToImportSite2', 'Failed to import site: {{message}}', { message: error.message }));
        } finally {
            setImportLoading(false);
        }
    };

    useTopbarActions(() =>
        <>
            <Button variant="outline" size="sm" onClick={() => navigate('/imports')}>
                {t('wp.wordPress.importASite', 'Import a site')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setShowImportModal(true)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                {t('wp.wordPress.importSite', 'Import Site')}
            </Button>
            <Button size="sm" onClick={() => setShowCreateModal(true)} data-walkthrough="wordpress-create-site">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                {t('wp.wordPress.createSite', 'Create Site')}
            </Button>
        </>,
        []
    );

    const allTags = Array.from(new Set(sites.flatMap(s => s.tags || []))).sort();
    const runningCount = sites.filter(s => s.status === 'running').length;
    const q = siteSearch.trim().toLowerCase();
    const siteLabel = site => site.name || site.application?.name || `Site ${site.id}`;
    const shownSites = sites.filter(site => (
        (statusFilter === 'all'
            || (statusFilter === 'running' ? site.status === 'running' : site.status !== 'running'))
        && (activeTag === null || (site.tags || []).includes(activeTag))
        && (q === '' || [siteLabel(site), site.title, site.url, site.domain]
            .some(v => v && String(v).toLowerCase().includes(q)))
    ));
    const allSelected = shownSites.length > 0 && shownSites.every(s => selectedIds.has(s.id));

    const columns = [
        {
            key: '__select',
            className: 'wp-list__ck',
            cellClassName: 'wp-list__ck',
            header: (
                <Checkbox
                    checked={allSelected}
                    onCheckedChange={(checked) => setSelectedIds(checked ? new Set(shownSites.map(s => s.id)) : new Set())}
                    aria-label={t('wp.wordPress.selectAllSites', 'Select all sites')}
                />
            ),
            render: (site) => (
                <div onClick={e => e.stopPropagation()}>
                    <Checkbox
                        checked={selectedIds.has(site.id)}
                        onCheckedChange={(checked) => {
                            setSelectedIds(prev => {
                                const next = new Set(prev);
                                if (checked) next.add(site.id);
                                else next.delete(site.id);
                                return next;
                            });
                        }}
                        aria-label={t('wp.wordPress.select', 'Select {{value}}', { value: site.name || `site ${site.id}` })}
                    />
                </div>
            ),
        },
        {
            key: 'name',
            headerKey: 'wp.wordPress.site', header: 'Site',
            render: (site) => (
                <div className="sk-cell-name">
                    <ServiceTile name={siteLabel(site)} size={30} className="wp-list__tile" aria-hidden="true" />
                    <span>
                        <div>{siteLabel(site)}</div>
                        {site.port && <div className="sk-cell-sub">:{site.port}</div>}
                    </span>
                </div>
            ),
        },
        { key: 'environments', headerKey: 'wp.wordPress.environments', header: 'Environments', cellClassName: 'sk-cell-mono', render: (site) => (site.environment_count || 0) + 1 },
        { key: 'version', headerKey: 'wp.wordPress.version', header: 'Version', cellClassName: 'sk-cell-mono', render: (site) => `WP ${site.wp_version || '6.4'}` },
        {
            key: 'status',
            headerKey: 'wp.wordPress.status', header: 'Status',
            render: (site) => (
                <Pill kind={site.status === 'running' ? 'green' : 'gray'}>
                    {site.status === 'running' ? 'Running' : 'Stopped'}
                </Pill>
            ),
        },
        {
            key: 'tags',
            headerKey: 'wp.wordPress.tags', header: 'Tags',
            render: (site) => (
                site.tags?.length
                    ? site.tags.map(tag => <span key={tag} className="sk-tag">{tag}</span>)
                    : <span className="wp-list__dash">—</span>
            ),
        },
        {
            key: '__links',
            header: '',
            width: 70,
            render: (site) => (
                site.url && site.status === 'running' ? (
                    <div className="wp-list__links" onClick={e => e.stopPropagation()}>
                        <a href={site.url} target="_blank" rel="noopener noreferrer" title={t('wp.wordPress.openSite', 'Open site')} aria-label={t('wp.wordPress.openSite2', 'Open site')}>
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                        </a>
                        <a href={`${site.url}/wp-admin`} target="_blank" rel="noopener noreferrer" title={t('wp.wordPress.wpAdmin', 'WP Admin')} aria-label={t('wp.wordPress.wpAdmin2', 'WP Admin')}>
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                        </a>
                    </div>
                ) : (
                    <ChevronRight size={16} className="wp-list__chev" />
                )
            ),
        },
    ];

    return (
        <ResourceListPage
            className="wordpress-page"
            loading={loading}
            totalCount={sites.length}
            items={shownSites}
            columns={columns}
            keyField="id"
            onRowClick={(site) => navigate(`/wordpress/${site.id}`)}
            rowClassName={(site) => (selectedIds.has(site.id) ? 'is-selected' : '')}
            header={<>
                {/* Advisory, not a gate: a constrained server says so here and
                    the operator still decides. */}
                <ResourceAdvisory workload="wordpress" />
                {(createdCreds || createdSite) && (
                <div className="wp-creds-banner" data-walkthrough="wordpress-created-site">
                    <div className="wp-creds-banner-text">
                        {createdSite && (createdSite.domain ? (
                            <span>
                                {t('wp.wordPress.yourSiteIsLiveAt', 'Your site is live at')}{' '}
                                <a href={createdSite.url} target="_blank" rel="noopener noreferrer"><code>{createdSite.domain}</code></a>
                                {createdSite.url?.startsWith('https')
                                    ? ` ${t('wp.wordPress.httpsIsReady', '— HTTPS is ready.')}`
                                    : '.'}
                            </span>
                        ) : (
                            <span>
                                {t('wp.wordPress.yourSiteIsRunningAt', 'Your site is running at')}{' '}
                                <a href={createdSite.url} target="_blank" rel="noopener noreferrer"><code>{createdSite.url}</code></a>.
                                {' '}{t('wp.wordPress.setAManagedSitesBaseDomain', 'Set a managed-sites base domain in Settings to publish it at a public URL.')}
                            </span>
                        ))}
                        {createdCreds && (
                            <>
                                <strong>{t('wp.wordPress.saveTheseAdminCredentialsTheyAre', 'Save these admin credentials — they are shown only once.')}</strong>
                                <span>{t('wp.wordPress.username', 'Username:')} <code>{createdCreds.user}</code></span>
                                <span>{t('wp.wordPress.password', 'Password:')} <code>{createdCreds.password}</code></span>
                            </>
                        )}
                    </div>
                    <Button variant="ghost" onClick={() => { setCreatedCreds(null); setCreatedSite(null); }}>{t('wp.wordPress.dismiss', 'Dismiss')}</Button>
                </div>
                )}
            </>}
            filters={[
                { value: 'all', labelKey: 'wp.wordPress.all', label: 'All', count: sites.length },
                { value: 'running', labelKey: 'wp.wordPress.running', label: 'Running', count: runningCount },
                { value: 'stopped', labelKey: 'wp.wordPress.stopped', label: 'Stopped', count: sites.length - runningCount },
            ]}
            activeFilter={statusFilter}
            onFilterChange={setStatusFilter}
            searchTerm={siteSearch}
            onSearchChange={setSiteSearch}
            searchPlaceholder="Search sites…"
            toolbarExtra={allTags.length > 0 && (
                <div className="wp-tag-filter">
                    <button type="button"
                        className={`wp-tag-chip wp-tag-chip--filter ${activeTag === null ? 'is-active' : ''}`}
                        onClick={() => setActiveTag(null)}
                    >
                        {t('wp.wordPress.allTags', 'All tags')}
                    </button>
                    {allTags.map(tag => (
                        <button type="button"
                            key={tag}
                            className={`wp-tag-chip wp-tag-chip--filter ${activeTag === tag ? 'is-active' : ''}`}
                            onClick={() => setActiveTag(tag)}
                        >
                            {tag}
                        </button>
                    ))}
                </div>
            )}
            selectedCount={selectedIds.size}
            onClearSelection={() => setSelectedIds(new Set())}
            bulkActions={
                <>
                    <Button variant="outline" size="sm" disabled={bulkLoading}
                        onClick={() => bulkRun('Start', s => wordpressApi.unarchiveSite(s.id), s => s.status !== 'running')}>
                        {t('wp.wordPress.start', 'Start')}
                    </Button>
                    <Button variant="outline" size="sm" disabled={bulkLoading}
                        onClick={() => bulkRun('Stop', s => wordpressApi.archiveSite(s.id), s => s.status === 'running')}>
                        {t('wp.wordPress.stop', 'Stop')}
                    </Button>
                    <Button variant="outline" size="sm" disabled={bulkLoading}
                        onClick={() => bulkRun('Update core', s => wordpressApi.updateCore(s.id), s => s.status === 'running')}>
                        {t('wp.wordPress.update', 'Update')}
                    </Button>
                    <Button variant="outline" size="sm" disabled={bulkLoading}
                        onClick={() => bulkRun('Backup', s => wordpressApi.createSnapshot(s.id, { name: 'bulk-backup' }), s => s.status === 'running')}>
                        {t('wp.wordPress.backup', 'Backup')}
                    </Button>
                    <Button variant="outline" size="sm" disabled={bulkLoading}
                        onClick={() => bulkRun('Clear cache', s => wordpressApi.flushCache(s.id), s => s.status === 'running')}>
                        {t('wp.wordPress.clearCache', 'Clear cache')}
                    </Button>
                </>
            }
            emptyIcon={Globe}
            emptyTitle="No WordPress Sites"
            emptyDescription="Create your first WordPress site powered by Docker. Each site gets its own isolated environment with MySQL."
            emptyAction={
                <Button onClick={() => setShowCreateModal(true)} data-walkthrough="wordpress-create-site">
                    {t('wp.wordPress.createSite2', 'Create Site')}
                </Button>
            }
            filteredEmptyIcon={Globe}
            filteredEmptyTitle="No sites found"
            filteredEmptyDescription="Try adjusting your search or filter"
        >
            {/* Import Site Modal */}
            <Modal
                open={showImportModal}
                onClose={() => !importLoading && setShowImportModal(false)}
                title={t('wp.wordPress.importWordpressSite', 'Import WordPress Site')}
                size="lg"
            >
                <div className="modal-body">
                            <div className="install-warning">
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
                                <div>
                                    <strong>{t('wp.wordPress.importsADatabaseDumpIntoA', 'Imports a database dump into a new stack:')}</strong>
                                    <ul>
                                        <li>{t('wp.wordPress.provisionsAFreshWordpressMysqlContainer', 'Provisions a fresh WordPress + MySQL container')}</li>
                                        <li>{t('wp.wordPress.loadsYourSqlSqlGzDump', 'Loads your .sql / .sql.gz dump')}</li>
                                        <li>{t('wp.wordPress.rewritesTheSiteUrlToThis', 'Rewrites the site URL to this server')}</li>
                                    </ul>
                                </div>
                            </div>

                            <div className="form-group">
                                <Label>{t('wp.wordPress.siteName', 'Site Name')} <span className="required">*</span></Label>
                                <Input
                                    type="text"
                                    value={importForm.name}
                                    onChange={e => setImportForm({ ...importForm, name: e.target.value })}
                                    placeholder="my-imported-site"
                                    disabled={importLoading}
                                />
                                <span className="form-hint">{t('wp.wordPress.usedAsTheDockerProjectName', 'Used as the Docker project name. Letters, numbers, and hyphens only.')}</span>
                            </div>

                            <div className="form-group">
                                <Label>{t('wp.wordPress.originalSiteUrl', 'Original Site URL')} <span className="required">*</span></Label>
                                <Input
                                    type="text"
                                    value={importForm.oldUrl}
                                    onChange={e => setImportForm({ ...importForm, oldUrl: e.target.value })}
                                    placeholder="https://old-site.com"
                                    disabled={importLoading}
                                />
                                <span className="form-hint">{t('wp.wordPress.theLiveUrlInYourDump', 'The live URL in your dump; we rewrite it to the localhost address on this server.')}</span>
                            </div>

                            <div className="form-group">
                                <Label>{t('wp.wordPress.adminEmail', 'Admin Email')}</Label>
                                <Input
                                    type="email"
                                    value={importForm.adminEmail}
                                    onChange={e => setImportForm({ ...importForm, adminEmail: e.target.value })}
                                    placeholder="admin@example.com"
                                    disabled={importLoading}
                                />
                            </div>

                            <div className="form-group">
                                <Label>{t('wp.wordPress.databaseDump', 'Database Dump')} <span className="required">*</span></Label>
                                <input
                                    type="file"
                                    accept=".sql,.gz,.sql.gz"
                                    disabled={importLoading}
                                    onChange={e => setImportFile(e.target.files?.[0] || null)}
                                />
                                <span className="form-hint">{t('wp.wordPress.exportViaPhpmyadminOrTheWp', 'Export via phpMyAdmin or the wp db export command. .sql.gz is supported and recommended (100MB upload limit).')}</span>
                            </div>

                            <div className="form-group">
                                <Label>{t('wp.wordPress.wpContentArchiveOptional', 'wp-content archive (optional)')}</Label>
                                <input
                                    type="file"
                                    accept=".zip"
                                    disabled={importLoading}
                                    onChange={e => setWpContentFile(e.target.files?.[0] || null)}
                                />
                                <span className="form-hint">{t('wp.wordPress.aZipOfWpContentPlugins', 'A .zip of wp-content (plugins/themes/uploads) or the full site. Copied into the new container after the database import. Leave empty to import the database only.')}</span>
                            </div>
                        </div>
                        <div className="modal-footer">
                            <Button variant="outline" onClick={() => setShowImportModal(false)} disabled={importLoading}>
                                {t('wp.wordPress.cancel', 'Cancel')}
                            </Button>
                            <Button onClick={handleImport} disabled={importLoading || !importForm.name || !importForm.oldUrl || !importFile}>
                                {importLoading ? <><Spinner size="sm" /> {t('wp.wordPress.importing', 'Importing...')}</> : 'Import Site'}
                            </Button>
                        </div>
            </Modal>

            {/* Create Site — the same drawer shape the templates catalog uses, so
                creating a WordPress site and deploying a template feel like one
                product rather than two. */}
            <Drawer
                flush
                open={showCreateModal}
                onOpenChange={(next) => { if (!next && !createLoading) setShowCreateModal(false); }}
                title={t('wp.wordPress.createWordpressSite', 'Create WordPress Site')}
                subtitle={t('wp.wordPress.wordpressMysqlOnAnIsolatedDocker', 'WordPress + MySQL on an isolated Docker network')}
                icon={<Globe size={20} />}
                width={560}
                className="sk-formdrawer"
            >
                <div className="sk-formdrawer__form" data-walkthrough="wordpress-create-form">
                    <div className="sk-formdrawer__body">
                            <div className="sk-formdrawer__callout">
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
                                <div>
                                    <strong>{t('wp.wordPress.thisWillCreate', 'This will create:')}</strong>
                                    <ul>
                                        <li>{t('wp.wordPress.wordpress64ApacheContainer', 'WordPress 6.4 (Apache) container')}</li>
                                        <li>{t('wp.wordPress.mysql80DatabaseContainer', 'MySQL 8.0 database container')}</li>
                                        <li>{t('wp.wordPress.isolatedDockerNetwork', 'Isolated Docker network')}</li>
                                    </ul>
                                </div>
                            </div>

                            <div className="sk-formdrawer__field">
                                <Label>
                                    {t('wp.wordPress.siteName2', 'Site Name')} <span className="required">*</span>
                                </Label>
                                <Input
                                    type="text"
                                    value={createForm.name}
                                    onChange={e => setCreateForm({ ...createForm, name: e.target.value })}
                                    placeholder="my-wordpress-site"
                                    disabled={createLoading}
                                />
                                <span className="sk-formdrawer__hint">{t('wp.wordPress.usedAsTheDockerProjectName2', 'Used as the Docker project name. Letters, numbers, and hyphens only.')}</span>
                            </div>

                            {baseDomains.length > 0 ? (
                                <div className="sk-formdrawer__field">
                                    <Label>{t('wp.wordPress.publishUnder', 'Publish under')}</Label>
                                    <select
                                        value={createForm.baseDomain}
                                        onChange={e => setCreateForm({ ...createForm, baseDomain: e.target.value })}
                                        disabled={createLoading}
                                    >
                                        {baseDomains.map(b => (
                                            <option key={b.domain} value={b.domain}>
                                                {b.domain}{b.is_default ? ' (default)' : ''}{b.https_enabled ? ' — HTTPS' : ''}
                                            </option>
                                        ))}
                                    </select>
                                    <span className="sk-formdrawer__hint">
                                        {createForm.name
                                            ? <>{t('wp.wordPress.theSiteWillBeLiveAt', 'The site will be live at')} <code>{slugifyPreview(createForm.name)}.{createForm.baseDomain}</code>.</>
                                            : <>{t('wp.wordPress.whichBaseDomainToPublishThis', 'Which base domain to publish this site under.')}</>}
                                    </span>
                                </div>
                            ) : (
                                <div className="sk-formdrawer__field">
                                    <Label>{t('wp.wordPress.publishUnder2', 'Publish under')}</Label>
                                    <span className="sk-formdrawer__hint">{t('wp.wordPress.noBaseDomainConfiguredTheSite', 'No base domain configured — the site will be reachable at')} <code>localhost:&lt;port&gt;</code>. Add a managed-sites base domain in Settings to publish it at a real subdomain.</span>
                                </div>
                            )}

                            <div className="sk-formdrawer__field">
                                <Label>{t('wp.wordPress.customDomain', 'Custom Domain')}</Label>
                                <Input
                                    type="text"
                                    value={createForm.domain}
                                    onChange={e => setCreateForm({ ...createForm, domain: e.target.value })}
                                    placeholder="example.com"
                                    disabled={createLoading}
                                />
                                <span className="sk-formdrawer__hint">{t('wp.wordPress.optionalOverridesTheBaseDomainAbove', 'Optional. Overrides the base domain above — the site is created and migrated to this domain.')}</span>
                            </div>

                            <div className="sk-formdrawer__field">
                                <Label>{t('wp.wordPress.adminEmail2', 'Admin Email')}</Label>
                                <Input
                                    type="email"
                                    value={createForm.adminEmail}
                                    onChange={e => setCreateForm({ ...createForm, adminEmail: e.target.value })}
                                    placeholder="admin@example.com"
                                    disabled={createLoading}
                                />
                            </div>

                            <div className="sk-formdrawer__field">
                                <Label>{t('wp.wordPress.phpVersion', 'PHP Version')}</Label>
                                <select
                                    value={createForm.phpVersion}
                                    onChange={e => setCreateForm({ ...createForm, phpVersion: e.target.value })}
                                    disabled={createLoading}
                                >
                                    <option value="">{t('wp.wordPress.defaultLatestForWordpress64', 'Default (latest for WordPress 6.4)')}</option>
                                    <option value="8.1">{t('wp.wordPress.php81', 'PHP 8.1')}</option>
                                    <option value="8.2">{t('wp.wordPress.php82', 'PHP 8.2')}</option>
                                    <option value="8.3">{t('wp.wordPress.php83', 'PHP 8.3')}</option>
                                </select>
                                <span className="sk-formdrawer__hint">{t('wp.wordPress.bakedIntoTheContainerImageAt', 'Baked into the container image at creation. Changeable later from the PHP tab.')}</span>
                            </div>

                            <div className="sk-formdrawer__field">
                                <label className="checkbox-label">
                                    <input
                                        type="checkbox"
                                        checked={createForm.enablePageCache}
                                        onChange={e => setCreateForm({ ...createForm, enablePageCache: e.target.checked })}
                                        disabled={createLoading}
                                    />
                                    {t('wp.wordPress.enableFullPageCache', 'Enable full-page cache')}
                                </label>
                                <span className="sk-formdrawer__hint">{t('wp.wordPress.diskPageCacheWithWordpressAware', 'Disk page cache with WordPress-aware skip rules (admin, login, cart, checkout).')}</span>
                            </div>

                            <div className="sk-formdrawer__field">
                                <label className="checkbox-label">
                                    <input
                                        type="checkbox"
                                        checked={createForm.enableObjectCache}
                                        onChange={e => setCreateForm({ ...createForm, enableObjectCache: e.target.checked })}
                                        disabled={createLoading}
                                    />
                                    {t('wp.wordPress.enableRedisObjectCache', 'Enable Redis object cache')}
                                </label>
                                <span className="sk-formdrawer__hint">{t('wp.wordPress.usesTheBundledRedisContainerWith', 'Uses the bundled Redis container with the redis-cache drop-in.')}</span>
                            </div>
                    </div>
                    <div className="sk-formdrawer__foot">
                        <Button
                            variant="outline"
                            onClick={() => setShowCreateModal(false)}
                            disabled={createLoading}
                        >
                            {t('wp.wordPress.cancel2', 'Cancel')}
                        </Button>
                        <Button
                            onClick={handleCreate}
                            disabled={createLoading || !createForm.name}
                            data-walkthrough="wordpress-create-submit"
                        >
                            {createLoading ? <><Spinner size="sm" /> {t('wp.wordPress.creating', 'Creating...')}</> : 'Create Site'}
                        </Button>
                    </div>
                </div>
            </Drawer>
        </ResourceListPage>
    );
}

export default WordPress;
