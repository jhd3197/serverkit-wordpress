import { useState, useEffect } from 'react';
import { Palette } from 'lucide-react';
import wordpressApi from '../../../services/wordpress';
import { useToast } from 'serverkit-sdk';
import { ErrorState } from 'serverkit-sdk';
import { EmptyState } from 'serverkit-sdk';
import { Pill } from 'serverkit-sdk';
import { Button } from 'serverkit-sdk';
import { Input } from 'serverkit-sdk';
import { SkeletonBoundary } from 'serverkit-sdk';
import { ListItemSkeleton } from './wpDetailShared';
import { useTranslation } from 'serverkit-sdk';

// Themes Tab
const ThemesTab = ({ siteId }) => {
    const { t } = useTranslation();
    const toast = useToast();
    const [themes, setThemes] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [installing, setInstalling] = useState(false);
    const [updating, setUpdating] = useState(null); // theme name being updated, or 'all'
    const [newTheme, setNewTheme] = useState('');
    const [activating, setActivating] = useState(null); // theme name being activated

    useEffect(() => {
        loadThemes();
    }, [siteId]);

    async function loadThemes() {
        setLoading(true);
        setError(null);
        try {
            const data = await wordpressApi.getThemes(siteId);
            setThemes(data.themes || []);
        } catch (err) {
            console.error('Failed to load themes:', err);
            setError(err);
        } finally {
            setLoading(false);
        }
    }

    async function handleInstall(e) {
        e.preventDefault();
        if (!newTheme.trim()) return;

        setInstalling(true);
        try {
            await wordpressApi.installTheme(siteId, { theme: newTheme.trim() });
            toast.success(t('wp.themesTab.themeInstalledSuccessfully', 'Theme installed'));
            setNewTheme('');
            loadThemes();
        } catch (err) {
            toast.error(err.message || t('wp.themesTab.failedToInstallTheme', 'Failed to install theme'));
        } finally {
            setInstalling(false);
        }
    }

    async function handleUpdate(themeName) {
        setUpdating(themeName || 'all');
        toast.info(themeName ? t('wp.themesTab.updating', 'Updating {{themeName}}…', { themeName: themeName }) : t('wp.themesTab.updatingAllThemes', 'Updating all themes…'), { duration: 4000 });
        try {
            const res = await wordpressApi.updateThemes(siteId, themeName ? [themeName] : undefined);
            if (res.success === false) {
                toast.error(res.error || t('wp.themesTab.themeUpdateFailed', 'Theme update failed'));
                return;
            }
            toast.success(res.message || t('wp.themesTab.themesUpdated', 'Themes updated'));
            loadThemes();
        } catch (err) {
            toast.error(err.message || t('wp.themesTab.themeUpdateFailed2', 'Theme update failed'));
        } finally {
            setUpdating(null);
        }
    }

    async function handleActivate(theme) {
        setActivating(theme.name);
        try {
            const res = await wordpressApi.activateTheme(siteId, theme.name);
            if (res && res.success === false) {
                toast.error(res.error || t('wp.themesTab.failedToActivate', 'Failed to activate {{name}}', { name: theme.name }));
                return;
            }
            toast.success(`${theme.title || theme.name} activated`);
            loadThemes();
        } catch (err) {
            toast.error(err.message || t('wp.themesTab.failedToActivateTheme', 'Failed to activate theme'));
        } finally {
            setActivating(null);
        }
    }

    if (loading) {
        return (
            <SkeletonBoundary loading skeleton={(
                <div className="themes-tab">
                    <div className="section-header">
                        <div className="skeleton" style={{ width: 80, height: 24 }} />
                    </div>
                    <div className="skeleton" style={{ height: 44, borderRadius: 6, marginBottom: 16 }} />
                    <div className="themes-list">
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
                title={t('wp.themesTab.failedToLoadThemes', 'Failed to load themes')}
                error={error}
                onRetry={loadThemes}
            />
        );
    }

    return (
        <div className="themes-tab">
            <div className="section-header">
                <h3>{t('wp.themesTab.themes', 'Themes')}</h3>
            </div>

            <form className="install-form" onSubmit={handleInstall}>
                <Input
                    type="text"
                    value={newTheme}
                    onChange={(e) => setNewTheme(e.target.value)}
                    placeholder={t('wp.themesTab.themeSlugEGTwentytwentyfour', 'Theme slug (e.g. twentytwentyfour)')}
                />
                <Button type="submit" disabled={installing}>
                    {installing ? t('wp.themesTab.installing', 'Installing…') : t('wp.themesTab.installTheme', 'Install theme')}
                </Button>
            </form>

            {themes.some(t => t.update === 'available') && (
                <div className="bulk-update-bar">
                    <span>{themes.filter(t => t.update === 'available').length} {t('wp.themesTab.themeUpdateSAvailable', 'theme update(s) available')}</span>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleUpdate(null)}
                        disabled={updating !== null}
                    >
                        {updating === 'all' ? t('wp.themesTab.updating2', 'Updating…') : t('wp.themesTab.updateAll', 'Update all')}
                    </Button>
                </div>
            )}

            {themes.length === 0 ? (
                <EmptyState icon={Palette} title={t('wp.themesTab.noThemesInstalled', 'No themes installed')} description={t('wp.themesTab.installAThemeByEnteringIts', 'Install a theme by entering its slug above.')} />
            ) : (
                <div className="wp-theme-grid">
                    {themes.map(theme => {
                        const isActive = theme.status === 'active';
                        return (
                            <div className={`wp-theme-card ${isActive ? 'is-active' : ''}`} key={theme.name}>
                                <div className="wp-theme-card__shot">
                                    <Palette size={26} />
                                    {isActive && <Pill kind="green">{t('wp.themesTab.active', 'Active')}</Pill>}
                                </div>
                                <div className="wp-theme-card__meta">
                                    <div className="wp-theme-card__name">{theme.title || theme.name}</div>
                                    <div className="wp-theme-card__sub">{theme.name} {t('wp.themesTab.v', '· v')}{theme.version}</div>
                                    <div className="wp-theme-card__actions">
                                        {isActive ? (
                                            <span className="wp-theme-card__current">{t('wp.themesTab.currentTheme', 'Current theme')}</span>
                                        ) : (
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                onClick={() => handleActivate(theme)}
                                                disabled={activating === theme.name}
                                            >
                                                {activating === theme.name ? t('wp.themesTab.activating', 'Activating…') : t('wp.themesTab.activate', 'Activate')}
                                            </Button>
                                        )}
                                        {theme.update === 'available' && (
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                onClick={() => handleUpdate(theme.name)}
                                                disabled={updating !== null}
                                            >
                                                {updating === theme.name ? t('wp.themesTab.updating2', 'Updating…') : t('wp.themesTab.update', 'Update')}
                                            </Button>
                                        )}
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

export default ThemesTab;
