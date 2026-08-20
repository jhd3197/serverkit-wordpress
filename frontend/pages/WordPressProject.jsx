import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Plus, ExternalLink, RefreshCw, GitBranch, Search, Shield, Activity, Settings, ArrowRight, RotateCcw } from 'lucide-react';
import { useTabParam } from 'serverkit-sdk';
import wordpressApi from '../services/wordpress';
import { useToast } from 'serverkit-sdk';
import {
    PipelineView,
    PromoteModal,
    SyncModal,
    ActivityFeed,
    ContainerLogs,
    CompareView,
    SanitizationProfileForm,
    ResourceLimitsModal,
    BasicAuthModal,
    WpCliTerminal,
    HealthStatusPanel,
    AutoSyncScheduleModal,
    BulkActionsBar,
} from '../components/wordpress';
import { ConfirmDialog } from 'serverkit-sdk';
import { Modal } from 'serverkit-sdk';
import { Spinner } from 'serverkit-sdk';
import { EmptyState } from 'serverkit-sdk';
import { FolderGit2 } from 'lucide-react';
import { io } from 'socket.io-client';
import { Button } from 'serverkit-sdk';
import { Input } from 'serverkit-sdk';
import { Label } from 'serverkit-sdk';
import { useTranslation, useFormat } from 'serverkit-sdk';

const SOCKET_URL = import.meta.env.VITE_API_URL?.replace('/api/v1', '') || window.location.origin;

const VALID_TABS = ['pipeline', 'activity', 'health'];

