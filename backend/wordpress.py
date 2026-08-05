# Bucket: PER-APP (plan 29 #9). Per-site WordPress routes gate on the linked
# application's access seam: reads use can_access_app (owner/admin/any grant),
# writes use can_edit_app (owner/admin/editor grant). The P0 <site_id> lifecycle
# mutations and the previously-open <site_id>/<app_id> reads seal from open —
# denial (or a missing resource) is an indistinguishable 404 (Decision 5). Host/
# system ops (standalone install/uninstall/start/stop/restart, legacy install,
# wp-cli, plugin library) stay @admin_required.
import json
from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt_identity
from app.middleware.rbac import admin_required, get_current_user
from app.models import User, Application, WordPressSite
from app.services.resource_grant_service import ResourceGrantService
from .wordpress_service import WordPressService
from app import db

wordpress_bp = Blueprint('wordpress', __name__)


def _resolve_app(site_or_app_id):
    """Resolve an ID to an Application. Tries WordPressSite first, then Application."""
    wp_site = WordPressSite.query.get(site_or_app_id)
    if wp_site and wp_site.application:
        return wp_site.application
    return Application.query.get(site_or_app_id)


def _is_wp_app(app):
    """True if `app` is a WordPress-managed site. Containerized WP sites are
    stored with app_type 'docker' (see WordPressService), so app_type alone is
    not a reliable signal — a linked WordPressSite record is the source of truth.
    """
    if not app:
        return False
    if app.app_type == 'wordpress':
        return True
    return WordPressSite.query.filter_by(application_id=app.id).first() is not None


def _guard_app(site_or_app_id, write=False):
    """Resolve a per-site WordPress route to its Application and enforce access,
    returning ``(app, None)`` or ``(None, error_response)``. Reads use
    can_access_app (owner/admin/any grant); writes use can_edit_app (owner/admin/
    editor grant). Denial is a 403 — used by the convergence reads that keep
    their status. A missing/non-WP resource is a 404."""
    app = _resolve_app(site_or_app_id)
    if not _is_wp_app(app):
        return None, (jsonify({'error': 'Application not found'}), 404)
    user = get_current_user()
    ok = (ResourceGrantService.can_edit_app(user, app) if write
          else ResourceGrantService.can_access_app(user, app))
    if not ok:
        return None, (jsonify({'error': 'Access denied'}), 403)
    return app, None


def _guard_sealed_app(site_or_app_id, write=False):
    """Like :func:`_guard_app` but sealed-from-open (Decision 5): a missing
    resource OR an unauthorized caller both return an indistinguishable
    ``404 {'error': 'Not found'}`` so a foreign caller cannot probe existence.
    Used by the P0 <site_id> lifecycle mutations and the previously-open
    <site_id>/<app_id> reads."""
    app = _resolve_app(site_or_app_id)
    if not _is_wp_app(app):
        return None, (jsonify({'error': 'Not found'}), 404)
    user = get_current_user()
    ok = (ResourceGrantService.can_edit_app(user, app) if write
          else ResourceGrantService.can_access_app(user, app))
    if not ok:
        return None, (jsonify({'error': 'Not found'}), 404)
    return app, None


# ==================== WORDPRESS SITES HUB ENDPOINTS ====================

@wordpress_bp.route('/sites', methods=['GET'])
@jwt_required()
def list_sites():
    """List all WordPress sites (production sites with environment counts).

    Workspace-aware (#33): filters to the active workspace when one is supplied
    (X-Workspace-Id / ?workspace_id), via the site's parent application."""
    from app.services.workspace_service import WorkspaceService
    user = User.query.get(get_jwt_identity())
    ws_id = WorkspaceService.resolve_workspace_id(
        user, request.headers.get('X-Workspace-Id') or request.args.get('workspace_id'))
    result = WordPressService.get_sites(workspace_id=ws_id)
    return jsonify(result), 200


@wordpress_bp.route('/sites', methods=['POST'])
@jwt_required()
def create_site():
    """Create a new WordPress site via Docker."""
    data = request.get_json() or {}
    name = data.get('name')
    admin_email = data.get('adminEmail', '')
    php_version = data.get('phpVersion') or None
    enable_page_cache = bool(data.get('enablePageCache'))
    enable_object_cache = bool(data.get('enableObjectCache'))
    domain = (data.get('domain') or '').strip()
    base_domain = (data.get('baseDomain') or data.get('base_domain') or '').strip()

    if not name:
        return jsonify({'error': 'Site name is required'}), 400

    if php_version and php_version not in WordPressService.get_available_php_versions():
        return jsonify({'error': f'Unsupported PHP version: {php_version}'}), 400

    current_user_id = get_jwt_identity()
    result = WordPressService.create_site(
        name, admin_email, current_user_id,
        php_version=php_version,
        enable_page_cache=enable_page_cache,
        enable_object_cache=enable_object_cache,
        domain=domain or None,
        base_domain=base_domain or None,
    )

    if result.get('success'):
        return jsonify(result), 201
    return jsonify(result), 400


@wordpress_bp.route('/sites/import', methods=['POST'])
@jwt_required()
def import_site():
    """Import an existing WordPress site from an uploaded SQL dump plus an optional
    wp-content/full-site .zip (multipart)."""
    import os
    import tempfile
    name = request.form.get('name')
    admin_email = request.form.get('adminEmail', '')
    old_url = request.form.get('oldUrl', '').strip()
    if not name:
        return jsonify({'error': 'Site name is required'}), 400
    if not old_url:
        return jsonify({'error': 'Original site URL (old_url) is required for search-replace'}), 400
    if 'sql' not in request.files:
        return jsonify({'error': 'A .sql or .sql.gz database dump is required'}), 400
    sql_file = request.files['sql']
    if not sql_file.filename:
        return jsonify({'error': 'No SQL file selected'}), 400
    fname = sql_file.filename.lower()
    if not (fname.endswith('.sql') or fname.endswith('.sql.gz') or fname.endswith('.gz')):
        return jsonify({'error': 'Dump must be a .sql or .sql.gz file'}), 400

    # Optional wp-content / full-site zip (plugins/themes/uploads).
    zip_file = request.files.get('wp_content')
    if zip_file and zip_file.filename and not zip_file.filename.lower().endswith('.zip'):
        return jsonify({'error': 'wp-content archive must be a .zip file'}), 400

    suffix = '.sql.gz' if fname.endswith('.gz') else '.sql'
    fd, tmp_path = tempfile.mkstemp(suffix=suffix, prefix='wp_import_')
    os.close(fd)
    zip_tmp = None
    try:
        sql_file.save(tmp_path)
        if zip_file and zip_file.filename:
            zfd, zip_tmp = tempfile.mkstemp(suffix='.zip', prefix='wp_import_content_')
            os.close(zfd)
            zip_file.save(zip_tmp)
        current_user_id = get_jwt_identity()
        result = WordPressService.import_site(
            name=name,
            admin_email=admin_email,
            user_id=current_user_id,
            sql_path=tmp_path,
            old_url=old_url,
            wp_content_zip_path=zip_tmp,
        )
    finally:
        for p in (tmp_path, zip_tmp):
            if p:
                try:
                    os.remove(p)
                except OSError:
                    pass
    return (jsonify(result), 201) if result.get('success') else (jsonify(result), 400)


@wordpress_bp.route('/sites/<int:site_id>', methods=['GET'])
@jwt_required()
def get_site(site_id):
    """Get site detail with environments."""
    _, err = _guard_sealed_app(site_id)
    if err:
        return err
    result = WordPressService.get_site(site_id)
    if 'error' in result:
        return jsonify(result), 404
    return jsonify(result), 200


