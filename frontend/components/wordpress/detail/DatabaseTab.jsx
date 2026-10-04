import { useState, useEffect } from 'react';
import { Database, Plus } from 'lucide-react';
import wordpressApi from '../../../services/wordpress';
import { useToast } from 'serverkit-sdk';
import { SnapshotTable } from '../index';
import { ErrorState } from 'serverkit-sdk';
import { Modal } from 'serverkit-sdk';
import { Button } from 'serverkit-sdk';
import { Input } from 'serverkit-sdk';
import { Label } from 'serverkit-sdk';
import { Textarea } from 'serverkit-sdk';
import { InfoList, InfoItem } from 'serverkit-sdk';
import { useTranslation, useFormat } from 'serverkit-sdk';

// Database Tab
const DatabaseTab = ({ siteId, site }) => {
    const { t } = useTranslation();
    const { formatDate } = useFormat();
    const toast = useToast();
    const [snapshots, setSnapshots] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [showCreateModal, setShowCreateModal] = useState(false);

    useEffect(() => {
        loadSnapshots();
    }, [siteId]);

    async function loadSnapshots() {
        setLoading(true);
        setError(null);
        try {
            const data = await wordpressApi.getSnapshots(siteId);
            setSnapshots(data.snapshots || []);
        } catch (err) {
            console.error('Failed to load snapshots:', err);
            setError(err);
        } finally {
            setLoading(false);
        }
    }

    async function handleCreateSnapshot(data) {
        toast.info(t('wp.databaseTab.creatingSnapshot', 'Creating snapshot...'), { duration: 3000 });
        try {
            await wordpressApi.createSnapshot(siteId, data);
            toast.success(t('wp.databaseTab.snapshotCreatedSuccessfully', 'Snapshot created successfully'));
            loadSnapshots();
            setShowCreateModal(false);
        } catch (err) {
            toast.error(err.message || t('wp.databaseTab.failedToCreateSnapshot', 'Failed to create snapshot'));
        }
    }

    async function handleRestore(snapId) {
        toast.info(t('wp.databaseTab.restoringDatabaseThisMayTakeA', 'Restoring database... This may take a moment.'), { duration: 5000 });
        try {
            await wordpressApi.restoreSnapshot(siteId, snapId);
            toast.success(t('wp.databaseTab.databaseRestoredFromSnapshot', 'Database restored from snapshot'));
        } catch (err) {
            toast.error(err.message || t('wp.databaseTab.failedToRestoreSnapshot', 'Failed to restore snapshot'));
        }
    }

    async function handleDelete(snapId) {
        try {
            await wordpressApi.deleteSnapshot(siteId, snapId);
            toast.success(t('wp.databaseTab.snapshotDeleted', 'Snapshot deleted'));
            loadSnapshots();
        } catch (err) {
            toast.error(err.message || t('wp.databaseTab.failedToDeleteSnapshot', 'Failed to delete snapshot'));
        }
    }

    if (error) {
        return (
            <ErrorState
                title={t('wp.databaseTab.failedToLoadSnapshots', 'Failed to load snapshots')}
                error={error}
                onRetry={loadSnapshots}
            />
        );
    }

    return (
        <div className="database-tab">
            {/* Database Connection Info */}
            <div className="app-panel">
                <div className="app-panel-header">
                    <Database size={16} />
                    {t('wp.databaseTab.databaseConnection', 'Database Connection')}
                </div>
                <div className="app-panel-body">
                    <InfoList>
                        <InfoItem label={t('wp.databaseTab.databaseName', 'Database Name')} value={site?.db_name || 'wordpress'} mono />
                        <InfoItem label={t('wp.databaseTab.databaseUser', 'Database User')} value={site?.db_user || 'wordpress'} mono />
                        <InfoItem label={t('wp.databaseTab.databaseHost', 'Database Host')} value={site?.db_host || 'db'} mono />
                        <InfoItem label={t('wp.databaseTab.tablePrefix', 'Table Prefix')} value={site?.db_prefix || 'wp_'} mono />
                        <InfoItem label={t('wp.databaseTab.container', 'Container')} value={site?.compose_project_name ? `${site.compose_project_name}-db` : '-'} mono />
                        <InfoItem label={t('wp.databaseTab.engine', 'Engine')} value={t('wp.databaseTab.mysql80', 'MySQL 8.0')} />
                    </InfoList>
                </div>
            </div>

            {/* Snapshots */}
            <div className="section-header mt-6">
                <h3>{t('wp.databaseTab.databaseSnapshots', 'Database Snapshots')}</h3>
                <Button onClick={() => setShowCreateModal(true)}>
                    <Plus size={14} /> {t('wp.databaseTab.createSnapshot', 'Create Snapshot')}
                </Button>
            </div>

            <SnapshotTable
                snapshots={snapshots}
                loading={loading}
                onRestore={handleRestore}
                onDelete={handleDelete}
            />

            {showCreateModal && (
                <CreateSnapshotModal
                    onClose={() => setShowCreateModal(false)}
                    onCreate={handleCreateSnapshot}
                />
            )}
        </div>
    );
};

// Create Snapshot Modal
const CreateSnapshotModal = ({ onClose, onCreate }) => {
    const { formatDate } = useFormat();
    const { t } = useTranslation();
    const [formData, setFormData] = useState({
        name: `Snapshot ${formatDate(new Date())}`,
        description: '',
        tag: ''
    });
    const [loading, setLoading] = useState(false);

    function handleChange(e) {
        const { name, value } = e.target;
        setFormData(prev => ({ ...prev, [name]: value }));
    }

    async function handleSubmit(e) {
        e.preventDefault();
        setLoading(true);
        try {
            await onCreate(formData);
        } finally {
            setLoading(false);
        }
    }

    return (
        <Modal open onClose={onClose} title={t('wp.databaseTab.createSnapshot2', 'Create Snapshot')}>
            <form onSubmit={handleSubmit}>
                <div className="form-group">
                    <Label>{t('wp.databaseTab.snapshotName', 'Snapshot Name *')}</Label>
                    <Input
                        type="text"
                        name="name"
                        value={formData.name}
                        onChange={handleChange}
                        required
                    />
                </div>

                <div className="form-group">
                    <Label>{t('wp.databaseTab.description', 'Description')}</Label>
                    <Textarea
                        name="description"
                        value={formData.description}
                        onChange={handleChange}
                        placeholder={t('wp.databaseTab.optionalDescription', 'Optional description...')}
                        rows={3}
                    />
                </div>

                <div className="form-group">
                    <Label>{t('wp.databaseTab.tag', 'Tag')}</Label>
                    <Input
                        type="text"
                        name="tag"
                        value={formData.tag}
                        onChange={handleChange}
                        placeholder={t('wp.databaseTab.eGV100Before', 'e.g., v1.0.0, before-update')}
                    />
                </div>

                <div className="modal-actions">
                    <Button type="button" variant="outline" onClick={onClose}>
                        {t('wp.databaseTab.cancel', 'Cancel')}
                    </Button>
                    <Button type="submit" disabled={loading}>
                        {loading ? 'Creating...' : 'Create Snapshot'}
                    </Button>
                </div>
            </form>
        </Modal>
    );
};

export default DatabaseTab;
