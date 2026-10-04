import { useState, useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Spinner } from 'serverkit-sdk';
import { Modal } from 'serverkit-sdk';
import { Button } from 'serverkit-sdk';
import { Switch } from 'serverkit-sdk';
import { CopyField } from 'serverkit-sdk';
import { useTranslation } from 'serverkit-sdk';

const BasicAuthModal = ({ environment, prodId, onClose, api }) => {
    const { t } = useTranslation();
    const [loading, setLoading] = useState(true);
    const [status, setStatus] = useState({ enabled: false, username: null });
    const [credentials, setCredentials] = useState(null);
    const [toggling, setToggling] = useState(false);

    useEffect(() => {
        loadStatus();
    }, []);

    async function loadStatus() {
        setLoading(true);
        try {
            const data = await api.getBasicAuthStatus(prodId, environment.id);
            setStatus(data);
        } catch {
            setStatus({ enabled: false, username: null });
        } finally {
            setLoading(false);
        }
    }

    async function handleEnable() {
        setToggling(true);
        try {
            const data = await api.enableBasicAuth(prodId, environment.id);
            if (data.success) {
                setStatus({ enabled: true, username: data.username });
                setCredentials({ username: data.username, password: data.password });
            }
        } catch (err) {
            console.error('Failed to enable basic auth:', err);
        } finally {
            setToggling(false);
        }
    }

    async function handleDisable() {
        setToggling(true);
        try {
            const data = await api.disableBasicAuth(prodId, environment.id);
            if (data.success) {
                setStatus({ enabled: false, username: null });
                setCredentials(null);
            }
        } catch (err) {
            console.error('Failed to disable basic auth:', err);
        } finally {
            setToggling(false);
        }
    }

    const envName = environment?.name || 'Environment';

    return (
        <Modal open={true} onClose={onClose} title={t('wp.basicAuthModal.basicAuth', 'Basic Auth')} className="basic-auth-modal">
            <div className="basic-auth-body">
                <div className="basic-auth-env-name">{envName}</div>

                {loading ? (
                    <div className="basic-auth-loading">
                        <Spinner size="sm" />
                        <span>{t('wp.basicAuthModal.loadingStatus', 'Loading status...')}</span>
                    </div>
                ) : (
                    <>
                        <div className="basic-auth-toggle">
                            <label className="basic-auth-toggle-label">
                                <span>{t('wp.basicAuthModal.httpBasicAuthentication', 'HTTP Basic Authentication')}</span>
                                <Switch
                                    checked={status.enabled}
                                    onCheckedChange={status.enabled ? handleDisable : handleEnable}
                                    disabled={toggling}
                                />
                            </label>
                            <p className="basic-auth-description">
                                {t('wp.basicAuthModal.addsPasswordProtectionToTheSite', 'Adds password protection to the site. Visitors must enter credentials to access any page.')}
                            </p>
                        </div>

                        {status.enabled && status.username && !credentials && (
                            <div className="basic-auth-current">
                                <CopyField label={t('wp.basicAuthModal.username', 'Username')} value={status.username} />
                                <p className="basic-auth-hint">
                                    {t('wp.basicAuthModal.passwordWasShownWhenBasicAuth', 'Password was shown when Basic Auth was first enabled. Disable and re-enable to generate new credentials.')}
                                </p>
                            </div>
                        )}

                        {credentials && (
                            <div className="basic-auth-credentials">
                                <div className="alert alert-warning">
                                    <AlertTriangle size={14} />
                                    <span>{t('wp.basicAuthModal.saveTheseCredentialsNowThePassword', 'Save these credentials now. The password will not be shown again.')}</span>
                                </div>
                                <CopyField label={t('wp.basicAuthModal.username2', 'Username')} value={credentials.username} />
                                <CopyField label={t('wp.basicAuthModal.password', 'Password')} value={credentials.password} secret />
                            </div>
                        )}
                    </>
                )}
            </div>

            <div className="modal-actions">
                <Button variant="outline" onClick={onClose}>
                    {t('wp.basicAuthModal.close', 'Close')}
                </Button>
            </div>
        </Modal>
    );
};

export default BasicAuthModal;