@wordpress_bp.route('/sites/<int:site_id>/clone', methods=['POST'])
@jwt_required()
def clone_site(site_id):
    """Clone a site into a new INDEPENDENT top-level site with fresh admin creds."""
    _, err = _guard_sealed_app(site_id, write=True)
    if err:
        return err
    data = request.get_json() or {}
    new_name = data.get('name')
    if not new_name:
        return jsonify({'error': 'New site name is required'}), 400

    current_user_id = get_jwt_identity()
    result = WordPressService.clone_site(site_id, new_name, current_user_id)
    if result.get('success'):
        return jsonify(result), 201
    return jsonify(result), 400


@wordpress_bp.route('/sites/<int:site_id>/tags', methods=['PATCH'])
@jwt_required()
def set_site_tags(site_id):
    """Replace the tag list for a WordPress site."""
    _, err = _guard_sealed_app(site_id, write=True)
    if err:
        return err
    data = request.get_json() or {}
    tags = data.get('tags')
    if tags is None or not isinstance(tags, list):
        return jsonify({'error': 'tags must be a list'}), 400

    site = WordPressSite.query.get(site_id)
    if not site:
        return jsonify({'error': 'Site not found'}), 404

    # Normalize: strings only, trimmed, non-empty, de-duplicated (order-preserving)
    seen = set()
    cleaned = []
    for t in tags:
        if not isinstance(t, str):
            continue
        v = t.strip()
        if v and v.lower() not in seen:
            seen.add(v.lower())
            cleaned.append(v)

    import json as _json
    site.tags = _json.dumps(cleaned)
    db.session.commit()
    return jsonify({'success': True, 'tags': cleaned}), 200


@wordpress_bp.route('/sites/<int:site_id>', methods=['DELETE'])
@jwt_required()
def delete_site(site_id):
    """Delete site and all its environments (takes a final backup by default)."""
    _, err = _guard_sealed_app(site_id, write=True)
    if err:
        return err
    # Back up before delete unless explicitly opted out via ?create_backup=false
    create_backup = request.args.get('create_backup', 'true').lower() != 'false'
    result = WordPressService.delete_site(site_id, create_backup=create_backup)
    if result.get('success'):
        return jsonify(result), 200
    return jsonify(result), 400


@wordpress_bp.route('/sites/<int:site_id>/archive', methods=['POST'])
@jwt_required()
def archive_site(site_id):
    """Archive a site: stop the stack but keep all data. Reversible."""
    _, err = _guard_sealed_app(site_id, write=True)
    if err:
        return err
    result = WordPressService.archive_site(site_id)
    if result.get('success'):
        return jsonify(result), 200
    return jsonify(result), 400


@wordpress_bp.route('/sites/<int:site_id>/unarchive', methods=['POST'])
@jwt_required()
def unarchive_site(site_id):
    """Restore a previously archived site."""
    _, err = _guard_sealed_app(site_id, write=True)
    if err:
        return err
    result = WordPressService.unarchive_site(site_id)
    if result.get('success'):
        return jsonify(result), 200
    return jsonify(result), 400


@wordpress_bp.route('/sites/<int:site_id>/environments', methods=['GET'])
@jwt_required()
def list_environments(site_id):
    """List environments for a site."""
    _, err = _guard_sealed_app(site_id)
    if err:
        return err
    result = WordPressService.get_environments(site_id)
    if 'error' in result:
        return jsonify(result), 404
    return jsonify(result), 200


@wordpress_bp.route('/sites/<int:site_id>/environments', methods=['POST'])
@jwt_required()
def create_environment(site_id):
    """Create a staging or development environment."""
    _, err = _guard_sealed_app(site_id, write=True)
    if err:
        return err
    data = request.get_json() or {}
    env_type = data.get('type', '')

    if not env_type:
        return jsonify({'error': 'Environment type is required'}), 400

    current_user_id = get_jwt_identity()
    result = WordPressService.create_environment(site_id, env_type, current_user_id)

    if result.get('success'):
        return jsonify(result), 201
    return jsonify(result), 400


@wordpress_bp.route('/sites/<int:site_id>/environments/<int:env_id>', methods=['DELETE'])
@jwt_required()
def delete_environment(site_id, env_id):
    """Delete a non-production environment."""
    _, err = _guard_sealed_app(site_id, write=True)
    if err:
        return err
    result = WordPressService.delete_environment(env_id)
    if result.get('success'):
        return jsonify(result), 200
    return jsonify(result), 400


# ==================== STANDALONE WORDPRESS (DOCKER) ENDPOINTS ====================

@wordpress_bp.route('/standalone/status', methods=['GET'])
@jwt_required()
def get_standalone_status():
    """Get WordPress standalone installation status."""
    result = WordPressService.get_wordpress_standalone_status()
    return jsonify(result), 200


@wordpress_bp.route('/standalone/requirements', methods=['GET'])
@jwt_required()
def get_standalone_requirements():
    """Get resource requirements for WordPress installation."""
    result = WordPressService.get_wordpress_resource_requirements()
    return jsonify(result), 200


@wordpress_bp.route('/standalone/install', methods=['POST'])
@jwt_required()
@admin_required
def install_standalone():
    """Install WordPress via Docker Compose."""
    data = request.get_json() or {}

    result = WordPressService.install_wordpress_standalone(
        admin_email=data.get('adminEmail')
    )

    if result.get('success'):
        return jsonify(result), 201
    return jsonify(result), 400


@wordpress_bp.route('/standalone/uninstall', methods=['POST'])
@jwt_required()
@admin_required
def uninstall_standalone():
    """Uninstall standalone WordPress and optionally remove data."""
    data = request.get_json() or {}

    result = WordPressService.uninstall_wordpress_standalone(
        remove_data=data.get('removeData', False)
    )

    if result.get('success'):
        return jsonify(result), 200
    return jsonify(result), 400


@wordpress_bp.route('/standalone/start', methods=['POST'])
@jwt_required()
@admin_required
def start_standalone():
    """Start WordPress containers."""
    result = WordPressService.start_wordpress_standalone()

    if result.get('success'):
        return jsonify(result), 200
    return jsonify(result), 400


@wordpress_bp.route('/standalone/stop', methods=['POST'])
@jwt_required()
@admin_required
def stop_standalone():
    """Stop WordPress containers."""
    result = WordPressService.stop_wordpress_standalone()

    if result.get('success'):
        return jsonify(result), 200
    return jsonify(result), 400


@wordpress_bp.route('/standalone/restart', methods=['POST'])
@jwt_required()
@admin_required
def restart_standalone():
    """Restart WordPress containers."""
    result = WordPressService.restart_wordpress_standalone()

    if result.get('success'):
        return jsonify(result), 200
    return jsonify(result), 400


# ==================== LEGACY WP-CLI ENDPOINTS ====================


@wordpress_bp.route('/install', methods=['POST'])
@jwt_required()
@admin_required
def install_wordpress():
    """Install a new WordPress site."""
    data = request.get_json()

    if not data:
        return jsonify({'error': 'No data provided'}), 400

    required_fields = ['path', 'site_url', 'admin_email', 'db_name', 'db_user', 'db_password']
    missing = [f for f in required_fields if f not in data]
    if missing:
        return jsonify({'error': f'Missing required fields: {", ".join(missing)}'}), 400

    result = WordPressService.install_wordpress(data['path'], data)

    if result['success']:
        # Create application record
        current_user_id = get_jwt_identity()
        app = Application(
            name=data.get('site_title', 'WordPress Site'),
            app_type='wordpress',
            status='running',
            php_version=data.get('php_version', '8.2'),
            root_path=data['path'],
            user_id=current_user_id
        )
        db.session.add(app)
        db.session.commit()
        result['app_id'] = app.id

    return jsonify(result), 201 if result['success'] else 400


