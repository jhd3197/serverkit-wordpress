import { useState } from 'react';
import { GitCommit, Rocket, Copy, CheckCircle, ExternalLink } from 'lucide-react';
import { Modal } from 'serverkit-sdk';
import { Button } from 'serverkit-sdk';
import { Input } from 'serverkit-sdk';
import { Label } from 'serverkit-sdk';
import { detectProvider } from 'serverkit-sdk';
import { EmptyState } from 'serverkit-sdk';
import { useTranslation, useFormat } from 'serverkit-sdk';

// Build a web URL to a commit on the host from the clone URL + sha so the log is
// clickable. Handles https + scp-style ssh remotes and Bitbucket's /commits path.
function commitUrl(repoUrl, sha) {
    if (!repoUrl || !sha) return null;
    let base = repoUrl.trim().replace(/\.git$/i, '');
    const ssh = base.match(/^git@([^:]+):(.+)$/);
    if (ssh) base = `https://${ssh[1]}/${ssh[2]}`;
    if (!/^https?:\/\//i.test(base)) return null;
    const seg = detectProvider(repoUrl)?.key === 'bitbucket' ? 'commits' : 'commit';
    return `${base}/${seg}/${sha}`;
}

const CommitList = ({ commits, currentCommit, onDeploy, onCreateDev, loading = false, repoUrl }) => {
    const { t } = useTranslation();
    // Aliased: this file already has a local helper of that name, so the
    // door goes in under a distinct one rather than shadowing it into
    // infinite recursion.
    const { formatDate: formatDateLocalized } = useFormat();
    const [actionLoading, setActionLoading] = useState({});
    const [showDevModal, setShowDevModal] = useState(null);

    function formatDate(dateString) {
        if (!dateString) return '-';
        const date = new Date(dateString);
        const now = new Date();
        const diffMs = now - date;
        const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
        const diffDays = Math.floor(diffHours / 24);

        if (diffHours < 1) return 'Just now';
        if (diffHours < 24) return `${diffHours}h ago`;
        if (diffDays < 7) return `${diffDays}d ago`;
        return formatDateLocalized(date);
    }

    async function handleDeploy(commit) {
        if (!confirm(t('wp.commitList.deployCommitToProduction', 'Deploy commit {{value}} to production?', { value: commit.sha.substring(0, 7) }))) {
            return;
        }
        setActionLoading(prev => ({ ...prev, [`deploy-${commit.sha}`]: true }));
        try {
            await onDeploy?.({ commit_sha: commit.sha });
        } finally {
            setActionLoading(prev => ({ ...prev, [`deploy-${commit.sha}`]: false }));
        }
    }

    async function handleCreateDev(commit, config) {
        setActionLoading(prev => ({ ...prev, [`dev-${commit.sha}`]: true }));
        try {
            await onCreateDev?.({
                commit_sha: commit.sha,
                config
            });
            setShowDevModal(null);
        } finally {
            setActionLoading(prev => ({ ...prev, [`dev-${commit.sha}`]: false }));
        }
    }

    if (loading) {
        return <EmptyState loading title={t('wp.commitList.loadingCommits', 'Loading commits...')} />;
    }

    if (!commits || commits.length === 0) {
        return (
            <div className="empty-state-small">
                <p>{t('wp.commitList.noCommitsFound', 'No commits found.')}</p>
                <p className="hint">{t('wp.commitList.pushChangesToYourRepositoryTo', 'Push changes to your repository to see commits here.')}</p>
            </div>
        );
    }

    return (
        <div className="commit-list">
            {commits.map(commit => {
                const isCurrent = currentCommit === commit.sha;
                const isDeploying = actionLoading[`deploy-${commit.sha}`];
                const isCreatingDev = actionLoading[`dev-${commit.sha}`];

                return (
                    <div key={commit.sha} className={`commit-item ${isCurrent ? 'current' : ''}`}>
                        <div className="commit-icon">
                            {isCurrent ? (
                                <CheckCircle size={16} className="current-icon" />
                            ) : (
                                <GitCommit size={16} />
                            )}
                        </div>

                        <div className="commit-info">
                            <div className="commit-header">
                                {commitUrl(repoUrl, commit.sha) ? (
                                    <a
                                        className="commit-sha mono commit-sha--link"
                                        href={commitUrl(repoUrl, commit.sha)}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        title={t('wp.commitList.viewThisCommitOnTheRemote', 'View this commit on the remote')}
                                    >
                                        {commit.sha.substring(0, 7)}
                                        <ExternalLink size={11} />
                                    </a>
                                ) : (
                                    <span className="commit-sha mono">{commit.sha.substring(0, 7)}</span>
                                )}
                                {isCurrent && <span className="current-badge">{t('wp.commitList.deployed', 'Deployed')}</span>}
                                <span className="commit-date">{formatDate(commit.date)}</span>
                            </div>
                            <p className="commit-message">{commit.message}</p>
                            {commit.author && (
                                <span className="commit-author">{commit.author}</span>
                            )}
                        </div>

                        <div className="commit-actions">
                            {!isCurrent && (
                                <Button
                                    size="sm"
                                    onClick={() => handleDeploy(commit)}
                                    disabled={isDeploying}
                                    title={t('wp.commitList.deployThisCommit', 'Deploy this commit')}
                                >
                                    <Rocket size={12} />
                                    {isDeploying ? 'Deploying...' : 'Deploy'}
                                </Button>
                            )}
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setShowDevModal(commit)}
                                disabled={isCreatingDev}
                                title={t('wp.commitList.createDevEnvironmentFromThisCommit', 'Create dev environment from this commit')}
                            >
                                <Copy size={12} />
                                {isCreatingDev ? 'Creating...' : 'Create Dev'}
                            </Button>
                        </div>
                    </div>
                );
            })}

            {showDevModal && (
                <CreateDevModal
                    commit={showDevModal}
                    onClose={() => setShowDevModal(null)}
                    onCreate={(config) => handleCreateDev(showDevModal, config)}
                    loading={actionLoading[`dev-${showDevModal.sha}`]}
                />
            )}
        </div>
    );
};

