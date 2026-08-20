// Runtime-ESM entry for ServerKit's no-rebuild loader (same pattern as
// serverkit-minecraft / serverkit-analytics). The three WordPress SCSS
// entries compile at extension build time (sass) and are imported as STRINGS
// (?inline), then injected once at module load — the single dist/index.mjs
// the panel blob-imports carries its own styles, exactly layered as the old
// main.scss partials were. Shared libs (react, react-router-dom,
// serverkit-sdk) are externalized by vite.config and resolved to the panel's
// singletons via its import map; lucide-react, recharts and socket.io-client
// are bundled.
import cssMain from './styles/wordpress.scss?inline';
import cssPipeline from './styles/wordpress-pipeline.scss?inline';
import cssLibrary from './styles/wordpress-plugin-library.scss?inline';

if (typeof document !== 'undefined' && !document.getElementById('serverkit-wordpress-styles')) {
    const style = document.createElement('style');
    style.id = 'serverkit-wordpress-styles';
    style.textContent = [cssMain, cssPipeline, cssLibrary].join('\n');
    document.head.appendChild(style);
}

// Translations. Registered against the PANEL's i18next singleton (shared via
// its vendor import map), additively and under this extension's own `wp`
// namespace — never `init()` or `changeLanguage()`, which the panel owns and
// which would reconfigure or switch the language for every other surface.
//
// The English bundle is generated from the inline `t('wp.x', 'English')`
// defaults, so registering it is belt-and-braces: a key with no bundle still
// renders its default. Additional locales drop in beside en.json and get one
// more addResourceBundle line each.
import i18next from 'i18next';
import en from './locales/en.json';
import es from './locales/es.json';

for (const [language, bundle] of Object.entries({ en, es })) {
    i18next.addResourceBundle(language, 'translation', bundle, true, false);
}

// Named exports match the `component` values in plugin.json's route
// contributions; resolveComponent(slug, name) picks them up at runtime.
// Deliberately NO default export (PluginLoader auto-renders those globally).
export { WordPressExtension } from './index.jsx';