@wordpress_bp.route('/sites/<int:app_id>/php', methods=['GET'])
@jwt_required()
def get_php(app_id):
    """Live PHP version + ini limits for a Docker WP site (read-only)."""
    current_user_id = get_jwt_identity()
    user = User.query.get(current_user_id)
    app = _resolve_app(app_id)
    if not app:
        return jsonify({'error': 'Application not found'}), 404
    if not ResourceGrantService.can_access_app(user, app):
        return jsonify({'error': 'Access denied'}), 403
    info = WordPressService.get_php_info(app.root_path)
    info['available_versions'] = WordPressService.get_available_php_versions()
    # The directives the limits panel may edit (#24 write side).
    info['editable_limits'] = list(WordPressService.get_php_limit_spec().keys())
    return jsonify({'php': info}), 200


@wordpress_bp.route('/sites/<int:app_id>/php', methods=['POST'])
@jwt_required()
@admin_required
def set_php(app_id):
    """Switch the Docker WP site's PHP version (swaps image tag + recreates)."""
    app = _resolve_app(app_id)
    data = request.get_json() or {}
    if not app:
        return jsonify({'error': 'Application not found'}), 404
    if app.app_type not in ('wordpress', 'docker'):
        return jsonify({'error': 'Application is not a WordPress site'}), 400
    version = data.get('version')
    if not version:
        return jsonify({'error': 'version is required'}), 400
    result = WordPressService.set_php_version(app.root_path, version)
    return jsonify(result), 200 if result.get('success') else 400


@wordpress_bp.route('/sites/<int:app_id>/php/limits', methods=['POST'])
@jwt_required()
@admin_required
def set_php_limits(app_id):
    """Durably set per-site PHP ini limits (#24): writes a conf.d drop-in,
    bind-mounts it, and reloads the container. Body: {limits: {key: value, ...}}."""
    app = _resolve_app(app_id)
    data = request.get_json() or {}
    if not app:
        return jsonify({'error': 'Application not found'}), 404
    if app.app_type not in ('wordpress', 'docker'):
        return jsonify({'error': 'Application is not a WordPress site'}), 400
    limits = data.get('limits')
    if not isinstance(limits, dict) or not limits:
        return jsonify({'error': 'limits object is required'}), 400
    result = WordPressService.set_php_limits(app.root_path, limits)
    return jsonify(result), 200 if result.get('success') else 400


def _site_status_target(wp_site):
    """Best-effort public URL for a managed site's status-page component.
    Prefers a primary domain (https when SSL), falls back to the local port.
    The component is health-driven, so this is mainly cosmetic / manual-probe."""
    app = wp_site.application
    if not app:
        return ''
    try:
        domains = list(app.domains)
    except Exception:
        domains = []
    primary = next((d for d in domains if getattr(d, 'is_primary', False)),
                   domains[0] if domains else None)
    if primary and getattr(primary, 'name', None):
        scheme = 'https' if getattr(primary, 'ssl_enabled', False) else 'http'
        return f'{scheme}://{primary.name}'
    # No public domain yet — leave the probe target empty rather than storing an
    # internal localhost:port (the component is health-driven, not network-probed).
    return ''


@wordpress_bp.route('/sites/<int:app_id>/status-page', methods=['GET'])
@jwt_required()
def get_site_status_page(app_id):
    """Return the site's live health + bound status-page component (if any) and
    the status pages it can be attached to."""
    from app.models.status_page import StatusPage, StatusComponent
    current_user_id = get_jwt_identity()
    user = User.query.get(current_user_id)
    app = _resolve_app(app_id)
    if not app:
        return jsonify({'error': 'Application not found'}), 404
    if not ResourceGrantService.can_access_app(user, app):
        return jsonify({'error': 'Access denied'}), 403
    wp_site = WordPressSite.query.filter_by(application_id=app.id).first()
    component = None
    if wp_site:
        comp = StatusComponent.query.filter_by(wordpress_site_id=wp_site.id).first()
        component = comp.to_dict() if comp else None
    pages = [{'id': p.id, 'name': p.name, 'slug': p.slug}
             for p in StatusPage.query.order_by(StatusPage.name).all()]
    return jsonify({
        'health_status': wp_site.health_status if wp_site else None,
        'last_health_check': (wp_site.last_health_check.isoformat()
                              if wp_site and wp_site.last_health_check else None),
        'component': component,
        'pages': pages,
    }), 200


@wordpress_bp.route('/sites/<int:app_id>/status-page', methods=['POST'])
@jwt_required()
@admin_required
def attach_site_status_page(app_id):
    """Attach a managed site to a status page as a health-driven component."""
    from app.models.status_page import StatusPage, StatusComponent
    from app.services.status_page_service import StatusPageService
    app = _resolve_app(app_id)
    if not app:
        return jsonify({'error': 'Application not found'}), 404
    wp_site = WordPressSite.query.filter_by(application_id=app.id).first()
    if not wp_site:
        return jsonify({'error': 'Not a WordPress site'}), 400
    if not wp_site.is_production:
        # The health poller only sweeps production sites, so a component bound to
        # a staging/dev environment would never accrue uptime — reject it.
        return jsonify({'error': 'Only production sites can be added to a status page'}), 400
    data = request.get_json() or {}
    page_id = data.get('page_id')
    if not page_id:
        return jsonify({'error': 'page_id is required'}), 400
    if not StatusPage.query.get(page_id):
        return jsonify({'error': 'Status page not found'}), 404
    existing = StatusComponent.query.filter_by(wordpress_site_id=wp_site.id).first()
    if existing:
        return jsonify({'error': 'Site is already on a status page',
                        'component': existing.to_dict()}), 409
    comp = StatusPageService.create_component(page_id, {
        'name': app.name,
        'group': 'WordPress',
        'check_type': 'http',
        'check_target': _site_status_target(wp_site),
        'wordpress_site_id': wp_site.id,
    })
    return jsonify({'success': True, 'component': comp.to_dict()}), 201


@wordpress_bp.route('/sites/<int:app_id>/status-page', methods=['DELETE'])
@jwt_required()
@admin_required
def detach_site_status_page(app_id):
    """Detach a managed site from its status page (removes the bound component)."""
    from app.models.status_page import StatusComponent
    from app.services.status_page_service import StatusPageService
    app = _resolve_app(app_id)
    if not app:
        return jsonify({'error': 'Application not found'}), 404
    wp_site = WordPressSite.query.filter_by(application_id=app.id).first()
    if not wp_site:
        return jsonify({'error': 'Not a WordPress site'}), 400
    removed = 0
    for comp in StatusComponent.query.filter_by(wordpress_site_id=wp_site.id).all():
        StatusPageService.delete_component(comp.id)
        removed += 1
    return jsonify({'success': True, 'removed': removed}), 200


@wordpress_bp.route('/sites/<int:app_id>/analytics', methods=['GET'])
@jwt_required()
def get_site_analytics(app_id):
    """Per-site traffic + error analytics, parsed on-demand from the container's
    Apache access log (visits / bandwidth / status codes / 404s / bots / top URLs)."""
    from .wp_analytics_service import WpAnalyticsService
    current_user_id = get_jwt_identity()
    user = User.query.get(current_user_id)
    app = _resolve_app(app_id)
    if not app:
        return jsonify({'error': 'Application not found'}), 404
    if not ResourceGrantService.can_access_app(user, app):
        return jsonify({'error': 'Access denied'}), 403
    result = WpAnalyticsService.get_traffic(app.name, request.args.get('hours', 24))
    # PHP fatals/warnings from the WP_DEBUG log (#25 fatals; populated by #30's toggle).
    result['php_errors'] = WpAnalyticsService.get_php_errors(app.name)
    return jsonify(result), 200


