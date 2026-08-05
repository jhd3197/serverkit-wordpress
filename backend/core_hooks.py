"""Core-hook registrations for the WordPress extension (plan 52, D4).

Core keeps the engines — backup policies/runs/restore, the event bus catalog,
the template catalog/installer — and this extension supplies its entries at
load time through the manifest ``core_hooks`` seam
(``extension_lifecycle.register_capabilities`` calls :func:`register` at
install and on every boot while the extension is active).

Everything here is idempotent: ``register`` runs once per boot (and once per
install), and possibly again after a test cleared a registry.

Absent extension = feature absent, gracefully:
- no ``wordpress_site`` backup target type (policies that reference it report
  "provider missing" instead of crashing),
- no ``wordpress.*`` types in the event catalog,
- no WordPress cards in the Templates grid, and template installs of the WP
  templates refuse with a clear provider-missing error.
"""
import logging
import os

logger = logging.getLogger(__name__)

SLUG = 'serverkit-wordpress'

# The wordpress.* lifecycle events this extension emits (emitted via
# EventService.emit_wp from the git-deploy / create / safe-update flows).
# Catalog registration only — emission never validates against the catalog.
WP_EVENT_TYPES = [
    {'type': 'wordpress.site_down', 'category': 'WordPress', 'description': 'A WordPress site failed its health check'},
    {'type': 'wordpress.site_up', 'category': 'WordPress', 'description': 'A WordPress site recovered after a failed health check'},
    {'type': 'wordpress.created', 'category': 'WordPress', 'description': 'A WordPress site was created'},
    {'type': 'wordpress.deleted', 'category': 'WordPress', 'description': 'A WordPress site was deleted'},
    {'type': 'wordpress.backup_completed', 'category': 'WordPress', 'description': 'A WordPress site backup/snapshot completed'},
    {'type': 'wordpress.updated', 'category': 'WordPress', 'description': 'A WordPress safe-update completed'},
    {'type': 'wordpress.update_rolled_back', 'category': 'WordPress', 'description': 'A WordPress update was auto-rolled-back'},
    {'type': 'wordpress.deployed', 'category': 'WordPress', 'description': 'A WordPress git deploy completed'},
    {'type': 'wordpress.deploy_failed', 'category': 'WordPress', 'description': 'A WordPress git deploy failed'},
]


def register():
    """Register every WordPress entry into the core seams. Idempotent."""
    _register_backup_kind()
    _register_event_types()
    _register_template_provider()


# --------------------------------------------------------------------------- #
# Backup target kind: 'wordpress_site'
# --------------------------------------------------------------------------- #

def _register_backup_kind():
    from app.services import backup_kind_registry
    if backup_kind_registry.get('wordpress_site'):
        return
    backup_kind_registry.register(
        'wordpress_site',
        resolve=_backup_resolve,
        execute=_backup_execute,
        restore=_backup_restore,
        label='WordPress site',
        restore_scopes=['full', 'files', 'database', 'tables'],
    )


def _backup_resolve(policy):
    """Describe the live WordPress site behind a backup policy."""
    from app.models.wordpress_site import WordPressSite  # core model (D1)
    from app.services.backup_policy_service import BackupPolicyError
    site = WordPressSite.query.get(policy.target_id)
    if not site:
        raise BackupPolicyError('WordPress site not found')
    app = site.application
    if not app or not app.root_path:
        raise BackupPolicyError('Target path not found')
    return {
        'name': app.name, 'root_path': app.root_path,
        'site': site, 'app': app,
    }


def _backup_execute(policy, target, kind):
    """Produce a WordPress backup (files + database via wp-cli). Always full."""
    from app.services.backup_policy_service import (
        BackupPolicyError, BackupPolicyService,
    )
    from .wordpress_service import WordPressService
    result = WordPressService.backup_wordpress(target['root_path'], include_db=True)
    if not result.get('success'):
        raise BackupPolicyError(result.get('error') or 'WordPress backup failed')
    storage_path = result.get('backup_path')
    size = result.get('size') or BackupPolicyService._path_size(storage_path)
    meta = {
        'kind': 'full', 'compression': 'gzip', 'incremental': False,
        'backup_name': result.get('backup_name'), 'includes': ['files', 'database'],
        'primary_archive': os.path.join(storage_path, 'files.tar.gz'),
    }
    return storage_path, size, meta


def _backup_restore(policy, target, run, options):
    """Restore a WordPress backup. 'full' (and 'tables', for now) restores
    files + database; 'database' imports only the SQL dump; 'files' extracts
    only the file archive."""
    from app.services.backup_policy_service import BackupPolicyError
    from .wordpress_service import WordPressService
    scope = (options or {}).get('scope', 'full')
    meta = run.get_metadata() or {}
    backup_dir = run.storage_path
    root = target['root_path']

    if scope == 'database':
        db_sql = os.path.join(backup_dir or '', 'database.sql')
        if not os.path.exists(db_sql):
            raise BackupPolicyError('Database dump not found in this backup')
        result = WordPressService.wp_cli(root, ['db', 'import', db_sql])
        if not result.get('success'):
            raise BackupPolicyError(result.get('error') or 'Database restore failed')
        return

    if scope == 'files':
        files_archive = os.path.join(backup_dir or '', 'files.tar.gz')
        if not os.path.exists(files_archive):
            raise BackupPolicyError('Files archive not found in this backup')
        import tarfile
        with tarfile.open(files_archive, 'r:gz') as tar:
            tar.extractall(os.path.dirname(root.rstrip('/')) or '/', filter='data')
        return

    # full (or 'tables', approximated as full until per-table is implemented)
    backup_name = meta.get('backup_name') or (os.path.basename(backup_dir) if backup_dir else None)
    if not backup_name:
        raise BackupPolicyError('Backup archive not found')
    result = WordPressService.restore_backup(backup_name, root)
    if not result.get('success'):
        raise BackupPolicyError(result.get('error') or 'Restore failed')


# --------------------------------------------------------------------------- #
# Event catalog: wordpress.* types
# --------------------------------------------------------------------------- #

def _register_event_types():
    from app.services import event_service
    event_service.register_event_types(WP_EVENT_TYPES, source=SLUG)


# --------------------------------------------------------------------------- #
# Templates: 'wordpress' + 'wordpress-external-db'
# --------------------------------------------------------------------------- #

def _register_template_provider():
    from app.services.template_service import TemplateService
    TemplateService.register_template_provider(SLUG, validate=_validate_wp_template)


def _validate_wp_template(template_id, variables):
    """Provider validate hook for the WP templates.

    The external-DB preflight (a live MySQL connection check before install)
    used to be a hardcoded ``template_id == 'wordpress-external-db'`` branch in
    core's TemplateService; it moved here with the rest of the WP coupling.
    Returns an error dict to veto the install, or None.
    """
    if template_id != 'wordpress-external-db':
        return None
    from app.services.template_service import TemplateService
    db_check = TemplateService.validate_mysql_connection(
        host=variables.get('DB_HOST'),
        port=variables.get('DB_PORT', '3306'),
        user=variables.get('DB_USER'),
        password=variables.get('DB_PASSWORD'),
        database=variables.get('DB_NAME'),
    )
    if not db_check.get('success'):
        return {
            'success': False,
            'error': f"Database connection failed: {db_check.get('error')}",
        }
    return None
