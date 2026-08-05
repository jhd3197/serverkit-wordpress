import { HardDrive } from 'lucide-react';
import { formatBytes } from 'serverkit-sdk';

const REFERENCE_THRESHOLD = 10 * 1024 * 1024 * 1024; // 10 GB reference

const DiskUsageBar = ({ usage, showBreakdown = true, compact = false }) => {
    if (!usage) return null;

    const total = usage.total || 0;
    const wordpress = usage.wordpress || 0;
    const mysql = usage.mysql || 0;
    const snapshots = usage.snapshots || 0;

    const percent = REFERENCE_THRESHOLD > 0
        ? Math.min((total / REFERENCE_THRESHOLD) * 100, 100)
        : 0;

    const wpPercent = total > 0 ? (wordpress / total) * percent : 0;
    const dbPercent = total > 0 ? (mysql / total) * percent : 0;
    const snapPercent = total > 0 ? (snapshots / total) * percent : 0;

    const colorClass = percent < 70 ? 'green' : percent < 90 ? 'yellow' : 'red';

    if (compact) {
        return (
            <div className="disk-usage-compact" title={`Disk: ${formatBytes(total)}`}>
                <HardDrive size={10} />
                <span className="disk-usage-compact-text">{formatBytes(total)}</span>
            </div>
        );
    }

    return (
        <div className="disk-usage-bar-container">
            <div className="disk-usage-header">
                <HardDrive size={14} />
                <span className="disk-usage-total">{formatBytes(total)}</span>
            </div>

            <div className="disk-usage-bar">
                <div
                    className={`disk-usage-segment wordpress ${colorClass}`}
                    style={{ width: `${wpPercent}%` }}
                    title={`WordPress: ${formatBytes(wordpress)}`}
                />
                <div
                    className="disk-usage-segment mysql"
                    style={{ width: `${dbPercent}%` }}
                    title={`MySQL: ${formatBytes(mysql)}`}
                />
                <div
                    className="disk-usage-segment snapshots"
                    style={{ width: `${snapPercent}%` }}
                    title={`Snapshots: ${formatBytes(snapshots)}`}
                />
            </div>

            {showBreakdown && (
                <div className="disk-usage-legend">
                    <div className="disk-usage-legend-item">
                        <span className="disk-usage-legend-dot wordpress" />
                        <span>WordPress {formatBytes(wordpress)}</span>
                    </div>
                    <div className="disk-usage-legend-item">
                        <span className="disk-usage-legend-dot mysql" />
                        <span>MySQL {formatBytes(mysql)}</span>
                    </div>
                    <div className="disk-usage-legend-item">
                        <span className="disk-usage-legend-dot snapshots" />
                        <span>Snapshots {formatBytes(snapshots)}</span>
                    </div>
                </div>
            )}
        </div>
    );
};

export default DiskUsageBar;