@wordpress_bp.route('/sites/<int:app_id>/vulnerabilities', methods=['GET'])
@jwt_required()
def get_site_vulnerabilities(app_id):
    """Return persisted vulnerability findings + live scan status for a site."""
    from .wp_vulnerability_service import WpVulnerabilityService
    current_user_id = get_jwt_identity()
    user = User.query.get(current_user_id)
    app = _resolve_app(app_id)
    if not app:
        return jsonify({'error': 'Application not found'}), 404
    if not ResourceGrantService.can_access_app(user, app):
        return jsonify({'error': 'Access denied'}), 403
    wp_site = WordPressSite.query.filter_by(application_id=app.id).first()
    if not wp_site:
        return jsonify({'error': 'Not a WordPress site'}), 400
    return jsonify(WpVulnerabilityService.get_results(wp_site)), 200


@wordpress_bp.route('/sites/<int:app_id>/vulnerabilities/scan', methods=['POST'])
@jwt_required()
@admin_required
def scan_site_vulnerabilities(app_id):
    """Start a background vulnerability scan (cross-references the WPVulnerability feed)."""
    from .wp_vulnerability_service import WpVulnerabilityService
    app = _resolve_app(app_id)
    if not app:
        return jsonify({'error': 'Application not found'}), 404
    wp_site = WordPressSite.query.filter_by(application_id=app.id).first()
    if not wp_site:
        return jsonify({'error': 'Not a WordPress site'}), 400
    return jsonify(WpVulnerabilityService.start_scan(wp_site)), 200


# ---- Per-site security depth (#30): file integrity, WP_DEBUG, WP-Cron ----

def _owner_or_admin_app(app_id):
    """Resolve an app and enforce the access guard: owner, admin, or a user the
    app was shared with via a per-resource grant (#33). Returns (app, None) or
    (None, (response, status))."""
    user = User.query.get(get_jwt_identity())
    app = _resolve_app(app_id)
    if not app:
        return None, (jsonify({'error': 'Application not found'}), 404)
    # user.id (int), not the stringified token id; honor per-resource grants.
    if not user.is_admin and app.user_id != user.id:
        from app.services.resource_grant_service import ResourceGrantService
        if not ResourceGrantService.user_has_grant(user.id, 'application', app.id):
            return None, (jsonify({'error': 'Access denied'}), 403)
    return app, None


@wordpress_bp.route('/sites/<int:app_id>/integrity', methods=['GET'])
@jwt_required()
def get_site_integrity(app_id):
    """Return the latest file-integrity result + scan status for a site."""
    from .wp_security_service import WpSecurityService
    app, err = _owner_or_admin_app(app_id)
    if err:
        return err
    wp_site = WordPressSite.query.filter_by(application_id=app.id).first()
    if not wp_site:
        return jsonify({'error': 'Not a WordPress site'}), 400
    return jsonify(WpSecurityService.get_integrity(wp_site.id)), 200


@wordpress_bp.route('/sites/<int:app_id>/integrity/scan', methods=['POST'])
@jwt_required()
@admin_required
def scan_site_integrity(app_id):
    """Start a background file-integrity check (wp core/plugin verify-checksums)."""
    from .wp_security_service import WpSecurityService
    app = _resolve_app(app_id)
    if not app:
        return jsonify({'error': 'Application not found'}), 404
    wp_site = WordPressSite.query.filter_by(application_id=app.id).first()
    if not wp_site:
        return jsonify({'error': 'Not a WordPress site'}), 400
    return jsonify(WpSecurityService.start_integrity_scan(wp_site)), 200


@wordpress_bp.route('/sites/<int:app_id>/debug', methods=['GET'])
@jwt_required()
def get_site_debug(app_id):
    """Return the site's WP_DEBUG / WP_DEBUG_LOG / SCRIPT_DEBUG state."""
    from .wp_security_service import WpSecurityService
    app, err = _owner_or_admin_app(app_id)
    if err:
        return err
    return jsonify(WpSecurityService.get_debug(app.root_path)), 200


@wordpress_bp.route('/sites/<int:app_id>/debug', methods=['POST'])
@jwt_required()
@admin_required
def set_site_debug(app_id):
    """Toggle debug logging (WP_DEBUG/WP_DEBUG_LOG/SCRIPT_DEBUG on; display always off)."""
    from .wp_security_service import WpSecurityService
    app = _resolve_app(app_id)
    if not app:
        return jsonify({'error': 'Application not found'}), 404
    enabled = bool((request.get_json() or {}).get('enabled'))
    return jsonify(WpSecurityService.set_debug(app.root_path, enabled)), 200


@wordpress_bp.route('/sites/<int:app_id>/cron', methods=['GET'])
@jwt_required()
def get_site_cron(app_id):
    """Return WP-Cron status (DISABLE_WP_CRON + due events)."""
    from .wp_security_service import WpSecurityService
    app, err = _owner_or_admin_app(app_id)
    if err:
        return err
    return jsonify(WpSecurityService.get_cron(app.root_path)), 200


@wordpress_bp.route('/sites/<int:app_id>/cron/run', methods=['POST'])
@jwt_required()
@admin_required
def run_site_cron(app_id):
    """Run all due WP-Cron events now."""
    from .wp_security_service import WpSecurityService
    app = _resolve_app(app_id)
    if not app:
        return jsonify({'error': 'Application not found'}), 404
    return jsonify(WpSecurityService.run_cron(app.root_path)), 200


@wordpress_bp.route('/sites/<int:app_id>/cron', methods=['POST'])
@jwt_required()
@admin_required
def set_site_cron(app_id):
    """Enable/disable WP's pseudo-cron (DISABLE_WP_CRON)."""
    from .wp_security_service import WpSecurityService
    app = _resolve_app(app_id)
    if not app:
        return jsonify({'error': 'Application not found'}), 404
    disabled = bool((request.get_json() or {}).get('disabled'))
    return jsonify(WpSecurityService.set_cron_disabled(app.root_path, disabled)), 200


@wordpress_bp.route('/sites/<int:app_id>/security/bruteforce', methods=['GET'])
@jwt_required()
def get_site_bruteforce(app_id):
    """Per-site login brute-force status: fail2ban availability, jail on/off, bans."""
    from .wp_security_service import WpSecurityService
    app, err = _owner_or_admin_app(app_id)
    if err:
        return err
    wp_site = WordPressSite.query.filter_by(application_id=app.id).first()
    if not wp_site:
        return jsonify({'error': 'Not a WordPress site'}), 400
    return jsonify(WpSecurityService.get_brute_force(wp_site)), 200


@wordpress_bp.route('/sites/<int:app_id>/security/bruteforce', methods=['POST'])
@jwt_required()
@admin_required
def set_site_bruteforce(app_id):
    """Enable/disable the site's WP-login brute-force jail."""
    from .wp_security_service import WpSecurityService
    app = _resolve_app(app_id)
    if not app:
        return jsonify({'error': 'Application not found'}), 404
    wp_site = WordPressSite.query.filter_by(application_id=app.id).first()
    if not wp_site:
        return jsonify({'error': 'Not a WordPress site'}), 400
    enabled = bool((request.get_json() or {}).get('enabled'))
    return jsonify(WpSecurityService.set_brute_force(wp_site, enabled)), 200


@wordpress_bp.route('/sites/<int:app_id>/security/bruteforce/unban', methods=['POST'])
@jwt_required()
@admin_required
def unban_site_bruteforce(app_id):
    """Unban an IP from the site's brute-force jail."""
    from .wp_security_service import WpSecurityService
    app = _resolve_app(app_id)
    if not app:
        return jsonify({'error': 'Application not found'}), 404
    wp_site = WordPressSite.query.filter_by(application_id=app.id).first()
    if not wp_site:
        return jsonify({'error': 'Not a WordPress site'}), 400
    ip = ((request.get_json() or {}).get('ip') or '').strip()
    if not ip:
        return jsonify({'error': 'ip is required'}), 400
    return jsonify(WpSecurityService.unban_brute_force(wp_site, ip)), 200


