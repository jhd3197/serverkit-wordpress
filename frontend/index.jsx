// WordPress UI, contributed through the extension system. Both halves live in
// this repo: the backend (the /api/v1/wordpress* blueprints + services) under
// backend/, and the full frontend (5 pages + the components/wordpress tree +
// styles/) here. The panel loads it as a runtime-ESM bundle (plugin.json
// frontend_entry: dist/index.mjs) — react / react-router-dom / serverkit-sdk
// resolve to the panel's singletons via its import map; styles are compiled
// from the SCSS entries and injected by runtime-entry.jsx (?inline).
//
// The WordPress surface is a tab group + full-bleed detail pages. Contributed
// routes are flat (there's no way to contribute a shared TabGroupLayout parent
// inside the dashboard), so we contribute ONE splat route (`wordpress/*`) and
// this component self-renders the whole WordPress sub-router — reproducing the
// exact structure the core App.jsx used to own (TabGroupLayout + WORDPRESS_TABS
// over the three list pages; full-bleed detail/pipeline routes as siblings;
// the legacy /wordpress/projects → /wordpress/pipelines deprecation redirects).
import { Routes, Route, Navigate, useParams } from 'react-router-dom';
import { TabGroupLayout } from 'serverkit-sdk';

import { WORDPRESS_TABS } from './components/wordpress/wordpressTabs';
import WordPress from './pages/WordPress';
import WordPressPluginLibrary from './pages/WordPressPluginLibrary';
import WordPressProjects from './pages/WordPressProjects';
import WordPressProject from './pages/WordPressProject';
import WordPressDetail from './pages/WordPressDetail';
import WordPressSshImport from './WordPressSshImport';

// "WordPress Projects" was renamed to "Pipelines" (§2 unification). Forward old
// deep links to the new space.
function LegacyWpPipelineRedirect() {
    const { id, tab } = useParams();
    const suffix = [id, tab].filter(Boolean).join('/');
    return <Navigate to={`/wordpress/pipelines/${suffix}`} replace />;
}

export function WordPressExtension() {
    return (
        <Routes>
            {/* Tab group — list surfaces share one PageTopbar + WORDPRESS_TABS. */}
            <Route element={<TabGroupLayout tabs={WORDPRESS_TABS} />}>
                <Route index element={<WordPress />} />
                <Route path="plugins/library" element={<WordPressPluginLibrary />} />
                <Route path="pipelines" element={<WordPressProjects />} />
                {/* SSH pull-import (Panel Improvements #3) — shares the group
                    chrome; reached via the command palette / direct link. */}
                <Route path="ssh-import" element={<WordPressSshImport />} />
            </Route>
            {/* Full-bleed pipeline detail (own chrome, outside the tab group). */}
            <Route path="pipelines/:id" element={<WordPressProject />} />
            <Route path="pipelines/:id/:tab" element={<WordPressProject />} />
            {/* Legacy "WordPress Projects" URLs → Pipelines (§2). */}
            <Route path="projects" element={<Navigate to="/wordpress/pipelines" replace />} />
            <Route path="projects/:id" element={<LegacyWpPipelineRedirect />} />
            <Route path="projects/:id/:tab" element={<LegacyWpPipelineRedirect />} />
            {/* Full-bleed site detail (own chrome, outside the tab group). The
                :tab/:section depth keeps the Settings sub-nav shareable. */}
            <Route path=":id" element={<WordPressDetail />} />
            <Route path=":id/:tab" element={<WordPressDetail />} />
            <Route path=":id/:tab/:section" element={<WordPressDetail />} />
        </Routes>
    );
}

// No default export on purpose: PluginLoader legacy-auto-renders any plugin
// default export globally — this sub-router mounted that way runs outside its
// route and swallows the current location ("/domains" → :id "domains").
// The route contribution resolves the NAMED export via resolveComponent.
