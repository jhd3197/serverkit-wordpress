import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { GitBranch, Layers } from 'lucide-react';
import wordpressApi from '../services/wordpress';
import { useToast } from 'serverkit-sdk';
import { ResourceListPage } from 'serverkit-sdk';
import { Pill, ServiceTile, EnvTag } from 'serverkit-sdk';
import { useTranslation } from 'serverkit-sdk';

// Environment badges, in promotion order — production is always present, the
// rest only when the project actually has them.
const ENV_TAGS = [
    ['staging', 'STG'],
    ['development', 'DEV'],
    ['multidev', 'MD'],
];

// A WordPress project = one site plus its environment chain. This lists which
// projects HAVE a pipeline; the run history of what was promoted and when lives
// in Deploy Activity, which answers a different question.
const WordPressProjects = () => {
    const { t } = useTranslation();
    const [projects, setProjects] = useState([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [statusFilter, setStatusFilter] = useState('all');
    const navigate = useNavigate();
    const toast = useToast();

    useEffect(() => {
        loadProjects();
    }, []);

    async function loadProjects() {
        setLoading(true);
        try {
            const data = await wordpressApi.getPipelines();
            setProjects(data.projects || []);
        } catch (err) {
            console.error('Failed to load projects:', err);
            toast.error(t('wp.wordPressProjects.failedToLoadWordpressProjects', 'Failed to load WordPress projects'));
        } finally {
            setLoading(false);
        }
    }

    const runningCount = projects.filter(p => p.status === 'running').length;

    const shown = projects.filter(p => {
        if (statusFilter === 'running' && p.status !== 'running') return false;
        if (statusFilter === 'stopped' && p.status === 'running') return false;
        const q = search.trim().toLowerCase();
        if (!q) return true;
        return [p.name, p.url, p.application?.domains?.[0]]
            .some(v => v && String(v).toLowerCase().includes(q));
    });

    const domainOf = (p) => p.application?.domains?.[0] || p.url || '';
    const envCount = (p) => (p.environment_count || 0) + 1;

    const columns = [
        {
            key: 'name',
            headerKey: 'wp.wordPressProjects.project', header: 'Project',
            render: (p) => (
                <div className="sk-cell-name">
                    <ServiceTile name={p.name} size={30} aria-hidden="true" />
                    <span>
                        <div>{p.name}</div>
                        {domainOf(p) && <div className="sk-cell-sub">{domainOf(p)}</div>}
                    </span>
                </div>
            ),
        },
        {
            key: 'environments',
            headerKey: 'wp.wordPressProjects.environments', header: 'Environments',
            render: (p) => (
                <span className="wp-projects-page__envs">
                    <span className="wp-projects-page__envcount">
                        <Layers size={13} aria-hidden="true" />
                        {envCount(p)}
                    </span>
                    <EnvTag env="production">PROD</EnvTag>
                    {ENV_TAGS.map(([type, label]) => (
                        (p.environment_types || []).includes(type)
                            ? <EnvTag key={type} env={type}>{label}</EnvTag>
                            : null
                    ))}
                </span>
            ),
        },
        {
            key: 'version',
            headerKey: 'wp.wordPressProjects.version', header: 'Version',
            cellClassName: 'sk-cell-mono',
            render: (p) => (p.wp_version ? `WP ${p.wp_version}` : '—'),
        },
        {
            key: 'source',
            headerKey: 'wp.wordPressProjects.source', header: 'Source',
            render: (p) => (
                p.git_repo_url
                    ? <span className="wp-projects-page__git"><GitBranch size={12} /> {t('wp.wordPressProjects.gitConnected', 'Git connected')}</span>
                    : <span className="wp-list__dash">—</span>
            ),
        },
        {
            key: 'status',
            headerKey: 'wp.wordPressProjects.status', header: 'Status',
            render: (p) => (
                <Pill kind={p.status === 'running' ? 'green' : 'gray'}>
                    {p.status === 'running' ? t('wp.wordPressProjects.running2', 'Running') : t('wp.wordPressProjects.stopped2', 'Stopped')}
                </Pill>
            ),
        },
    ];

    return (
        <ResourceListPage
            className="wp-projects-page"
            loading={loading}
            loadingTitle="Loading WordPress pipelines"
            totalCount={projects.length}
            items={shown}
            columns={columns}
            keyField="id"
            onRowClick={(p) => navigate(`/wordpress/pipelines/${p.id}`)}
            filters={[
                { value: 'all', labelKey: 'wp.wordPressProjects.all', label: 'All', count: projects.length },
                { value: 'running', labelKey: 'wp.wordPressProjects.running', label: 'Running', count: runningCount },
                { value: 'stopped', labelKey: 'wp.wordPressProjects.stopped', label: 'Stopped', count: projects.length - runningCount },
            ]}
            activeFilter={statusFilter}
            onFilterChange={setStatusFilter}
            searchTerm={search}
            onSearchChange={setSearch}
            searchPlaceholder="Search pipelines…"
            emptyIcon={Layers}
            emptyTitle="No WordPress pipelines"
            emptyDescription="Sites with environment pipelines appear here. Create a WordPress site with environments enabled to get started."
            filteredEmptyIcon={Layers}
            filteredEmptyTitle="No pipelines found"
            filteredEmptyDescription="Try adjusting your search or filter."
            viewStorageKey="serverkit.wpPipelines.view"
            renderCard={(p) => (
                <>
                    <div className="services-card__top">
                        <ServiceTile name={p.name} size={40} aria-hidden="true" />
                        <div className="services-card__id">
                            <div className="services-card__name">{p.name}</div>
                            <div className="sk-cell-sub">{p.wp_version ? `WordPress ${p.wp_version}` : 'WordPress'}</div>
                        </div>
                        <Pill kind={p.status === 'running' ? 'green' : 'gray'}>
                            {p.status === 'running' ? t('wp.wordPressProjects.running2', 'Running') : t('wp.wordPressProjects.stopped2', 'Stopped')}
                        </Pill>
                    </div>

                    <div className="services-card__domain">
                        {domainOf(p) || <span className="wp-list__dash">{t('wp.wordPressProjects.noDomain', 'No domain')}</span>}
                    </div>

                    <div className="services-card__stats">
                        <div>
                            <span className="l">{t('wp.wordPressProjects.environments2', 'Environments')}</span>
                            <span className="v">{envCount(p)}</span>
                        </div>
                        <div>
                            <span className="l">{t('wp.wordPressProjects.source2', 'Source')}</span>
                            <span className="v">{p.git_repo_url ? 'Git' : t('wp.wordPressProjects.local', 'Local')}</span>
                        </div>
                        <div>
                            <span className="l">{t('wp.wordPressProjects.status2', 'Status')}</span>
                            <span className="v">{p.status === 'running' ? t('wp.wordPressProjects.running2', 'Running') : t('wp.wordPressProjects.stopped2', 'Stopped')}</span>
                        </div>
                    </div>
                </>
            )}
        />
    );
};

export default WordPressProjects;