# ---- Safe update manager (#29): run history, on-demand safe update, schedule ----

@wordpress_bp.route('/sites/<int:app_id>/updates', methods=['GET'])
@jwt_required()
def get_site_updates(app_id):
    """Return safe-update run history + status + the site's update schedule."""
    from .wp_update_service import WpUpdateService
    app, err = _owner_or_admin_app(app_id)
    if err:
        return err
    wp_site = WordPressSite.query.filter_by(application_id=app.id).first()
    if not wp_site:
        return jsonify({'error': 'Not a WordPress site'}), 400
    result = WpUpdateService.get_runs(wp_site)
    result['schedule'] = wp_site.auto_update_schedule
    result['exclude'] = json.loads(wp_site.auto_update_exclude) if wp_site.auto_update_exclude else []
    return jsonify(result), 200


@wordpress_bp.route('/sites/<int:app_id>/updates/run', methods=['POST'])
@jwt_required()
@admin_required
def run_site_updates(app_id):
    """Start a background safe update (snapshot -> update -> health-check -> auto-rollback)."""
    from .wp_update_service import WpUpdateService
    app = _resolve_app(app_id)
    if not app:
        return jsonify({'error': 'Application not found'}), 404
    wp_site = WordPressSite.query.filter_by(application_id=app.id).first()
    if not wp_site:
        return jsonify({'error': 'Not a WordPress site'}), 400
    data = request.get_json() or {}
    targets = data.get('targets') or {'core': True, 'plugins': True, 'themes': True}
    exclude = data.get('exclude') or []
    return jsonify(WpUpdateService.start_update(wp_site, targets=targets, exclude=exclude)), 200


@wordpress_bp.route('/sites/<int:app_id>/updates/schedule', methods=['POST'])
@jwt_required()
@admin_required
def set_site_update_schedule(app_id):
    """Set/clear the per-site auto-update cron schedule + exclusion list."""
    app = _resolve_app(app_id)
    if not app:
        return jsonify({'error': 'Application not found'}), 404
    wp_site = WordPressSite.query.filter_by(application_id=app.id).first()
    if not wp_site:
        return jsonify({'error': 'Not a WordPress site'}), 400
    data = request.get_json() or {}
    wp_site.auto_update_schedule = (data.get('schedule') or '').strip() or None
    if data.get('exclude') is not None:
        wp_site.auto_update_exclude = json.dumps(data.get('exclude'))
    db.session.commit()
    return jsonify({
        'success': True,
        'schedule': wp_site.auto_update_schedule,
        'exclude': json.loads(wp_site.auto_update_exclude) if wp_site.auto_update_exclude else [],
    }), 200


# ---- Monthly client reports (#33 agency slice): persisted per-month rollups ----

@wordpress_bp.route('/sites/<int:app_id>/reports', methods=['GET'])
@jwt_required()
def get_site_reports(app_id):
    """Return all persisted monthly reports for a site (newest month first)."""
    from .wp_reports_service import WpReportsService
    app, err = _owner_or_admin_app(app_id)
    if err:
        return err
    wp_site = WordPressSite.query.filter_by(application_id=app.id).first()
    if not wp_site:
        return jsonify({'error': 'Not a WordPress site'}), 400
    return jsonify(WpReportsService.get_reports(wp_site)), 200


@wordpress_bp.route('/sites/<int:app_id>/reports/generate', methods=['POST'])
@jwt_required()
@admin_required
def generate_site_report(app_id):
    """Generate (or regenerate) the monthly report for a site. Body may carry
    {year, month}; defaults to the current UTC month."""
    from .wp_reports_service import WpReportsService
    app = _resolve_app(app_id)
    if not app:
        return jsonify({'error': 'Application not found'}), 404
    wp_site = WordPressSite.query.filter_by(application_id=app.id).first()
    if not wp_site:
        return jsonify({'error': 'Not a WordPress site'}), 400
    data = request.get_json() or {}
    result = WpReportsService.generate(wp_site, year=data.get('year'), month=data.get('month'))
    return jsonify(result), (200 if result.get('success') else 400)


@wordpress_bp.route('/sites/<int:app_id>/reports/<int:report_id>', methods=['DELETE'])
@jwt_required()
@admin_required
def delete_site_report(app_id, report_id):
    """Delete one persisted monthly report."""
    from .wp_reports_service import WpReportsService
    app = _resolve_app(app_id)
    if not app:
        return jsonify({'error': 'Application not found'}), 404
    wp_site = WordPressSite.query.filter_by(application_id=app.id).first()
    if not wp_site:
        return jsonify({'error': 'Not a WordPress site'}), 400
    result = WpReportsService.delete(wp_site, report_id)
    return jsonify(result), (200 if result.get('success') else 404)


@wordpress_bp.route('/sites/<int:app_id>/info', methods=['GET'])
@jwt_required()
def get_wordpress_info(app_id):
    """Get WordPress site info."""
    current_user_id = get_jwt_identity()
    user = User.query.get(current_user_id)
    app = _resolve_app(app_id)

    if not app:
        return jsonify({'error': 'Application not found'}), 404

    if not ResourceGrantService.can_access_app(user, app):
        return jsonify({'error': 'Access denied'}), 403

    if not _is_wp_app(app):
        return jsonify({'error': 'Application is not a WordPress site'}), 400

    info = WordPressService.get_wordpress_info(app.root_path)
    if not info:
        return jsonify({'error': 'Could not get WordPress info'}), 400

    return jsonify({'info': info}), 200


@wordpress_bp.route('/sites/<int:app_id>/update', methods=['POST'])
@jwt_required()
@admin_required
def update_wordpress(app_id):
    """Update WordPress core."""
    app = _resolve_app(app_id)

    if not app:
        return jsonify({'error': 'Application not found'}), 404

    if not _is_wp_app(app):
        return jsonify({'error': 'Application is not a WordPress site'}), 400

    result = WordPressService.update_wordpress(app.root_path)
    return jsonify(result), 200 if result['success'] else 400


# Plugin management
@wordpress_bp.route('/sites/<int:app_id>/plugins', methods=['GET'])
@jwt_required()
def get_plugins(app_id):
    """Get installed plugins."""
    current_user_id = get_jwt_identity()
    user = User.query.get(current_user_id)
    app = _resolve_app(app_id)

    if not app:
        return jsonify({'error': 'Application not found'}), 404

    if not ResourceGrantService.can_access_app(user, app):
        return jsonify({'error': 'Access denied'}), 403

    plugins = WordPressService.get_plugins(app.root_path)
    return jsonify({'plugins': plugins}), 200


@wordpress_bp.route('/sites/<int:app_id>/plugins', methods=['POST'])
@jwt_required()
@admin_required
def install_plugin(app_id):
    """Install a plugin."""
    app = _resolve_app(app_id)
    data = request.get_json()

    if not app:
        return jsonify({'error': 'Application not found'}), 404

    if not data or 'plugin' not in data:
        return jsonify({'error': 'plugin is required'}), 400

    result = WordPressService.install_plugin(
        app.root_path,
        data['plugin'],
        data.get('activate', True)
    )
    return jsonify(result), 200 if result['success'] else 400


@wordpress_bp.route('/sites/<int:app_id>/plugins/<plugin>', methods=['DELETE'])
@jwt_required()
@admin_required
def uninstall_plugin(app_id, plugin):
    """Uninstall a plugin."""
    app = _resolve_app(app_id)

    if not app:
        return jsonify({'error': 'Application not found'}), 404

    result = WordPressService.uninstall_plugin(app.root_path, plugin)
    return jsonify(result), 200 if result['success'] else 400


