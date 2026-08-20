import { useState, useEffect } from 'react';
import { Package, Download } from 'lucide-react';
import wordpressApi from '../../../services/wordpress';
import { useToast } from 'serverkit-sdk';
import { ErrorState } from 'serverkit-sdk';
import { EmptyState } from 'serverkit-sdk';
import { ServiceTile } from 'serverkit-sdk';
import { Button } from 'serverkit-sdk';
import { Input } from 'serverkit-sdk';
import { Switch } from 'serverkit-sdk';
import { SkeletonBoundary } from 'serverkit-sdk';
import { ListItemSkeleton } from './wpDetailShared';
import { useTranslation } from 'serverkit-sdk';

// Plugins Tab
const PluginsTab = ({ siteId }) => {
    const { t } = useTranslation();
    const toast = useToast();
    const [plugins, setPlugins] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [installing, setInstalling] = useState(false);
    const [updating, setUpdating] = useState(null); // plugin name being updated, or 'all'
    const [newPlugin, setNewPlugin] = useState('');
    const [toggling, setToggling] = useState(null); // plugin name being activated/deactivated
    // Map of slug -> managed metadata (installed/library version, update_available).
    const [managed, setManaged] = useState({});

    useEffect(() => {
        loadPlugins();
    }, [siteId]);

    async function loadPlugins() {
        setLoading(true);
        setError(null);
        try {
            const data = await wordpressApi.getPlugins(siteId);
            setPlugins(data.plugins || []);
            loadManaged();
        } catch (err) {
            console.error('Failed to load plugins:', err);
            setError(err);
        } finally {
            setLoading(false);
        }
    }

    // Which installed plugins are library-managed. Best-effort: a scan first so the
    // mapping reflects the live site, then read it back keyed by slug.
    async function loadManaged() {
        try {
            await wordpressApi.scanManagedPlugins(siteId);
            const data = await wordpressApi.getManagedPlugins(siteId);
            const map = {};
            (data.managed || []).forEach(m => { map[m.slug] = m; });
            setManaged(map);
        } catch {
            // Library layer is optional — never block the plugins list on it.
            setManaged({});
        }
    }

    async function handleLibraryUpdate(slug) {
        const m = managed[slug];
        if (!m) return;
        setUpdating(slug);
        toast.info(t('wp.pluginsTab.updatingFromLibrary', 'Updating {{slug}} from library…', { slug: slug }), { duration: 4000 });
        try {
            const res = await wordpressApi.installLibraryPluginOnSite(m.plugin_id, siteId, m.status === 'active');
            if (res.success === false) { toast.error(res.error || t('wp.pluginsTab.libraryUpdateFailed', 'Library update failed')); return; }
            toast.success(t('wp.pluginsTab.updatedToLibraryVersion', '{{slug}} updated to library version', { slug: slug }));
            loadPlugins();
        } catch (err) {
            toast.error(err.message || t('wp.pluginsTab.libraryUpdateFailed2', 'Library update failed'));
        } finally {
            setUpdating(null);
        }
    }

    async function handleInstall(e) {
        e.preventDefault();
        if (!newPlugin.trim()) return;

        setInstalling(true);
        try {
            await wordpressApi.installPlugin(siteId, { plugin: newPlugin.trim() });
            toast.success(t('wp.pluginsTab.pluginInstalledSuccessfully', 'Plugin installed successfully'));
            setNewPlugin('');
            loadPlugins();
        } catch (err) {
            toast.error(err.message || t('wp.pluginsTab.failedToInstallPlugin', 'Failed to install plugin'));
        } finally {
            setInstalling(false);
        }
    }

    async function handleUpdate(pluginName) {
        setUpdating(pluginName || 'all');
        toast.info(pluginName ? t('wp.pluginsTab.updating', 'Updating {{pluginName}}...', { pluginName: pluginName }) : t('wp.pluginsTab.updatingAllPlugins', 'Updating all plugins...'), { duration: 4000 });
        try {
            const res = await wordpressApi.updatePlugins(siteId, pluginName ? [pluginName] : undefined);
            if (res.success === false) {
                toast.error(res.error || t('wp.pluginsTab.pluginUpdateFailed', 'Plugin update failed'));
                return;
            }
            toast.success(res.message || t('wp.pluginsTab.pluginsUpdated', 'Plugins updated'));
            loadPlugins();
        } catch (err) {
            toast.error(err.message || t('wp.pluginsTab.pluginUpdateFailed2', 'Plugin update failed'));
        } finally {
            setUpdating(null);
        }
    }

    async function handleToggle(plugin) {
        const activating = plugin.status !== 'active';
        setToggling(plugin.name);
        try {
            const res = activating
                ? await wordpressApi.activatePlugin(siteId, plugin.name)
                : await wordpressApi.deactivatePlugin(siteId, plugin.name);
            if (res && res.success === false) {
                toast.error(res.error || t('wp.pluginsTab.failedTo', 'Failed to {{value}} {{name}}', { value: activating ? 'activate' : 'deactivate', name: plugin.name }));
                return;
            }
            toast.success(`${plugin.title || plugin.name} ${activating ? 'activated' : 'deactivated'}`);
            loadPlugins();
        } catch (err) {
            toast.error(err.message || t('wp.pluginsTab.failedToPlugin', 'Failed to {{value}} plugin', { value: activating ? 'activate' : 'deactivate' }));
        } finally {
            setToggling(null);
        }
    }

    if (loading) {
        return (
            <SkeletonBoundary loading skeleton={(
                <div className="plugins-tab">
                    <div className="section-header">
                        <div className="skeleton" style={{ width: 80, height: 24 }} />
                    </div>
                    <div className="skeleton" style={{ height: 44, borderRadius: 6, marginBottom: 16 }} />
                    <div className="plugins-list">
                        <ListItemSkeleton />
                        <ListItemSkeleton />
                        <ListItemSkeleton />
                    </div>
                </div>
            )} />
        );
    }

    if (error) {
        return (
            <ErrorState
                title={t('wp.pluginsTab.failedToLoadPlugins', 'Failed to load plugins')}
                error={error}
                onRetry={loadPlugins}
            />
        );
    }

    return (
        <div className="plugins-tab">
            <div className="section-header">
                <h3>{t('wp.pluginsTab.plugins', 'Plugins')}</h3>
            </div>

            <form className="install-form" onSubmit={handleInstall}>
                <Input
                    type="text"
                    value={newPlugin}
                    onChange={(e) => setNewPlugin(e.target.value)}
                    placeholder={t('wp.pluginsTab.pluginSlugEGAkismetWoocommerce', 'Plugin slug (e.g., akismet, woocommerce)')}
                />
                <Button type="submit" disabled={installing}>
                    {installing ? 'Installing...' : 'Install Plugin'}
                </Button>
            </form>

            {plugins.some(p => p.update === 'available') && (
                <div className="bulk-update-bar">
                    <span>{plugins.filter(p => p.update === 'available').length} {t('wp.pluginsTab.pluginUpdateSAvailable', 'plugin update(s) available')}</span>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleUpdate(null)}
                        disabled={updating !== null}
                    >
                        {updating === 'all' ? 'Updating...' : 'Update all'}
                    </Button>
                </div>
            )}

            {plugins.length === 0 ? (
                <EmptyState icon={Package} title={t('wp.pluginsTab.noPluginsInstalled', 'No plugins installed')} description={t('wp.pluginsTab.installAPluginByEnteringIts', 'Install a plugin by entering its slug above.')} />
            ) : (
                <div className="wp-asset-grid">
                    {plugins.map(plugin => {
                        const isActive = plugin.status === 'active';
                        const mgd = managed[plugin.name];
                        return (
                            <div className={`wp-asset-card ${isActive ? 'is-active' : ''}`} key={plugin.name}>
                                <ServiceTile name={plugin.title || plugin.name} size={42} />
                                <div className="wp-asset-card__body">
                                    <div className="wp-asset-card__name">
                                        {plugin.title || plugin.name}
                                        {mgd && <span className="wp-managed-pill">{t('wp.pluginsTab.managed', 'Managed')}</span>}
                                    </div>
                                    <div className="wp-asset-card__sub">{plugin.name}</div>
                                    <div className="wp-asset-card__foot">
                                        <span className="wp-asset-card__ver">v{plugin.version}</span>
                                        {mgd && mgd.update_available ? (
                                            <button
                                                type="button"
                                                className="wp-update-flag wp-update-flag--library"
                                                onClick={() => handleLibraryUpdate(plugin.name)}
                                                disabled={updating !== null}
                                                title={t('wp.pluginsTab.libraryHasV', 'Library has v{{libraryversion}}', { libraryversion: mgd.library_version })}
                                            >
                                                <Download size={11} />
                                                {updating === plugin.name ? 'Updating…' : `Update from library ${mgd.library_version}`}
                                            </button>
                                        ) : plugin.update === 'available' && (
                                            <button
                                                type="button"
                                                className="wp-update-flag"
                                                onClick={() => handleUpdate(plugin.name)}
                                                disabled={updating !== null}
                                            >
                                                <Download size={11} />
                                                {updating === plugin.name ? 'Updating…' : `Update${plugin.update_version ? ` ${plugin.update_version}` : ''}`}
                                            </button>
                                        )}
                                    </div>
                                </div>
                                <div className="wp-asset-card__toggle">
                                    <Switch
                                        checked={isActive}
                                        disabled={toggling === plugin.name}
                                        onCheckedChange={() => handleToggle(plugin)}
                                        aria-label={isActive ? t('wp.pluginsTab.deactivate', 'Deactivate {{name}}', { name: plugin.name }) : t('wp.pluginsTab.activate', 'Activate {{name}}', { name: plugin.name })}
                                    />
                                    <span className={`wp-asset-card__state ${isActive ? 'is-on' : ''}`}>
                                        {isActive ? 'Active' : 'Inactive'}
                                    </span>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

export default PluginsTab;
