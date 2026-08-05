# Tests

These suites exercise the extension itself (site surface, extraction wiring,
reports, plugin library, pipelines alias, promote deploy jobs, SSH import,
PHP limits/errors, zip import) but need the **panel's Flask app and pytest
fixtures** (`app`, `client`, `auth_headers`) plus the core WP models (plan 52
D1 — the schema is core Alembic tables), so they run from inside a ServerKit
checkout rather than standalone:

```bash
# Symlink (or copy) the test files into the panel's test suite:
ln -s "$(pwd)"/test_*.py /path/to/ServerKit/backend/tests/

# Then run them from the panel backend:
cd /path/to/ServerKit/backend
pytest tests/test_app_wordpress_surface.py tests/test_wordpress_extraction.py \
       tests/test_wp_import_zip.py tests/test_wp_php_errors.py \
       tests/test_wp_php_limits.py tests/test_wp_pipelines_alias.py \
       tests/test_wp_plugin_library.py tests/test_wp_promote_deploy_job.py \
       tests/test_wp_reports.py tests/test_wp_ssh_import.py
```

Via symlink each test resolves this repo's root with `os.path.realpath` (and
pulls in the shared `_wp_support.py` from this directory — no need to link
it). If you copy the files instead, point them at the repo:

```bash
SERVERKIT_WORDPRESS_DIR=/path/to/serverkit-wordpress pytest tests/test_*wp*
```

`_wp_support.ensure_plugin(app)` mirrors a real install on each test app:
an active InstalledPlugin row, every manifest blueprint mount (entry_point +
extra_blueprints — `/api/v1/wordpress`, `/projects`, `/pipelines`; D3), and
the `core_hooks` seam registrations.

Panel-core WP coverage (hook-absent degradation, onboarding/seeding
machinery, generic feature suites that merely use WP as a vehicle) stays in
the ServerKit repo.
