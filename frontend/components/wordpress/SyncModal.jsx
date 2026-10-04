import { useState, useEffect } from 'react';
import { ArrowDownLeft, Shield } from 'lucide-react';
import wordpressApi from '../../services/wordpress';
import { Spinner } from 'serverkit-sdk';
import { Modal } from 'serverkit-sdk';
import { Button } from 'serverkit-sdk';
import { Input } from 'serverkit-sdk';
import { Label } from 'serverkit-sdk';
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from 'serverkit-sdk';
import { Checkbox } from 'serverkit-sdk';
import { useTranslation } from 'serverkit-sdk';

const SyncModal = ({ environment, productionName, onClose, onSync }) => {
    const { t } = useTranslation();
    const [syncType, setSyncType] = useState('database');
    const [config, setConfig] = useState({
        sanitize: false,
        truncate_tables: '',
        exclude_tables: '',
        sanitization_profile_id: ''
    });
    const [loading, setLoading] = useState(false);
    const [profiles, setProfiles] = useState([]);

    useEffect(() => {
        loadProfiles();
    }, []);

    async function loadProfiles() {
        try {
            const data = await wordpressApi.getSanitizationProfiles();
            setProfiles(data.profiles || []);
            const defaultProfile = (data.profiles || []).find(p => p.is_default);
            if (defaultProfile) {
                setConfig(prev => ({
                    ...prev,
                    sanitization_profile_id: String(defaultProfile.id),
                    sanitize: true
                }));
            }
        } catch {
            setProfiles([]);
        }
    }

    async function handleSubmit(e) {
        e.preventDefault();
        setLoading(true);
        try {
            await onSync({
                type: syncType,
                sanitize: config.sanitize,
                sanitization_profile_id: config.sanitization_profile_id
                    ? Number(config.sanitization_profile_id) : null,
                truncate_tables: config.truncate_tables
                    ? config.truncate_tables.split(',').map(s => s.trim()).filter(Boolean)
                    : [],
                exclude_tables: config.exclude_tables
                    ? config.exclude_tables.split(',').map(s => s.trim()).filter(Boolean)
                    : []
            });
        } finally {
            setLoading(false);
        }
    }

    function handleConfigChange(key, value) {
        setConfig(prev => ({ ...prev, [key]: value }));
    }

    const envType = environment.environment_type || 'development';

    return (
        <Modal open={true} onClose={onClose} title={t('wp.syncModal.syncFromProduction', 'Sync from production')}>
            <form onSubmit={handleSubmit}>
                <div className="sync-direction">
                    <div className="promote-env-pill production">
                        <span className="promote-env-type">{t('wp.syncModal.production', 'Production')}</span>
                        <span className="promote-env-name">{productionName}</span>
                    </div>
                    <ArrowDownLeft size={20} className="promote-arrow" />
                    <div className={`promote-env-pill ${envType}`}>
                        <span className="promote-env-type">{envType}</span>
                        <span className="promote-env-name">{environment.name}</span>
                    </div>
                </div>

                <div className="form-group">
                    <Label>{t('wp.syncModal.syncType', 'Sync type')}</Label>
                    <div className="radio-group">
                        <label className="radio-label">
                            <input
                                type="radio"
                                name="syncType"
                                value="database"
                                checked={syncType === 'database'}
                                onChange={e => setSyncType(e.target.value)}
                            />
                            <div className="radio-content">
                                <strong>{t('wp.syncModal.databaseOnly', 'Database only')}</strong>
                                <span>{t('wp.syncModal.pullProductionDatabaseIntoThisEnvironment', 'Pull production database into this environment')}</span>
                            </div>
                        </label>
                        <label className="radio-label">
                            <input
                                type="radio"
                                name="syncType"
                                value="files"
                                checked={syncType === 'files'}
                                onChange={e => setSyncType(e.target.value)}
                            />
                            <div className="radio-content">
                                <strong>{t('wp.syncModal.filesOnly', 'Files only')}</strong>
                                <span>{t('wp.syncModal.pullProductionFilesWpContentInto', 'Pull production files (wp-content) into this environment')}</span>
                            </div>
                        </label>
                        <label className="radio-label">
                            <input
                                type="radio"
                                name="syncType"
                                value="full"
                                checked={syncType === 'full'}
                                onChange={e => setSyncType(e.target.value)}
                            />
                            <div className="radio-content">
                                <strong>{t('wp.syncModal.fullSync', 'Full sync')}</strong>
                                <span>{t('wp.syncModal.pullBothDatabaseAndFilesFrom', 'Pull both database and files from production')}</span>
                            </div>
                        </label>
                    </div>
                </div>

                {(syncType === 'database' || syncType === 'full') && (
                    <>
                        <div className="form-group">
                            <label className="checkbox-label">
                                <Checkbox
                                    checked={config.sanitize}
                                    onCheckedChange={v => handleConfigChange('sanitize', v)}
                                />
                                <span>{t('wp.syncModal.sanitizeDataAnonymizeEmailsResetPasswords', 'Sanitize data (anonymize emails, reset passwords)')}</span>
                            </label>
                        </div>

                        {config.sanitize && profiles.length > 0 && (
                            <div className="form-group">
                                <Label>
                                    <Shield size={14} style={{ marginRight: 4, verticalAlign: -2 }} />
                                    {t('wp.syncModal.sanitizationProfile', 'Sanitization profile')}
                                </Label>
                                <Select
                                    value={config.sanitization_profile_id}
                                    onValueChange={v => handleConfigChange('sanitization_profile_id', v)}
                                >
                                    <SelectTrigger>
                                        <SelectValue placeholder={t('wp.syncModal.manualConfiguration', 'Manual configuration')} />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="">{t('wp.syncModal.manualConfiguration2', 'Manual configuration')}</SelectItem>
                                        {profiles.map(p => (
                                            <SelectItem key={p.id} value={String(p.id)}>
                                                {p.name}{p.is_default ? ' (default)' : ''}{p.is_builtin ? '' : ' (custom)'}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                                {config.sanitization_profile_id && (
                                    <span className="form-hint">
                                        {profiles.find(p => String(p.id) === config.sanitization_profile_id)?.description || ''}
                                    </span>
                                )}
                            </div>
                        )}

                        <div className="form-group">
                            <Label>{t('wp.syncModal.excludeTablesCommaSeparatedOptional', 'Exclude tables (comma-separated, optional)')}</Label>
                            <Input
                                type="text"
                                value={config.exclude_tables}
                                onChange={e => handleConfigChange('exclude_tables', e.target.value)}
                                placeholder={t('wp.syncModal.wpUsersWpUsermeta', 'wp_users, wp_usermeta')}
                            />
                            <span className="form-hint">{t('wp.syncModal.tablesToSkipDuringSync', 'Tables to skip during sync.')}</span>
                        </div>

                        <div className="form-group">
                            <Label>{t('wp.syncModal.truncateTablesCommaSeparatedOptional', 'Truncate tables (comma-separated, optional)')}</Label>
                            <Input
                                type="text"
                                value={config.truncate_tables}
                                onChange={e => handleConfigChange('truncate_tables', e.target.value)}
                                placeholder={t('wp.syncModal.wpActionschedulerActionsWpActionschedulerLogs', 'wp_actionscheduler_actions, wp_actionscheduler_logs')}
                            />
                            <span className="form-hint">{t('wp.syncModal.tablesToEmptyStructureKeptData', 'Tables to empty (structure kept, data removed).')}</span>
                        </div>
                    </>
                )}

                <div className="sync-warning">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="10" />
                        <path d="M12 8v4M12 16h.01" />
                    </svg>
                    <div>
                        <strong>{t('wp.syncModal.thisWillOverwriteData', 'This will overwrite data')}</strong>
                        <p>{t('wp.syncModal.theCurrent', 'The current')} {syncType === 'files' ? t('wp.syncModal.files', 'files') : syncType === 'database' ? t('wp.syncModal.database', 'database') : t('wp.syncModal.databaseAndFiles', 'database and files')} {t('wp.syncModal.inThisEnvironmentWillBeReplaced', 'in this environment will be replaced with production data. A snapshot will be created before syncing.')}</p>
                    </div>
                </div>

                <div className="modal-actions">
                    <Button type="button" variant="outline" onClick={onClose} disabled={loading}>
                        {t('wp.syncModal.cancel', 'Cancel')}
                    </Button>
                    <Button type="submit" disabled={loading}>
                        {loading ? <><Spinner size="sm" /> {t('wp.syncModal.syncing', 'Syncing…')}</> : t('wp.syncModal.syncNow', 'Sync now')}
                    </Button>
                </div>
            </form>
        </Modal>
    );
};

export default SyncModal;
