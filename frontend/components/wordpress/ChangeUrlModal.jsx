import { useState, useEffect } from 'react';
import { Globe, AlertTriangle, ArrowRight } from 'lucide-react';
import { Modal } from 'serverkit-sdk';
import { Button } from 'serverkit-sdk';
import { Input } from 'serverkit-sdk';
import { Label } from 'serverkit-sdk';
import { Switch } from 'serverkit-sdk';
import wordpressApi from '../../services/wordpress';
import { useToast } from 'serverkit-sdk';
import { useTranslation } from 'serverkit-sdk';

// Change a WordPress site's URL safely: a debounced dry-run preview of the DB
// rewrite, then a backed-up, serialization-safe apply (WP-CLI search-replace)
// on confirm. The backend re-points the Domain row + nginx vhost afterwards.
export default function ChangeUrlModal({ site, onClose, onChanged }) {
    const { t } = useTranslation();
    const toast = useToast();
    const currentUrl = site.url || '';
    const [newUrl, setNewUrl] = useState(currentUrl);
    const [keepOld, setKeepOld] = useState(true);
    const [preview, setPreview] = useState(null);
    const [previewing, setPreviewing] = useState(false);
    const [applying, setApplying] = useState(false);

    const target = newUrl.trim();
    const dirty = target && target !== currentUrl;

    // Debounced dry-run preview whenever the target URL settles.
    useEffect(() => {
        if (!dirty) { setPreview(null); return undefined; }
        let cancelled = false;
        setPreviewing(true);
        const timer = setTimeout(async () => {
            try {
                const res = await wordpressApi.previewUrlChange(site.id, target);
                if (!cancelled) setPreview(res);
            } catch (err) {
                if (!cancelled) setPreview({ success: false, error: err.message || t('wp.changeUrlModal.previewFailed', 'Preview failed') });
            } finally {
                if (!cancelled) setPreviewing(false);
            }
        }, 500);
        return () => { cancelled = true; clearTimeout(timer); };
    }, [target, dirty, site.id]);

    async function handleApply(e) {
        e?.preventDefault();
        if (!dirty || applying) return;
        setApplying(true);
        toast.info(t('wp.changeUrlModal.changingSiteUrlBackingUpAnd', 'Changing site URL: backing up and rewriting the database…'), { duration: 5000 });
        try {
            const res = await wordpressApi.changeUrl(site.id, target, keepOld);
            if (res.success) {
                toast.success(t('wp.changeUrlModal.siteUrlChangedToReplacement', 'Site URL changed to {{newurl}} ({{replacements}} replacement{{value}})', { newurl: res.new_url, replacements: res.replacements, value: res.replacements === 1 ? '' : 's' }));
                if (res.warning) toast.warning(res.warning, { duration: 7000 });
                onChanged?.();
                onClose();
            } else {
                toast.error(res.error || t('wp.changeUrlModal.failedToChangeUrl', 'Failed to change URL'));
            }
        } catch (err) {
            toast.error(err.message || t('wp.changeUrlModal.failedToChangeUrl2', 'Failed to change URL'));
        } finally {
            setApplying(false);
        }
    }

    return (
        <Modal open onClose={() => !applying && onClose()} title={<><Globe size={18} /> {t('wp.changeUrlModal.changeSiteUrl', 'Change site URL')}</>} size="lg">
            <form onSubmit={handleApply}>
                <div className="wp-url-swap">
                    <div className="wp-url-swap__warning">
                        <AlertTriangle size={18} aria-hidden="true" />
                        <span>
                            {t('wp.changeUrlModal.thisRewritesEveryReferenceToThe', 'This rewrites every reference to the site URL across the database (posts, options, serialized data) with a serialization-safe search-replace. A database backup is taken first and restored automatically if anything fails.')}
                        </span>
                    </div>

                    <div className="wp-url-swap__fromto">
                        <code>{currentUrl || '—'}</code>
                        <ArrowRight size={15} aria-hidden="true" />
                        <code className={dirty ? 'is-new' : ''}>{target || '—'}</code>
                    </div>

                    <div className="form-group">
                        <Label htmlFor="wp-new-url">{t('wp.changeUrlModal.newUrl', 'New URL')}</Label>
                        <Input
                            id="wp-new-url"
                            type="text"
                            value={newUrl}
                            onChange={(e) => setNewUrl(e.target.value)}
                            placeholder="https://example.com"
                            disabled={applying}
                            autoFocus
                        />
                        <span className="form-hint">
                            {t('wp.changeUrlModal.includeHttpOrHttpsPointThis', 'Include http:// or https://. Point this hostname\'s DNS at the server first.')}
                        </span>
                    </div>

                    <label className="wp-url-swap__keep">
                        <Switch checked={keepOld} onCheckedChange={setKeepOld} disabled={applying} />
                        <span>
                            {t('wp.changeUrlModal.keepTheOldAddressWorking', 'Keep the old address working')}
                            <small>{t('wp.changeUrlModal.thePreviousHostKeepsResolvingWordpress', 'The previous host keeps resolving; WordPress 301-redirects it to the new URL.')}</small>
                        </span>
                    </label>

                    {dirty && (
                        <div className="wp-url-swap__preview">
                            {previewing && <span className="form-hint">{t('wp.changeUrlModal.previewingChanges', 'Previewing changes…')}</span>}
                            {!previewing && preview?.success && (
                                <>
                                    <div className="wp-url-swap__preview-total">
                                        {preview.total} {t('wp.changeUrlModal.databaseReplacement', 'database replacement')}{preview.total === 1 ? '' : 's'} {t('wp.changeUrlModal.willBeMade', 'will be made')}
                                    </div>
                                    <ul className="wp-url-swap__preview-pairs">
                                        {preview.pairs.map((p, i) => (
                                            <li key={i}>
                                                <code>{p.search}</code>
                                                <ArrowRight size={12} aria-hidden="true" />
                                                <code>{p.replace}</code>
                                                <span className="wp-url-swap__count">{p.replacements}</span>
                                            </li>
                                        ))}
                                    </ul>
                                </>
                            )}
                            {!previewing && preview && !preview.success && (
                                <div className="wp-url-swap__preview-error">{preview.error}</div>
                            )}
                        </div>
                    )}
                </div>

                <div className="modal-actions">
                    <Button type="button" variant="outline" onClick={onClose} disabled={applying}>{t('wp.changeUrlModal.cancel', 'Cancel')}</Button>
                    <Button type="submit" disabled={!dirty || applying}>
                        {applying ? t('wp.changeUrlModal.changing', 'Changing…') : t('wp.changeUrlModal.changeUrl', 'Change URL')}
                    </Button>
                </div>
            </form>
        </Modal>
    );
}
