import { useState, useEffect } from 'react';
import { Plus } from 'lucide-react';
import wordpressApi from '../../../services/wordpress';
import { useToast } from 'serverkit-sdk';
import { EnvironmentCard } from '../index';
import { ErrorState } from 'serverkit-sdk';
import { Modal } from 'serverkit-sdk';
import { Button } from 'serverkit-sdk';
import { Input } from 'serverkit-sdk';
import { Label } from 'serverkit-sdk';
import { SkeletonBoundary } from 'serverkit-sdk';
import { EnvironmentCardSkeleton } from './wpDetailShared';
import { useTranslation } from 'serverkit-sdk';

// Environments Tab
const EnvironmentsTab = ({ siteId, site, onUpdate }) => {
    const { t } = useTranslation();
    const toast = useToast();
    const [environments, setEnvironments] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [showCreateModal, setShowCreateModal] = useState(false);

    useEffect(() => {
        loadEnvironments();
    }, [siteId]);

    async function loadEnvironments() {
        setLoading(true);
        setError(null);
        try {
            const data = await wordpressApi.getEnvironments(siteId);
            setEnvironments(data.environments || []);
        } catch (err) {
            console.error('Failed to load environments:', err);
            setError(err);
        } finally {
            setLoading(false);
        }
    }

    async function handleCreateEnvironment(data) {
        toast.info(t('wp.environmentsTab.creatingEnvironmentThisMayTakeA', 'Creating environment... This may take a moment.'), { duration: 5000 });
        try {
            await wordpressApi.createEnvironment(siteId, data);
            toast.success(t('wp.environmentsTab.environmentCreatedSuccessfully', 'Environment created successfully'));
            loadEnvironments();
            setShowCreateModal(false);
        } catch (err) {
            toast.error(err.message || t('wp.environmentsTab.failedToCreateEnvironment', 'Failed to create environment'));
        }
    }

    async function handleSync(envId) {
        toast.info(t('wp.environmentsTab.syncingFromProduction', 'Syncing from production...'), { duration: 3000 });
        try {
            await wordpressApi.syncEnvironment(siteId, { environment_id: envId });
            toast.success(t('wp.environmentsTab.environmentSyncedFromProduction', 'Environment synced from production'));
            loadEnvironments();
        } catch (err) {
            toast.error(err.message || t('wp.environmentsTab.failedToSyncEnvironment', 'Failed to sync environment'));
        }
    }

    async function handleDelete(envId) {
        toast.info(t('wp.environmentsTab.deletingEnvironment', 'Deleting environment...'), { duration: 2000 });
        try {
            await wordpressApi.deleteEnvironment(siteId, envId);
            toast.success(t('wp.environmentsTab.environmentDeleted', 'Environment deleted'));
            loadEnvironments();
        } catch (err) {
            toast.error(err.message || t('wp.environmentsTab.failedToDeleteEnvironment', 'Failed to delete environment'));
        }
    }

    if (loading) {
        return (
            <SkeletonBoundary loading skeleton={(
                <div className="environments-tab">
                    <div className="section-header">
                        <div className="skeleton" style={{ width: 120, height: 24 }} />
                        <div className="skeleton" style={{ width: 160, height: 36, borderRadius: 6 }} />
                    </div>
                    <div className="environments-grid">
                        <EnvironmentCardSkeleton />
                        <EnvironmentCardSkeleton />
                    </div>
                </div>
            )} />
        );
    }

    if (error) {
        return (
            <ErrorState
                title={t('wp.environmentsTab.failedToLoadEnvironments', 'Failed to load environments')}
                error={error}
                onRetry={loadEnvironments}
            />
        );
    }

    // Filter out production from the environments list (it's shown separately)
    const childEnvs = environments.filter(e => e.id !== site.id && !e.is_production);
    const hasStaging = childEnvs.some(e => e.environment_type === 'staging');
    const hasDev = childEnvs.some(e => e.environment_type === 'development');
    const canCreateMore = site.is_production && (!hasStaging || !hasDev);

    return (
        <div className="environments-tab">
            <div className="section-header">
                <h3>{t('wp.environmentsTab.environments', 'Environments')}</h3>
                {canCreateMore && (
                    <Button onClick={() => setShowCreateModal(true)}>
                        <Plus size={14} /> {t('wp.environmentsTab.createEnvironment', 'Create Environment')}
                    </Button>
                )}
            </div>

            <div className="environments-grid">
                {/* Production environment (the current site) */}
                <EnvironmentCard
                    environment={{
                        id: site.id,
                        name: site.name,
                        url: site.url,
                        status: site.status,
                        db_name: site.db_name,
                        type: 'production'
                    }}
                    isProduction={true}
                />

                {/* Dev/staging environments */}
                {childEnvs.map(env => (
                    <EnvironmentCard
                        key={env.id}
                        environment={env}
                        productionUrl={site.url}
                        onSync={handleSync}
                        onDelete={handleDelete}
                    />
                ))}

                {/* Add-environment tile — sits inline next to the existing
                    environments instead of a full-width "empty" block. */}
                {canCreateMore && (
                    <button
                        type="button"
                        className="wp-env-add-tile"
                        onClick={() => setShowCreateModal(true)}
                    >
                        <span className="wp-env-add-tile__icon"><Plus size={22} /></span>
                        <span className="wp-env-add-tile__title">{t('wp.environmentsTab.createEnvironment2', 'Create environment')}</span>
                        <span className="wp-env-add-tile__hint">
                            {childEnvs.length === 0
                                ? 'Spin up a dev or staging copy to test changes safely before deploying to production.'
                                : 'Add another dev or staging copy.'}
                        </span>
                    </button>
                )}
            </div>

            {showCreateModal && (
                <CreateEnvironmentModal
                    onClose={() => setShowCreateModal(false)}
                    onCreate={handleCreateEnvironment}
                    productionDomain={site.url}
                    hasStaging={hasStaging}
                    hasDev={hasDev}
                />
            )}
        </div>
    );
};

