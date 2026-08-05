import { Globe, GitBranch, Package } from 'lucide-react';

// Shared sub-nav for the WordPress page group (WordPress sites / Pipeline).
// Rendered in each page's <PageTopbar tabs={WORDPRESS_TABS}> — the demo's
// top-bar layout replaces the old sidebar sub-menu (REDESIGN_MAP §6 dec. 3).
// (The Pipeline tab was wpInstalled-gated in the sidebar; kept always-visible
// here for simplicity — the pipeline page shows an empty state when unused.)
export const WORDPRESS_TABS = [
    { to: '/wordpress', label: 'WordPress', end: true, icon: <Globe size={15} /> },
    { to: '/wordpress/plugins/library', label: 'Plugin Library', icon: <Package size={15} /> },
    { to: '/wordpress/pipelines', label: 'Pipeline', icon: <GitBranch size={15} /> },
];
