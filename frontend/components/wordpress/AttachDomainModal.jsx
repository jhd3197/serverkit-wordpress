import { useState } from 'react';
import { Globe, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Modal } from 'serverkit-sdk';
import { Button } from 'serverkit-sdk';
import { DomainField } from 'serverkit-sdk';
import { Label } from 'serverkit-sdk';
import { Switch } from 'serverkit-sdk';
import wordpressApi from '../../services/wordpress';
import { useToast } from 'serverkit-sdk';
import { useTranslation } from 'serverkit-sdk';

// Attach a user-owned custom domain to a site: auto-create the DNS A record (or
// show the exact record to add manually), optional HTTPS, then migrate the site
// URL to it via the URL-swap tool. Shows the result inline so a manual DNS
// record can be read/copied.
export default function AttachDomainModal({ site, onClose, onChanged }) {
    const { t } = useTranslation();
    const toast = useToast();
    // The normalized hostname, '' until the DomainField reads it as valid.
    const [domain, setDomain] = useState('');
    const [issueSsl, setIssueSsl] = useState(false);
    const [attaching, setAttaching] = useState(false);
    const [result, setResult] = useState(null);

    const valid = !!domain;

    async function handleAttach(e) {
        e?.preventDefault();
        if (!valid || attaching) return;
        setAttaching(true);
        toast.info(t('wp.attachDomainModal.attachingDomainCreatingDnsAndMoving', 'Attaching domain: creating DNS and moving the site…'), { duration: 5000 });
        try {
            const res = await wordpressApi.attachDomain(site.id, { domain, issueSsl });
            if (res.success) {
                setResult(res);
                if (res.dns?.created) toast.success(t('wp.attachDomainModal.dnsARecordCreatedVia', 'DNS A record created via {{provider}}', { provider: res.dns.provider }));
                else toast.warning(t('wp.attachDomainModal.domainAttachedAddTheDnsRecord', 'Domain attached. Add the DNS record shown to finish.'), { duration: 7000 });
                onChanged?.();
            } else {
                toast.error(res.error || t('wp.attachDomainModal.failedToAttachDomain', 'Failed to attach domain'));
            }
        } catch (err) {
            toast.error(err.message || t('wp.attachDomainModal.failedToAttachDomain2', 'Failed to attach domain'));
        } finally {
            setAttaching(false);
        }
    }

    const rec = result?.dns?.record;

    return (
        <Modal open onClose={() => !attaching && onClose()} title={<><Globe size={18} /> {t('wp.attachDomainModal.addCustomDomain', 'Add custom domain')}</>}>
            {!result ? (
                <form onSubmit={handleAttach}>
                    <div className="wp-url-swap">
                        <div className="wp-url-swap__warning">
                            <AlertTriangle size={18} aria-hidden="true" />
                            <span>
                                {t('wp.attachDomainModal.pointsADomainYouOwnAt', "Points a domain you own at this site. If a connected DNS provider manages it, the A record is created automatically. Otherwise you'll get the exact record to add. The site URL is then migrated to the domain (serialization-safe).")}
                            </span>
                        </div>

                        <div className="form-group">
                            <Label htmlFor="wp-domain">{t('wp.attachDomainModal.domain', 'Domain')}</Label>
                            <DomainField
                                id="wp-domain"
                                modes={['custom']}
                                onChange={setDomain}
                                disabled={attaching}
                                autoFocus
                            />
                            <span className="form-hint">{t('wp.attachDomainModal.aDomainOrSubdomainYouControl', 'A domain or subdomain you control, without the http:// prefix.')}</span>
                        </div>

                        <label className="wp-url-swap__keep">
                            <Switch checked={issueSsl} onCheckedChange={setIssueSsl} disabled={attaching} />
                            <span>
                                {t('wp.attachDomainModal.setUpHttpsNow', 'Set up HTTPS now')}
                                <small>{t('wp.attachDomainModal.requestsALetSEncryptCertificate', 'Requests a Let\'s Encrypt certificate. Needs DNS to already resolve to this server.')}</small>
                            </span>
                        </label>
                    </div>

                    <div className="modal-actions">
                        <Button type="button" variant="outline" onClick={onClose} disabled={attaching}>{t('wp.attachDomainModal.cancel', 'Cancel')}</Button>
                        <Button type="submit" disabled={!valid || attaching}>
                            {attaching ? t('wp.attachDomainModal.attaching', 'Attaching…') : t('wp.attachDomainModal.attachDomain', 'Attach domain')}
                        </Button>
                    </div>
                </form>
            ) : (
                <>
                    <div className="wp-url-swap">
                        <div className="wp-url-swap__result">
                            <CheckCircle2 size={18} aria-hidden="true" />
                            <span>{t('wp.attachDomainModal.siteIsNowAt', 'Site is now at')} <code>{result.url}</code></span>
                        </div>

                        {result.dns?.created ? (
                            <div className="form-hint">
                                {t('wp.attachDomainModal.dnsARecordCreatedAutomaticallyVia', 'DNS A record created automatically via')} {result.dns.provider}
                                {result.dns.zone ? ` (zone ${result.dns.zone})` : ''}.
                            </div>
                        ) : (
                            <div className="wp-url-swap__dns-manual">
                                <strong>{t('wp.attachDomainModal.addThisDnsRecordToFinish', 'Add this DNS record to finish:')}</strong>
                                {rec?.value ? (
                                    <code className="wp-url-swap__record">
                                        {rec.type}&nbsp;&nbsp;{rec.name}&nbsp;→&nbsp;{rec.value}
                                    </code>
                                ) : (
                                    <div className="form-hint">{result.dns?.message}</div>
                                )}
                            </div>
                        )}

                        {result.warning && (
                            <div className="wp-url-swap__preview-error">{result.warning}</div>
                        )}
                    </div>
                    <div className="modal-actions">
                        <Button type="button" onClick={onClose}>{t('wp.attachDomainModal.done', 'Done')}</Button>
                    </div>
                </>
            )}
        </Modal>
    );
}