// Create Environment Modal
export const CreateEnvironmentModal = ({ onClose, onCreate, productionDomain, hasStaging = false, hasDev = false }) => {
    const { t } = useTranslation();
    // Default to whichever type is still available
    const defaultType = !hasDev ? 'development' : !hasStaging ? 'staging' : 'development';
    const [formData, setFormData] = useState({
        type: defaultType,
        name: '',
        domain: '',
        cloneDb: true,
        syncSchedule: ''
    });
    const [loading, setLoading] = useState(false);

    // Generate suggested domain based on production domain
    function getSuggestedDomain() {
        if (!productionDomain) return '';
        try {
            const url = new URL(productionDomain);
            const prefix = formData.type === 'staging' ? 'staging' : 'dev';
            return `${prefix}.${url.hostname}`;
        } catch {
            return '';
        }
    }

    const suggestedDomain = getSuggestedDomain();
    const displayDomain = formData.domain || suggestedDomain;

    function handleChange(e) {
        const { name, value, type, checked } = e.target;
        setFormData(prev => ({
            ...prev,
            [name]: type === 'checkbox' ? checked : value
        }));
    }

    async function handleSubmit(e) {
        e.preventDefault();
        setLoading(true);
        try {
            await onCreate({
                type: formData.type,
                name: formData.name,
                domain: formData.domain || suggestedDomain,
                clone_db: formData.cloneDb,
                sync_schedule: formData.syncSchedule || null
            });
        } finally {
            setLoading(false);
        }
    }

    return (
        <Modal open onClose={onClose} title={t('wp.environmentsTab.createEnvironment3', 'Create Environment')}>
            <form onSubmit={handleSubmit}>
                <div className="form-group">
                    <Label>{t('wp.environmentsTab.environmentType', 'Environment Type')}</Label>
                    <select name="type" value={formData.type} onChange={handleChange}>
                        {!hasDev && <option value="development">{t('wp.environmentsTab.development', 'Development')}</option>}
                        {!hasStaging && <option value="staging">{t('wp.environmentsTab.staging', 'Staging')}</option>}
                    </select>
                </div>

                <div className="form-group">
                    <Label>{t('wp.environmentsTab.environmentName', 'Environment Name *')}</Label>
                    <Input
                        type="text"
                        name="name"
                        value={formData.name}
                        onChange={handleChange}
                        placeholder={t('wp.environmentsTab.mySiteDev', 'My Site Dev')}
                        required
                    />
                </div>

                <div className="form-group">
                    <Label>{t('wp.environmentsTab.domain', 'Domain')}</Label>
                    <Input
                        type="text"
                        name="domain"
                        value={formData.domain}
                        onChange={handleChange}
                        placeholder={suggestedDomain || 'dev.example.com'}
                    />
                    {suggestedDomain && !formData.domain && (
                        <span className="form-hint form-hint-domain">
                            {t('wp.environmentsTab.willUse', 'Will use:')} <code>{suggestedDomain}</code>
                        </span>
                    )}
                    {!suggestedDomain && !formData.domain && (
                        <span className="form-hint">{t('wp.environmentsTab.enterADomainOrLeaveEmpty', 'Enter a domain or leave empty to auto-generate')}</span>
                    )}
                </div>

                {displayDomain && (
                    <div className="env-preview-url">
                        <span className="preview-label">{t('wp.environmentsTab.environmentUrl', 'Environment URL:')}</span>
                        <span className="preview-url">https://{displayDomain}</span>
                    </div>
                )}

                <div className="form-group">
                    <label className="checkbox-label">
                        <input
                            type="checkbox"
                            name="cloneDb"
                            checked={formData.cloneDb}
                            onChange={handleChange}
                        />
                        <span>{t('wp.environmentsTab.cloneProductionDatabase', 'Clone production database')}</span>
                    </label>
                </div>

                <div className="form-group">
                    <Label>{t('wp.environmentsTab.syncScheduleOptional', 'Sync Schedule (optional)')}</Label>
                    <select name="syncSchedule" value={formData.syncSchedule} onChange={handleChange}>
                        <option value="">{t('wp.environmentsTab.noAutomaticSync', 'No automatic sync')}</option>
                        <option value="0 3 * * 0">{t('wp.environmentsTab.weeklySunday3am', 'Weekly (Sunday 3am)')}</option>
                        <option value="0 3 * * *">{t('wp.environmentsTab.daily3am', 'Daily (3am)')}</option>
                    </select>
                    <span className="form-hint">{t('wp.environmentsTab.automaticallySyncDatabaseFromProduction', 'Automatically sync database from production')}</span>
                </div>

                <div className="modal-actions">
                    <Button type="button" variant="outline" onClick={onClose}>
                        {t('wp.environmentsTab.cancel', 'Cancel')}
                    </Button>
                    <Button type="submit" disabled={loading}>
                        {loading ? 'Creating...' : 'Create Environment'}
                    </Button>
                </div>
            </form>
        </Modal>
    );
};

export default EnvironmentsTab;