@wordpress_bp.route('/sites/<int:app_id>/plugins/<plugin>/activate', methods=['POST'])
@jwt_required()
@admin_required
def activate_plugin(app_id, plugin):
    """Activate a plugin."""
    app = _resolve_app(app_id)

    if not app:
        return jsonify({'error': 'Application not found'}), 404

    result = WordPressService.activate_plugin(app.root_path, plugin)
    return jsonify(result), 200 if result['success'] else 400


@wordpress_bp.route('/sites/<int:app_id>/plugins/<plugin>/deactivate', methods=['POST'])
@jwt_required()
@admin_required
def deactivate_plugin(app_id, plugin):
    """Deactivate a plugin."""
    app = _resolve_app(app_id)

    if not app:
        return jsonify({'error': 'Application not found'}), 404

    result = WordPressService.deactivate_plugin(app.root_path, plugin)
    return jsonify(result), 200 if result['success'] else 400


@wordpress_bp.route('/sites/<int:app_id>/plugins/update', methods=['POST'])
@jwt_required()
@admin_required
def update_plugins(app_id):
    """Update plugins."""
    app = _resolve_app(app_id)
    data = request.get_json()

    if not app:
        return jsonify({'error': 'Application not found'}), 404

    plugins = data.get('plugins') if data else None
    result = WordPressService.update_plugins(app.root_path, plugins)
    return jsonify(result), 200 if result['success'] else 400


# Theme management
@wordpress_bp.route('/sites/<int:app_id>/themes', methods=['GET'])
@jwt_required()
def get_themes(app_id):
    """Get installed themes."""
    current_user_id = get_jwt_identity()
    user = User.query.get(current_user_id)
    app = _resolve_app(app_id)

    if not app:
        return jsonify({'error': 'Application not found'}), 404

    if not ResourceGrantService.can_access_app(user, app):
        return jsonify({'error': 'Access denied'}), 403

    themes = WordPressService.get_themes(app.root_path)
    return jsonify({'themes': themes}), 200


@wordpress_bp.route('/sites/<int:app_id>/themes', methods=['POST'])
@jwt_required()
@admin_required
def install_theme(app_id):
    """Install a theme."""
    app = _resolve_app(app_id)
    data = request.get_json()

    if not app:
        return jsonify({'error': 'Application not found'}), 404

    if not data or 'theme' not in data:
        return jsonify({'error': 'theme is required'}), 400

    result = WordPressService.install_theme(
        app.root_path,
        data['theme'],
        data.get('activate', False)
    )
    return jsonify(result), 200 if result['success'] else 400


@wordpress_bp.route('/sites/<int:app_id>/themes/update', methods=['POST'])
@jwt_required()
@admin_required
def update_themes(app_id):
    """Update themes."""
    app = _resolve_app(app_id)
    data = request.get_json()

    if not app:
        return jsonify({'error': 'Application not found'}), 404

    themes = data.get('themes') if data else None
    result = WordPressService.update_themes(app.root_path, themes)
    return jsonify(result), 200 if result['success'] else 400


@wordpress_bp.route('/sites/<int:app_id>/themes/<theme>/activate', methods=['POST'])
@jwt_required()
@admin_required
def activate_theme(app_id, theme):
    """Activate a theme."""
    app = _resolve_app(app_id)

    if not app:
        return jsonify({'error': 'Application not found'}), 404

    result = WordPressService.activate_theme(app.root_path, theme)
    return jsonify(result), 200 if result['success'] else 400


# Backup management
@wordpress_bp.route('/sites/<int:app_id>/backup', methods=['POST'])
@jwt_required()
@admin_required
def create_backup(app_id):
    """Create a backup."""
    app = _resolve_app(app_id)
    data = request.get_json() or {}

    if not app:
        return jsonify({'error': 'Application not found'}), 404

    result = WordPressService.backup_wordpress(
        app.root_path,
        data.get('include_db', True)
    )
    return jsonify(result), 200 if result['success'] else 400


@wordpress_bp.route('/sites/<int:app_id>/backups', methods=['GET'])
@jwt_required()
def list_backups(app_id):
    """List backups for a site."""
    current_user_id = get_jwt_identity()
    user = User.query.get(current_user_id)
    app = _resolve_app(app_id)

    if not app:
        return jsonify({'error': 'Application not found'}), 404

    if not ResourceGrantService.can_access_app(user, app):
        return jsonify({'error': 'Access denied'}), 403

    import os
    site_name = os.path.basename(app.root_path)
    backups = WordPressService.list_backups(site_name)
    return jsonify({'backups': backups}), 200


@wordpress_bp.route('/sites/<int:app_id>/restore', methods=['POST'])
@jwt_required()
@admin_required
def restore_backup(app_id):
    """Restore a backup."""
    app = _resolve_app(app_id)
    data = request.get_json()

    if not app:
        return jsonify({'error': 'Application not found'}), 404

    if not data or 'backup_name' not in data:
        return jsonify({'error': 'backup_name is required'}), 400

    result = WordPressService.restore_backup(data['backup_name'], app.root_path)
    return jsonify(result), 200 if result['success'] else 400


@wordpress_bp.route('/backups/<backup_name>', methods=['DELETE'])
@jwt_required()
@admin_required
def delete_backup(backup_name):
    """Delete a backup."""
    result = WordPressService.delete_backup(backup_name)
    return jsonify(result), 200 if result['success'] else 400


# Security and maintenance
@wordpress_bp.route('/sites/<int:app_id>/harden', methods=['POST'])
@jwt_required()
@admin_required
def harden_wordpress(app_id):
    """Apply security hardening."""
    app = _resolve_app(app_id)

    if not app:
        return jsonify({'error': 'Application not found'}), 404

    result = WordPressService.harden_wordpress(app.root_path)
    return jsonify(result), 200 if result['success'] else 400


@wordpress_bp.route('/sites/<int:app_id>/search-replace', methods=['POST'])
@jwt_required()
@admin_required
def search_replace(app_id):
    """Search and replace in database."""
    app = _resolve_app(app_id)
    data = request.get_json()

    if not app:
        return jsonify({'error': 'Application not found'}), 404

    if not data or 'search' not in data or 'replace' not in data:
        return jsonify({'error': 'search and replace are required'}), 400

    result = WordPressService.search_replace(
        app.root_path,
        data['search'],
        data['replace'],
        data.get('dry_run', True)
    )
    return jsonify(result), 200 if result['success'] else 400


@wordpress_bp.route('/sites/<int:app_id>/url/preview', methods=['POST'])
@jwt_required()
@admin_required
def preview_site_url(app_id):
    """Dry-run a site URL change: per-pair replacement counts, no mutation."""
    app = _resolve_app(app_id)
    if not app:
        return jsonify({'error': 'Application not found'}), 404
    data = request.get_json() or {}
    new_url = data.get('new_url')
    if not new_url:
        return jsonify({'error': 'new_url is required'}), 400
    result = WordPressService.preview_url_change(app, new_url)
    return jsonify(result), 200 if result.get('success') else 400


@wordpress_bp.route('/sites/<int:app_id>/url', methods=['POST'])
@jwt_required()
@admin_required
def change_site_url(app_id):
    """Change a site's URL end to end: backup, serialization-safe DB rewrite,
    home/siteurl + cache flush, then re-point the Domain row + nginx vhost."""
    app = _resolve_app(app_id)
    if not app:
        return jsonify({'error': 'Application not found'}), 404
    data = request.get_json() or {}
    new_url = data.get('new_url')
    if not new_url:
        return jsonify({'error': 'new_url is required'}), 400
    keep_old = data.get('keep_old_redirect', True)
    result = WordPressService.change_site_url(app, new_url, keep_old_redirect=keep_old)
    return jsonify(result), 200 if result.get('success') else 400


