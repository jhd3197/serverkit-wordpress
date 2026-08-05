"""WordPress-over-SSH pull importer API (Panel Improvements #3).

Admin-only surface:

* ``POST /api/v1/wordpress/ssh-import/probe`` — connect to the source box,
  return the host-key fingerprint + site facts for operator confirmation.
* ``POST /api/v1/wordpress/ssh-import`` — enqueue the import job (requires the
  probed fingerprint back: that confirmation IS the host-key trust decision).
* ``GET  /api/v1/wordpress/ssh-import/<job_id>`` — poll job status + step log.

Mounted via ``plugin.json`` ``extra_blueprints`` at ``/api/v1/wordpress``.
"""
from flask import Blueprint, request, jsonify

from app.middleware.rbac import admin_required, get_current_user

from .wp_ssh_import_service import (
    JOB_KIND, WpSshImportError, WpSshImportService,
)

wp_ssh_import_bp = Blueprint('wp_ssh_import', __name__)

# Belt-and-braces: the manifest declares the job handler too, but registering on
# blueprint import guarantees the kind exists as soon as the API is mounted.
WpSshImportService.register_jobs()


@wp_ssh_import_bp.route('/ssh-import/probe', methods=['POST'])
@admin_required
def ssh_import_probe():
    """Probe a remote WordPress over SSH: host-key fingerprint + site facts."""
    data = request.get_json() or {}
    try:
        result = WpSshImportService.probe(
            host=data.get('host'),
            port=data.get('port') or 22,
            username=data.get('username'),
            auth=data.get('auth') or {},
            wp_path=data.get('wp_path'),
        )
    except WpSshImportError as e:
        return jsonify({'error': str(e)}), 400
    return jsonify(result)


@wp_ssh_import_bp.route('/ssh-import', methods=['POST'])
@admin_required
def ssh_import_start():
    """Enqueue the pull-import job. Body: {connection, fingerprint, target, options}."""
    data = request.get_json() or {}
    user = get_current_user()
    try:
        job = WpSshImportService.enqueue_import(
            connection=data.get('connection') or {},
            fingerprint=(data.get('fingerprint') or '').strip(),
            target=data.get('target') or {},
            options=data.get('options') or {},
            user_id=user.id,
        )
    except WpSshImportError as e:
        return jsonify({'error': str(e)}), 400
    return jsonify({'success': True, 'job_id': job.id}), 202


@wp_ssh_import_bp.route('/ssh-import/<job_id>', methods=['GET'])
@admin_required
def ssh_import_status(job_id):
    """Job status + step log for a running/finished SSH import."""
    from app.jobs.models import Job
    job = Job.query.get(job_id)
    if not job or job.kind != JOB_KIND:
        return jsonify({'error': 'Import job not found'}), 404
    out = job.to_dict()  # payload excluded by default — never echo credentials
    result = job.get_result() or {}
    out['steps'] = result.get('steps') or []
    return jsonify(out)
