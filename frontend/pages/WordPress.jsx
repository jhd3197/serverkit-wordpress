import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
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
import { SkeletonBoundary } from 'serverkit-sdk';

// Mirror the backend slug rule (a-z, 0-9, single dashes) so the create modal can
// preview the exact <slug>.<base> host the site will be published at.
function slugifyPreview(name) {
    return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'site';
}

function WordPress() {
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
    const toast = useToast();

    useEffect(() => {
        loadSites();
    }, []);

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
            toast.error('Site name is required');
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
                toast.success('WordPress site created successfully');
                setShowCreateModal(false);
                setCreateForm({ name: '', domain: '', adminEmail: '', phpVersion: '', enablePageCache: false, enableObjectCache: false, baseDomain: '' });
                await loadSites();
            } else {
                toast.error(result.error || 'Failed to create site');
            }
        } catch (error) {
            toast.error(`Failed to create site: ${error.message}`);
        } finally {
            setCreateLoading(false);
        }
    };

    // Bulk ops fan out per-site (no bulk route yet — §5); `applies` filters the
    // selection to sites the action makes sense for.
    const bulkRun = async (label, fn, applies = () => true) => {
        const targets = sites.filter(s => selectedIds.has(s.id) && applies(s));
        if (targets.length === 0) {
            toast.info(`No selected sites need "${label}"`);
            return;
        }
        setBulkLoading(true);
        try {
            const results = await Promise.allSettled(targets.map(s => fn(s)));
            const failed = results.filter(r => r.status === 'rejected').length;
            if (failed) toast.error(`${label}: ${failed} of ${targets.length} failed`);
            else toast.success(`${label} sent to ${targets.length} site${targets.length === 1 ? '' : 's'}`);
            setSelectedIds(new Set());
            await loadSites();
        } finally {
            setBulkLoading(false);
        }
    };

    const handleImport = async () => {
        if (!importForm.name) { toast.error('Site name is required'); return; }
        if (!importForm.oldUrl) { toast.error('Original site URL is required'); return; }
        if (!importFile) { toast.error('A .sql or .sql.gz dump is required'); return; }
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
                toast.success('WordPress site imported successfully');
                if (result.wp_content_imported) toast.success('wp-content (plugins/themes/uploads) imported');
                if (result.warning) toast.info(result.warning, { duration: 8000 });
                setShowImportModal(false);
                setImportForm({ name: '', adminEmail: '', oldUrl: '' });
                setImportFile(null);
                setWpContentFile(null);
                await loadSites();
            } else {
                toast.error(result.error || 'Failed to import site');
            }
        } catch (error) {
            toast.error(`Failed to import site: ${error.message}`);
        } finally {
            setImportLoading(false);
        }
    };

    useTopbarActions(() =>
        <>
            <Button variant="outline" size="sm" onClick={() => navigate('/imports')}>
                Import a site
            </Button>
            <Button variant="outline" size="sm" onClick={() => setShowImportModal(true)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                Import Site
            </Button>
            <Button size="sm" onClick={() => setShowCreateModal(true)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                Create Site
            </Button>
        </>,
        []
    );

    const wpListSkeleton = (
        <div className="wp-sites-grid">
            {[1, 2, 3].map(i => (
                <div key={i} className="wp-site-card-skeleton">
                    <div className="wp-site-card-skeleton-header">
                        <div className="wp-site-card-skeleton-icon" />
                        <div className="wp-site-card-skeleton-info">
                            <div className="wp-site-card-skeleton-name" />
                            <div className="wp-site-card-skeleton-url" />
                        </div>
                        <div className="wp-site-card-skeleton-status" />
                    </div>
                    <div className="wp-site-card-skeleton-body">
                        <div className="wp-site-card-skeleton-meta">
                            <div className="wp-site-card-skeleton-label" />
                            <div className="wp-site-card-skeleton-value" />
                        </div>
                        <div className="wp-site-card-skeleton-meta">
                            <div className="wp-site-card-skeleton-label" />
                            <div className="wp-site-card-skeleton-value" />
                        </div>
                    </div>
                </div>
            ))}
        </div>
    );

    if (loading) {
        return (
            <SkeletonBoundary
                className="sk-tabgroup__inner wordpress-page"
                loading
                skeleton={wpListSkeleton}
            />
        );
    }

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
                    aria-label="Select all sites"
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
                        aria-label={`Select ${site.name || `site ${site.id}`}`}
                    />
                </div>
            ),
        },
        {
            key: 'name',
            header: 'Site',
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
        { key: 'environments', header: 'Environments', cellClassName: 'sk-cell-mono', render: (site) => (site.environment_count || 0) + 1 },
        { key: 'version', header: 'Version', cellClassName: 'sk-cell-mono', render: (site) => `WP ${site.wp_version || '6.4'}` },
        {
            key: 'status',
            header: 'Status',
            render: (site) => (
                <Pill kind={site.status === 'running' ? 'green' : 'gray'}>
                    {site.status === 'running' ? 'Running' : 'Stopped'}
                </Pill>
            ),
        },
        {
            key: 'tags',
            header: 'Tags',
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
                        <a href={site.url} target="_blank" rel="noopener noreferrer" title="Open site" aria-label="Open site">
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                        </a>
                        <a href={`${site.url}/wp-admin`} target="_blank" rel="noopener noreferrer" title="WP Admin" aria-label="WP Admin">
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
                <div className="wp-creds-banner">
                    <div className="wp-creds-banner-text">
                        {createdSite && (createdSite.domain ? (
                            <span>
                                Your site is live at{' '}
                                <a href={createdSite.url} target="_blank" rel="noopener noreferrer"><code>{createdSite.domain}</code></a>
                                {createdSite.url?.startsWith('https') ? ' — HTTPS is ready.' : '.'}
                            </span>
                        ) : (
                            <span>
                                Your site is running at{' '}
                                <a href={createdSite.url} target="_blank" rel="noopener noreferrer"><code>{createdSite.url}</code></a>.
                                {' '}Set a managed-sites base domain in Settings to publish it at a public URL.
                            </span>
                        ))}
                        {createdCreds && (
                            <>
                                <strong>Save these admin credentials — they are shown only once.</strong>
                                <span>Username: <code>{createdCreds.user}</code></span>
                                <span>Password: <code>{createdCreds.password}</code></span>
                            </>
                        )}
                    </div>
                    <Button variant="ghost" onClick={() => { setCreatedCreds(null); setCreatedSite(null); }}>Dismiss</Button>
                </div>
                )}
            </>}
            filters={[
                { value: 'all', label: 'All', count: sites.length },
                { value: 'running', label: 'Running', count: runningCount },
                { value: 'stopped', label: 'Stopped', count: sites.length - runningCount },
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
                        All tags
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
                        Start
                    </Button>
                    <Button variant="outline" size="sm" disabled={bulkLoading}
                        onClick={() => bulkRun('Stop', s => wordpressApi.archiveSite(s.id), s => s.status === 'running')}>
                        Stop
                    </Button>
                    <Button variant="outline" size="sm" disabled={bulkLoading}
                        onClick={() => bulkRun('Update core', s => wordpressApi.updateCore(s.id), s => s.status === 'running')}>
                        Update
                    </Button>
                    <Button variant="outline" size="sm" disabled={bulkLoading}
                        onClick={() => bulkRun('Backup', s => wordpressApi.createSnapshot(s.id, { name: 'bulk-backup' }), s => s.status === 'running')}>
                        Backup
                    </Button>
                    <Button variant="outline" size="sm" disabled={bulkLoading}
                        onClick={() => bulkRun('Clear cache', s => wordpressApi.flushCache(s.id), s => s.status === 'running')}>
                        Clear cache
                    </Button>
                </>
            }
            emptyIcon={Globe}
            emptyTitle="No WordPress Sites"
            emptyDescription="Create your first WordPress site powered by Docker. Each site gets its own isolated environment with MySQL."
            emptyAction={
                <Button onClick={() => setShowCreateModal(true)}>
                    Create Site
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
                title="Import WordPress Site"
                size="lg"
            >
                <div className="modal-body">
                            <div className="install-warning">
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
                                <div>
                                    <strong>Imports a database dump into a new stack:</strong>
                                    <ul>
                                        <li>Provisions a fresh WordPress + MySQL container</li>
                                        <li>Loads your .sql / .sql.gz dump</li>
                                        <li>Rewrites the site URL to this server</li>
                                    </ul>
                                </div>
                            </div>

                            <div className="form-group">
                                <Label>Site Name <span className="required">*</span></Label>
                                <Input
                                    type="text"
                                    value={importForm.name}
                                    onChange={e => setImportForm({ ...importForm, name: e.target.value })}
                                    placeholder="my-imported-site"
                                    disabled={importLoading}
                                />
                                <span className="form-hint">Used as the Docker project name. Letters, numbers, and hyphens only.</span>
                            </div>

                            <div className="form-group">
                                <Label>Original Site URL <span className="required">*</span></Label>
                                <Input
                                    type="text"
                                    value={importForm.oldUrl}
                                    onChange={e => setImportForm({ ...importForm, oldUrl: e.target.value })}
                                    placeholder="https://old-site.com"
                                    disabled={importLoading}
                                />
                                <span className="form-hint">The live URL in your dump; we rewrite it to the localhost address on this server.</span>
                            </div>

                            <div className="form-group">
                                <Label>Admin Email</Label>
                                <Input
                                    type="email"
                                    value={importForm.adminEmail}
                                    onChange={e => setImportForm({ ...importForm, adminEmail: e.target.value })}
                                    placeholder="admin@example.com"
                                    disabled={importLoading}
                                />
                            </div>

                            <div className="form-group">
                                <Label>Database Dump <span className="required">*</span></Label>
                                <input
                                    type="file"
                                    accept=".sql,.gz,.sql.gz"
                                    disabled={importLoading}
                                    onChange={e => setImportFile(e.target.files?.[0] || null)}
                                />
                                <span className="form-hint">Export via phpMyAdmin or the wp db export command. .sql.gz is supported and recommended (100MB upload limit).</span>
                            </div>

                            <div className="form-group">
                                <Label>wp-content archive (optional)</Label>
                                <input
                                    type="file"
                                    accept=".zip"
                                    disabled={importLoading}
                                    onChange={e => setWpContentFile(e.target.files?.[0] || null)}
                                />
                                <span className="form-hint">A .zip of wp-content (plugins/themes/uploads) or the full site. Copied into the new container after the database import. Leave empty to import the database only.</span>
                            </div>
                        </div>
                        <div className="modal-footer">
                            <Button variant="outline" onClick={() => setShowImportModal(false)} disabled={importLoading}>
                                Cancel
                            </Button>
                            <Button onClick={handleImport} disabled={importLoading || !importForm.name || !importForm.oldUrl || !importFile}>
                                {importLoading ? <><Spinner size="sm" /> Importing...</> : 'Import Site'}
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
                title="Create WordPress Site"
                subtitle="WordPress + MySQL on an isolated Docker network"
                icon={<Globe size={20} />}
                width={560}
                className="sk-formdrawer"
            >
                <div className="sk-formdrawer__form">
                    <div className="sk-formdrawer__body">
                            <div className="sk-formdrawer__callout">
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
                                <div>
                                    <strong>This will create:</strong>
                                    <ul>
                                        <li>WordPress 6.4 (Apache) container</li>
                                        <li>MySQL 8.0 database container</li>
                                        <li>Isolated Docker network</li>
                                    </ul>
                                </div>
                            </div>

                            <div className="sk-formdrawer__field">
                                <Label>
                                    Site Name <span className="required">*</span>
                                </Label>
                                <Input
                                    type="text"
                                    value={createForm.name}
                                    onChange={e => setCreateForm({ ...createForm, name: e.target.value })}
                                    placeholder="my-wordpress-site"
                                    disabled={createLoading}
                                />
                                <span className="sk-formdrawer__hint">Used as the Docker project name. Letters, numbers, and hyphens only.</span>
                            </div>

                            {baseDomains.length > 0 ? (
                                <div className="sk-formdrawer__field">
                                    <Label>Publish under</Label>
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
                                            ? <>The site will be live at <code>{slugifyPreview(createForm.name)}.{createForm.baseDomain}</code>.</>
                                            : <>Which base domain to publish this site under.</>}
                                    </span>
                                </div>
                            ) : (
                                <div className="sk-formdrawer__field">
                                    <Label>Publish under</Label>
                                    <span className="sk-formdrawer__hint">No base domain configured — the site will be reachable at <code>localhost:&lt;port&gt;</code>. Add a managed-sites base domain in Settings to publish it at a real subdomain.</span>
                                </div>
                            )}

                            <div className="sk-formdrawer__field">
                                <Label>Custom Domain</Label>
                                <Input
                                    type="text"
                                    value={createForm.domain}
                                    onChange={e => setCreateForm({ ...createForm, domain: e.target.value })}
                                    placeholder="example.com"
                                    disabled={createLoading}
                                />
                                <span className="sk-formdrawer__hint">Optional. Overrides the base domain above — the site is created and migrated to this domain.</span>
                            </div>

                            <div className="sk-formdrawer__field">
                                <Label>Admin Email</Label>
                                <Input
                                    type="email"
                                    value={createForm.adminEmail}
                                    onChange={e => setCreateForm({ ...createForm, adminEmail: e.target.value })}
                                    placeholder="admin@example.com"
                                    disabled={createLoading}
                                />
                            </div>

                            <div className="sk-formdrawer__field">
                                <Label>PHP Version</Label>
                                <select
                                    value={createForm.phpVersion}
                                    onChange={e => setCreateForm({ ...createForm, phpVersion: e.target.value })}
                                    disabled={createLoading}
                                >
                                    <option value="">Default (latest for WordPress 6.4)</option>
                                    <option value="8.1">PHP 8.1</option>
                                    <option value="8.2">PHP 8.2</option>
                                    <option value="8.3">PHP 8.3</option>
                                </select>
                                <span className="sk-formdrawer__hint">Baked into the container image at creation. Changeable later from the PHP tab.</span>
                            </div>

                            <div className="sk-formdrawer__field">
                                <label className="checkbox-label">
                                    <input
                                        type="checkbox"
                                        checked={createForm.enablePageCache}
                                        onChange={e => setCreateForm({ ...createForm, enablePageCache: e.target.checked })}
                                        disabled={createLoading}
                                    />
                                    Enable full-page cache
                                </label>
                                <span className="sk-formdrawer__hint">Disk page cache with WordPress-aware skip rules (admin, login, cart, checkout).</span>
                            </div>

                            <div className="sk-formdrawer__field">
                                <label className="checkbox-label">
                                    <input
                                        type="checkbox"
                                        checked={createForm.enableObjectCache}
                                        onChange={e => setCreateForm({ ...createForm, enableObjectCache: e.target.checked })}
                                        disabled={createLoading}
                                    />
                                    Enable Redis object cache
                                </label>
                                <span className="sk-formdrawer__hint">Uses the bundled Redis container with the redis-cache drop-in.</span>
                            </div>
                    </div>
                    <div className="sk-formdrawer__foot">
                        <Button
                            variant="outline"
                            onClick={() => setShowCreateModal(false)}
                            disabled={createLoading}
                        >
                            Cancel
                        </Button>
                        <Button
                            onClick={handleCreate}
                            disabled={createLoading || !createForm.name}
                        >
                            {createLoading ? <><Spinner size="sm" /> Creating...</> : 'Create Site'}
                        </Button>
                    </div>
                </div>
            </Drawer>
        </ResourceListPage>
    );
}

export default WordPress;
