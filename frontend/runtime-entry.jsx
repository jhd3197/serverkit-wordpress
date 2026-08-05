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

// Named exports match the `component` values in plugin.json's route
// contributions; resolveComponent(slug, name) picks them up at runtime.
// Deliberately NO default export (PluginLoader auto-renders those globally).
export { WordPressExtension } from './index.jsx';