const CreateDevModal = ({ commit, onClose, onCreate, loading }) => {
    const { t } = useTranslation();
    const [formData, setFormData] = useState({
        name: `dev-${commit.sha.substring(0, 7)}`,
        domain: ''
    });

    function handleChange(e) {
        const { name, value } = e.target;
        setFormData(prev => ({ ...prev, [name]: value }));
    }

    function handleSubmit(e) {
        e.preventDefault();
        onCreate(formData);
    }

    return (
        <Modal open={true} onClose={onClose} title={t('wp.commitList.createDevEnvironment', 'Create Dev Environment')}>
            <p className="hint">
                {t('wp.commitList.createADevelopmentEnvironmentWithCode', 'Create a development environment with code from commit')}{' '}
                <code>{commit.sha.substring(0, 7)}</code>
            </p>
            <p className="commit-message-preview">&ldquo;{commit.message}&rdquo;</p>

            <form onSubmit={handleSubmit}>
                <div className="form-group">
                    <Label>{t('wp.commitList.environmentName', 'Environment Name')}</Label>
                    <Input
                        type="text"
                        name="name"
                        value={formData.name}
                        onChange={handleChange}
                        placeholder="dev-abc1234"
                    />
                </div>

                <div className="form-group">
                    <Label>{t('wp.commitList.domainOptional', 'Domain (optional)')}</Label>
                    <Input
                        type="text"
                        name="domain"
                        value={formData.domain}
                        onChange={handleChange}
                        placeholder="dev.example.com"
                    />
                    <span className="form-hint">{t('wp.commitList.leaveEmptyToAutoGenerate', 'Leave empty to auto-generate')}</span>
                </div>

                <div className="modal-actions">
                    <Button type="button" variant="outline" onClick={onClose}>
                        {t('wp.commitList.cancel', 'Cancel')}
                    </Button>
                    <Button type="submit" disabled={loading}>
                        {loading ? 'Creating...' : 'Create Environment'}
                    </Button>
                </div>
            </form>
        </Modal>
    );
};

export default CommitList;
