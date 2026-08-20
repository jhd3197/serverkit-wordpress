import { useState, useEffect } from 'react';
import { RefreshCw } from 'lucide-react';
import wordpressApi from '../../../services/wordpress';
import { useToast } from 'serverkit-sdk';
import { GitConnectForm, CommitList } from '../index';
import { ErrorState } from 'serverkit-sdk';
import { Button } from 'serverkit-sdk';
import { SkeletonBoundary } from 'serverkit-sdk';
import { useTranslation } from 'serverkit-sdk';

// Git Tab
const GitTab = ({ siteId, site, onUpdate }) => {
    const { t } = useTranslation();
    const toast = useToast();
    const [gitStatus, setGitStatus] = useState(null);
    const [commits, setCommits] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        loadGitData();
    }, [siteId]);

    async function loadGitData() {
        setLoading(true);
        setError(null);
        try {
            const statusData = await wordpressApi.getGitStatus(siteId);
            setGitStatus(statusData);

            if (statusData.connected) {
                const commitsData = await wordpressApi.getCommits(siteId);
                setCommits(commitsData.commits || []);
            }
        } catch (err) {
            console.error('Failed to load git data:', err);
            setError(err);
        } finally {
            setLoading(false);
        }
    }

    async function handleConnect(data) {
        await wordpressApi.connectRepo(siteId, data);
        toast.success(t('wp.gitTab.repositoryConnected', 'Repository connected'));
        loadGitData();
        onUpdate?.();
    }

    async function handleDisconnect() {
        await wordpressApi.disconnectRepo(siteId);
        toast.success(t('wp.gitTab.repositoryDisconnected', 'Repository disconnected'));
        loadGitData();
        onUpdate?.();
    }

    async function handleDeploy(data) {
        try {
            await wordpressApi.deployCommit(siteId, data);
            toast.success(t('wp.gitTab.deploymentCompleted', 'Deployment completed'));
            loadGitData();
            onUpdate?.();
        } catch (err) {
            toast.error(err.message || t('wp.gitTab.deploymentFailed', 'Deployment failed'));
        }
    }

    async function handleCreateDev(data) {
        try {
            await wordpressApi.createDevFromCommit(siteId, data);
            toast.success(t('wp.gitTab.developmentEnvironmentCreated', 'Development environment created'));
        } catch (err) {
            toast.error(err.message || t('wp.gitTab.failedToCreateEnvironment', 'Failed to create environment'));
        }
    }

    if (loading) {
        return (
            <SkeletonBoundary loading skeleton={(
                <div className="git-tab">
                    <div className="git-connect git-connect--card">
                        <div className="skeleton" style={{ width: 200, height: 24, marginBottom: 16 }} />
                        <div className="skeleton" style={{ height: 44, borderRadius: 6, marginBottom: 12 }} />
                        <div className="skeleton" style={{ height: 44, borderRadius: 6, marginBottom: 12 }} />
                        <div className="skeleton" style={{ width: 140, height: 36, borderRadius: 6 }} />
                    </div>
                </div>
            )} />
        );
    }

    if (error) {
        return (
            <ErrorState
                title={t('wp.gitTab.failedToLoadGitInformation', 'Failed to load Git information')}
                error={error}
                onRetry={loadGitData}
            />
        );
    }

    return (
        <div className="git-tab">
            <GitConnectForm
                gitStatus={gitStatus}
                onConnect={handleConnect}
                onDisconnect={handleDisconnect}
            />

            {gitStatus?.connected && (
                <div className="git-commits-section">
                    <div className="section-header">
                        <h3>{t('wp.gitTab.recentCommits', 'Recent Commits')}</h3>
                        <Button variant="outline" size="sm" onClick={loadGitData}>
                            <RefreshCw size={14} /> {t('wp.gitTab.refresh', 'Refresh')}
                        </Button>
                    </div>

                    <CommitList
                        commits={commits}
                        currentCommit={site.last_deploy_commit}
                        onDeploy={handleDeploy}
                        onCreateDev={handleCreateDev}
                        repoUrl={gitStatus?.repo_url}
                    />
                </div>
            )}
        </div>
    );
};

export default GitTab;
