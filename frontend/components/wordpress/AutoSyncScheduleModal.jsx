import { useState, useEffect } from 'react';
import { RefreshCw } from 'lucide-react';
import { Spinner } from 'serverkit-sdk';
import { Modal } from 'serverkit-sdk';
import { Button } from 'serverkit-sdk';
import { Input } from 'serverkit-sdk';
import { Label } from 'serverkit-sdk';
import { Switch } from 'serverkit-sdk';
import { useTranslation, useFormat } from 'serverkit-sdk';

const SCHEDULE_PRESETS = [
    { labelKey: 'wp.autoSyncScheduleModal.dailyAt3Am', label: 'Daily at 3 AM', value: '0 3 * * *' },
    { labelKey: 'wp.autoSyncScheduleModal.weeklySunday3Am', label: 'Weekly Sunday 3 AM', value: '0 3 * * 0' },
    { labelKey: 'wp.autoSyncScheduleModal.every6Hours', label: 'Every 6 hours', value: '0 */6 * * *' },
    { labelKey: 'wp.autoSyncScheduleModal.every12Hours', label: 'Every 12 hours', value: '0 */12 * * *' },
    { labelKey: 'wp.autoSyncScheduleModal.custom', label: 'Custom', value: 'custom' },
];

const AutoSyncScheduleModal = ({ environment, prodId, onClose, api }) => {
    const { t } = useTranslation();
    // Aliased: this file already has a local helper of that name, so the
    // door goes in under a distinct one rather than shadowing it into
    // infinite recursion.
    const { formatDateTime: formatDateTimeLocalized } = useFormat();
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [enabled, setEnabled] = useState(false);
    const [schedule, setSchedule] = useState('0 3 * * *');
    const [selectedPreset, setSelectedPreset] = useState('0 3 * * *');
    const [customCron, setCustomCron] = useState('');
    const [nextRuns, setNextRuns] = useState([]);

    useEffect(() => {
        loadSchedule();
    }, []);

    async function loadSchedule() {
        setLoading(true);
        try {
            const data = await api.getAutoSyncSchedule(prodId, environment.id);
            setEnabled(data.enabled || false);
            if (data.schedule) {
                const matchingPreset = SCHEDULE_PRESETS.find(p => p.value === data.schedule);
                if (matchingPreset) {
                    setSelectedPreset(data.schedule);
                } else {
                    setSelectedPreset('custom');
                    setCustomCron(data.schedule);
                }
                setSchedule(data.schedule);
            }
            setNextRuns(data.next_runs || []);
        } catch {
            // Default values already set
        } finally {
            setLoading(false);
        }
    }

    function handlePresetChange(value) {
        setSelectedPreset(value);
        if (value !== 'custom') {
            setSchedule(value);
        }
    }

    function handleCustomCronChange(value) {
        setCustomCron(value);
        setSchedule(value);
    }

    async function handleSave() {
        setSaving(true);
        try {
            const finalSchedule = selectedPreset === 'custom' ? customCron : selectedPreset;
            await api.updateAutoSyncSchedule(prodId, environment.id, {
                enabled,
                schedule: finalSchedule,
            });
            onClose();
        } catch (err) {
            console.error('Failed to save auto-sync schedule:', err);
        } finally {
            setSaving(false);
        }
    }

    function formatDateTime(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        return formatDateTimeLocalized(d);
    }

    const envName = environment?.name || t('wp.autoSyncScheduleModal.environment', 'Environment');

    return (
        <Modal open={true} onClose={onClose} title={t('wp.autoSyncScheduleModal.autoSyncSchedule', 'Auto-sync schedule')} className="auto-sync-modal">
            {loading ? (
                <div className="auto-sync-loading">
                    <Spinner size="sm" />
                    <span>{t('wp.autoSyncScheduleModal.loadingSchedule', 'Loading schedule…')}</span>
                </div>
            ) : (
                <div className="auto-sync-body">
                    <div className="auto-sync-env-name">{envName}</div>

                    <div className="auto-sync-toggle">
                        <label className="auto-sync-toggle-label">
                            <span>{t('wp.autoSyncScheduleModal.enableAutoSyncFromProduction', 'Enable auto-sync from production')}</span>
                            <Switch checked={enabled} onCheckedChange={setEnabled} />
                        </label>
                        <p className="auto-sync-description">
                            {t('wp.autoSyncScheduleModal.automaticallySyncThisEnvironmentFromProduction', 'Automatically sync this environment from production on a schedule.')}
                        </p>
                    </div>

                    {enabled && (
                        <>
                            <div className="form-group">
                                <Label>{t('wp.autoSyncScheduleModal.schedule', 'Schedule')}</Label>
                                <div className="auto-sync-presets">
                                    {SCHEDULE_PRESETS.map(preset => (
                                        <label key={preset.value} className="radio-label">
                                            <input
                                                type="radio"
                                                name="schedule-preset"
                                                checked={selectedPreset === preset.value}
                                                onChange={() => handlePresetChange(preset.value)}
                                            />
                                            <span className="radio-content">
                                                <strong>{preset.label}</strong>
                                                {preset.value !== 'custom' && (
                                                    <span className="auto-sync-cron-display">{preset.value}</span>
                                                )}
                                            </span>
                                        </label>
                                    ))}
                                </div>
                            </div>

                            {selectedPreset === 'custom' && (
                                <div className="form-group">
                                    <Label>{t('wp.autoSyncScheduleModal.customCronExpression', 'Custom cron expression')}</Label>
                                    <Input
                                        type="text"
                                        value={customCron}
                                        onChange={e => handleCustomCronChange(e.target.value)}
                                        placeholder="0 3 * * *"
                                        className="auto-sync-cron-input"
                                    />
                                    <span className="form-hint">
                                        {t('wp.autoSyncScheduleModal.formatMinuteHourDayOfMonth', 'Format: minute hour day-of-month month day-of-week')}
                                    </span>
                                </div>
                            )}

                            {nextRuns.length > 0 && (
                                <div className="auto-sync-next-runs">
                                    <h5>{t('wp.autoSyncScheduleModal.nextScheduledRuns', 'Next scheduled runs')}</h5>
                                    <ul>
                                        {nextRuns.map((run, i) => (
                                            <li key={i}>
                                                <RefreshCw size={10} />
                                                <span>{formatDateTime(run)}</span>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                        </>
                    )}
                </div>
            )}

            <div className="modal-actions">
                <Button variant="outline" onClick={onClose} disabled={saving}>
                    {t('wp.autoSyncScheduleModal.cancel', 'Cancel')}
                </Button>
                <Button onClick={handleSave} disabled={saving || loading}>
                    {saving ? <><Spinner size="sm" /> {t('wp.autoSyncScheduleModal.saving', 'Saving…')}</> : t('wp.autoSyncScheduleModal.saveSchedule', 'Save schedule')}
                </Button>
            </div>
        </Modal>
    );
};

export default AutoSyncScheduleModal;
