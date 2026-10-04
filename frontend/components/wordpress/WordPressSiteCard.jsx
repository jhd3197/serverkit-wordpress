import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ExternalLink, Settings, Copy, Trash2 } from 'lucide-react';
import { ConfirmDialog } from 'serverkit-sdk';
import { Button } from 'serverkit-sdk';
import { useTranslation } from 'serverkit-sdk';

const WordPressSiteCard = ({ site, onDelete }) => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const isRunning = site.status === 'running';

    function getEnvironmentCount() {
        return site.environments?.length || 0;
    }

    function handleVisitSite(e) {
        e.stopPropagation();
        if (site.url) {
            window.open(site.url, '_blank');
        }
    }

    function handleOpenDashboard(e) {
        e.stopPropagation();
        if (site.url) {
            window.open(`${site.url}/wp-admin`, '_blank');
        }
    }

    function handleManage() {
        navigate(`/wordpress/${site.id}`);
    }

    function handleDelete(e) {
        e.stopPropagation();
        setShowDeleteConfirm(true);
    }

    function confirmDelete() {
        setShowDeleteConfirm(false);
        onDelete?.(site.id);
    }

    return (
        <div className="wp-site-card" onClick={handleManage}>
            <div className="wp-site-card-header">
                <div className="wp-site-icon">
                    <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
                        <path d="M12 2C6.486 2 2 6.486 2 12s4.486 10 10 10 10-4.486 10-10S17.514 2 12 2zm0 19.542c-5.261 0-9.542-4.281-9.542-9.542S6.739 2.458 12 2.458 21.542 6.739 21.542 12 17.261 21.542 12 21.542z"/>
                    </svg>
                </div>
                <div className="wp-site-info">
                    <h3 className="wp-site-name">{site.name}</h3>
                    {site.url && (
                        <span className="wp-site-url">{site.url}</span>
                    )}
                </div>
                <span className={`wp-site-status ${isRunning ? 'running' : 'stopped'}`}>
                    <span className="status-dot" />
                    {isRunning ? t('wp.wordPressSiteCard.running', 'Running') : t('wp.wordPressSiteCard.stopped', 'Stopped')}
                </span>
            </div>

            <div className="wp-site-card-body">
                <div className="wp-site-meta">
                    <div className="wp-site-meta-item">
                        <span className="meta-label">{t('wp.wordPressSiteCard.version', 'Version')}</span>
                        <span className="meta-value">{site.wp_version || t('wp.wordPressSiteCard.unknown', 'Unknown')}</span>
                    </div>
                    <div className="wp-site-meta-item">
                        <span className="meta-label">{t('wp.wordPressSiteCard.environments', 'Environments')}</span>
                        <span className="meta-value">{getEnvironmentCount() + 1}</span>
                    </div>
                    {site.git_repo_url && (
                        <div className="wp-site-meta-item">
                            <span className="meta-label">{t('wp.wordPressSiteCard.git', 'Git')}</span>
                            <span className="meta-value git-connected">{t('wp.wordPressSiteCard.connected', 'Connected')}</span>
                        </div>
                    )}
                </div>

                {site.is_production && (
                    <span className="wp-site-badge production">{t('wp.wordPressSiteCard.production', 'Production')}</span>
                )}
                {!site.is_production && site.production_site_id && (
                    <span className="wp-site-badge development">{t('wp.wordPressSiteCard.development', 'Development')}</span>
                )}
            </div>

            <div className="wp-site-card-footer">
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleVisitSite}
                    disabled={!site.url}
                    title={t('wp.wordPressSiteCard.visitSite', 'Visit site')}
                >
                    <ExternalLink size={14} />
                    {t('wp.wordPressSiteCard.visit', 'Visit')}
                </Button>
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleOpenDashboard}
                    disabled={!site.url}
                    title={t('wp.wordPressSiteCard.openDashboard', 'Open dashboard')}
                >
                    <Settings size={14} />
                    {t('wp.wordPressSiteCard.dashboard', 'Dashboard')}
                </Button>
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleManage}
                    title={t('wp.wordPressSiteCard.manageSite', 'Manage site')}
                >
                    <Copy size={14} />
                    {t('wp.wordPressSiteCard.manage', 'Manage')}
                </Button>
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleDelete}
                    title={t('wp.wordPressSiteCard.deleteSite', 'Delete site')}
                    className="text-destructive hover:text-destructive"
                >
                    <Trash2 size={14} />
                </Button>
            </div>

            <ConfirmDialog
                isOpen={showDeleteConfirm}
                title={t('wp.wordPressSiteCard.deleteWordpressSite', 'Delete WordPress site')}
                message={t('wp.wordPressSiteCard.areYouSureYouWantTo', 'Delete "{{name}}"? This can\'t be undone.', { name: site.name })}
                details={
                    <ul>
                        <li>{t('wp.wordPressSiteCard.allSiteFilesWillBePermanently', 'All site files will be permanently deleted')}</li>
                        <li>{t('wp.wordPressSiteCard.database', 'Database')} <code>{site.db_name || 'associated database'}</code> {t('wp.wordPressSiteCard.willBeRemoved', 'will be deleted')}</li>
                        {site.environments?.length > 0 && (
                            <li>{site.environments.length} {t('wp.wordPressSiteCard.linkedEnvironmentSWillAlsoBe', 'linked environment(s) will also be deleted')}</li>
                        )}
                    </ul>
                }
                confirmText={t('wp.wordPressSiteCard.deleteSite2', 'Delete site')}
                variant="danger"
                requireConfirmation={site.name}
                onConfirm={confirmDelete}
                onCancel={() => setShowDeleteConfirm(false)}
            />
        </div>
    );
};

export default WordPressSiteCard;
