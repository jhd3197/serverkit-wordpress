import { useState, useEffect, useRef } from 'react';
import { Terminal, X, Download } from 'lucide-react';
import wordpressApi from '../../services/wordpress';
import { Button } from 'serverkit-sdk';
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from 'serverkit-sdk';
import { useTranslation } from 'serverkit-sdk';

const ContainerLogs = ({ projectId, envId, onClose }) => {
    const { t } = useTranslation();
    const [logs, setLogs] = useState([]);
    const [loading, setLoading] = useState(true);
    const [service, setService] = useState('wordpress');
    const [lines, setLines] = useState(100);
    const [autoScroll, setAutoScroll] = useState(true);
    const logsEndRef = useRef(null);
    const containerRef = useRef(null);

    useEffect(() => {
        loadLogs();
    }, [projectId, envId, service, lines]);

    useEffect(() => {
        if (autoScroll && logsEndRef.current) {
            logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [logs, autoScroll]);

    async function loadLogs() {
        setLoading(true);
        try {
            const data = await wordpressApi.getEnvironmentLogs(projectId, envId, { service, lines });
            setLogs(data.logs || []);
        } catch (err) {
            console.error('Failed to load logs:', err);
            setLogs([`Error loading logs: ${err.message}`]);
        } finally {
            setLoading(false);
        }
    }

    function handleScroll() {
        if (!containerRef.current) return;
        const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
        setAutoScroll(scrollHeight - scrollTop - clientHeight < 50);
    }

    function handleDownload() {
        const text = logs.join('\n');
        const blob = new Blob([text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `env-${envId}-${service}-logs.txt`;
        a.click();
        URL.revokeObjectURL(url);
    }

    return (
        <div className="container-logs-panel">
            <div className="container-logs-header">
                <div className="container-logs-title">
                    <span className="container-logs-ico">
                        <Terminal size={15} />
                    </span>
                    <div className="container-logs-titles">
                        <span>{t('wp.containerLogs.containerLogs', 'Container Logs')}</span>
                        <span className="container-logs-sub">env-{envId} · {service}</span>
                    </div>
                </div>
                <div className="container-logs-controls">
                    <Select value={service} onValueChange={setService}>
                        <SelectTrigger className="logs-service-select">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="wordpress">{t('wp.containerLogs.wordpress', 'WordPress')}</SelectItem>
                            <SelectItem value="db">{t('wp.containerLogs.mysql', 'MySQL')}</SelectItem>
                        </SelectContent>
                    </Select>
                    <Select value={String(lines)} onValueChange={(v) => setLines(Number(v))}>
                        <SelectTrigger className="logs-lines-select">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="50">{t('wp.containerLogs.50Lines', '50 lines')}</SelectItem>
                            <SelectItem value="100">{t('wp.containerLogs.100Lines', '100 lines')}</SelectItem>
                            <SelectItem value="500">{t('wp.containerLogs.500Lines', '500 lines')}</SelectItem>
                        </SelectContent>
                    </Select>
                    <Button variant="ghost" size="sm" onClick={loadLogs} title={t('wp.containerLogs.refresh', 'Refresh')}>
                        <RefreshIcon />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={handleDownload} title={t('wp.containerLogs.download', 'Download')}>
                        <Download size={14} />
                    </Button>
                    {onClose && (
                        <Button variant="ghost" size="sm" onClick={onClose}>
                            <X size={14} />
                        </Button>
                    )}
                </div>
            </div>
            <div
                className="container-logs-body"
                ref={containerRef}
                onScroll={handleScroll}
            >
                {loading ? (
                    <div className="logs-loading">{t('wp.containerLogs.loadingLogs', 'Loading logs...')}</div>
                ) : logs.length === 0 ? (
                    <div className="logs-empty">{t('wp.containerLogs.noLogsAvailable', 'No logs available.')}</div>
                ) : (
                    <pre className="logs-content">
                        {logs.map((line, i) => (
                            <div key={i} className="log-line">{line}</div>
                        ))}
                        <div ref={logsEndRef} />
                    </pre>
                )}
            </div>
        </div>
    );
};

function RefreshIcon() {
    return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
        </svg>
    );
}

export default ContainerLogs;
