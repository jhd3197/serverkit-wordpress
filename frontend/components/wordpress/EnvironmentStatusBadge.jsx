import { Lock } from 'lucide-react';
import { useTranslation } from 'serverkit-sdk';

const EnvironmentStatusBadge = ({ type, status, isLocked }) => {
    const { t } = useTranslation();
    function getTypeBadgeClass() {
        switch (type) {
            case 'production': return 'env-production';
            case 'staging': return 'env-staging';
            case 'multidev': return 'env-multidev';
            default: return 'env-development';
        }
    }

    const isRunning = status === 'running';

    return (
        <div className="env-status-badge-group">
            <span className={`wp-env-badge ${getTypeBadgeClass()}`}>
                {type?.toUpperCase() || 'DEV'}
            </span>
            {isLocked && (
                <span className="env-locked-badge" title={t('wp.environmentStatusBadge.environmentIsLocked', 'Environment is locked')}>
                    <Lock size={10} />
                </span>
            )}
            <span className={`wp-env-status ${isRunning ? 'running' : 'stopped'}`}>
                <span className="status-dot" />
                {isRunning ? t('wp.environmentStatusBadge.running', 'Running') : t('wp.environmentStatusBadge.stopped', 'Stopped')}
            </span>
        </div>
    );
};

export default EnvironmentStatusBadge;
