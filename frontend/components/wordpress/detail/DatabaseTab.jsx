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

// Database Tab
const DatabaseTab = ({ siteId, site }) => {
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
        toast.info('Creating snapshot...', { duration: 3000 });
        try {
            await wordpressApi.createSnapshot(siteId, data);
            toast.success('Snapshot created successfully');
            loadSnapshots();
            setShowCreateModal(false);
        } catch (err) {
            toast.error(err.message || 'Failed to create snapshot');
        }
    }

    async function handleRestore(snapId) {
        toast.info('Restoring database... This may take a moment.', { duration: 5000 });
        try {
            await wordpressApi.restoreSnapshot(siteId, snapId);
            toast.success('Database restored from snapshot');
        } catch (err) {
            toast.error(err.message || 'Failed to restore snapshot');
        }
    }

    async function handleDelete(snapId) {
        try {
            await wordpressApi.deleteSnapshot(siteId, snapId);
            toast.success('Snapshot deleted');
            loadSnapshots();
        } catch (err) {
            toast.error(err.message || 'Failed to delete snapshot');
        }
    }

    if (error) {
        return (
            <ErrorState
                title="Failed to load snapshots"
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
                    Database Connection
                </div>
                <div className="app-panel-body">
                    <div className="app-info-grid">
                        <div className="app-info-item">
                            <span className="app-info-label">Database Name</span>
                            <span className="app-info-value mono">{site?.db_name || 'wordpress'}</span>
                        </div>
                        <div className="app-info-item">
                            <span className="app-info-label">Database User</span>
                            <span className="app-info-value mono">{site?.db_user || 'wordpress'}</span>
                        </div>
                        <div className="app-info-item">
                            <span className="app-info-label">Database Host</span>
                            <span className="app-info-value mono">{site?.db_host || 'db'}</span>
                        </div>
                        <div className="app-info-item">
                            <span className="app-info-label">Table Prefix</span>
                            <span className="app-info-value mono">{site?.db_prefix || 'wp_'}</span>
                        </div>
                        <div className="app-info-item">
                            <span className="app-info-label">Container</span>
                            <span className="app-info-value mono">{site?.compose_project_name ? `${site.compose_project_name}-db` : '-'}</span>
                        </div>
                        <div className="app-info-item">
                            <span className="app-info-label">Engine</span>
                            <span className="app-info-value">MySQL 8.0</span>
                        </div>
                    </div>
                </div>
            </div>

            {/* Snapshots */}
            <div className="section-header mt-6">
                <h3>Database Snapshots</h3>
                <Button onClick={() => setShowCreateModal(true)}>
                    <Plus size={14} /> Create Snapshot
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
    const [formData, setFormData] = useState({
        name: `Snapshot ${new Date().toLocaleDateString()}`,
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
        <Modal open onClose={onClose} title="Create Snapshot">
            <form onSubmit={handleSubmit}>
                <div className="form-group">
                    <Label>Snapshot Name *</Label>
                    <Input
                        type="text"
                        name="name"
                        value={formData.name}
                        onChange={handleChange}
                        required
                    />
                </div>

                <div className="form-group">
                    <Label>Description</Label>
                    <Textarea
                        name="description"
                        value={formData.description}
                        onChange={handleChange}
                        placeholder="Optional description..."
                        rows={3}
                    />
                </div>

                <div className="form-group">
                    <Label>Tag</Label>
                    <Input
                        type="text"
                        name="tag"
                        value={formData.tag}
                        onChange={handleChange}
                        placeholder="e.g., v1.0.0, before-update"
                    />
                </div>

                <div className="modal-actions">
                    <Button type="button" variant="outline" onClick={onClose}>
                        Cancel
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
