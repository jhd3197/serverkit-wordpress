import React, { useState, useEffect } from 'react';
import wordpressApi from '../../../services/wordpress';
import { useToast, useConfirm } from 'serverkit-sdk';
import { Button } from 'serverkit-sdk';
import { Input } from 'serverkit-sdk';
import { Label } from 'serverkit-sdk';
import { SkeletonBoundary } from 'serverkit-sdk';
import { OverviewGridSkeleton, PHP_LIMIT_LABELS } from './wpDetailShared';
import { InfoList, InfoItem } from 'serverkit-sdk';
import { useTranslation } from 'serverkit-sdk';

// PHP Tab — live PHP version + ini limits for the Docker (apache/mod_php) site.
// Version is the image tag; switching recreates the container (volumes persist).
// Limits are written as a durable conf.d drop-in (bind-mounted), editable below.
const PhpTab = ({ siteId }) => {
    const { t } = useTranslation();
    const toast = useToast();
    const { confirm } = useConfirm();
    const [php, setPhp] = useState(null);
    const [loading, setLoading] = useState(true);
    const [switching, setSwitching] = useState(false);
    const [form, setForm] = useState({});
    const [saving, setSaving] = useState(false);

    const load = React.useCallback(async () => {
        setLoading(true);
        try {
            const data = await wordpressApi.getPhpInfo(siteId);
            const info = data.php || data;
            setPhp(info);
            // Seed the edit form from live values for the editable directives.
            const lim = info?.limits || {};
            const seed = {};
            (info?.editable_limits || []).forEach(k => { seed[k] = lim[k] || ''; });
            setForm(seed);
        } catch (err) {
            toast.error(err.message || t('wp.phpTab.failedToLoadPhpInfo', 'Failed to load PHP info'));
        } finally {
            setLoading(false);
        }
    }, [siteId, toast, t]);

    useEffect(() => { load(); }, [load]);

    async function handleSwitch(version) {
        if (!await confirm({ title: 'Update PHP runtime', message: `Update this site to patched PHP ${version} with PDO MySQL? The image builds first, then WordPress briefly restarts. Files and database are preserved.`, confirmText: 'Update PHP' })) return;
        setSwitching(true);
        toast.info(t('wp.phpTab.switchingToPhp', 'Switching to PHP {{version}}…', { version: version }), { duration: 4000 });
        try {
            const res = await wordpressApi.setPhpVersion(siteId, version);
            if (res.success === false) { toast.error(res.error || t('wp.phpTab.failedToSwitchPhpVersion', 'Failed to switch PHP version')); return; }
            toast.success(res.message || t('wp.phpTab.switchedToPhp', 'Switched to PHP {{version}}', { version: version }));
            await load();
        } catch (err) {
            toast.error(err.message || t('wp.phpTab.failedToSwitchPhpVersion2', 'Failed to switch PHP version'));
        } finally {
            setSwitching(false);
        }
    }

    async function handleSaveLimits() {
        // Send only the directives that changed from the live value (partial update).
        const live = php?.limits || {};
        const changed = {};
        Object.entries(form).forEach(([k, v]) => {
            const val = (v ?? '').toString().trim();
            if (val && val !== (live[k] || '')) changed[k] = val;
        });
        if (Object.keys(changed).length === 0) { toast.info(t('wp.phpTab.noChangesToSave', 'No changes to save')); return; }
        if (!await confirm({ title: 'Apply PHP limits', message: 'The container reloads briefly. Database and files are preserved.', confirmText: 'Apply limits' })) return;
        setSaving(true);
        try {
            const res = await wordpressApi.setPhpLimits(siteId, changed);
            if (res.success === false) { toast.error(res.error || t('wp.phpTab.failedToUpdatePhpLimits', 'Failed to update PHP limits')); return; }
            toast.success(res.message || t('wp.phpTab.phpLimitsUpdated', 'PHP limits updated'));
            await load();
        } catch (err) {
            toast.error(err.message || t('wp.phpTab.failedToUpdatePhpLimits2', 'Failed to update PHP limits'));
        } finally {
            setSaving(false);
        }
    }

    if (loading) return <SkeletonBoundary loading skeleton={<OverviewGridSkeleton panels={2} />} />;

    const limits = php?.limits || {};
    const current = php?.php_version || t('wp.phpTab.unknown', 'Unknown');
    const versions = php?.available_versions || [];
    const editableKeys = php?.editable_limits || [];

    return (
        <div className="app-overview-grid">
            <div className="app-overview-left">
                <div className="app-panel">
                    <div className="app-panel-header">PHP</div>
                    <div className="app-panel-body">
                        <InfoList>
                            <InfoItem label={t('wp.phpTab.phpVersion', 'PHP version')} value={current} />
                            <InfoItem label={t('wp.phpTab.memoryLimit', 'Memory limit')} value={limits.memory_limit || '-'} />
                            <InfoItem label={t('wp.phpTab.uploadMaxFilesize', 'Upload max filesize')} value={limits.upload_max_filesize || '-'} />
                            <InfoItem label={t('wp.phpTab.postMaxSize', 'Post max size')} value={limits.post_max_size || '-'} />
                            <InfoItem label={t('wp.phpTab.maxExecutionTime', 'Max execution time')} value={limits.max_execution_time || '-'} />
                            <InfoItem label={t('wp.phpTab.maxInputTime', 'Max input time')} value={limits.max_input_time || '-'} />
                        </InfoList>
                    </div>
                </div>

                {versions.length > 0 && (
                    <div className="app-panel">
                        <div className="app-panel-header">{t('wp.phpTab.changePhpVersion', 'Change PHP version')}</div>
                        <div className="app-panel-body">
                            <p className="hint">{t('wp.phpTab.switchingRebuildsTheContainerFromThe', 'Switching rebuilds the container from the official wordpress php-apache image. The database and uploaded files are preserved.')}</p>
                            <div className="app-detail-actions">
                                {versions.map(v => (
                                    <Button key={v} variant="outline" size="sm" disabled={switching || saving} onClick={() => handleSwitch(v)}>
                                        {current.startsWith(v) ? `Update PHP ${v}` : `PHP ${v}`}
                                    </Button>
                                ))}
                            </div>
                        </div>
                    </div>
                )}

                {editableKeys.length > 0 && (
                    <div className="app-panel">
                        <div className="app-panel-header">{t('wp.phpTab.editPhpLimits', 'Edit PHP limits')}</div>
                        <div className="app-panel-body">
                            <p className="hint">{t('wp.phpTab.savedAsADurableConfD', 'Saved as a durable conf.d drop-in bind-mounted into the container, so limits survive a container recreate. Saving reloads the container (brief downtime).')}</p>
                            {editableKeys.map(k => (
                                <div className="form-group" key={k}>
                                    <Label>{PHP_LIMIT_LABELS[k] || k}</Label>
                                    <Input value={form[k] ?? ''} placeholder={limits[k] || ''} disabled={saving || switching}
                                        onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))} />
                                </div>
                            ))}
                            <div className="app-detail-actions">
                                <Button size="sm" onClick={handleSaveLimits} disabled={saving || switching}>{saving ? t('wp.phpTab.saving', 'Saving…') : t('wp.phpTab.saveLimits', 'Save limits')}</Button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default PhpTab;
