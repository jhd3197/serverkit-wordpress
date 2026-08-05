// Import a live WordPress site over SSH (Panel Improvements #3).
//
// Three-step surface rendered inside the WordPress tab group:
//   1. Connection — host/port/user + password-or-key + remote WP path.
//   2. Probe — the backend captures the SSH host-key fingerprint and reads
//      site facts (wp-config, version, size). The operator explicitly trusts
//      the fingerprint before anything else touches the box.
//   3. Import — enqueues the pull-import job and polls its step log.
//
// After sync this file lives at frontend/src/plugins/serverkit-wordpress/, so
// shared pieces come from the serverkit-sdk surface like other extensions.
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, Spinner, useToast, Button, Input, Label } from 'serverkit-sdk';

const POLL_MS = 2500;

export default function WordPressSshImport() {
    const toast = useToast();
    const [conn, setConn] = useState({
        host: '', port: '22', username: 'root',
        authMethod: 'key', password: '', privateKey: '',
        wpPath: '/var/www/html',
    });
    const [probing, setProbing] = useState(false);
    const [probe, setProbe] = useState(null);        // probe result (incl. fingerprint)
    const [trusted, setTrusted] = useState(false);   // operator confirmed the host key
    const [target, setTarget] = useState({ siteName: '', adminEmail: '', oldUrl: '' });
    const [starting, setStarting] = useState(false);
    const [job, setJob] = useState(null);            // { id, status, steps, result, error }
    const pollRef = useRef(null);

    useEffect(() => () => clearInterval(pollRef.current), []);

    const authPayload = () => (conn.authMethod === 'password'
        ? { password: conn.password }
        : { private_key: conn.privateKey });

    const handleProbe = async () => {
        setProbing(true);
        setProbe(null);
        setTrusted(false);
        try {
            const result = await api.request('/wordpress/ssh-import/probe', {
                method: 'POST',
                body: {
                    host: conn.host.trim(),
                    port: parseInt(conn.port, 10) || 22,
                    username: conn.username.trim(),
                    auth: authPayload(),
                    wp_path: conn.wpPath.trim(),
                },
            });
            setProbe(result);
            setTarget(t => ({ ...t, oldUrl: t.oldUrl || result.site_url || '' }));
        } catch (error) {
            toast.error(error.message || 'Probe failed');
        } finally {
            setProbing(false);
        }
    };

    const pollJob = async (jobId) => {
        try {
            const status = await api.request(`/wordpress/ssh-import/${jobId}`);
            setJob(status);
            if (['completed', 'failed', 'dead'].includes(status.status)) {
                clearInterval(pollRef.current);
                pollRef.current = null;
                if (status.status === 'completed') {
                    toast.success('WordPress site imported successfully');
                } else {
                    toast.error(status.error || 'Import failed — see the step log');
                }
            }
        } catch {
            /* transient poll error — keep polling */
        }
    };

    const handleStart = async () => {
        if (!trusted) { toast.error('Confirm the host-key fingerprint first'); return; }
        if (!target.siteName.trim()) { toast.error('New site name is required'); return; }
        setStarting(true);
        try {
            const res = await api.request('/wordpress/ssh-import', {
                method: 'POST',
                body: {
                    connection: {
                        host: conn.host.trim(),
                        port: parseInt(conn.port, 10) || 22,
                        username: conn.username.trim(),
                        auth: authPayload(),
                    },
                    fingerprint: probe.host_key_fingerprint,
                    target: {
                        site_name: target.siteName.trim(),
                        admin_email: target.adminEmail.trim(),
                    },
                    options: {
                        wp_path: conn.wpPath.trim(),
                        old_url: target.oldUrl.trim() || undefined,
                    },
                },
            });
            setJob({ id: res.job_id, status: 'pending', steps: [] });
            pollRef.current = setInterval(() => pollJob(res.job_id), POLL_MS);
            pollJob(res.job_id);
        } catch (error) {
            toast.error(error.message || 'Failed to start the import');
        } finally {
            setStarting(false);
        }
    };

    const running = job && !['completed', 'failed', 'dead'].includes(job.status);
    const canProbe = conn.host.trim() && conn.username.trim() && conn.wpPath.trim()
        && (conn.authMethod === 'password' ? conn.password : conn.privateKey);
    const facts = probe && [
        ['WordPress version', probe.wp_version || 'unknown'],
        ['Site URL', probe.site_url || 'unknown'],
        ['Database', probe.db_name],
        ['Table prefix', probe.table_prefix],
        ['Docroot size', probe.docroot_size_kb != null
            ? `${(probe.docroot_size_kb / 1024).toFixed(1)} MB` : 'unknown'],
        ['WP-CLI on source', probe.has_wp_cli ? 'yes' : 'no (fallbacks used)'],
    ];

    return (
        <div className="sk-tabgroup__inner wp-ssh-import">
            <div className="page-section">
                <h2 className="text-lg font-semibold">Import a live site over SSH</h2>
                <p className="text-sm text-muted-foreground">
                    Point at any WordPress install you can reach over SSH. The panel pulls the
                    files and database through the tunnel and rebuilds it as a managed site —
                    nothing is installed on the source server.
                </p>
            </div>

            {/* Step 1 — connection */}
            <div className="card p-4 mb-4">
                <h3 className="font-medium mb-3">1. Source server</h3>
                <div className="grid grid-cols-2 gap-4">
                    <div className="form-group">
                        <Label>Host <span className="required">*</span></Label>
                        <Input value={conn.host} disabled={running}
                               onChange={e => setConn({ ...conn, host: e.target.value })}
                               placeholder="203.0.113.10 or wp.example.com" />
                    </div>
                    <div className="form-group">
                        <Label>Port</Label>
                        <Input value={conn.port} disabled={running}
                               onChange={e => setConn({ ...conn, port: e.target.value })}
                               placeholder="22" />
                    </div>
                    <div className="form-group">
                        <Label>Username <span className="required">*</span></Label>
                        <Input value={conn.username} disabled={running}
                               onChange={e => setConn({ ...conn, username: e.target.value })}
                               placeholder="root" />
                    </div>
                    <div className="form-group">
                        <Label>WordPress path <span className="required">*</span></Label>
                        <Input value={conn.wpPath} disabled={running}
                               onChange={e => setConn({ ...conn, wpPath: e.target.value })}
                               placeholder="/var/www/html" />
                        <span className="form-hint">Absolute path of the directory containing wp-config.php.</span>
                    </div>
                </div>
                <div className="form-group">
                    <Label>Authentication</Label>
                    <div className="flex gap-4 mb-2">
                        <label className="flex items-center gap-2 text-sm">
                            <input type="radio" checked={conn.authMethod === 'key'} disabled={running}
                                   onChange={() => setConn({ ...conn, authMethod: 'key' })} />
                            Private key
                        </label>
                        <label className="flex items-center gap-2 text-sm">
                            <input type="radio" checked={conn.authMethod === 'password'} disabled={running}
                                   onChange={() => setConn({ ...conn, authMethod: 'password' })} />
                            Password
                        </label>
                    </div>
                    {conn.authMethod === 'key' ? (
                        <>
                            <textarea
                                className="w-full font-mono text-xs"
                                rows={5}
                                value={conn.privateKey}
                                disabled={running}
                                onChange={e => setConn({ ...conn, privateKey: e.target.value })}
                                placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n…'}
                            />
                            <span className="form-hint">Used for this import only — never stored.</span>
                        </>
                    ) : (
                        <>
                            <Input type="password" value={conn.password} disabled={running}
                                   onChange={e => setConn({ ...conn, password: e.target.value })}
                                   placeholder="SSH password" />
                            <span className="form-hint">Used for this import only — never stored. Password auth requires the sshpass package on the panel host.</span>
                        </>
                    )}
                </div>
                <Button onClick={handleProbe} disabled={!canProbe || probing || running}>
                    {probing ? <><Spinner size="sm" /> Probing…</> : 'Probe server'}
                </Button>
            </div>

            {/* Step 2 — facts + host-key trust */}
            {probe && (
                <div className="card p-4 mb-4">
                    <h3 className="font-medium mb-3">2. Confirm the host</h3>
                    <div className="form-group">
                        <Label>SSH host-key fingerprint ({probe.host_key_type})</Label>
                        <code className="block font-mono text-xs break-all">{probe.host_key_fingerprint}</code>
                        <span className="form-hint">
                            Compare against the server you expect (ssh-keygen -lf on the source).
                            Every step of the import is pinned to this exact key.
                        </span>
                    </div>
                    <table className="text-sm">
                        <tbody>
                            {facts.map(([k, v]) => (
                                <tr key={k}>
                                    <td className="pr-4 text-muted-foreground">{k}</td>
                                    <td className="font-mono">{String(v)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <label className="flex items-center gap-2 text-sm mt-3">
                        <input type="checkbox" checked={trusted} disabled={running}
                               onChange={e => setTrusted(e.target.checked)} />
                        I recognize this fingerprint — trust this host for the import
                    </label>
                </div>
            )}

            {/* Step 3 — target + run */}
            {probe && (
                <div className="card p-4 mb-4">
                    <h3 className="font-medium mb-3">3. New managed site</h3>
                    <div className="grid grid-cols-2 gap-4">
                        <div className="form-group">
                            <Label>Site name <span className="required">*</span></Label>
                            <Input value={target.siteName} disabled={running}
                                   onChange={e => setTarget({ ...target, siteName: e.target.value })}
                                   placeholder="my-migrated-site" />
                            <span className="form-hint">Letters, numbers, and hyphens only.</span>
                        </div>
                        <div className="form-group">
                            <Label>Admin email</Label>
                            <Input type="email" value={target.adminEmail} disabled={running}
                                   onChange={e => setTarget({ ...target, adminEmail: e.target.value })}
                                   placeholder="admin@example.com" />
                        </div>
                        <div className="form-group">
                            <Label>Original site URL</Label>
                            <Input value={target.oldUrl} disabled={running}
                                   onChange={e => setTarget({ ...target, oldUrl: e.target.value })}
                                   placeholder="https://old-site.com" />
                            <span className="form-hint">Rewritten to the new local address after import (detected automatically when possible).</span>
                        </div>
                    </div>
                    <Button onClick={handleStart} disabled={!trusted || starting || running}>
                        {starting ? <><Spinner size="sm" /> Starting…</> : 'Pull and import'}
                    </Button>
                </div>
            )}

            {/* Job progress */}
            {job && (
                <div className="card p-4 mb-4">
                    <h3 className="font-medium mb-3">
                        Import job #{job.id} — {job.status}
                        {running && <Spinner size="sm" />}
                    </h3>
                    <ul className="text-sm font-mono space-y-1">
                        {(job.steps || []).map((s, i) => (
                            <li key={i}>
                                <span className="text-muted-foreground">[{s.step}]</span> {s.message}
                            </li>
                        ))}
                    </ul>
                    {job.status === 'failed' && job.error && (
                        <p className="text-sm text-destructive mt-2">{job.error}</p>
                    )}
                    {job.status === 'completed' && (
                        <p className="text-sm mt-2">
                            Done. <Link to="/wordpress" className="underline">Open the WordPress sites list</Link>
                            {job.result?.new_url && <> — new address: <code>{job.result.new_url}</code></>}
                        </p>
                    )}
                </div>
            )}
        </div>
    );
}