const WordPressProject = () => {
    const { t } = useTranslation();
    const { formatDateTime } = useFormat();
    const { id } = useParams();
    const navigate = useNavigate();
    const toast = useToast();

    const [pipeline, setPipeline] = useState(null);
    const [loading, setLoading] = useState(true);
    const [activeTab, setActiveTab] = useTabParam(`/wordpress/pipelines/${id}`, VALID_TABS);
    const [showCreateEnvModal, setShowCreateEnvModal] = useState(false);
    const [promoteModal, setPromoteModal] = useState(null);
    const [syncModal, setSyncModal] = useState(null);
    const [logsPanel, setLogsPanel] = useState(null);
    const [confirmDialog, setConfirmDialog] = useState(null);
    const [operationInProgress, setOperationInProgress] = useState(null);
    const [operationProgress, setOperationProgress] = useState(null);
    const [compareModal, setCompareModal] = useState(null);
    const [showSanitizationProfiles, setShowSanitizationProfiles] = useState(false);

    // Phase 7 state
    const [resourceLimitsModal, setResourceLimitsModal] = useState(null);
    const [basicAuthModal, setBasicAuthModal] = useState(null);
    const [wpCliModal, setWpCliModal] = useState(null);
    const [autoSyncModal, setAutoSyncModal] = useState(null);
    const [healthData, setHealthData] = useState({});
    const [diskUsageData, setDiskUsageData] = useState({});
    const [bulkSelected, setBulkSelected] = useState([]);

    const socketRef = useRef(null);

    useEffect(() => {
        loadPipeline();
        connectSocket();

        return () => {
            if (socketRef.current) {
                socketRef.current.emit('unsubscribe_pipeline', { project_id: Number(id) });
                socketRef.current.disconnect();
            }
        };
    }, [id]);

    function connectSocket() {
        const token = localStorage.getItem('access_token');
        if (!token) return;

        const socket = io(SOCKET_URL, {
            auth: { token },
            transports: ['websocket', 'polling']
        });

        socket.on('connect', () => {
            socket.emit('subscribe_pipeline', { project_id: Number(id) });
        });

        socket.on('pipeline_event', (data) => {
            handlePipelineEvent(data);
        });

        socketRef.current = socket;
    }

    function handlePipelineEvent(data) {
        const { event, data: eventData } = data;

        switch (event) {
            case 'environment_created':
            case 'environment_deleted':
            case 'promotion_completed':
            case 'sync_completed':
                loadPipeline();
                if (eventData.success) {
                    toast.success(eventData.message || `${event.replace(/_/g, ' ')} successfully`);
                }
                setOperationInProgress(null);
                break;
            case 'environment_create_failed':
            case 'environment_delete_failed':
            case 'promotion_failed':
            case 'sync_failed':
                loadPipeline();
                toast.error(eventData.message || `${event.replace(/_/g, ' ')}`);
                setOperationInProgress(null);
                break;
            case 'environment_started':
            case 'environment_stopped':
            case 'environment_restarted':
            case 'environment_locked':
            case 'environment_unlocked':
                loadPipeline();
                break;
            case 'promotion_started':
            case 'sync_started':
            case 'environment_creating':
                setOperationInProgress(event);
                setOperationProgress(null);
                break;
            case 'operation_progress':
                setOperationProgress(eventData);
                break;
            case 'bulk_operation_completed':
                loadPipeline();
                toast.success(t('wp.wordPressProject.bulkOperationCompleted', 'Bulk operation completed'));
                break;
            default:
                break;
        }
    }

    async function loadPipeline() {
        try {
            const data = await wordpressApi.getProjectPipeline(id);
            setPipeline(data);
        } catch (err) {
            console.error('Failed to load pipeline:', err);
            toast.error(t('wp.wordPressProject.failedToLoadProjectPipeline', 'Failed to load project pipeline'));
        } finally {
            setLoading(false);
        }
    }

    const handlePromote = useCallback((sourceEnv, targetEnv) => {
        setPromoteModal({ sourceEnv, targetEnv });
    }, []);

    const handleDoPromote = useCallback(async (config) => {
        try {
            const res = await wordpressApi.promoteEnvironment(id, config);
            setPromoteModal(null);
            // A promotion is a deployment now: open its console, where the
            // steps, live log and retry live.
            if (res?.job_id) navigate(`/deployments/${res.job_id}`);
            else toast.info(t('wp.wordPressProject.promotionQueued', 'Promotion queued'));
        } catch (err) {
            toast.error(err.message || t('wp.wordPressProject.promotionFailed', 'Promotion failed'));
        }
    }, [id, navigate, toast]);

    const handleSync = useCallback((env) => {
        setSyncModal({ environment: env });
    }, []);

    const handleDoSync = useCallback(async (config) => {
        const env = syncModal.environment;
        toast.info(t('wp.wordPressProject.startingSync', 'Starting sync...'), { duration: 3000 });
        try {
            await wordpressApi.syncProjectEnvironment(id, env.id, config);
            setSyncModal(null);
        } catch (err) {
            toast.error(err.message || t('wp.wordPressProject.syncFailed', 'Sync failed'));
        }
    }, [id, syncModal, toast]);

    const handleStart = useCallback(async (env) => {
        try {
            await wordpressApi.startEnvironment(id, env.id);
            toast.success(t('wp.wordPressProject.environmentStarted', 'Environment started'));
            loadPipeline();
        } catch (err) {
            toast.error(err.message || t('wp.wordPressProject.failedToStartEnvironment', 'Failed to start environment'));
        }
    }, [id, toast]);

    const handleStop = useCallback(async (env) => {
        setConfirmDialog({
            titleKey: 'wp.wordPressProject.stopEnvironment', title: 'Stop Environment',
            message: `Stop the ${env.environment_type || ''} environment "${env.name}"?`,
            confirmTextKey: 'wp.wordPressProject.stop', confirmText: 'Stop',
            variant: 'warning',
            onConfirm: async () => {
                try {
                    await wordpressApi.stopEnvironment(id, env.id);
                    toast.success(t('wp.wordPressProject.environmentStopped', 'Environment stopped'));
                    loadPipeline();
                } catch (err) {
                    toast.error(err.message || t('wp.wordPressProject.failedToStopEnvironment', 'Failed to stop environment'));
                } finally {
                    setConfirmDialog(null);
                }
            },
            onCancel: () => setConfirmDialog(null)
        });
    }, [id, toast]);

    const handleRollback = useCallback((promotion) => {
        setConfirmDialog({
            titleKey: 'wp.wordPressProject.rollBackPromotion', title: 'Roll Back Promotion',
            message: `Restore the pre-promotion snapshot for "${promotion.target_site?.name || 'target environment'}"? This overwrites the target environment's current database with the snapshot taken just before promotion #${promotion.id}.`,
            confirmTextKey: 'wp.wordPressProject.rollBack', confirmText: 'Roll Back',
            variant: 'danger',
            onConfirm: async () => {
                toast.info(t('wp.wordPressProject.rollingBackPromotion', 'Rolling back promotion...'), { duration: 4000 });
                try {
                    await wordpressApi.rollbackPromotion(id, promotion.id);
                    toast.success(t('wp.wordPressProject.promotionRolledBack', 'Promotion rolled back'));
                    loadPipeline();
                } catch (err) {
                    toast.error(err.message || t('wp.wordPressProject.rollbackFailed', 'Rollback failed'));
                } finally {
                    setConfirmDialog(null);
                }
            },
            onCancel: () => setConfirmDialog(null),
        });
    }, [id, toast]);

    const handleRestart = useCallback(async (env) => {
        try {
            await wordpressApi.restartEnvironment(id, env.id);
            toast.success(t('wp.wordPressProject.environmentRestarted', 'Environment restarted'));
            loadPipeline();
        } catch (err) {
            toast.error(err.message || t('wp.wordPressProject.failedToRestartEnvironment', 'Failed to restart environment'));
        }
    }, [id, toast]);

    const handleDelete = useCallback((env) => {
        setConfirmDialog({
            titleKey: 'wp.wordPressProject.deleteEnvironment', title: 'Delete Environment',
            message: `Are you sure you want to delete "${env.name}"? This will remove all containers, files, and database for this environment.`,
            confirmTextKey: 'wp.wordPressProject.deleteEnvironment2', confirmText: 'Delete Environment',
            variant: 'danger',
            onConfirm: async () => {
                try {
                    await wordpressApi.deleteProjectEnvironment(id, env.id);
                    toast.success(t('wp.wordPressProject.environmentDeleted', 'Environment deleted'));
                    loadPipeline();
                } catch (err) {
                    toast.error(err.message || t('wp.wordPressProject.failedToDeleteEnvironment', 'Failed to delete environment'));
                } finally {
                    setConfirmDialog(null);
                }
            },
            onCancel: () => setConfirmDialog(null)
        });
    }, [id, toast]);

    const handleLock = useCallback(async (env) => {
        try {
            await wordpressApi.lockEnvironment(id, env.id, {
                reason: 'Manually locked',
                duration_minutes: 60
            });
            toast.success(t('wp.wordPressProject.environmentLocked', 'Environment locked'));
            loadPipeline();
        } catch (err) {
            toast.error(err.message || t('wp.wordPressProject.failedToLockEnvironment', 'Failed to lock environment'));
        }
    }, [id, toast]);

    const handleUnlock = useCallback(async (env) => {
        try {
            await wordpressApi.unlockEnvironment(id, env.id);
            toast.success(t('wp.wordPressProject.environmentUnlocked', 'Environment unlocked'));
            loadPipeline();
        } catch (err) {
            toast.error(err.message || t('wp.wordPressProject.failedToUnlockEnvironment', 'Failed to unlock environment'));
        }
    }, [id, toast]);

    const handleViewLogs = useCallback((env) => {
        setLogsPanel({ envId: env.id });
    }, []);

    const handleCompare = useCallback((envA, envB) => {
        setCompareModal({ envA, envB });
    }, []);

    // Phase 7 handlers
    const handleResourceLimits = useCallback((env) => {
        setResourceLimitsModal({ environment: env, currentLimits: env.resource_limits });
    }, []);

    const handleApplyResourceLimits = useCallback(async (limits) => {
        const env = resourceLimitsModal.environment;
        try {
            await wordpressApi.updateResourceLimits(id, env.id, limits);
            toast.success(t('wp.wordPressProject.resourceLimitsUpdatedContainersRestarting', 'Resource limits updated, containers restarting'));
            setResourceLimitsModal(null);
            loadPipeline();
        } catch (err) {
            toast.error(err.message || t('wp.wordPressProject.failedToUpdateResourceLimits', 'Failed to update resource limits'));
        }
    }, [id, resourceLimitsModal, toast]);

    const handleBasicAuth = useCallback((env) => {
        setBasicAuthModal({ environment: env });
    }, []);

    const handleWpCli = useCallback((env) => {
        setWpCliModal({ environment: env });
    }, []);

    const handleAutoSync = useCallback((env) => {
        setAutoSyncModal({ environment: env });
    }, []);

    const handleHealthCheck = useCallback(async (env) => {
        try {
            const data = await wordpressApi.getEnvironmentHealth(id, env.id);
            if (data.success) {
                setHealthData(prev => ({ ...prev, [env.id]: data }));
                toast.info(`${env.name}: ${data.overall_status}`);
            }
        } catch (err) {
            toast.error(t('wp.wordPressProject.healthCheckFailed', 'Health check failed'));
        }
    }, [id, toast]);

    const handleBulkToggle = useCallback((envId) => {
        setBulkSelected(prev =>
            prev.includes(envId)
                ? prev.filter(id => id !== envId)
                : [...prev, envId]
        );
    }, []);

    const handleBulkExecute = useCallback(async (action, envIds) => {
        try {
            await wordpressApi.executeBulkOperation(id, [{ action, env_ids: envIds }]);
            toast.success(t('wp.wordPressProject.bulkCompleted', 'Bulk {{action}} completed', { action: action }));
            setBulkSelected([]);
            loadPipeline();
        } catch (err) {
            toast.error(err.message || t('wp.wordPressProject.bulkFailed', 'Bulk {{action}} failed', { action: action }));
        }
    }, [id, toast]);

    // Load health and disk usage data on pipeline load
    useEffect(() => {
        if (pipeline) {
            loadHealthData();
            loadDiskUsageData();
        }
    }, [pipeline]);

    async function loadHealthData() {
        try {
            const data = await wordpressApi.getProjectHealth(id);
            if (data.success) {
                setHealthData(data.environments || {});
            }
        } catch {
            // Health data is optional
        }
    }

    async function loadDiskUsageData() {
        try {
            const data = await wordpressApi.getProjectDiskUsage(id);
            if (data.success) {
                setDiskUsageData(data.environments || {});
            }
        } catch {
            // Disk usage data is optional
        }
    }

    const handleCreateEnvironment = useCallback(async (data) => {
        toast.info(t('wp.wordPressProject.creatingEnvironment', 'Creating environment...'), { duration: 5000 });
        try {
            await wordpressApi.createProjectEnvironment(id, data);
            setShowCreateEnvModal(false);
        } catch (err) {
            toast.error(err.message || t('wp.wordPressProject.failedToCreateEnvironment', 'Failed to create environment'));
        }
    }, [id, toast]);

    if (loading) {
        return <EmptyState loading loadingVariant="detail" size="lg" title={t('wp.wordPressProject.loadingProjectPipeline', 'Loading project pipeline')} />;
    }

    if (!pipeline) {
        return (
            <EmptyState
                icon={FolderGit2}
                title={t('wp.wordPressProject.pipelineNotFound', 'Pipeline not found')}
                description={t('wp.wordPressProject.thisWordpressPipelineDoesNotExist', 'This WordPress pipeline does not exist or has been removed.')}
                action={<Button onClick={() => navigate('/wordpress/pipelines')}>{t('wp.wordPressProject.backToPipelines', 'Back to Pipelines')}</Button>}
            />
        );
    }

    const production = pipeline.production || pipeline;
    const projectName = production.name || 'WordPress Project';
    const projectDomain = production.application?.domains?.[0] || production.url || '';

    return (
        <div className="app-detail-page app-detail-page--wide wp-project-page">
            {/* Top Bar */}
            <div className="app-detail-topbar">
                <div className="app-detail-breadcrumbs">
                    <Link to="/wordpress/pipelines">{t('wp.wordPressProject.pipelines', 'Pipelines')}</Link>
                    <span>/</span>
                    <span className="current">{projectName}</span>
                </div>
                <div className="app-detail-actions">
                    {projectDomain && (
                        <Button variant="ghost" asChild>
                            <a
                                href={projectDomain.startsWith('http') ? projectDomain : `https://${projectDomain}`}
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                <ExternalLink size={16} />
                                {t('wp.wordPressProject.visitSite', 'Visit Site')}
                            </a>
                        </Button>
                    )}
                    <Button
                        variant="ghost"
                        onClick={() => setShowSanitizationProfiles(true)}
                        title={t('wp.wordPressProject.manageSanitizationProfiles', 'Manage sanitization profiles')}
                    >
                        <Shield size={16} />
                        {t('wp.wordPressProject.profiles', 'Profiles')}
                    </Button>
                    <Button
                        onClick={() => setShowCreateEnvModal(true)}
                    >
                        <Plus size={16} />
                        {t('wp.wordPressProject.newEnvironment', 'New Environment')}
                    </Button>
                </div>
            </div>

            {/* Header */}
            <div className="app-detail-header">
                <div className="app-detail-icon wp-icon">
                    <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor">
                        <path d="M12 2C6.486 2 2 6.486 2 12s4.486 10 10 10 10-4.486 10-10S17.514 2 12 2zm0 19.542c-5.261 0-9.542-4.281-9.542-9.542S6.739 2.458 12 2.458 21.542 6.739 21.542 12 17.261 21.542 12 21.542z" />
                    </svg>
                </div>
                <div className="app-detail-title-block">
                    <h1>
                        {projectName}
                        <span className={`app-status-badge ${production.status === 'running' ? 'running' : 'stopped'}`}>
                            <span className="pulse-dot" />
                            {production.status === 'running' ? 'Running' : 'Stopped'}
                        </span>
                    </h1>
                    <div className="app-detail-subtitle">
                        {projectDomain && <span className="mono">{projectDomain}</span>}
                        {production.wp_version && (
                            <>
                                <span className="separator">•</span>
                                <span>{t('wp.wordPressProject.wordpress', 'WordPress')} {production.wp_version}</span>
                            </>
                        )}
                        {pipeline.environments && (
                            <>
                                <span className="separator">•</span>
                                <span>{(pipeline.environments?.length || 0) + 1} environments</span>
                            </>
                        )}
                    </div>
                </div>
            </div>

            {/* Tabs */}
            <div className="app-detail-tabs">
                <div
                    className={`app-detail-tab ${activeTab === 'pipeline' ? 'active' : ''}`}
                    onClick={() => setActiveTab('pipeline')}
                >
                    {t('wp.wordPressProject.pipeline', 'Pipeline')}
                </div>
                <div
                    className={`app-detail-tab ${activeTab === 'activity' ? 'active' : ''}`}
                    onClick={() => setActiveTab('activity')}
                >
                    {t('wp.wordPressProject.activity', 'Activity')}
                </div>
                <div
                    className={`app-detail-tab ${activeTab === 'health' ? 'active' : ''}`}
                    onClick={() => setActiveTab('health')}
                >
                    {t('wp.wordPressProject.health', 'Health')}
                </div>
            </div>

            {/* Tab Content */}
            <div className="app-detail-content">
                {activeTab === 'pipeline' && (
                    <div className="pipeline-tab">
                        {operationInProgress && (
                            <div className="pipeline-operation-banner">
                                <Spinner size="sm" />
                                <div className="operation-progress-content">
                                    <span>
                                        {operationInProgress === 'promotion_started' && 'Promotion in progress...'}
                                        {operationInProgress === 'sync_started' && 'Sync in progress...'}
                                        {operationInProgress === 'environment_creating' && 'Creating environment...'}
                                    </span>
                                    {operationProgress && (
                                        <div className="operation-progress">
                                            <div className="operation-progress-bar">
                                                <div
                                                    className="operation-progress-fill"
                                                    style={{ width: `${operationProgress.percent || 0}%` }}
                                                />
                                            </div>
                                            <span className="operation-progress-step">
                                                {t('wp.wordPressProject.step', 'Step')} {operationProgress.step}/{operationProgress.total}: {operationProgress.message}
                                            </span>
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}

                        {bulkSelected.length > 0 && (
                            <BulkActionsBar
                                selectedIds={bulkSelected}
                                environments={[
                                    ...(pipeline.environments || []),
                                    pipeline.production
                                ].filter(Boolean)}
                                prodId={id}
                                onClear={() => setBulkSelected([])}
                                onExecute={handleBulkExecute}
                                api={wordpressApi}
                            />
                        )}

                        <PipelineView
                            pipeline={pipeline}
                            onPromote={handlePromote}
                            onSync={handleSync}
                            onStart={handleStart}
                            onStop={handleStop}
                            onRestart={handleRestart}
                            onDelete={handleDelete}
                            onLock={handleLock}
                            onUnlock={handleUnlock}
                            onViewLogs={handleViewLogs}
                            onCompare={handleCompare}
                            onCreateMultidev={() => {
                                setShowCreateEnvModal(true);
                            }}
                            onResourceLimits={handleResourceLimits}
                            onBasicAuth={handleBasicAuth}
                            onWpCli={handleWpCli}
                            onAutoSync={handleAutoSync}
                            onHealthCheck={handleHealthCheck}
                            operationInProgress={operationInProgress}
                            healthData={healthData}
                            diskUsageData={diskUsageData}
                            bulkSelected={bulkSelected}
                            onBulkToggle={handleBulkToggle}
                        />

                        {/* Promotion History (with rollback) */}
                        <PromotionHistory projectId={id} onRollback={handleRollback} />

                        {/* Recent Activity Preview */}
                        <div className="pipeline-activity-preview">
                            <div className="section-header">
                                <h3>{t('wp.wordPressProject.recentActivity', 'Recent Activity')}</h3>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setActiveTab('activity')}
                                >
                                    {t('wp.wordPressProject.viewAll', 'View All')}
                                </Button>
                            </div>
                            <ActivityFeed projectId={id} limit={5} compact />
                        </div>
                    </div>
                )}

                {activeTab === 'activity' && (
                    <div className="activity-tab">
                        <div className="section-header">
                            <h3>{t('wp.wordPressProject.activityLog', 'Activity Log')}</h3>
                            <Button variant="ghost" size="sm" onClick={loadPipeline}>
                                <RefreshCw size={14} /> {t('wp.wordPressProject.refresh', 'Refresh')}
                            </Button>
                        </div>
                        <ActivityFeed projectId={id} limit={50} />
                    </div>
                )}

                {activeTab === 'health' && (
                    <div className="health-tab">
                        <HealthStatusPanel
                            projectId={id}
                            environments={[
                                pipeline.production,
                                ...(pipeline.environments || [])
                            ].filter(Boolean)}
                            api={wordpressApi}
                        />
                    </div>
                )}
            </div>

            {/* Logs Panel */}
            {logsPanel && (
                <div className="pipeline-logs-overlay">
                    <ContainerLogs
                        projectId={id}
                        envId={logsPanel.envId}
                        onClose={() => setLogsPanel(null)}
                    />
                </div>
            )}

            {/* Modals */}
            {promoteModal && (
                <PromoteModal
                    sourceEnv={promoteModal.sourceEnv}
                    targetEnv={promoteModal.targetEnv}
                    onClose={() => setPromoteModal(null)}
                    onPromote={handleDoPromote}
                />
            )}

            {syncModal && (
                <SyncModal
                    environment={syncModal.environment}
                    productionName={projectName}
                    onClose={() => setSyncModal(null)}
                    onSync={handleDoSync}
                />
            )}

            {showCreateEnvModal && (
                <CreatePipelineEnvModal
                    onClose={() => setShowCreateEnvModal(false)}
                    onCreate={handleCreateEnvironment}
                    productionDomain={projectDomain}
                    existingTypes={(pipeline.environments || []).map(e => e.environment_type)}
                    projectId={id}
                />
            )}

            {compareModal && (
                <CompareView
                    projectId={id}
                    envA={compareModal.envA}
                    envB={compareModal.envB}
                    onClose={() => setCompareModal(null)}
                />
            )}

            {showSanitizationProfiles && (
                <SanitizationProfileForm
                    onClose={() => setShowSanitizationProfiles(false)}
                    onProfilesChange={() => {}}
                />
            )}

            {resourceLimitsModal && (
                <ResourceLimitsModal
                    environment={resourceLimitsModal.environment}
                    currentLimits={resourceLimitsModal.currentLimits}
                    onClose={() => setResourceLimitsModal(null)}
                    onApply={handleApplyResourceLimits}
                />
            )}

            {basicAuthModal && (
                <BasicAuthModal
                    environment={basicAuthModal.environment}
                    prodId={id}
                    onClose={() => setBasicAuthModal(null)}
                    api={wordpressApi}
                />
            )}

            {wpCliModal && (
                <WpCliTerminal
                    environment={wpCliModal.environment}
                    prodId={id}
                    onClose={() => setWpCliModal(null)}
                    api={wordpressApi}
                />
            )}

            {autoSyncModal && (
                <AutoSyncScheduleModal
                    environment={autoSyncModal.environment}
                    prodId={id}
                    onClose={() => setAutoSyncModal(null)}
                    api={wordpressApi}
                />
            )}

            <ConfirmDialog
                isOpen={!!confirmDialog}
                title={confirmDialog?.title}
                message={confirmDialog?.message}
                confirmText={confirmDialog?.confirmText}
                variant={confirmDialog?.variant}
                onConfirm={confirmDialog?.onConfirm}
                onCancel={confirmDialog?.onCancel || (() => setConfirmDialog(null))}
            />
        </div>
    );
};

// Promotion History (lists past promotions; rollback available for completed promotions with a pre-promotion snapshot)
const PromotionHistory = ({ projectId, onRollback }) => {
    const { t } = useTranslation();
    const [promotions, setPromotions] = useState([]);
    const [loading, setLoading] = useState(true);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const data = await wordpressApi.getPromotionHistory(projectId, { limit: 20 });
            setPromotions(data.promotions || []);
        } catch {
            setPromotions([]);
        } finally {
            setLoading(false);
        }
    }, [projectId]);

    useEffect(() => { load(); }, [load]);

    if (loading || promotions.length === 0) {
        return null;
    }

    return (
        <div className="pipeline-promotion-history">
            <div className="section-header">
                <h3>{t('wp.wordPressProject.promotionHistory', 'Promotion History')}</h3>
                <Button variant="ghost" size="sm" onClick={load}>
                    <RefreshCw size={14} /> {t('wp.wordPressProject.refresh2', 'Refresh')}
                </Button>
            </div>
            <div className="promotion-history-list">
                {promotions.map(p => {
                    const canRollback = p.status === 'completed' && !!p.pre_promotion_snapshot_id;
                    return (
                        <div key={p.id} className="promotion-history-item">
                            <div className="promotion-history-main">
                                <span className={`promotion-status promotion-status-${p.status}`}>{p.status}</span>
                                <span className="promotion-route">
                                    {p.source_site?.name || `#${p.source_site_id}`} <ArrowRight size={12} /> {p.target_site?.name || `#${p.target_site_id}`}
                                </span>
                                <span className="promotion-type">{p.promotion_type}</span>
                                {p.created_at && (
                                    <span className="promotion-date">{formatDateTime(p.created_at)}</span>
                                )}
                            </div>
                            {canRollback && (
                                <Button variant="outline" size="sm" onClick={() => onRollback(p)}>
                                    <RotateCcw size={14} /> {t('wp.wordPressProject.rollback', 'Rollback')}
                                </Button>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

// Create Environment Modal (Pipeline version)
const CreatePipelineEnvModal = ({ onClose, onCreate, productionDomain, existingTypes, projectId }) => {
    const { t } = useTranslation();
    const [formData, setFormData] = useState({
        type: existingTypes.includes('development') ? 'staging' : 'development',
        name: '',
        branch: '',
        clone_db: true
    });
    const [loading, setLoading] = useState(false);
    const [branches, setBranches] = useState([]);
    const [branchesLoading, setBranchesLoading] = useState(false);
    const [branchSearch, setBranchSearch] = useState('');
    const [useCustomBranch, setUseCustomBranch] = useState(false);

    const availableTypes = [
        { value: 'development', labelKey: 'wp.wordPressProject.development', label: 'Development', disabled: existingTypes.includes('development') },
        { value: 'staging', labelKey: 'wp.wordPressProject.staging', label: 'Staging', disabled: existingTypes.includes('staging') },
        { value: 'multidev', labelKey: 'wp.wordPressProject.multidevBranchBased', label: 'Multidev (branch-based)', disabled: false }
    ];

    useEffect(() => {
        if (formData.type === 'multidev' && branches.length === 0 && !branchesLoading) {
            loadBranches();
        }
    }, [formData.type]);

    async function loadBranches() {
        setBranchesLoading(true);
        try {
            const data = await wordpressApi.getBranches(projectId);
            setBranches(data.branches || []);
        } catch {
            setBranches([]);
        } finally {
            setBranchesLoading(false);
        }
    }

    function handleChange(e) {
        const { name, value, type, checked } = e.target;
        setFormData(prev => ({
            ...prev,
            [name]: type === 'checkbox' ? checked : value
        }));
    }

    function selectBranch(branchName) {
        setFormData(prev => ({ ...prev, branch: branchName }));
        setBranchSearch('');
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

    const filteredBranches = branches.filter(b => {
        if (!branchSearch) return true;
        return b.name.toLowerCase().includes(branchSearch.toLowerCase());
    });

    return (
        <Modal open onClose={onClose} title={t('wp.wordPressProject.createEnvironment', 'Create Environment')}>
            <form onSubmit={handleSubmit}>
                    <div className="form-group">
                        <Label>{t('wp.wordPressProject.environmentType', 'Environment Type')}</Label>
                        <select name="type" value={formData.type} onChange={handleChange}>
                            {availableTypes.map(t => (
                                <option key={t.value} value={t.value} disabled={t.disabled}>
                                    {t.label}{t.disabled ? ' (already exists)' : ''}
                                </option>
                            ))}
                        </select>
                    </div>

                    {formData.type === 'multidev' && (
                        <div className="form-group">
                            <Label>
                                <GitBranch size={14} className="mr-1" style={{ verticalAlign: -2 }} />
                                {t('wp.wordPressProject.gitBranch', 'Git Branch *')}
                            </Label>

                            {formData.branch && !useCustomBranch && (
                                <div className="branch-selected">
                                    <GitBranch size={14} />
                                    <span className="branch-selected-name">{formData.branch}</span>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => setFormData(prev => ({ ...prev, branch: '' }))}
                                    >
                                        {t('wp.wordPressProject.change', 'Change')}
                                    </Button>
                                </div>
                            )}

                            {!formData.branch && !useCustomBranch && (
                                <>
                                    {branchesLoading ? (
                                        <div className="branch-picker-loading">
                                            <Spinner size="sm" />
                                            <span>{t('wp.wordPressProject.loadingBranches', 'Loading branches...')}</span>
                                        </div>
                                    ) : branches.length > 0 ? (
                                        <div className="branch-picker">
                                            <div className="branch-picker-search">
                                                <Search size={14} />
                                                <Input
                                                    type="text"
                                                    value={branchSearch}
                                                    onChange={e => setBranchSearch(e.target.value)}
                                                    placeholder={t('wp.wordPressProject.searchBranches', 'Search branches...')}
                                                    autoFocus
                                                />
                                            </div>
                                            <div className="branch-picker-list">
                                                {filteredBranches.map(b => (
                                                    <button
                                                        key={b.name}
                                                        type="button"
                                                        className={`branch-picker-item ${b.has_multidev ? 'has-env' : ''} ${b.is_current ? 'current' : ''}`}
                                                        onClick={() => selectBranch(b.name)}
                                                        disabled={b.has_multidev}
                                                        title={b.has_multidev ? t('wp.wordPressProject.multidevAlreadyExistsForThisBranch', 'Multidev already exists for this branch') : ''}
                                                    >
                                                        <div className="branch-picker-item-main">
                                                            <GitBranch size={12} />
                                                            <span className="branch-name">{b.name}</span>
                                                            {b.is_current && <span className="branch-tag">default</span>}
                                                            {b.has_multidev && <span className="branch-tag env">{t('wp.wordPressProject.hasEnv', 'has env')}</span>}
                                                        </div>
                                                        {b.message && (
                                                            <div className="branch-picker-item-meta">
                                                                <span className="branch-sha">{b.short_sha}</span>
                                                                <span className="branch-msg">{b.message}</span>
                                                            </div>
                                                        )}
                                                    </button>
                                                ))}
                                                {filteredBranches.length === 0 && (
                                                    <div className="branch-picker-empty">
                                                        {t('wp.wordPressProject.noBranchesMatch', 'No branches match "')}{branchSearch}&quot;
                                                    </div>
                                                )}
                                            </div>
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="sm"
                                                className="branch-picker-custom"
                                                onClick={() => setUseCustomBranch(true)}
                                            >
                                                {t('wp.wordPressProject.enterBranchNameManually', 'Enter branch name manually')}
                                            </Button>
                                        </div>
                                    ) : (
                                        <div>
                                            <Input
                                                type="text"
                                                name="branch"
                                                value={formData.branch}
                                                onChange={handleChange}
                                                placeholder="feature/my-branch"
                                                required
                                            />
                                            <span className="form-hint">{t('wp.wordPressProject.noGitRepoConnectedOrNo', 'No git repo connected or no branches found. Enter branch name manually.')}</span>
                                        </div>
                                    )}
                                </>
                            )}

                            {useCustomBranch && (
                                <div>
                                    <Input
                                        type="text"
                                        name="branch"
                                        value={formData.branch}
                                        onChange={handleChange}
                                        placeholder="feature/my-branch"
                                        required
                                        autoFocus
                                    />
                                    {branches.length > 0 && (
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="sm"
                                            className="mt-1"
                                            onClick={() => { setUseCustomBranch(false); setFormData(prev => ({ ...prev, branch: '' })); }}
                                        >
                                            {t('wp.wordPressProject.backToBranchList', 'Back to branch list')}
                                        </Button>
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    <div className="form-group">
                        <Label>{t('wp.wordPressProject.environmentName', 'Environment Name')}</Label>
                        <Input
                            type="text"
                            name="name"
                            value={formData.name}
                            onChange={handleChange}
                            placeholder={formData.type === 'multidev' ? t('wp.wordPressProject.autoGeneratedFromBranch', 'Auto-generated from branch') : `${formData.type} environment`}
                        />
                        <span className="form-hint">{t('wp.wordPressProject.leaveEmptyToAutoGenerate', 'Leave empty to auto-generate')}</span>
                    </div>

                    <div className="form-group">
                        <label className="checkbox-label">
                            <input
                                type="checkbox"
                                name="clone_db"
                                checked={formData.clone_db}
                                onChange={handleChange}
                            />
                            <span>{t('wp.wordPressProject.cloneProductionDatabase', 'Clone production database')}</span>
                        </label>
                        <span className="form-hint">{t('wp.wordPressProject.createsACopyOfTheProduction', 'Creates a copy of the production database for this environment')}</span>
                    </div>

                    <div className="modal-actions">
                        <Button type="button" variant="outline" onClick={onClose} disabled={loading}>
                            {t('wp.wordPressProject.cancel', 'Cancel')}
                        </Button>
                        <Button
                            type="submit"
                            disabled={loading || (formData.type === 'multidev' && !formData.branch)}
                        >
                            {loading ? <><Spinner size="sm" /> {t('wp.wordPressProject.creating', 'Creating...')}</> : 'Create Environment'}
                        </Button>
                    </div>
                </form>
        </Modal>
    );
};

export default WordPressProject;
