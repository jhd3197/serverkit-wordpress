import { useState } from 'react';
import { ExternalLink, RefreshCw, Trash2, GitBranch, Clock, AlertTriangle, Calendar, FileText } from 'lucide-react';
import { ConfirmDialog } from 'serverkit-sdk';
import { Pill, EnvTag } from 'serverkit-sdk';
import { useTranslation, useFormat } from 'serverkit-sdk';

const EnvironmentCard = ({ environment, productionUrl, onSync, onDelete, onViewLogs, isProduction = false }) => {
    const { t } = useTranslation();
    // Aliased: this component already had its own `formatDate` wrapper (it
    // returns null rather than a dash for an empty value, which the layout
    // depends on), so the door's goes in under a distinct name instead of
    // shadowing it into infinite recursion.
    const { formatDate: formatDateLocalized } = useFormat();
    const [syncing, setSyncing] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [showSyncConfirm, setShowSyncConfirm] = useState(false);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

    const isRunning = environment.status === 'running';
    const envType = environment.type || environment.environment_type || (isProduction ? 'production' : 'development');

    // Helper functions
    function formatDate(dateString) {
        if (!dateString) return null;
        return formatDateLocalized(dateString);
    }

    function formatRelativeTime(dateString) {
        if (!dateString) return null;
        const date = new Date(dateString);
        const now = new Date();
        const diffMs = now - date;
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

        if (diffDays === 0) return t('wp.environmentCard.today', 'Today');
        if (diffDays === 1) return t('wp.environmentCard.yesterday', 'Yesterday');
        if (diffDays < 7) return `${diffDays} days ago`;
        if (diffDays < 30) return `${Math.floor(diffDays / 7)} week(s) ago`;
        return `${Math.floor(diffDays / 30)} month(s) ago`;
    }

    function isStale() {
        if (!environment.last_sync || isProduction) return false;
        const lastSync = new Date(environment.last_sync);
        const now = new Date();
        const diffDays = Math.floor((now - lastSync) / (1000 * 60 * 60 * 24));
        return diffDays > 7; // Consider stale if not synced in 7 days
    }

    function formatSchedule(schedule) {
        if (!schedule) return null;
        const scheduleMap = {
            '0 3 * * 0': 'Weekly (Sunday 3am)',
            '0 3 * * *': 'Daily (3am)',
            '0 0 * * 0': 'Weekly (Sunday midnight)',
            '0 0 * * *': 'Daily (midnight)'
        };
        return scheduleMap[schedule] || schedule;
    }

    const stale = isStale();

    async function handleSync() {
        setShowSyncConfirm(false);
        setSyncing(true);
        try {
            await onSync?.(environment.id);
        } finally {
            setSyncing(false);
        }
    }

    async function handleDelete() {
        setShowDeleteConfirm(false);
        setDeleting(true);
        try {
            await onDelete?.(environment.id);
        } finally {
            setDeleting(false);
        }
    }

    function handleVisit() {
        if (environment.url) {
            window.open(environment.url, '_blank');
        }
    }

    const envTagLabel = envType === 'production' ? 'PROD'
        : envType === 'staging' ? 'STAGING'
        : envType === 'multidev' ? 'MULTIDEV'
        : 'DEV';

    return (
        <div className={`wp-env-card ${isProduction ? 'production' : ''} ${stale ? 'stale' : ''}`}>
            <div className="wp-env-header">
                <div className="wp-env-info">
                    <EnvTag env={envTagLabel} />
                    <h4 className="wp-env-name">{environment.name}</h4>
                </div>
                <div className="wp-env-status-group">
                    {stale && (
                        <span className="wp-env-stale-badge" title={t('wp.environmentCard.environmentHasnTBeenSyncedIn', 'Environment hasn\'t been synced in over 7 days')}>
                            <AlertTriangle size={12} />
                            {t('wp.environmentCard.stale', 'Stale')}
                        </span>
                    )}
                    <Pill kind={isRunning ? 'green' : 'gray'}>{isRunning ? t('wp.environmentCard.running', 'Running') : t('wp.environmentCard.stopped', 'Stopped')}</Pill>
                </div>
            </div>

            <div className="wp-env-body">
                {environment.url && (
                    <div className="wp-env-url">
                        <a href={environment.url} target="_blank" rel="noopener noreferrer">
                            {environment.url}
                        </a>
                    </div>
                )}

                <div className="wp-env-meta">
                    {environment.db_name && (
                        <div className="wp-env-meta-item">
                            <span className="meta-label">{t('wp.environmentCard.database', 'Database')}</span>
                            <span className="meta-value mono">{environment.db_name}</span>
                        </div>
                    )}
                    {environment.commit_sha && (
                        <div className="wp-env-meta-item">
                            <span className="meta-label">
                                <GitBranch size={12} /> {t('wp.environmentCard.commit', 'Commit')}
                            </span>
                            <span className="meta-value mono">{environment.commit_sha.substring(0, 7)}</span>
                        </div>
                    )}
                    {!isProduction && environment.last_sync && (
                        <div className="wp-env-meta-item">
                            <span className="meta-label">
                                <Clock size={12} /> {t('wp.environmentCard.lastSync', 'Last sync')}
                            </span>
                            <span className={`meta-value ${stale ? 'text-warning' : ''}`}>
                                {formatRelativeTime(environment.last_sync)}
                            </span>
                        </div>
                    )}
                    {!isProduction && environment.sync_schedule && (
                        <div className="wp-env-meta-item">
                            <span className="meta-label">
                                <Calendar size={12} /> {t('wp.environmentCard.schedule', 'Schedule')}
                            </span>
                            <span className="meta-value">
                                {formatSchedule(environment.sync_schedule)}
                            </span>
                        </div>
                    )}
                </div>
            </div>

            <div className="wp-env-footer">
                <button type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={handleVisit}
                    disabled={!environment.url}
                >
                    <ExternalLink size={14} />
                    {t('wp.environmentCard.visit', 'Visit')}
                </button>

                {!isProduction && (
                    <>
                        <button type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => setShowSyncConfirm(true)}
                            disabled={syncing || !productionUrl}
                            title={t('wp.environmentCard.syncFromProduction', 'Sync from production')}
                        >
                            <RefreshCw size={14} className={syncing ? 'spinning' : ''} />
                            {syncing ? t('wp.environmentCard.syncing', 'Syncing…') : t('wp.environmentCard.sync', 'Sync')}
                        </button>
                        {onViewLogs && (
                            <button type="button"
                                className="btn btn-ghost btn-sm"
                                onClick={() => onViewLogs?.(environment.id)}
                                title={t('wp.environmentCard.viewSyncLogs', 'View sync logs')}
                            >
                                <FileText size={14} />
                                {t('wp.environmentCard.logs', 'Logs')}
                            </button>
                        )}
                        <button type="button"
                            className="btn btn-ghost btn-sm btn-danger"
                            onClick={() => setShowDeleteConfirm(true)}
                            disabled={deleting}
                        >
                            <Trash2 size={14} />
                            {deleting ? t('wp.environmentCard.deleting', 'Deleting…') : t('wp.environmentCard.delete', 'Delete')}
                        </button>
                    </>
                )}
            </div>

            <ConfirmDialog
                isOpen={showSyncConfirm}
                title={t('wp.environmentCard.syncFromProduction2', 'Sync from production')}
                message={t('wp.environmentCard.syncFromProduction3', 'Sync "{{name}}" from production?', { name: environment.name })}
                details={
                    <ul>
                        <li><strong>{t('wp.environmentCard.warning', 'Warning:')}</strong> {t('wp.environmentCard.thisWillOverwriteTheCurrentDatabase', 'This will overwrite the current database')}</li>
                        <li>{t('wp.environmentCard.allDataInThisEnvironmentWill', 'All data in this environment will be replaced with production data')}</li>
                        <li>{t('wp.environmentCard.urlsWillBeAutomaticallyUpdatedFor', 'URLs will be automatically updated for this environment')}</li>
                    </ul>
                }
                confirmText={t('wp.environmentCard.syncNow', 'Sync now')}
                variant="warning"
                onConfirm={handleSync}
                onCancel={() => setShowSyncConfirm(false)}
            />

            <ConfirmDialog
                isOpen={showDeleteConfirm}
                title={t('wp.environmentCard.deleteEnvironment', 'Delete {{value}} environment', { value: envType.charAt(0).toUpperCase() + envType.slice(1) })}
                message={t('wp.environmentCard.areYouSureYouWantTo', 'Delete "{{name}}"?', { name: environment.name })}
                details={
                    <ul>
                        <li>{t('wp.environmentCard.allEnvironmentFilesWillBePermanently', 'All environment files will be permanently deleted')}</li>
                        <li>{t('wp.environmentCard.database2', 'Database')} <code>{environment.db_name || 'associated database'}</code> {t('wp.environmentCard.willBeRemoved', 'will be deleted')}</li>
                        <li>{t('wp.environmentCard.thisActionCannotBeUndone', "This can't be undone")}</li>
                    </ul>
                }
                confirmText={t('wp.environmentCard.deleteEnvironment2', 'Delete environment')}
                variant="danger"
                onConfirm={handleDelete}
                onCancel={() => setShowDeleteConfirm(false)}
            />
        </div>
    );
};

export default EnvironmentCard;
