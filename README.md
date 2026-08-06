# ServerKit WordPress

<p>
  <img src="assets/logo.png" alt="ServerKit WordPress logo" width="96" align="right" />
</p>

[![Install in ServerKit](https://serverkit.ai/badge/install.svg)](https://serverkit.ai/i/ext/serverkit-wordpress)

The full WordPress suite for [ServerKit](https://github.com/jhd3197/ServerKit) —
a first-party extension. One-click WordPress hosting on your own server:

- **Site provisioning** — one-click WordPress sites on Docker, with base-domain
  publishing, SSL, and capacity checks.
- **Environments & pipelines** — staging/production environments per site,
  promote pipelines (content + database) riding the Deploy Console.
- **Plugin library** — a curated, cached plugin catalog with one-click install.
- **Updates** — core/plugin/theme update runs with per-site policies.
- **Security** — hardening checks, vulnerability scanning, fail2ban jail wiring.
- **Analytics & reports** — traffic analytics integration and scheduled
  client-friendly site reports.
- **Imports** — bring an existing site over SSH or from a SQL/wp-content zip.

## Install

[**Install in ServerKit →**](https://serverkit.ai/i/ext/serverkit-wordpress)

Name your panel once and that link opens it straight to the install
confirmation; it is remembered in your browser, so every later install is a
single click. Your panel does the installing — serverkit.ai never connects to
it, and the panel's own consent and signature checks still run.

From inside the panel instead:

- **Onboarding wizard:** pick the WordPress use case on a fresh panel and it's
  installed for you.
- **Extensions page:** ServerKit → Extensions → find "WordPress" → Install.
- **Zip or URL:** Extensions → *Install manually* → paste this repo's URL or
  upload the release zip.

Requires ServerKit ≥ 1.7.81 (panel SDK ^1.2.0). API prefixes and route shapes
are unchanged from the pre-extraction builtin (`/api/v1/wordpress*`), so the
CLI, LocalKit, and existing integrations keep working.

## The core data seam (read this before hacking on the backend)

WordPress's database schema is **core, permanently and on purpose** (plan 52
D1): `WordPressSite`, `WordPressVulnerability`, `WordPressUpdateRun`,
`WordPressReport` and friends are core Alembic-managed tables
(`backend/app/models/wordpress_site.py`, `wordpress_custom_plugin.py` in the
panel repo). This extension imports them:

```python
from app.models.wordpress_site import WordPressSite
```

There is no `ext_serverkit_wordpress_*` rename and no extension-owned
migration mechanism — the tables carry live data on every install, and the
core migrations own their lifecycle. Conversely, core never imports this
extension: it reaches it through `app.services.wordpress_bridge` /
`get_installed_extension_attr` and the registration seams this extension fills
at load (`core_hooks:register` — backup target provider, event types, template
provider, fail2ban jail). Absent extension = feature absent, gracefully.

## Development

```
backend/     Flask blueprints + services (loaded as app.plugins.serverkit-wordpress)
frontend/    runtime-ESM bundle source (react / react-router-dom /
             serverkit-sdk are external; SCSS compiled + inlined into
             dist/index.mjs)
tests/       pytest suite — runs inside a ServerKit checkout (see tests/README.md)
scripts/     release-zip + registry tooling (first-party release flow)
```

Build the frontend bundle:

```bash
cd frontend
npm install
npm run build        # → dist/index.mjs
```

Build the installable zip:

```bash
./scripts/build-zip.sh        # or scripts/build-zip.ps1 on Windows
```

## Tests

The tests need the panel's Flask app + pytest fixtures, so they run from
inside a ServerKit checkout via symlink — see [tests/README.md](tests/README.md).

## License

MIT — see [LICENSE](LICENSE). WordPress is a trademark of the WordPress
Foundation; this extension is not affiliated with or endorsed by them.
