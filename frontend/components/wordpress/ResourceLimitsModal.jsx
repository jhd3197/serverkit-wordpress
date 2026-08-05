import { useState } from 'react';
import { HardDrive, AlertTriangle } from 'lucide-react';
import { Spinner } from 'serverkit-sdk';
import { Modal } from 'serverkit-sdk';
import { Button } from 'serverkit-sdk';
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from 'serverkit-sdk';
import { Label } from 'serverkit-sdk';

const PRESETS = {
    low: { memory: '256M', cpus: '0.25', db_memory: '256M', db_cpus: '0.25' },
    standard: { memory: '512M', cpus: '1.0', db_memory: '384M', db_cpus: '0.5' },
    high: { memory: '2G', cpus: '2.0', db_memory: '1G', db_cpus: '1.0' },
};

const MEMORY_OPTIONS = ['256M', '384M', '512M', '768M', '1G', '1.5G', '2G'];
const CPU_OPTIONS = ['0.25', '0.5', '1.0', '1.5', '2.0'];

const ResourceLimitsModal = ({ environment, currentLimits, onClose, onApply }) => {
    const [limits, setLimits] = useState({
        memory: currentLimits?.memory || '512M',
        cpus: currentLimits?.cpus || '1.0',
        db_memory: currentLimits?.db_memory || '384M',
        db_cpus: currentLimits?.db_cpus || '0.5',
    });
    const [loading, setLoading] = useState(false);

    function applyPreset(preset) {
        setLimits({ ...PRESETS[preset] });
    }

    function handleChange(key, value) {
        setLimits(prev => ({ ...prev, [key]: value }));
    }

    async function handleSubmit(e) {
        e.preventDefault();
        setLoading(true);
        try {
            await onApply(limits);
        } finally {
            setLoading(false);
        }
    }

    const envName = environment?.name || 'Environment';

    return (
        <Modal open={true} onClose={onClose} title="Resource Limits" className="resource-limits-modal">
            <form onSubmit={handleSubmit}>
                <div className="resource-limits-env-name">{envName}</div>

                <div className="resource-limits-presets">
                    <span className="resource-limits-presets-label">Presets:</span>
                    {Object.entries(PRESETS).map(([key]) => (
                        <Button
                            key={key}
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="resource-preset-btn"
                            onClick={() => applyPreset(key)}
                        >
                            {key.charAt(0).toUpperCase() + key.slice(1)}
                        </Button>
                    ))}
                </div>

                <div className="resource-limits-section">
                    <h4>
                        <HardDrive size={14} />
                        WordPress Container
                    </h4>
                    <div className="resource-limits-row">
                        <Label>Memory</Label>
                        <Select value={limits.memory} onValueChange={v => handleChange('memory', v)}>
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {MEMORY_OPTIONS.map(opt => (
                                    <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="resource-limits-row">
                        <Label>CPU Cores</Label>
                        <Select value={limits.cpus} onValueChange={v => handleChange('cpus', v)}>
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {CPU_OPTIONS.map(opt => (
                                    <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                </div>

                <div className="resource-limits-section">
                    <h4>
                        <HardDrive size={14} />
                        Database Container
                    </h4>
                    <div className="resource-limits-row">
                        <Label>Memory</Label>
                        <Select value={limits.db_memory} onValueChange={v => handleChange('db_memory', v)}>
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {MEMORY_OPTIONS.filter((_, i) => i < 5).map(opt => (
                                    <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="resource-limits-row">
                        <Label>CPU Cores</Label>
                        <Select value={limits.db_cpus} onValueChange={v => handleChange('db_cpus', v)}>
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {CPU_OPTIONS.filter((_, i) => i < 4).map(opt => (
                                    <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                </div>

                <div className="alert alert-warning">
                    <AlertTriangle size={14} />
                    <span>Applying resource limits will restart the environment containers.</span>
                </div>

                <div className="modal-actions">
                    <Button type="button" variant="outline" onClick={onClose} disabled={loading}>
                        Cancel
                    </Button>
                    <Button type="submit" disabled={loading}>
                        {loading ? <><Spinner size="sm" /> Applying...</> : 'Apply Limits'}
                    </Button>
                </div>
            </form>
        </Modal>
    );
};

export default ResourceLimitsModal;
