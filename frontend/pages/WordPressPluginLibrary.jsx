import { useState, useEffect } from 'react';
import { Package, RefreshCw, Download, Trash2, Github, FolderGit2, Pencil, Server } from 'lucide-react';
import wordpressApi from '../services/wordpress';
import { useToast } from 'serverkit-sdk';
import { useAuth } from 'serverkit-sdk';
import { EmptyState } from 'serverkit-sdk';
import { Spinner } from 'serverkit-sdk';
import { Modal } from 'serverkit-sdk';
import { Pill, ServiceTile } from 'serverkit-sdk';
import { useTopbarActions } from 'serverkit-sdk';
import { Button } from 'serverkit-sdk';
import { Input } from 'serverkit-sdk';
import { Label } from 'serverkit-sdk';
import { Switch } from 'serverkit-sdk';

const EMPTY_FORM = { source_type: 'github', source_url: '', slug: '', branch: 'main' };

function WordPressPluginLibrary() {
    const toast = useToast();
    const { user } = useAuth();
    const isAdmin = user?.role === 'admin';

    const [plugins, setPlugins] = useState([]);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(null); // `${action}:${id}` currently running

    const [showAdd, setShowAdd] = useState(false);
    const [editing, setEditing] = useState(null); // plugin being edited, or null
    const [form, setForm] = useState(EMPTY_FORM);
    const [saving, setSaving] = useState(false);

    const [installFor, setInstallFor] = useState(null); // plugin selected for "install on site"
    const [sites, setSites] = useState([]);
    const [installSiteId, setInstallSiteId] = useState('');
    const [installActivate, setInstallActivate] = useState(true);

    useEffect(() => { loadPlugins(); }, []);

    async function loadPlugins() {
        setLoading(true);
        try {
            const data = await wordpressApi.getLibraryPlugins();
            setPlugins(data.plugins || []);
        } catch (err) {
            toast.error(err.message || 'Failed to load plugin library');
            setPlugins([]);
        } finally {
            setLoading(false);
        }
    }

    function openAdd() {
        setEditing(null);
        setForm(EMPTY_FORM);
        setShowAdd(true);
    }

    function openEdit(plugin) {
        setEditing(plugin);
        setForm({
            source_type: plugin.source_type,
            source_url: plugin.source_url,
            slug: plugin.slug,
            branch: plugin.branch || 'main',
        });
        setShowAdd(true);
    }

    async function handleSave() {
        if (!form.source_url.trim()) {
            toast.error(form.source_type === 'local' ? 'A local path is required' : 'A repo (owner/repo or git URL) is required');
            return;
        }
        setSaving(true);
        try {
            if (editing) {
                await wordpressApi.updateLibraryPlugin(editing.id, form);
                toast.success('Plugin updated');
            } else {
                const res = await wordpressApi.addLibraryPlugin(form);
                if (res.sync_error) toast.info(`Added, but sync failed: ${res.sync_error}`, { duration: 8000 });
                else toast.success('Plugin added to library');
            }
            setShowAdd(false);
            await loadPlugins();
        } catch (err) {
            toast.error(err.message || 'Failed to save plugin');
        } finally {
            setSaving(false);
        }
    }

    async function handleSync(plugin) {
        setBusy(`sync:${plugin.id}`);
        try {
            const res = await wordpressApi.syncLibraryPlugin(plugin.id);
            if (res.success === false) toast.error(res.error || 'Sync failed');
            else toast.success(`Synced ${plugin.slug} (v${res.plugin?.version || '?'})`);
            await loadPlugins();
        } catch (err) {
            toast.error(err.message || 'Sync failed');
        } finally {
            setBusy(null);
        }
    }

    async function handleBulkUpdate(plugin) {
        setBusy(`bulk:${plugin.id}`);
        try {
            const res = await wordpressApi.bulkUpdateLibraryPlugin(plugin.id);
            toast.success(`Updated ${res.updated} of ${res.total} site(s)`);
            await loadPlugins();
        } catch (err) {
            toast.error(err.message || 'Bulk update failed');
        } finally {
            setBusy(null);
        }
    }

    async function handleDelete(plugin) {
        if (!window.confirm(`Remove "${plugin.slug}" from the library? Installed copies on sites are left untouched.`)) return;
        setBusy(`delete:${plugin.id}`);
        try {
            await wordpressApi.deleteLibraryPlugin(plugin.id);
            toast.success('Plugin removed from library');
            await loadPlugins();
        } catch (err) {
            toast.error(err.message || 'Failed to remove plugin');
        } finally {
            setBusy(null);
        }
    }

    async function openInstall(plugin) {
        setInstallFor(plugin);
        setInstallSiteId('');
        setInstallActivate(true);
        try {
            const data = await wordpressApi.getSites();
            setSites(data.sites || []);
        } catch {
            setSites([]);
        }
    }

    async function handleInstall() {
        if (!installSiteId) { toast.error('Pick a site'); return; }
        setBusy(`install:${installFor.id}`);
        try {
            const res = await wordpressApi.installLibraryPluginOnSite(installFor.id, Number(installSiteId), installActivate);
            if (res.success === false) toast.error(res.error || 'Install failed');
            else toast.success(`Installed ${installFor.slug} (${res.status})`);
            setInstallFor(null);
            await loadPlugins();
        } catch (err) {
            toast.error(err.message || 'Install failed');
        } finally {
            setBusy(null);
        }
    }

    useTopbarActions(() => (
        isAdmin ? (
            <Button size="sm" onClick={openAdd}>
                <Package size={16} /> Add Plugin
            </Button>
        ) : null
    ), [isAdmin]);

    if (loading) {
        return (
            <div className="sk-tabgroup__inner wp-plugin-library">
                <div className="wp-plugin-library__loading"><Spinner /></div>
            </div>
        );
    }

    return (
        <div className="sk-tabgroup__inner wp-plugin-library">
            {plugins.length === 0 ? (
                <EmptyState
                    icon={Package}
                    title="No plugins in the library yet"
                    description="Register your own plugins from a GitHub repo or a local path, then install or update them across every managed WordPress site from here."
                    action={isAdmin ? <Button onClick={openAdd}><Package size={16} /> Add Plugin</Button> : null}
                />
            ) : (
                <div className="wp-plib-grid">
                    {plugins.map(plugin => {
                        const SourceIcon = plugin.source_type === 'github' ? Github : FolderGit2;
                        return (
                            <div className={`wp-plib-card ${plugin.is_active ? '' : 'is-disabled'}`} key={plugin.id}>
                                <div className="wp-plib-card__head">
                                    <ServiceTile name={plugin.name || plugin.slug} size={40} />
                                    <div className="wp-plib-card__title">
                                        <div className="wp-plib-card__name">{plugin.name || plugin.slug}</div>
                                        <div className="wp-plib-card__slug">{plugin.slug}</div>
                                    </div>
                                    {plugin.version && <Pill kind="gray">v{plugin.version}</Pill>}
                                </div>

                                {plugin.description && (
                                    <p className="wp-plib-card__desc">{plugin.description}</p>
                                )}

                                <div className="wp-plib-card__meta">
                                    <span className="wp-plib-card__source" title={plugin.source_url}>
                                        <SourceIcon size={13} /> {plugin.source_url}
                                    </span>
                                    <span className="wp-plib-card__branch">{plugin.branch}</span>
                                </div>

                                <div className="wp-plib-card__stats">
                                    <span><Server size={13} /> {plugin.install_count} site{plugin.install_count === 1 ? '' : 's'}</span>
                                    {plugin.sync_error
                                        ? <Pill kind="red" title={plugin.sync_error}>Sync error</Pill>
                                        : plugin.last_synced_at
                                            ? <span className="wp-plib-card__synced">Synced</span>
                                            : <Pill kind="amber">Not synced</Pill>}
                                </div>

                                {isAdmin && (
                                    <div className="wp-plib-card__actions">
                                        <Button variant="outline" size="sm" disabled={busy === `sync:${plugin.id}`} onClick={() => handleSync(plugin)}>
                                            <RefreshCw size={14} className={busy === `sync:${plugin.id}` ? 'spin' : ''} /> Sync
                                        </Button>
                                        <Button variant="outline" size="sm" onClick={() => openInstall(plugin)}>
                                            <Download size={14} /> Install
                                        </Button>
                                        <Button variant="outline" size="sm" disabled={!plugin.install_count || busy === `bulk:${plugin.id}`} onClick={() => handleBulkUpdate(plugin)}>
                                            Bulk update
                                        </Button>
                                        <Button variant="ghost" size="sm" onClick={() => openEdit(plugin)} aria-label="Edit">
                                            <Pencil size={14} />
                                        </Button>
                                        <Button variant="ghost" size="sm" onClick={() => handleDelete(plugin)} aria-label="Delete">
                                            <Trash2 size={14} />
                                        </Button>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Add / Edit modal */}
            <Modal
                open={showAdd}
                onClose={() => setShowAdd(false)}
                title={editing ? `Edit ${editing.slug}` : 'Add plugin to library'}
            >
                <div className="wp-plib-form">
                    <div className="wp-plib-form__row">
                        <Label>Source</Label>
                        <div className="wp-plib-form__toggle">
                            <button
                                type="button"
                                className={form.source_type === 'github' ? 'is-on' : ''}
                                onClick={() => setForm(f => ({ ...f, source_type: 'github' }))}
                            ><Github size={14} /> GitHub</button>
                            <button
                                type="button"
                                className={form.source_type === 'local' ? 'is-on' : ''}
                                onClick={() => setForm(f => ({ ...f, source_type: 'local' }))}
                            ><FolderGit2 size={14} /> Local path</button>
                        </div>
                    </div>

                    <div className="wp-plib-form__row">
                        <Label htmlFor="plib-src">
                            {form.source_type === 'github' ? 'Repository (owner/repo or git URL)' : 'Absolute local path'}
                        </Label>
                        <Input
                            id="plib-src"
                            value={form.source_url}
                            onChange={e => setForm(f => ({ ...f, source_url: e.target.value }))}
                            placeholder={form.source_type === 'github' ? 'acme/my-plugin' : '/srv/plugins/my-plugin'}
                        />
                    </div>

                    <div className="wp-plib-form__row">
                        <Label htmlFor="plib-slug">Plugin slug <span className="wp-plib-form__hint">(folder name; auto-derived if blank)</span></Label>
                        <Input
                            id="plib-slug"
                            value={form.slug}
                            onChange={e => setForm(f => ({ ...f, slug: e.target.value }))}
                            placeholder="my-plugin"
                            disabled={!!editing}
                        />
                    </div>

                    {form.source_type === 'github' && (
                        <div className="wp-plib-form__row">
                            <Label htmlFor="plib-branch">Branch or tag</Label>
                            <Input
                                id="plib-branch"
                                value={form.branch}
                                onChange={e => setForm(f => ({ ...f, branch: e.target.value }))}
                                placeholder="main"
                            />
                        </div>
                    )}

                    <div className="wp-plib-form__footer">
                        <Button variant="outline" onClick={() => setShowAdd(false)}>Cancel</Button>
                        <Button onClick={handleSave} disabled={saving}>
                            {saving ? 'Saving…' : editing ? 'Save' : 'Add & sync'}
                        </Button>
                    </div>
                </div>
            </Modal>

            {/* Install-on-site modal */}
            <Modal
                open={!!installFor}
                onClose={() => setInstallFor(null)}
                title={installFor ? `Install ${installFor.slug} on a site` : ''}
            >
                <div className="wp-plib-form">
                    <div className="wp-plib-form__row">
                        <Label htmlFor="plib-site">Target site</Label>
                        <select
                            id="plib-site"
                            className="wp-plib-form__select"
                            value={installSiteId}
                            onChange={e => setInstallSiteId(e.target.value)}
                        >
                            <option value="">Select a site…</option>
                            {sites.map(s => (
                                <option key={s.id} value={s.id}>
                                    {s.name || s.application?.name || `Site ${s.id}`}
                                </option>
                            ))}
                        </select>
                    </div>
                    <div className="wp-plib-form__row wp-plib-form__row--inline">
                        <Switch checked={installActivate} onCheckedChange={setInstallActivate} id="plib-activate" />
                        <Label htmlFor="plib-activate">Activate after install</Label>
                    </div>
                    <div className="wp-plib-form__footer">
                        <Button variant="outline" onClick={() => setInstallFor(null)}>Cancel</Button>
                        <Button onClick={handleInstall} disabled={busy === `install:${installFor?.id}`}>
                            {busy === `install:${installFor?.id}` ? 'Installing…' : 'Install'}
                        </Button>
                    </div>
                </div>
            </Modal>
        </div>
    );
}

export default WordPressPluginLibrary;