@wordpress_bp.route('/sites/<int:app_id>/domain', methods=['POST'])
@jwt_required()
@admin_required
def attach_custom_domain(app_id):
    """Attach a user-owned custom domain: auto-create the DNS A record (or return
    it to add manually), optional Let's Encrypt cert, then migrate the site URL."""
    app = _resolve_app(app_id)
    if not app:
        return jsonify({'error': 'Application not found'}), 404
    data = request.get_json() or {}
    domain = data.get('domain')
    if not domain:
        return jsonify({'error': 'domain is required'}), 400
    result = WordPressService.attach_custom_domain(
        app, domain,
        migrate=data.get('migrate', True),
        issue_ssl=data.get('issue_ssl', False),
        email=data.get('email'),
    )
    return jsonify(result), 200 if result.get('success') else 400


@wordpress_bp.route('/sites/<int:app_id>/optimize', methods=['POST'])
@jwt_required()
@admin_required
def optimize_database(app_id):
    """Optimize WordPress database."""
    app = _resolve_app(app_id)

    if not app:
        return jsonify({'error': 'Application not found'}), 404

    result = WordPressService.optimize_database(app.root_path)
    return jsonify(result), 200 if result['success'] else 400


@wordpress_bp.route('/sites/<int:app_id>/page-cache', methods=['GET'])
@jwt_required()
def get_page_cache(app_id):
    """Report full-page cache plugin status for a site."""
    app, err = _guard_sealed_app(app_id)
    if err:
        return err
    return jsonify(WordPressService.get_page_cache_status(app.root_path)), 200


@wordpress_bp.route('/sites/<int:app_id>/page-cache', methods=['POST'])
@jwt_required()
@admin_required
def enable_page_cache(app_id):
    """Enable the full-page cache for a site."""
    app = _resolve_app(app_id)
    if not app:
        return jsonify({'error': 'Application not found'}), 404
    result = WordPressService.enable_page_cache(app.root_path)
    if result.get('success'):
        wp_site = WordPressSite.query.filter_by(application_id=app.id).first()
        if wp_site:
            cfg = json.loads(wp_site.sync_config) if wp_site.sync_config else {}
            cfg['page_cache_enabled'] = True
            wp_site.sync_config = json.dumps(cfg)
            db.session.commit()
    return jsonify(result), 200 if result.get('success') else 400


@wordpress_bp.route('/sites/<int:app_id>/page-cache', methods=['DELETE'])
@jwt_required()
@admin_required
def disable_page_cache(app_id):
    """Disable the full-page cache for a site."""
    app = _resolve_app(app_id)
    if not app:
        return jsonify({'error': 'Application not found'}), 404
    result = WordPressService.disable_page_cache(app.root_path)
    if result.get('success'):
        wp_site = WordPressSite.query.filter_by(application_id=app.id).first()
        if wp_site:
            cfg = json.loads(wp_site.sync_config) if wp_site.sync_config else {}
            cfg['page_cache_enabled'] = False
            wp_site.sync_config = json.dumps(cfg)
            db.session.commit()
    return jsonify(result), 200 if result.get('success') else 400


@wordpress_bp.route('/sites/<int:app_id>/object-cache', methods=['GET'])
@jwt_required()
def object_cache_status(app_id):
    """Report Redis object-cache state for a site."""
    app, err = _guard_sealed_app(app_id)
    if err:
        return err
    return jsonify(WordPressService.object_cache_status(app.root_path)), 200


@wordpress_bp.route('/sites/<int:app_id>/object-cache', methods=['POST'])
@jwt_required()
@admin_required
def enable_object_cache(app_id):
    """Enable Redis object cache (adds a redis container if needed, activates plugin)."""
    app = _resolve_app(app_id)
    if not app:
        return jsonify({'error': 'Application not found'}), 404
    result = WordPressService.enable_object_cache(app.root_path)
    return jsonify(result), 200 if result.get('success') else 400


@wordpress_bp.route('/sites/<int:app_id>/object-cache', methods=['DELETE'])
@jwt_required()
@admin_required
def disable_object_cache(app_id):
    """Disable Redis object cache (keeps the container + plugin)."""
    app = _resolve_app(app_id)
    if not app:
        return jsonify({'error': 'Application not found'}), 404
    result = WordPressService.disable_object_cache(app.root_path)
    return jsonify(result), 200 if result.get('success') else 400


@wordpress_bp.route('/sites/<int:app_id>/flush-cache', methods=['POST'])
@jwt_required()
@admin_required
def flush_cache(app_id):
    """Flush WordPress cache."""
    app = _resolve_app(app_id)

    if not app:
        return jsonify({'error': 'Application not found'}), 404

    result = WordPressService.flush_cache(app.root_path)
    return jsonify(result), 200 if result['success'] else 400


# User management
@wordpress_bp.route('/sites/<int:app_id>/users', methods=['POST'])
@jwt_required()
@admin_required
def create_wp_user(app_id):
    """Create a WordPress user."""
    app = _resolve_app(app_id)
    data = request.get_json()

    if not app:
        return jsonify({'error': 'Application not found'}), 404

    if not data or 'username' not in data or 'email' not in data:
        return jsonify({'error': 'username and email are required'}), 400

    result = WordPressService.create_user(
        app.root_path,
        data['username'],
        data['email'],
        data.get('role', 'subscriber'),
        data.get('password')
    )
    return jsonify(result), 201 if result['success'] else 400


@wordpress_bp.route('/sites/<int:site_id>/login', methods=['POST'])
@jwt_required()
@admin_required
def wp_auto_login(site_id):
    """Mint a one-time passwordless wp-admin login URL for the calling operator."""
    from app.services.audit_service import AuditService
    current_user_id = get_jwt_identity()
    operator = User.query.get(current_user_id)
    if not operator:
        return jsonify({'error': 'User not found'}), 404

    wp_site = WordPressSite.query.get(site_id)
    app = wp_site.application if wp_site else _resolve_app(site_id)
    if not app or not app.root_path:
        return jsonify({'error': 'Application not found'}), 404
    if not _is_wp_app(app):
        return jsonify({'error': 'Application is not a WordPress site'}), 400

    # Resolve a managed admin tied to the operator's panel email. Prefer the
    # site's recorded admin_user; otherwise derive a deterministic username
    # from the operator and create it via the WP-CLI bridge if absent.
    wp_user = (wp_site.admin_user if wp_site and wp_site.admin_user else None)
    if not wp_user:
        wp_user = (operator.username or operator.email.split('@')[0])
        exists = WordPressService.wp_cli(app.root_path, ['user', 'get', wp_user, '--field=ID'])
        if not exists.get('success'):
            created = WordPressService.create_user(
                app.root_path, wp_user, operator.email, role='administrator'
            )
            if not created.get('success'):
                return jsonify({'error': created.get('error') or 'Failed to provision admin'}), 400
        if wp_site:
            wp_site.admin_user = wp_user
            if not wp_site.admin_email:
                wp_site.admin_email = operator.email
            db.session.commit()

    result = WordPressService.create_login_url(app.root_path, wp_user)
    if not result.get('success'):
        return jsonify({'error': result.get('error') or 'Failed to create login URL'}), 400

    AuditService.log(
        action='wordpress.admin_login',
        user_id=current_user_id,
        target_type='app',
        target_id=app.id,
        details={'wp_user': wp_user, 'site_id': site_id, 'app_name': app.name},
    )

    return jsonify({'success': True, 'url': result['url']}), 200


@wordpress_bp.route('/sites/<int:app_id>/users/<user>/reset-password', methods=['POST'])
@jwt_required()
@admin_required
def reset_wp_password(app_id, user):
    """Reset a WordPress user's password."""
    app = _resolve_app(app_id)
    data = request.get_json() or {}

    if not app:
        return jsonify({'error': 'Application not found'}), 404

    result = WordPressService.reset_password(app.root_path, user, data.get('password'))
    return jsonify(result), 200 if result['success'] else 400


