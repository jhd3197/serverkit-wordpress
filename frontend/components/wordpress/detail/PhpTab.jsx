import React, { useState, useEffect } from 'react';
import wordpressApi from '../../../services/wordpress';
import { useToast } from 'serverkit-sdk';
import { Button } from 'serverkit-sdk';
import { Input } from 'serverkit-sdk';
import { Label } from 'serverkit-sdk';
import { SkeletonBoundary } from 'serverkit-sdk';
import { OverviewGridSkeleton, PHP_LIMIT_LABELS } from './wpDetailShared';
import { useTranslation } from 'serverkit-sdk';

// PHP Tab — live PHP version + ini limits for the Docker (apache/mod_php) site.
// Version is the image tag; switching recreates the container (volumes persist).
// Limits are written as a durable conf.d drop-in (bind-mounted), editable below.
const PhpTab = ({ siteId }) => {
    const { t } = useTranslation();
    const toast = useToast();
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
    }, [siteId, toast]);

    useEffect(() => { load(); }, [load]);

    async function handleSwitch(version) {
        if (!window.confirm(t('wp.phpTab.switchThisSiteToPhpThis', 'Switch this site to PHP {{version}}? This pulls the wordpress:php{{version2}}-apache image and recreates the container (brief downtime; database and files are preserved).', { version: version, version2: version }))) return;
        setSwitching(true);
        toast.info(t('wp.phpTab.switchingToPhp', 'Switching to PHP {{version}}...', { version: version }), { duration: 4000 });
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
        if (!window.confirm(t('wp.phpTab.applyThesePhpLimitsTheContainer', 'Apply these PHP limits? The container reloads (brief downtime; database and files are preserved).'))) return;
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
    const current = php?.php_version || 'Unknown';
    const versions = php?.available_versions || [];
    const editableKeys = php?.editable_limits || [];

    return (
        <div className="app-overview-grid">
            <div className="app-overview-left">
                <div className="app-panel">
                    <div className="app-panel-header">PHP</div>
                    <div className="app-panel-body">
                        <div className="app-info-grid">
                            <div className="app-info-item">
                                <span className="app-info-label">{t('wp.phpTab.phpVersion', 'PHP Version')}</span>
                                <span className="app-info-value">{current}</span>
                            </div>
                            <div className="app-info-item">
                                <span className="app-info-label">{t('wp.phpTab.memoryLimit', 'Memory Limit')}</span>
                                <span className="app-info-value">{limits.memory_limit || '-'}</span>
                            </div>
                            <div className="app-info-item">
                                <span className="app-info-label">{t('wp.phpTab.uploadMaxFilesize', 'Upload Max Filesize')}</span>
                                <span className="app-info-value">{limits.upload_max_filesize || '-'}</span>
                            </div>
                            <div className="app-info-item">
                                <span className="app-info-label">{t('wp.phpTab.postMaxSize', 'Post Max Size')}</span>
                                <span className="app-info-value">{limits.post_max_size || '-'}</span>
                            </div>
                            <div className="app-info-item">
                                <span className="app-info-label">{t('wp.phpTab.maxExecutionTime', 'Max Execution Time')}</span>
                                <span className="app-info-value">{limits.max_execution_time || '-'}</span>
                            </div>
                            <div className="app-info-item">
                                <span className="app-info-label">{t('wp.phpTab.maxInputTime', 'Max Input Time')}</span>
                                <span className="app-info-value">{limits.max_input_time || '-'}</span>
                            </div>
                        </div>
                    </div>
                </div>

                {versions.length > 0 && (
                    <div className="app-panel">
                        <div className="app-panel-header">{t('wp.phpTab.changePhpVersion', 'Change PHP Version')}</div>
                        <div className="app-panel-body">
                            <p className="hint">{t('wp.phpTab.switchingRebuildsTheContainerFromThe', 'Switching rebuilds the container from the official wordpress php-apache image. The database and uploaded files are preserved.')}</p>
                            <div className="app-detail-actions">
                                {versions.map(v => (
                                    <Button key={v} variant="outline" size="sm" disabled={switching || current.startsWith(v)} onClick={() => handleSwitch(v)}>
                                        {current.startsWith(v) ? `PHP ${v} (current)` : `PHP ${v}`}
                                    </Button>
                                ))}
                            </div>
                        </div>
                    </div>
                )}

                {editableKeys.length > 0 && (
                    <div className="app-panel">
                        <div className="app-panel-header">{t('wp.phpTab.editPhpLimits', 'Edit PHP Limits')}</div>
                        <div className="app-panel-body">
                            <p className="hint">{t('wp.phpTab.savedAsADurableConfD', 'Saved as a durable conf.d drop-in bind-mounted into the container, so limits survive a container recreate. Saving reloads the container (brief downtime).')}</p>
                            {editableKeys.map(k => (
                                <div className="form-group" key={k}>
                                    <Label>{PHP_LIMIT_LABELS[k] || k}</Label>
                                    <Input value={form[k] ?? ''} placeholder={limits[k] || ''} disabled={saving}
                                        onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))} />
                                </div>
                            ))}
                            <div className="app-detail-actions">
                                <Button size="sm" onClick={handleSaveLimits} disabled={saving}>{saving ? 'Saving…' : 'Save limits'}</Button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default PhpTab;
