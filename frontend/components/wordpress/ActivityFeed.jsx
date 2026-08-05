import { useState, useEffect } from 'react';
import { ArrowUpRight, ArrowDownLeft, Database, GitBranch, Lock, Unlock, Trash2, Play, Square, RefreshCw, Camera, AlertCircle } from 'lucide-react';
import wordpressApi from '../../services/wordpress';
import { formatRelativeTime } from 'serverkit-sdk';
import { Button } from 'serverkit-sdk';
import { Badge } from 'serverkit-sdk';
import { Skeleton } from 'serverkit-sdk';
import { SkeletonBoundary } from 'serverkit-sdk';

const ACTION_ICONS = {
    create: Play,
    deploy: GitBranch,
    promote: ArrowUpRight,
    sync: ArrowDownLeft,
    lock: Lock,
    unlock: Unlock,
    destroy: Trash2,
    snapshot_created: Camera,
    snapshot_restored: Database,
    started: Play,
    stopped: Square,
    restarted: RefreshCw
};

const ACTION_BADGE_VARIANTS = {
    create: 'success',
    deploy: 'info',
    promote: 'default',
    sync: 'info',
    lock: 'warning',
    unlock: 'secondary',
    destroy: 'destructive',
    snapshot_created: 'info',
    snapshot_restored: 'warning',
    started: 'success',
    stopped: 'secondary',
    restarted: 'info'
};

const ActivityFeed = ({ projectId, envId, limit = 20, compact = false }) => {
    const [activities, setActivities] = useState([]);
    const [loading, setLoading] = useState(true);
    const [total, setTotal] = useState(0);

    useEffect(() => {
        loadActivities();
    }, [projectId, envId]);

    async function loadActivities() {
        setLoading(true);
        try {
            const params = { limit };
            if (envId) params.env_id = envId;
            const data = await wordpressApi.getProjectActivity(projectId, params);
            setActivities(data.activities || []);
            setTotal(data.total || 0);
        } catch (err) {
            console.error('Failed to load activities:', err);
        } finally {
            setLoading(false);
        }
    }

    const feedSkeleton = (
        <>
            {[1, 2, 3].map(i => (
                <div key={i} className="activity-item-skeleton">
                    <Skeleton variant="circle" width={32} height={32} />
                    <div className="skeleton-stack">
                        <Skeleton variant="line" width="60%" />
                        <Skeleton variant="line" width="40%" />
                    </div>
                </div>
            ))}
        </>
    );

    if (!loading && activities.length === 0) {
        return (
            <div className="activity-feed-empty">
                <p>No activity recorded yet.</p>
            </div>
        );
    }

    return (
        <SkeletonBoundary
            className={`activity-feed ${compact ? 'compact' : ''}`.trim()}
            loading={loading}
            skeleton={feedSkeleton}
        >
            {activities.length > 0 && activities.map(activity => {
                const Icon = ACTION_ICONS[activity.action] || AlertCircle;
                const colorClass = ACTION_BADGE_VARIANTS[activity.action] || 'secondary';

                return (
                    <div key={activity.id} className="activity-item">
                        <div className={`activity-icon ${colorClass}`}>
                            <Icon size={14} />
                        </div>
                        <div className="activity-content">
                            <span className="activity-description">
                                {activity.description || `${activity.action} performed`}
                            </span>
                            {activity.status === 'failed' && activity.error_message && (
                                <span className="activity-error">{activity.error_message}</span>
                            )}
                        </div>
                        <div className="activity-meta">
                            <span className="activity-time">{formatRelativeTime(activity.created_at)}</span>
                            {activity.status === 'failed' && (
                                <Badge variant="destructive">Failed</Badge>
                            )}
                            {activity.status === 'running' && (
                                <Badge variant="info">Running</Badge>
                            )}
                        </div>
                    </div>
                );
            })}
            {total > activities.length && !compact && (
                <Button variant="ghost" size="sm" className="activity-load-more" onClick={loadActivities}>
                    Load more
                </Button>
            )}
        </SkeletonBoundary>
    );
};

export default ActivityFeed;
