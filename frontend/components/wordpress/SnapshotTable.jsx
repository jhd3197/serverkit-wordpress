import { useState } from 'react';
import { Download, RotateCcw, Trash2, GitCommit, Tag } from 'lucide-react';
import { ConfirmDialog } from 'serverkit-sdk';
import { formatBytes } from 'serverkit-sdk';
import { EmptyState } from 'serverkit-sdk';
import { useTranslation, useFormat } from 'serverkit-sdk';

const SnapshotTable = ({ snapshots, onRestore, onDelete, loading = false }) => {
    const { t } = useTranslation();
    const { formatDateTime } = useFormat();
    const [actionLoading, setActionLoading] = useState({});
    const [confirmRestore, setConfirmRestore] = useState(null);
    const [confirmDelete, setConfirmDelete] = useState(null);

    function formatDate(dateString) {
        if (!dateString) return '-';
        return formatDateTime(dateString);
    }

    async function handleRestore(snapshot) {
        setConfirmRestore(null);
        setActionLoading(prev => ({ ...prev, [`restore-${snapshot.id}`]: true }));
        try {
            await onRestore?.(snapshot.id);
        } finally {
            setActionLoading(prev => ({ ...prev, [`restore-${snapshot.id}`]: false }));
        }
    }

    async function handleDelete(snapshot) {
        setConfirmDelete(null);
        setActionLoading(prev => ({ ...prev, [`delete-${snapshot.id}`]: true }));
        try {
            await onDelete?.(snapshot.id);
        } finally {
            setActionLoading(prev => ({ ...prev, [`delete-${snapshot.id}`]: false }));
        }
    }

    if (loading) {
        return <EmptyState loading title={t('wp.snapshotTable.loadingSnapshots', 'Loading snapshots…')} />;
    }

    if (!snapshots || snapshots.length === 0) {
        return (
            <div className="empty-state-small">
                <p>{t('wp.snapshotTable.noDatabaseSnapshotsYet', 'No database snapshots yet.')}</p>
                <p className="hint">{t('wp.snapshotTable.createASnapshotToBackupYour', 'Create a snapshot to back up your database.')}</p>
            </div>
        );
    }

    return (
        <div className="wp-table-card">
            <table className="sk-dtable wp-snapshot-table">
                <thead>
                    <tr>
                        <th>{t('wp.snapshotTable.snapshot', 'Snapshot')}</th>
                        <th>{t('wp.snapshotTable.size', 'Size')}</th>
                        <th>{t('wp.snapshotTable.created', 'Created')}</th>
                        <th>{t('wp.snapshotTable.gitContext', 'Git context')}</th>
                        <th className="wp-th-right">{t('wp.snapshotTable.actions', 'Actions')}</th>
                    </tr>
                </thead>
                <tbody>
                    {snapshots.map(snapshot => (
                        <tr key={snapshot.id}>
                            <td>
                                <div className="snapshot-name-cell">
                                    <span className="snapshot-name">{snapshot.name}</span>
                                    {snapshot.tag && (
                                        <span className="snapshot-tag">
                                            <Tag size={10} /> {snapshot.tag}
                                        </span>
                                    )}
                                    {snapshot.description && (
                                        <span className="snapshot-desc">{snapshot.description}</span>
                                    )}
                                </div>
                            </td>
                            <td>
                                <span className="mono">{formatBytes(snapshot.size_bytes)}</span>
                                {snapshot.compressed && (
                                    <span className="compressed-badge" title={t('wp.snapshotTable.compressed', 'Compressed')}>gz</span>
                                )}
                            </td>
                            <td><span className="snapshot-date">{formatDate(snapshot.created_at)}</span></td>
                            <td>
                                {snapshot.commit_sha ? (
                                    <div className="git-context">
                                        <GitCommit size={12} />
                                        <span className="mono git-context-sha">{snapshot.commit_sha.substring(0, 7)}</span>
                                        {snapshot.commit_message && (
                                            <span className="commit-msg" title={snapshot.commit_message}>
                                                {snapshot.commit_message.substring(0, 30)}
                                                {snapshot.commit_message.length > 30 && '...'}
                                            </span>
                                        )}
                                    </div>
                                ) : (
                                    <span className="text-muted">-</span>
                                )}
                            </td>
                            <td className="wp-cell-actions">
                                <button type="button"
                                    className="wp-row-action"
                                    title={t('wp.snapshotTable.restore', 'Restore')}
                                    onClick={() => setConfirmRestore(snapshot)}
                                    disabled={actionLoading[`restore-${snapshot.id}`]}
                                >
                                    <RotateCcw size={14} />
                                </button>
                                <button type="button"
                                    className="wp-row-action wp-row-action--danger"
                                    title={t('wp.snapshotTable.delete', 'Delete')}
                                    onClick={() => setConfirmDelete(snapshot)}
                                    disabled={actionLoading[`delete-${snapshot.id}`]}
                                >
                                    <Trash2 size={14} />
                                </button>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>

            <ConfirmDialog
                isOpen={!!confirmRestore}
                title={t('wp.snapshotTable.restoreDatabaseSnapshot', 'Restore database snapshot')}
                message={t('wp.snapshotTable.restoreDatabaseFrom', 'Restore database from "{{value}}"?', { value: confirmRestore?.name })}
                details={
                    <ul>
                        <li><strong>{t('wp.snapshotTable.warning', 'Warning:')}</strong> {t('wp.snapshotTable.thisWillOverwriteYourCurrentDatabase', 'This will overwrite your current database')}</li>
                        <li>{t('wp.snapshotTable.snapshotSize', 'Snapshot size:')} <code>{formatBytes(confirmRestore?.size_bytes)}</code></li>
                        <li>{t('wp.snapshotTable.created2', 'Created:')} {formatDate(confirmRestore?.created_at)}</li>
                        {confirmRestore?.commit_sha && (
                            <li>{t('wp.snapshotTable.gitCommit', 'Git commit:')} <code>{confirmRestore.commit_sha.substring(0, 7)}</code></li>
                        )}
                    </ul>
                }
                confirmText={t('wp.snapshotTable.restoreSnapshot', 'Restore snapshot')}
                variant="warning"
                onConfirm={() => handleRestore(confirmRestore)}
                onCancel={() => setConfirmRestore(null)}
            />

            <ConfirmDialog
                isOpen={!!confirmDelete}
                title={t('wp.snapshotTable.deleteSnapshot', 'Delete snapshot')}
                message={t('wp.snapshotTable.deleteSnapshot2', 'Delete snapshot "{{value}}"?', { value: confirmDelete?.name })}
                details={
                    <ul>
                        <li>{t('wp.snapshotTable.thisSnapshotWillBePermanentlyDeleted', 'This snapshot will be permanently deleted')}</li>
                        <li>{t('wp.snapshotTable.thisActionCannotBeUndone', "This can't be undone")}</li>
                    </ul>
                }
                confirmText={t('wp.snapshotTable.deleteSnapshot3', 'Delete snapshot')}
                variant="danger"
                onConfirm={() => handleDelete(confirmDelete)}
                onCancel={() => setConfirmDelete(null)}
            />
        </div>
    );
};

export default SnapshotTable;
