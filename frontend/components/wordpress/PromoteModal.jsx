import { useState, useEffect } from 'react';
import { ArrowRight, Shield } from 'lucide-react';
import wordpressApi from '../../services/wordpress';
import { Spinner } from 'serverkit-sdk';
import { Modal } from 'serverkit-sdk';
import { Button } from 'serverkit-sdk';
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from 'serverkit-sdk';
import { Checkbox } from 'serverkit-sdk';
import { Label } from 'serverkit-sdk';
import { Input } from 'serverkit-sdk';
import { useTranslation } from 'serverkit-sdk';

const PromoteModal = ({ sourceEnv, targetEnv, onClose, onPromote }) => {
    const { t } = useTranslation();
    const [promotionType, setPromotionType] = useState('code');
    const [config, setConfig] = useState({
        include_plugins: true,
        include_themes: true,
        include_mu_plugins: true,
        include_uploads: false,
        backup_target_first: true,
        sanitize: false,
        sanitization_profile_id: '',
        exclude_tables: '',
        truncate_tables: ''
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
                setConfig(prev => ({ ...prev, sanitization_profile_id: String(defaultProfile.id) }));
            }
        } catch {
            setProfiles([]);
        }
    }

    async function handleSubmit(e) {
        e.preventDefault();
        setLoading(true);
        try {
            const submitConfig = { ...config };
            if (submitConfig.sanitization_profile_id) {
                submitConfig.sanitization_profile_id = Number(submitConfig.sanitization_profile_id);
            } else {
                delete submitConfig.sanitization_profile_id;
            }
            const toList = (s) => (s || '').split(',').map(t => t.trim()).filter(Boolean);
            submitConfig.exclude_tables = toList(config.exclude_tables);
            submitConfig.truncate_tables = toList(config.truncate_tables);
            await onPromote({
                source_env_id: sourceEnv.id,
                target_env_id: targetEnv.id,
                type: promotionType,
                config: submitConfig
            });
        } finally {
            setLoading(false);
        }
    }

    function handleConfigChange(key, value) {
        setConfig(prev => ({ ...prev, [key]: value }));
    }

    const sourceType = sourceEnv.environment_type || 'development';
    const targetType = targetEnv.environment_type || 'staging';

    return (
        <Modal open={true} onClose={onClose} title={t('wp.promoteModal.promoteEnvironment', 'Promote environment')} size="lg">
            <form onSubmit={handleSubmit}>
                <div className="promote-direction">
                    <div className={`promote-env-pill ${sourceType}`}>
                        <span className="promote-env-type">{sourceType}</span>
                        <span className="promote-env-name">{sourceEnv.name}</span>
                    </div>
                    <ArrowRight size={20} className="promote-arrow" />
                    <div className={`promote-env-pill ${targetType}`}>
                        <span className="promote-env-type">{targetType}</span>
                        <span className="promote-env-name">{targetEnv.name}</span>
                    </div>
                </div>

                <div className="form-group">
                    <Label>{t('wp.promoteModal.promotionType', 'Promotion type')}</Label>
                    <div className="radio-group">
                        <label className="radio-label">
                            <input
                                type="radio"
                                name="promotionType"
                                value="code"
                                checked={promotionType === 'code'}
                                onChange={e => setPromotionType(e.target.value)}
                            />
                            <div className="radio-content">
                                <strong>{t('wp.promoteModal.codeOnly', 'Code only')}</strong>
                                <span>{t('wp.promoteModal.syncThemesPluginsAndMuPlugins', 'Sync themes, plugins, and mu-plugins via rsync')}</span>
                            </div>
                        </label>
                        <label className="radio-label">
                            <input
                                type="radio"
                                name="promotionType"
                                value="database"
                                checked={promotionType === 'database'}
                                onChange={e => setPromotionType(e.target.value)}
                            />
                            <div className="radio-content">
                                <strong>{t('wp.promoteModal.databaseOnly', 'Database only')}</strong>
                                <span>{t('wp.promoteModal.exportTransformAndImportDatabase', 'Export, transform, and import database')}</span>
                            </div>
                        </label>
                        <label className="radio-label">
                            <input
                                type="radio"
                                name="promotionType"
                                value="full"
                                checked={promotionType === 'full'}
                                onChange={e => setPromotionType(e.target.value)}
                            />
                            <div className="radio-content">
                                <strong>{t('wp.promoteModal.fullCodeDatabase', 'Full (code + database)')}</strong>
                                <span>{t('wp.promoteModal.completeEnvironmentPromotion', 'Complete environment promotion')}</span>
                            </div>
                        </label>
                    </div>
                </div>

                {(promotionType === 'code' || promotionType === 'full') && (
                    <div className="form-group">
                        <Label>{t('wp.promoteModal.codeOptions', 'Code options')}</Label>
                        <div className="checkbox-group">
                            <label className="checkbox-label">
                                <Checkbox
                                    checked={config.include_plugins}
                                    onCheckedChange={v => handleConfigChange('include_plugins', v)}
                                />
                                <span>{t('wp.promoteModal.includePlugins', 'Include plugins')}</span>
                            </label>
                            <label className="checkbox-label">
                                <Checkbox
                                    checked={config.include_themes}
                                    onCheckedChange={v => handleConfigChange('include_themes', v)}
                                />
                                <span>{t('wp.promoteModal.includeThemes', 'Include themes')}</span>
                            </label>
                            <label className="checkbox-label">
                                <Checkbox
                                    checked={config.include_mu_plugins}
                                    onCheckedChange={v => handleConfigChange('include_mu_plugins', v)}
                                />
                                <span>{t('wp.promoteModal.includeMuPlugins', 'Include mu-plugins')}</span>
                            </label>
                            <label className="checkbox-label">
                                <Checkbox
                                    checked={config.include_uploads}
                                    onCheckedChange={v => handleConfigChange('include_uploads', v)}
                                />
                                <span>{t('wp.promoteModal.includeUploadsMediaFiles', 'Include uploads (media files)')}</span>
                            </label>
                        </div>
                    </div>
                )}

                {(promotionType === 'database' || promotionType === 'full') && (
                    <>
                        <div className="form-group">
                            <label className="checkbox-label">
                                <Checkbox
                                    checked={config.sanitize}
                                    onCheckedChange={v => handleConfigChange('sanitize', v)}
                                />
                                <span>{t('wp.promoteModal.sanitizeDatabaseDuringPromotion', 'Sanitize database during promotion')}</span>
                            </label>
                        </div>

                        {config.sanitize && profiles.length > 0 && (
                            <div className="form-group">
                                <Label>
                                    <Shield size={14} style={{ marginRight: 4, verticalAlign: -2 }} />
                                    {t('wp.promoteModal.sanitizationProfile', 'Sanitization profile')}
                                </Label>
                                <Select
                                    value={config.sanitization_profile_id}
                                    onValueChange={v => handleConfigChange('sanitization_profile_id', v)}
                                >
                                    <SelectTrigger>
                                        <SelectValue placeholder={t('wp.promoteModal.manualConfiguration', 'Manual configuration')} />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="">{t('wp.promoteModal.manualConfiguration2', 'Manual configuration')}</SelectItem>
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
                            <Label>{t('wp.promoteModal.excludeTablesOptional', 'Exclude tables (optional)')}</Label>
                            <Input
                                value={config.exclude_tables}
                                onChange={e => handleConfigChange('exclude_tables', e.target.value)}
                                placeholder={t('wp.promoteModal.eGWpStatisticsWpActionscheduler', 'e.g. wp_statistics, wp_actionscheduler_logs')}
                            />
                            <span className="form-hint">{t('wp.promoteModal.commaSeparatedTableNamesToOmit', 'Comma-separated table names to omit from the promotion entirely.')}</span>
                        </div>
                        <div className="form-group">
                            <Label>{t('wp.promoteModal.truncateTablesOptional', 'Truncate tables (optional)')}</Label>
                            <Input
                                value={config.truncate_tables}
                                onChange={e => handleConfigChange('truncate_tables', e.target.value)}
                                placeholder={t('wp.promoteModal.eGWpSessionsWpWoocommerce', 'e.g. wp_sessions, wp_woocommerce_log')}
                            />
                            <span className="form-hint">{t('wp.promoteModal.commaSeparatedTablesToKeepBut', 'Comma-separated tables to keep but empty (structure promoted, rows dropped).')}</span>
                        </div>
                    </>
                )}

                <div className="form-group">
                    <label className="checkbox-label">
                        <Checkbox
                            checked={config.backup_target_first}
                            onCheckedChange={v => handleConfigChange('backup_target_first', v)}
                        />
                        <span>{t('wp.promoteModal.createSnapshotOfTargetBeforePromoting', 'Create snapshot of target before promoting')}</span>
                    </label>
                    <span className="form-hint">{t('wp.promoteModal.recommendedAllowsRollbackIfSomethingGoes', 'Recommended. Allows rollback if something goes wrong.')}</span>
                </div>

                {targetType === 'production' && (
                    <div className="alert alert-warning">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                            <line x1="12" y1="9" x2="12" y2="13" />
                            <line x1="12" y1="17" x2="12.01" y2="17" />
                        </svg>
                        <span>{t('wp.promoteModal.youArePromotingTo', 'You are promoting to')} <strong>{t('wp.promoteModal.production', 'production')}</strong>. {t('wp.promoteModal.thisWillAffectTheLiveSite', 'This will affect the live site.')}</span>
                    </div>
                )}

                <div className="modal-actions">
                    <Button type="button" variant="outline" onClick={onClose} disabled={loading}>
                        {t('wp.promoteModal.cancel', 'Cancel')}
                    </Button>
                    <Button type="submit" disabled={loading}>
                        {loading ? <><Spinner size="sm" /> {t('wp.promoteModal.promoting', 'Promoting…')}</> : t('wp.promoteModal.promote', 'Promote')}
                    </Button>
                </div>
            </form>
        </Modal>
    );
};

export default PromoteModal;
