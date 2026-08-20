import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// ServerKit runtime-ESM extension build (panel plan 25).
// Externalizes the host-shared libraries so the panel resolves them to its OWN
// singletons via the import map — never bundle React (a second copy crashes
// hooks). Emits one self-contained dist/index.mjs; the SCSS is compiled and
// inlined via the runtime entry's `?inline` imports, so there is no separate
// stylesheet asset. lucide-react, recharts and socket.io-client ARE bundled
// (the panel does not share them with runtime extensions).
// i18next/react-i18next are externalized for the same reason React is: a
// second copy would be a SEPARATE, uninitialised instance, so every t() here
// would render its English default forever and nothing would report it. The
// panel shares them through its import map (SDK >= 1.3.0).
const EXTERNAL = [
    'react', 'react-dom', 'react-dom/client', 'react/jsx-runtime',
    'react-router-dom', 'i18next', 'react-i18next', 'serverkit-sdk',
];

export default defineConfig({
    plugins: [react()],
    // Match the host build: the migrated SCSS still uses legacy @import and
    // pre-1.80 color functions (lighten/fade) — silence the expected
    // deprecation noise, same as the panel's vite.config does.
    css: {
        preprocessorOptions: {
            scss: {
                silenceDeprecations: ['import', 'slash-div', 'legacy-js-api',
                    'global-builtin', 'color-functions', 'strict-unary'],
            },
        },
    },
    build: {
        outDir: 'dist',
        emptyOutDir: false, // dist also holds release zips; keep them
        lib: {
            entry: 'runtime-entry.jsx',
            formats: ['es'],
            fileName: () => 'index.mjs',
        },
        rollupOptions: {
            external: EXTERNAL,
            output: { inlineDynamicImports: true },
        },
    },
});
