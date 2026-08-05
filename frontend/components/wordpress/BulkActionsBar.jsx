import { useState } from 'react';
import { Square, Play, RefreshCw, ArrowDownLeft, X } from 'lucide-react';
import { Spinner } from 'serverkit-sdk';
import { Button } from 'serverkit-sdk';

const BulkActionsBar = ({ selectedIds, environments, prodId, onClear, onExecute, api }) => {
    const [executing, setExecuting] = useState(false);
    const [confirmAction, setConfirmAction] = useState(null);

    if (!selectedIds || selectedIds.length === 0) return null;

    const selectedNames = selectedIds.map(id => {
        const env = environments.find(e => e.id === id);
        return env?.name || `#${id}`;
    });

    async function handleAction(action) {
        if (action === 'stop' || action === 'sync') {
            setConfirmAction(action);
            return;
        }
        await executeAction(action);
    }

    async function executeAction(action) {
        setExecuting(true);
        setConfirmAction(null);
        try {
            await onExecute(action, selectedIds);
        } finally {
            setExecuting(false);
        }
    }

    return (
        <div className="bulk-actions-bar">
            {confirmAction ? (
                <div className="bulk-actions-confirm">
                    <span>
                        {confirmAction === 'stop' && `Stop ${selectedIds.length} environment(s)?`}
                        {confirmAction === 'sync' && `Sync ${selectedIds.length} environment(s) from production?`}
                    </span>
                    <Button
                        size="sm"
                        onClick={() => executeAction(confirmAction)}
                        disabled={executing}
                    >
                        {executing ? <Spinner size="sm" /> : 'Confirm'}
                    </Button>
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setConfirmAction(null)}
                        disabled={executing}
                    >
                        Cancel
                    </Button>
                </div>
            ) : (
                <>
                    <div className="bulk-actions-info">
                        <span className="bulk-actions-count">{selectedIds.length}</span>
                        <span>selected</span>
                    </div>

                    <div className="bulk-actions-buttons">
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleAction('start')}
                            disabled={executing}
                            title="Start Selected"
                        >
                            <Play size={12} />
                            Start
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleAction('stop')}
                            disabled={executing}
                            title="Stop Selected"
                        >
                            <Square size={12} />
                            Stop
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleAction('restart')}
                            disabled={executing}
                            title="Restart Selected"
                        >
                            <RefreshCw size={12} />
                            Restart
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleAction('sync')}
                            disabled={executing}
                            title="Sync from Production"
                        >
                            <ArrowDownLeft size={12} />
                            Sync from Prod
                        </Button>
                    </div>

                    <Button
                        variant="ghost"
                        size="icon"
                        className="bulk-actions-clear"
                        onClick={onClear}
                    >
                        <X size={12} />
                    </Button>
                </>
            )}
        </div>
    );
};

export default BulkActionsBar;