# WP-CLI status
@wordpress_bp.route('/wp-cli/status', methods=['GET'])
@jwt_required()
@admin_required
def wp_cli_status():
    """Check WP-CLI installation status."""
    installed = WordPressService.is_wp_cli_installed()
    return jsonify({
        'installed': installed,
        'path': WordPressService.WP_CLI_PATH if installed else None
    }), 200


@wordpress_bp.route('/wp-cli/install', methods=['POST'])
@jwt_required()
@admin_required
def install_wp_cli():
    """Install WP-CLI."""
    result = WordPressService.install_wp_cli()
    return jsonify(result), 200 if result['success'] else 400


# ==================== GLOBAL PLUGIN LIBRARY ====================
# A global layer over the per-site plugin management above: operators register
# their own plugins (GitHub repo / local path) once, then install or update them
# across any number of managed WordPress sites from one place.

def _resolve_wp_site(site_or_app_id):
    """Resolve an ID to a WordPressSite (accepts a WordPressSite.id or Application.id)."""
    site = WordPressSite.query.get(site_or_app_id)
    if site:
        return site
    return WordPressSite.query.filter_by(application_id=site_or_app_id).first()


@wordpress_bp.route('/plugins/library', methods=['GET'])
@jwt_required()
def list_library_plugins():
    """List all plugins in the global library."""
    from .wordpress_plugin_library_service import WordPressPluginLibraryService
    return jsonify({'plugins': WordPressPluginLibraryService.list_plugins()}), 200


@wordpress_bp.route('/plugins/library', methods=['POST'])
@jwt_required()
@admin_required
def add_library_plugin():
    """Register a new plugin in the library and sync it into the cache."""
    from .wordpress_plugin_library_service import (
        WordPressPluginLibraryService, PluginLibraryError)
    data = request.get_json() or {}
    try:
        result = WordPressPluginLibraryService.add_plugin(data, user_id=get_jwt_identity())
        return jsonify(result), 201
    except PluginLibraryError as e:
        return jsonify({'error': str(e)}), 400


@wordpress_bp.route('/plugins/library/<int:plugin_id>', methods=['GET'])
@jwt_required()
def get_library_plugin(plugin_id):
    """Library plugin detail, including per-site installations."""
    from .wordpress_plugin_library_service import WordPressPluginLibraryService
    data = WordPressPluginLibraryService.get_plugin(plugin_id)
    if not data:
        return jsonify({'error': 'Plugin not found'}), 404
    return jsonify(data), 200


@wordpress_bp.route('/plugins/library/<int:plugin_id>', methods=['PUT'])
@jwt_required()
@admin_required
def update_library_plugin(plugin_id):
    """Update a library plugin's source / branch / active state."""
    from .wordpress_plugin_library_service import (
        WordPressPluginLibraryService, PluginLibraryError)
    data = request.get_json() or {}
    try:
        result = WordPressPluginLibraryService.update_plugin(
            plugin_id, data, user_id=get_jwt_identity())
        return jsonify(result), 200
    except PluginLibraryError as e:
        return jsonify({'error': str(e)}), 400


@wordpress_bp.route('/plugins/library/<int:plugin_id>', methods=['DELETE'])
@jwt_required()
@admin_required
def delete_library_plugin(plugin_id):
    """Remove a plugin from the library (and delete its cache directory)."""
    from .wordpress_plugin_library_service import (
        WordPressPluginLibraryService, PluginLibraryError)
    try:
        return jsonify(WordPressPluginLibraryService.delete_plugin(plugin_id)), 200
    except PluginLibraryError as e:
        return jsonify({'error': str(e)}), 400


@wordpress_bp.route('/plugins/library/<int:plugin_id>/sync', methods=['POST'])
@jwt_required()
@admin_required
def sync_library_plugin(plugin_id):
    """Pull the latest source into the cache and re-parse the plugin header."""
    from .wordpress_plugin_library_service import WordPressPluginLibraryService
    from app.models import WordPressCustomPlugin
    plugin = WordPressCustomPlugin.query.get(plugin_id)
    if not plugin:
        return jsonify({'error': 'Plugin not found'}), 404
    result = WordPressPluginLibraryService.sync_plugin(plugin, user_id=get_jwt_identity())
    return jsonify(result), 200 if result.get('success') else 400


@wordpress_bp.route('/plugins/library/<int:plugin_id>/install', methods=['POST'])
@jwt_required()
@admin_required
def install_library_plugin(plugin_id):
    """Install (or update) a library plugin on a specific site."""
    from .wordpress_plugin_library_service import (
        WordPressPluginLibraryService, PluginLibraryError)
    from app.models import WordPressCustomPlugin
    data = request.get_json() or {}
    site_id = data.get('site_id')
    if not site_id:
        return jsonify({'error': 'site_id is required'}), 400

    plugin = WordPressCustomPlugin.query.get(plugin_id)
    if not plugin:
        return jsonify({'error': 'Plugin not found'}), 404
    site = _resolve_wp_site(site_id)
    if not site:
        return jsonify({'error': 'Site not found'}), 404

    try:
        result = WordPressPluginLibraryService.install_on_site(
            plugin, site, activate=data.get('activate', True))
        return jsonify(result), 200
    except PluginLibraryError as e:
        return jsonify({'error': str(e)}), 400


@wordpress_bp.route('/plugins/library/<int:plugin_id>/bulk-update', methods=['POST'])
@jwt_required()
@admin_required
def bulk_update_library_plugin(plugin_id):
    """Push the latest cached version to every site that has the plugin."""
    from .wordpress_plugin_library_service import WordPressPluginLibraryService
    from app.models import WordPressCustomPlugin
    plugin = WordPressCustomPlugin.query.get(plugin_id)
    if not plugin:
        return jsonify({'error': 'Plugin not found'}), 404
    return jsonify(WordPressPluginLibraryService.bulk_update(plugin)), 200


@wordpress_bp.route('/plugins/library/<int:plugin_id>/uninstall', methods=['POST'])
@jwt_required()
@admin_required
def uninstall_library_plugin(plugin_id):
    """Remove a library plugin from a specific site."""
    from .wordpress_plugin_library_service import (
        WordPressPluginLibraryService, PluginLibraryError)
    from app.models import WordPressCustomPlugin
    data = request.get_json() or {}
    site_id = data.get('site_id')
    if not site_id:
        return jsonify({'error': 'site_id is required'}), 400
    plugin = WordPressCustomPlugin.query.get(plugin_id)
    if not plugin:
        return jsonify({'error': 'Plugin not found'}), 404
    site = _resolve_wp_site(site_id)
    if not site:
        return jsonify({'error': 'Site not found'}), 404
    try:
        return jsonify(WordPressPluginLibraryService.uninstall_from_site(plugin, site)), 200
    except PluginLibraryError as e:
        return jsonify({'error': str(e)}), 400


@wordpress_bp.route('/sites/<int:app_id>/plugins/library-scan', methods=['POST'])
@jwt_required()
@admin_required
def scan_site_library_plugins(app_id):
    """Scan a site and tag which installed plugins are library-managed."""
    from .wordpress_plugin_library_service import WordPressPluginLibraryService
    site = _resolve_wp_site(app_id)
    if not site:
        return jsonify({'error': 'Site not found'}), 404
    return jsonify(WordPressPluginLibraryService.scan_site(site)), 200


@wordpress_bp.route('/sites/<int:app_id>/plugins/managed', methods=['GET'])
@jwt_required()
def get_site_managed_plugins(app_id):
    """Which of a site's installed plugins are library-managed (+ update state)."""
    from .wordpress_plugin_library_service import WordPressPluginLibraryService
    _, err = _guard_sealed_app(app_id)
    if err:
        return err
    site = _resolve_wp_site(app_id)
    if not site:
        return jsonify({'error': 'Site not found'}), 404
    return jsonify({'managed': WordPressPluginLibraryService.managed_for_site(site)}), 200
