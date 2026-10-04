import React, { useState, useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';
import wordpressApi from '../../../services/wordpress';
import { useToast } from 'serverkit-sdk';
import { KpiBand, MetricCard } from 'serverkit-sdk';
import { Button } from 'serverkit-sdk';
import { SkeletonBoundary } from 'serverkit-sdk';
import { OverviewGridSkeleton } from './wpDetailShared';
import { InfoList, InfoItem } from 'serverkit-sdk';
import { useTranslation, useFormat } from 'serverkit-sdk';

// Vulnerabilities Tab — cross-references plugin/theme/core versions against the
// keyless WPVulnerability community feed (#28). On-demand background scan + poll.
const VulnerabilitiesTab = ({ siteId }) => {
    const { t } = useTranslation();
    const { formatDateTime } = useFormat();
    const toast = useToast();
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [scanning, setScanning] = useState(false);

    const load = React.useCallback(async () => {
        try {
            const res = await wordpressApi.getVulnerabilities(siteId);
            setData(res);
        } catch (err) {
            toast.error(err.message || t('wp.vulnerabilitiesTab.failedToLoadVulnerabilities', 'Failed to load vulnerabilities'));
        } finally {
            setLoading(false);
        }
    }, [siteId, toast]);

    useEffect(() => { load(); }, [load]);
    useEffect(() => {
        if (data?.scan_status !== 'running') return undefined;
        const t = setTimeout(() => { load(); }, 2500);
        return () => clearTimeout(t);
    }, [data, load]);

    async function handleScan() {
        setScanning(true);
        try {
            await wordpressApi.scanVulnerabilities(siteId);
            toast.info(t('wp.vulnerabilitiesTab.vulnerabilityScanStarted', 'Vulnerability scan started…'));
            await load();
        } catch (err) {
            toast.error(err.message || t('wp.vulnerabilitiesTab.failedToStartScan', 'Failed to start scan'));
        } finally {
            setScanning(false);
        }
    }

    if (loading) return <SkeletonBoundary loading skeleton={<OverviewGridSkeleton panels={2} />} />;

    const running = data?.scan_status === 'running';
    const summary = data?.summary || {};
    const vulns = data?.vulnerabilities || [];

    return (
        <div className="app-overview-grid">
            <div className="app-overview-left">
                <div className="app-panel">
                    <div className="app-panel-header">{t('wp.vulnerabilitiesTab.vulnerabilityScan', 'Vulnerability scan')}</div>
                    <div className="app-panel-body">
                        <div className="app-detail-actions">
                            <Button size="sm" onClick={handleScan} disabled={scanning || running}>
                                {running ? 'Scanning…' : 'Run scan'}
                            </Button>
                        </div>
                        <InfoList>
                            <InfoItem label={t('wp.vulnerabilitiesTab.lastScan', 'Last scan')} value={data?.scanned_at ? formatDateTime(data.scanned_at) : 'Never'} />
                            <InfoItem label={t('wp.vulnerabilitiesTab.findings', 'Findings')} value={summary.total ?? 0} />
                        </InfoList>
                        {data?.scan_error && <p className="hint">{t('wp.vulnerabilitiesTab.lastScanError', 'Last scan error:')} {data.scan_error}</p>}
                        <p className="hint">{t('wp.vulnerabilitiesTab.crossReferencesInstalledPluginThemeAnd', 'Cross-references installed plugin, theme, and core versions against the WPVulnerability community database. Re-run after updating.')}</p>
                    </div>
                </div>

                {data?.scanned_at && (
                    <KpiBand>
                        <MetricCard icon={<AlertTriangle size={16} />} tone="red" value={summary.critical ?? 0} label={t('wp.vulnerabilitiesTab.critical', 'Critical')} />
                        <MetricCard icon={<AlertTriangle size={16} />} tone="red" value={summary.high ?? 0} label={t('wp.vulnerabilitiesTab.high', 'High')} />
                        <MetricCard icon={<AlertTriangle size={16} />} tone="amber" value={summary.medium ?? 0} label={t('wp.vulnerabilitiesTab.medium', 'Medium')} />
                        <MetricCard icon={<AlertTriangle size={16} />} tone="cyan" value={summary.low ?? 0} label={t('wp.vulnerabilitiesTab.low', 'Low')} />
                        {summary.unknown > 0 && (
                            <MetricCard icon={<AlertTriangle size={16} />} tone="violet" value={summary.unknown} label={t('wp.vulnerabilitiesTab.unrated', 'Unrated')} />
                        )}
                    </KpiBand>
                )}

                {vulns.length === 0 ? (
                    <div className="app-panel">
                        <div className="app-panel-body">
                            <p className="hint">{data?.scanned_at ? 'No known vulnerabilities found.' : 'No scan has run yet — click Run scan to check this site.'}</p>
                        </div>
                    </div>
                ) : (
                    <div className="app-panel">
                        <div className="app-panel-header">{t('wp.vulnerabilitiesTab.findings2', 'Findings')}</div>
                        <table className="sk-dtable wp-vuln-table">
                            <thead>
                                <tr>
                                    <th>{t('wp.vulnerabilitiesTab.severity', 'Severity')}</th>
                                    <th>{t('wp.vulnerabilitiesTab.component', 'Component')}</th>
                                    <th>{t('wp.vulnerabilitiesTab.issue', 'Issue')}</th>
                                    <th>{t('wp.vulnerabilitiesTab.installed', 'Installed')}</th>
                                    <th>{t('wp.vulnerabilitiesTab.fixedIn', 'Fixed in')}</th>
                                    <th>{t('wp.vulnerabilitiesTab.advisory', 'Advisory')}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {vulns.map(v => (
                                    <tr key={v.id}>
                                        <td><span className={`wp-sev wp-sev--${v.severity || 'unknown'}`}><span className="d" />{v.severity || 'unrated'}</span></td>
                                        <td>
                                            <div className="sk-cell-name">{v.name}</div>
                                            <div className="sk-cell-sub">{v.source}{v.slug ? ` · ${v.slug}` : ''}</div>
                                        </td>
                                        <td className="wp-vuln-title">{v.title || '—'}</td>
                                        <td><span className="sk-cell-mono">{v.installed_version}</span></td>
                                        <td>
                                            {v.fixed_in
                                                ? <span className="wp-fix-chip">{v.fixed_in}</span>
                                                : <span className="wp-no-fix">{t('wp.vulnerabilitiesTab.noFixYet', 'no fix yet')}</span>}
                                        </td>
                                        <td>
                                            {v.reference_url
                                                ? <a className="wp-advisory-link" href={v.reference_url} target="_blank" rel="noopener noreferrer">{v.advisory_id || 'advisory'} ↗</a>
                                                : <span className="sk-cell-mono">{v.advisory_id || '—'}</span>}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
};

export default VulnerabilitiesTab;
