// The panel's ApiClient via the SDK singleton (JWT refresh, workspace
// headers, error normalization included) — this file is the extension's
// own WP API client, moved out of the host's services/ with the suite.
import { api } from 'serverkit-sdk';

const BASE_PATH = '/wordpress/sites';

const wordpressApi = {
    // Site Management
    getSites: () => api.request(BASE_PATH),

    createSite: (data) => api.request(BASE_PATH, {
        method: 'POST',
        body: data
    }),

    // Base domains a new site can be published under (<slug>.<base>), for the
    // create-flow picker. Returns { base_domains: [...], default }.
    listBaseDomains: () => api.request('/domains/base-domains'),

    // Import an existing WP site from an uploaded SQL dump, plus an optional
    // wp-content/full-site .zip (plugins/themes/uploads). Multipart upload.
    importSite: ({ name, adminEmail, oldUrl, sqlFile, wpContentFile }) => {
        const fd = new FormData();
        fd.append('name', name);
        fd.append('adminEmail', adminEmail || '');
        fd.append('oldUrl', oldUrl);
        fd.append('sql', sqlFile);
        if (wpContentFile) fd.append('wp_content', wpContentFile);
        return api.request(`${BASE_PATH}/import`, { method: 'POST', body: fd });
    },

    // Clone a site into a new independent top-level site (fresh admin creds returned once).
    cloneSite: (id, data) => api.request(`${BASE_PATH}/${id}/clone`, {
        method: 'POST',
        body: data
    }),

    getSite: (id) => api.request(`${BASE_PATH}/${id}`),

    // Preview a site URL change (dry-run: per-pair DB replacement counts, no mutation).
    previewUrlChange: (id, newUrl) => api.request(`${BASE_PATH}/${id}/url/preview`, {
        method: 'POST',
        body: { new_url: newUrl }
    }),

    // Change a site's URL: backup + serialization-safe DB rewrite + re-point routing.
    changeUrl: (id, newUrl, keepOldRedirect = true) => api.request(`${BASE_PATH}/${id}/url`, {
        method: 'POST',
        body: { new_url: newUrl, keep_old_redirect: keepOldRedirect }
    }),

    // Attach a custom domain: auto-create DNS (or return the record to add) +
    // optional HTTPS, then migrate the site to it.
    attachDomain: (id, { domain, migrate = true, issueSsl = false, email } = {}) =>
        api.request(`${BASE_PATH}/${id}/domain`, {
            method: 'POST',
            body: { domain, migrate, issue_ssl: issueSsl, email }
        }),

    // Replace the tag list for a site (agency organization labels)
    setTags: (id, tags) => api.request(`${BASE_PATH}/${id}/tags`, {
        method: 'PATCH',
        body: { tags }
    }),

    // Deletes the site and all environments. A final files+DB backup is taken
    // by default (pass { createBackup: false } to skip).
    deleteSite: (id, { createBackup = true } = {}) => api.request(
        `${BASE_PATH}/${id}?create_backup=${createBackup}`,
        { method: 'DELETE' }
    ),

    // Stop the stack but keep data + files (reversible via unarchiveSite).
    archiveSite: (id) => api.request(`${BASE_PATH}/${id}/archive`, {
        method: 'POST'
    }),

    unarchiveSite: (id) => api.request(`${BASE_PATH}/${id}/unarchive`, {
        method: 'POST'
    }),

    // Environment Management
    getEnvironments: (siteId) => api.request(`${BASE_PATH}/${siteId}/environments`),

    createEnvironment: (siteId, data) => api.request(`${BASE_PATH}/${siteId}/environments`, {
        method: 'POST',
        body: data
    }),

    deleteEnvironment: (siteId, envId) => api.request(`${BASE_PATH}/${siteId}/environments/${envId}`, {
        method: 'DELETE'
    }),

    syncEnvironment: (siteId, data = {}) => api.request(`${BASE_PATH}/${siteId}/sync`, {
        method: 'POST',
        body: data
    }),

    // Database Snapshots
    getSnapshots: (siteId) => api.request(`${BASE_PATH}/${siteId}/snapshots`),

    createSnapshot: (siteId, data) => api.request(`${BASE_PATH}/${siteId}/snapshots`, {
        method: 'POST',
        body: data
    }),

    restoreSnapshot: (siteId, snapId) => api.request(`${BASE_PATH}/${siteId}/snapshots/${snapId}/restore`, {
        method: 'POST'
    }),

    deleteSnapshot: (siteId, snapId) => api.request(`${BASE_PATH}/${siteId}/snapshots/${snapId}`, {
        method: 'DELETE'
    }),

    // Git Integration
    getGitStatus: (siteId) => api.request(`${BASE_PATH}/${siteId}/git`),

    connectRepo: (siteId, data) => api.request(`${BASE_PATH}/${siteId}/git`, {
        method: 'POST',
        body: data
    }),

    disconnectRepo: (siteId) => api.request(`${BASE_PATH}/${siteId}/git`, {
        method: 'DELETE'
    }),

    getCommits: (siteId, limit = 20) => api.request(`${BASE_PATH}/${siteId}/git/commits?limit=${limit}`),

    deployCommit: (siteId, data) => api.request(`${BASE_PATH}/${siteId}/git/deploy`, {
        method: 'POST',
        body: data
    }),

    createDevFromCommit: (siteId, data) => api.request(`${BASE_PATH}/${siteId}/git/dev-from-commit`, {
        method: 'POST',
        body: data
    }),

    // Plugins
    getPlugins: (siteId) => api.request(`${BASE_PATH}/${siteId}/plugins`),

    installPlugin: (siteId, data) => api.request(`${BASE_PATH}/${siteId}/plugins`, {
        method: 'POST',
        body: data
    }),

    // Activate / deactivate an installed plugin (WP-CLI).
    activatePlugin: (siteId, plugin) => api.request(`${BASE_PATH}/${siteId}/plugins/${encodeURIComponent(plugin)}/activate`, {
        method: 'POST'
    }),

    deactivatePlugin: (siteId, plugin) => api.request(`${BASE_PATH}/${siteId}/plugins/${encodeURIComponent(plugin)}/deactivate`, {
        method: 'POST'
    }),

    // =========================================
    // Global Plugin Library
    // =========================================
    LIBRARY_PATH: '/wordpress/plugins/library',

    getLibraryPlugins: () => api.request('/wordpress/plugins/library'),

    getLibraryPlugin: (id) => api.request(`/wordpress/plugins/library/${id}`),

    addLibraryPlugin: (data) => api.request('/wordpress/plugins/library', {
        method: 'POST',
        body: data
    }),

    updateLibraryPlugin: (id, data) => api.request(`/wordpress/plugins/library/${id}`, {
        method: 'PUT',
        body: data
    }),

    deleteLibraryPlugin: (id) => api.request(`/wordpress/plugins/library/${id}`, {
        method: 'DELETE'
    }),

    syncLibraryPlugin: (id) => api.request(`/wordpress/plugins/library/${id}/sync`, {
        method: 'POST'
    }),

    // Install/update a library plugin on a specific site.
    installLibraryPluginOnSite: (id, siteId, activate = true) =>
        api.request(`/wordpress/plugins/library/${id}/install`, {
            method: 'POST',
            body: { site_id: siteId, activate }
        }),

    uninstallLibraryPluginFromSite: (id, siteId) =>
        api.request(`/wordpress/plugins/library/${id}/uninstall`, {
            method: 'POST',
            body: { site_id: siteId }
        }),

    // Push the latest cached version to every site that has the plugin.
    bulkUpdateLibraryPlugin: (id) => api.request(`/wordpress/plugins/library/${id}/bulk-update`, {
        method: 'POST'
    }),

    // Per-site: which installed plugins are library-managed (+ update state).
    getManagedPlugins: (siteId) => api.request(`${BASE_PATH}/${siteId}/plugins/managed`),

    scanManagedPlugins: (siteId) => api.request(`${BASE_PATH}/${siteId}/plugins/library-scan`, {
        method: 'POST'
    }),

    // Themes
    getThemes: (siteId) => api.request(`${BASE_PATH}/${siteId}/themes`),

    installTheme: (siteId, data) => api.request(`${BASE_PATH}/${siteId}/themes`, {
        method: 'POST',
        body: data
    }),

    // Activate an installed theme (WP-CLI).
    activateTheme: (siteId, theme) => api.request(`${BASE_PATH}/${siteId}/themes/${encodeURIComponent(theme)}/activate`, {
        method: 'POST'
    }),

    // WordPress Core Update
    updateCore: (siteId) => api.request(`${BASE_PATH}/${siteId}/update`, {
        method: 'POST'
    }),

    // Live WP-CLI info (core version + update_available / latest_version)
    getWordPressInfo: (siteId) => api.request(`${BASE_PATH}/${siteId}/info`),

    // Live PHP version + ini limits for a Docker WP site (read-only).
    getPhpInfo: (siteId) => api.request(`${BASE_PATH}/${siteId}/php`),

    // Switch the site's PHP version (swaps the Docker image tag + recreates the container).
    setPhpVersion: (siteId, version) => api.request(`${BASE_PATH}/${siteId}/php`, {
        method: 'POST',
        body: { version }
    }),

    // Durably set per-site PHP ini limits (conf.d drop-in + bind-mount; #24).
    setPhpLimits: (siteId, limits) => api.request(`${BASE_PATH}/${siteId}/php/limits`, {
        method: 'POST',
        body: { limits }
    }),

    // Update plugins. Pass an array of slugs to update specific ones, omit for all.
    updatePlugins: (siteId, plugins) => api.request(`${BASE_PATH}/${siteId}/plugins/update`, {
        method: 'POST',
        body: plugins ? { plugins } : {}
    }),

    // Update themes. Pass an array of slugs to update specific ones, omit for all.
    updateThemes: (siteId, themes) => api.request(`${BASE_PATH}/${siteId}/themes/update`, {
        method: 'POST',
        body: themes ? { themes } : {}
    }),

    // Maintenance & Security
    flushCache: (siteId) => api.request(`${BASE_PATH}/${siteId}/flush-cache`, {
        method: 'POST'
    }),

    // Full-page cache (plugin-backed) — status / enable / disable
    getPageCache: (siteId) => api.request(`${BASE_PATH}/${siteId}/page-cache`),
    enablePageCache: (siteId) => api.request(`${BASE_PATH}/${siteId}/page-cache`, { method: 'POST' }),
    disablePageCache: (siteId) => api.request(`${BASE_PATH}/${siteId}/page-cache`, { method: 'DELETE' }),

    searchReplace: (siteId, data) => api.request(`${BASE_PATH}/${siteId}/search-replace`, {
        method: 'POST',
        body: data
    }),

    harden: (siteId) => api.request(`${BASE_PATH}/${siteId}/harden`, {
        method: 'POST'
    }),

    // Object cache (Redis) — status / enable / disable
    getObjectCacheStatus: (siteId) => api.request(`${BASE_PATH}/${siteId}/object-cache`),
    enableObjectCache: (siteId) => api.request(`${BASE_PATH}/${siteId}/object-cache`, { method: 'POST' }),
    disableObjectCache: (siteId) => api.request(`${BASE_PATH}/${siteId}/object-cache`, { method: 'DELETE' }),

    // Status-page binding + uptime (#26): live health, bound component + uptime %, attach/detach
    getSiteStatusPage: (siteId) => api.request(`${BASE_PATH}/${siteId}/status-page`),
    attachStatusPage: (siteId, pageId) => api.request(`${BASE_PATH}/${siteId}/status-page`, { method: 'POST', body: { page_id: pageId } }),
    detachStatusPage: (siteId) => api.request(`${BASE_PATH}/${siteId}/status-page`, { method: 'DELETE' }),

    // Traffic + error analytics (#25) — parsed on-demand from the apache access log.
    getSiteAnalytics: (siteId, hours = 24) => api.request(`${BASE_PATH}/${siteId}/analytics?hours=${hours}`),

    // Vulnerability scanning (#28) — plugin/theme/core vs the WPVulnerability feed.
    getVulnerabilities: (siteId) => api.request(`${BASE_PATH}/${siteId}/vulnerabilities`),
    scanVulnerabilities: (siteId) => api.request(`${BASE_PATH}/${siteId}/vulnerabilities/scan`, { method: 'POST' }),

    // Safe update manager (#29): run history, on-demand safe update, schedule
    getUpdates: (siteId) => api.request(`${BASE_PATH}/${siteId}/updates`),
    runUpdates: (siteId, body = {}) => api.request(`${BASE_PATH}/${siteId}/updates/run`, { method: 'POST', body }),
    setUpdateSchedule: (siteId, body) => api.request(`${BASE_PATH}/${siteId}/updates/schedule`, { method: 'POST', body }),

    // Security depth (#30): file integrity / debug toggle / WP-Cron
    getIntegrity: (siteId) => api.request(`${BASE_PATH}/${siteId}/integrity`),
    scanIntegrity: (siteId) => api.request(`${BASE_PATH}/${siteId}/integrity/scan`, { method: 'POST' }),
    getDebug: (siteId) => api.request(`${BASE_PATH}/${siteId}/debug`),
    setDebug: (siteId, enabled) => api.request(`${BASE_PATH}/${siteId}/debug`, { method: 'POST', body: { enabled } }),
    getCron: (siteId) => api.request(`${BASE_PATH}/${siteId}/cron`),
    runCron: (siteId) => api.request(`${BASE_PATH}/${siteId}/cron/run`, { method: 'POST' }),
    setCronDisabled: (siteId, disabled) => api.request(`${BASE_PATH}/${siteId}/cron`, { method: 'POST', body: { disabled } }),

    // Per-site brute-force protection: a WP-login Fail2ban jail watching the
    // site's reverse-proxy access log.
    getBruteForce: (siteId) => api.request(`${BASE_PATH}/${siteId}/security/bruteforce`),
    setBruteForce: (siteId, enabled) => api.request(`${BASE_PATH}/${siteId}/security/bruteforce`, { method: 'POST', body: { enabled } }),
    unbanBruteForceIp: (siteId, ip) => api.request(`${BASE_PATH}/${siteId}/security/bruteforce/unban`, { method: 'POST', body: { ip } }),

    // Monthly client reports (#33): persisted per-month uptime/updates/backups/vuln rollups
    getReports: (siteId) => api.request(`${BASE_PATH}/${siteId}/reports`),
    generateReport: (siteId, body = {}) => api.request(`${BASE_PATH}/${siteId}/reports/generate`, { method: 'POST', body }),
    deleteReport: (siteId, reportId) => api.request(`${BASE_PATH}/${siteId}/reports/${reportId}`, { method: 'DELETE' }),

    // Mint a one-time passwordless wp-admin login URL for the current operator.
    autoLogin: (siteId) => api.request(`${BASE_PATH}/${siteId}/login`, {
        method: 'POST'
    }),

    // Clone Database (for advanced use)
    cloneDatabase: (siteId, data) => api.request(`${BASE_PATH}/${siteId}/clone-db`, {
        method: 'POST',
        body: data
    }),

    // =========================================
    // Pipeline API (Environment Management v2)
    // =========================================
    PIPELINE_PATH: '/wordpress/projects',

    // Pipeline listing. "Pipelines" is the user-facing term (§2); getProjects
    // is kept as a back-compat alias. Both hit the canonical backend route,
    // which is also mounted at /wordpress/pipelines.
    getPipelines: () => api.request('/wordpress/projects'),
    getProjects: () => api.request('/wordpress/projects'),

    // Pipeline dashboard
    getProjectPipeline: (prodId) => api.request(`/wordpress/projects/${prodId}/pipeline`),

    // Environment CRUD
    createProjectEnvironment: (prodId, data) => api.request(`/wordpress/projects/${prodId}/environments`, {
        method: 'POST',
        body: data
    }),

    getProjectEnvironment: (prodId, envId) => api.request(`/wordpress/projects/${prodId}/environments/${envId}`),

    deleteProjectEnvironment: (prodId, envId) => api.request(`/wordpress/projects/${prodId}/environments/${envId}`, {
        method: 'DELETE'
    }),

    // Container lifecycle
    startEnvironment: (prodId, envId) => api.request(`/wordpress/projects/${prodId}/environments/${envId}/start`, {
        method: 'POST'
    }),

    stopEnvironment: (prodId, envId) => api.request(`/wordpress/projects/${prodId}/environments/${envId}/stop`, {
        method: 'POST'
    }),

    restartEnvironment: (prodId, envId) => api.request(`/wordpress/projects/${prodId}/environments/${envId}/restart`, {
        method: 'POST'
    }),

    // Promotion
    promoteEnvironment: (prodId, data) => api.request(`/wordpress/projects/${prodId}/promote`, {
        method: 'POST',
        body: data
    }),

    // Sync from production
    syncProjectEnvironment: (prodId, envId, data) => api.request(`/wordpress/projects/${prodId}/environments/${envId}/sync`, {
        method: 'POST',
        body: data
    }),

    // Compare environments
    compareEnvironments: (prodId, envAId, envBId) =>
        api.request(`/wordpress/projects/${prodId}/compare?env_a=${envAId}&env_b=${envBId}`),

    // Locking
    lockEnvironment: (prodId, envId, data) => api.request(`/wordpress/projects/${prodId}/environments/${envId}/lock`, {
        method: 'POST',
        body: data
    }),

    unlockEnvironment: (prodId, envId) => api.request(`/wordpress/projects/${prodId}/environments/${envId}/lock`, {
        method: 'DELETE'
    }),

    // Activity log
    getProjectActivity: (prodId, params = {}) => {
        const query = new URLSearchParams(params).toString();
        return api.request(`/wordpress/projects/${prodId}/activity${query ? `?${query}` : ''}`);
    },

    // Container logs
    getEnvironmentLogs: (prodId, envId, params = {}) => {
        const query = new URLSearchParams(params).toString();
        return api.request(`/wordpress/projects/${prodId}/environments/${envId}/logs${query ? `?${query}` : ''}`);
    },

    // Promotion history
    getPromotionHistory: (prodId, params = {}) => {
        const query = new URLSearchParams(params).toString();
        return api.request(`/wordpress/projects/${prodId}/promotions${query ? `?${query}` : ''}`);
    },

    // Restore a promotion's pre-promotion snapshot into its target environment
    rollbackPromotion: (prodId, promotionId) => api.request(
        `/wordpress/projects/${prodId}/promotions/${promotionId}/rollback`,
        { method: 'POST' }
    ),

    // Git branches (for multidev)
    getBranches: (prodId) => api.request(`/wordpress/projects/${prodId}/git/branches`),

    // Multidev cleanup
    cleanupMultidevs: (prodId, dryRun = true) => api.request(`/wordpress/projects/${prodId}/multidev/cleanup`, {
        method: 'POST',
        body: { dry_run: dryRun }
    }),

    // Sanitization Profiles
    getSanitizationProfiles: () => api.request('/wordpress/projects/sanitization-profiles'),

    createSanitizationProfile: (data) => api.request('/wordpress/projects/sanitization-profiles', {
        method: 'POST',
        body: data
    }),

    updateSanitizationProfile: (profileId, data) => api.request(`/wordpress/projects/sanitization-profiles/${profileId}`, {
        method: 'PUT',
        body: data
    }),

    deleteSanitizationProfile: (profileId) => api.request(`/wordpress/projects/sanitization-profiles/${profileId}`, {
        method: 'DELETE'
    }),

    // =========================================
    // Phase 7: Advanced Features
    // =========================================

    // Resource Limits
    updateResourceLimits: (prodId, envId, limits) => api.request(`/wordpress/projects/${prodId}/environments/${envId}/resources`, {
        method: 'PUT',
        body: limits
    }),

    // Basic Auth
    enableBasicAuth: (prodId, envId, data = {}) => api.request(`/wordpress/projects/${prodId}/environments/${envId}/auth`, {
        method: 'POST',
        body: data
    }),

    disableBasicAuth: (prodId, envId) => api.request(`/wordpress/projects/${prodId}/environments/${envId}/auth`, {
        method: 'DELETE'
    }),

    getBasicAuthStatus: (prodId, envId) => api.request(`/wordpress/projects/${prodId}/environments/${envId}/auth`),

    // WP-CLI
    executeWpCli: (prodId, envId, command) => api.request(`/wordpress/projects/${prodId}/environments/${envId}/exec`, {
        method: 'POST',
        body: { command }
    }),

    // Health
    getEnvironmentHealth: (prodId, envId) => api.request(`/wordpress/projects/${prodId}/environments/${envId}/health`),

    getProjectHealth: (prodId) => api.request(`/wordpress/projects/${prodId}/health`),

    // Disk Usage
    getEnvironmentDiskUsage: (prodId, envId) => api.request(`/wordpress/projects/${prodId}/environments/${envId}/disk-usage`),

    getProjectDiskUsage: (prodId) => api.request(`/wordpress/projects/${prodId}/disk-usage`),

    // Bulk Operations
    executeBulkOperation: (prodId, operations) => api.request(`/wordpress/projects/${prodId}/bulk`, {
        method: 'POST',
        body: { operations }
    }),

    // Auto-Sync
    getAutoSyncSchedule: (prodId, envId) => api.request(`/wordpress/projects/${prodId}/environments/${envId}/auto-sync`),

    updateAutoSyncSchedule: (prodId, envId, config) => api.request(`/wordpress/projects/${prodId}/environments/${envId}/auto-sync`, {
        method: 'PUT',
        body: config
    })
};

export default wordpressApi;
