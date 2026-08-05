import { useState, useEffect } from 'react';
import { Shield, Plus, Trash2, Star, Edit3, Save } from 'lucide-react';
import wordpressApi from '../../services/wordpress';
import { Spinner } from 'serverkit-sdk';
import { Modal } from 'serverkit-sdk';
import { Button } from 'serverkit-sdk';
import { Input } from 'serverkit-sdk';
import { Label } from 'serverkit-sdk';
import { Checkbox } from 'serverkit-sdk';

const SanitizationProfileForm = ({ onClose, onProfilesChange }) => {
    const [profiles, setProfiles] = useState([]);
    const [loading, setLoading] = useState(true);
    const [editingProfile, setEditingProfile] = useState(null);
    const [showCreateForm, setShowCreateForm] = useState(false);

    useEffect(() => {
        loadProfiles();
    }, []);

    async function loadProfiles() {
        setLoading(true);
        try {
            const data = await wordpressApi.getSanitizationProfiles();
            setProfiles(data.profiles || []);
        } catch {
            setProfiles([]);
        } finally {
            setLoading(false);
        }
    }

    async function handleDelete(profileId) {
        try {
            await wordpressApi.deleteSanitizationProfile(profileId);
            setProfiles(prev => prev.filter(p => p.id !== profileId));
            onProfilesChange?.();
        } catch {
            // handled silently
        }
    }

    async function handleSetDefault(profileId) {
        try {
            await wordpressApi.updateSanitizationProfile(profileId, { is_default: true });
            setProfiles(prev => prev.map(p => ({
                ...p,
                is_default: p.id === profileId
            })));
            onProfilesChange?.();
        } catch {
            // handled silently
        }
    }

    async function handleSaveProfile(profileData) {
        try {
            if (editingProfile) {
                const result = await wordpressApi.updateSanitizationProfile(
                    editingProfile.id,
                    profileData
                );
                setProfiles(prev => prev.map(p =>
                    p.id === editingProfile.id ? result.profile : p
                ));
            } else {
                const result = await wordpressApi.createSanitizationProfile(profileData);
                setProfiles(prev => [...prev, result.profile]);
            }
            setEditingProfile(null);
            setShowCreateForm(false);
            onProfilesChange?.();
        } catch {
            // handled silently
        }
    }

    return (
        <Modal open={true} onClose={onClose} title="Sanitization Profiles" size="lg">
            <div className="sanitization-profiles-body">
                {loading ? (
                    <div className="sanitization-loading">
                        <Spinner size="md" />
                    </div>
                ) : (
                    <>
                        <div className="sanitization-profile-list">
                            {profiles.map(profile => (
                                <ProfileCard
                                    key={profile.id}
                                    profile={profile}
                                    onEdit={() => { setEditingProfile(profile); setShowCreateForm(false); }}
                                    onDelete={() => handleDelete(profile.id)}
                                    onSetDefault={() => handleSetDefault(profile.id)}
                                />
                            ))}
                        </div>

                        {!showCreateForm && !editingProfile && (
                            <Button
                                size="sm"
                                className="sanitization-add-btn"
                                onClick={() => setShowCreateForm(true)}
                            >
                                <Plus size={14} />
                                Create Custom Profile
                            </Button>
                        )}

                        {(showCreateForm || editingProfile) && (
                            <ProfileEditor
                                profile={editingProfile}
                                onSave={handleSaveProfile}
                                onCancel={() => { setEditingProfile(null); setShowCreateForm(false); }}
                            />
                        )}
                    </>
                )}
            </div>

            <div className="modal-actions">
                <Button variant="outline" onClick={onClose}>Close</Button>
            </div>
        </Modal>
    );
};

const ProfileCard = ({ profile, onEdit, onDelete, onSetDefault }) => (
    <div className={`sanitization-profile-card ${profile.is_default ? 'default' : ''}`}>
        <div className="sanitization-profile-card-header">
            <div className="sanitization-profile-card-title">
                <h5>{profile.name}</h5>
                {profile.is_builtin && <span className="sanitization-tag builtin">Built-in</span>}
                {profile.is_default && <span className="sanitization-tag default">Default</span>}
            </div>
            <div className="sanitization-profile-card-actions">
                {!profile.is_default && (
                    <Button variant="ghost" size="sm" onClick={onSetDefault} title="Set as default">
                        <Star size={12} />
                    </Button>
                )}
                <Button variant="ghost" size="sm" onClick={onEdit} title="Edit">
                    <Edit3 size={12} />
                </Button>
                {!profile.is_builtin && (
                    <Button variant="ghost" size="sm" onClick={onDelete} title="Delete">
                        <Trash2 size={12} />
                    </Button>
                )}
            </div>
        </div>
        {profile.description && (
            <p className="sanitization-profile-desc">{profile.description}</p>
        )}
        <div className="sanitization-profile-rules">
            <ProfileRuleTags config={profile.config} />
        </div>
    </div>
);

const ProfileRuleTags = ({ config }) => {
    const tags = [];
    if (config.anonymize_emails) tags.push('Anonymize emails');
    if (config.anonymize_names) tags.push('Anonymize names');
    if (config.reset_passwords) tags.push('Reset passwords');
    if (config.strip_payment_data) tags.push('Strip payments');
    if (config.remove_transients) tags.push('Clear transients');
    if (config.truncate_tables?.length > 0) tags.push(`Truncate ${config.truncate_tables.length} tables`);
    if (config.exclude_tables?.length > 0) tags.push(`Exclude ${config.exclude_tables.length} tables`);
    if (config.custom_search_replace && Object.keys(config.custom_search_replace).length > 0) {
        tags.push(`${Object.keys(config.custom_search_replace).length} replacements`);
    }

    return (
        <div className="sanitization-rule-tags">
            {tags.map(tag => (
                <span key={tag} className="sanitization-rule-tag">{tag}</span>
            ))}
            {tags.length === 0 && (
                <span className="sanitization-rule-tag empty">No rules configured</span>
            )}
        </div>
    );
};

const ProfileEditor = ({ profile, onSave, onCancel }) => {
    const [name, setName] = useState(profile?.name || '');
    const [description, setDescription] = useState(profile?.description || '');
    const [config, setConfig] = useState(profile?.config || {
        anonymize_emails: false,
        anonymize_names: false,
        reset_passwords: false,
        truncate_tables: [],
        exclude_tables: [],
        strip_payment_data: false,
        remove_transients: false,
        custom_search_replace: {},
    });
    const [truncateInput, setTruncateInput] = useState(
        (profile?.config?.truncate_tables || []).join(', ')
    );
    const [excludeInput, setExcludeInput] = useState(
        (profile?.config?.exclude_tables || []).join(', ')
    );
    const [saving, setSaving] = useState(false);

    function handleConfigToggle(key) {
        setConfig(prev => ({ ...prev, [key]: !prev[key] }));
    }

    async function handleSubmit(e) {
        e.preventDefault();
        setSaving(true);
        try {
            const finalConfig = {
                ...config,
                truncate_tables: truncateInput.split(',').map(s => s.trim()).filter(Boolean),
                exclude_tables: excludeInput.split(',').map(s => s.trim()).filter(Boolean),
            };
            await onSave({ name, description, config: finalConfig });
        } finally {
            setSaving(false);
        }
    }

    return (
        <form className="sanitization-editor" onSubmit={handleSubmit}>
            <h4>{profile ? 'Edit Profile' : 'Create Profile'}</h4>

            <div className="form-group">
                <Label>Profile Name *</Label>
                <Input
                    type="text"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    placeholder="My Custom Profile"
                    required
                    disabled={profile?.is_builtin}
                />
            </div>

            <div className="form-group">
                <Label>Description</Label>
                <Input
                    type="text"
                    value={description}
                    onChange={e => setDescription(e.target.value)}
                    placeholder="What this profile does..."
                />
            </div>

            <div className="form-group">
                <Label>Data Sanitization</Label>
                <div className="checkbox-group">
                    <label className="checkbox-label">
                        <Checkbox
                            checked={config.anonymize_emails || false}
                            onCheckedChange={() => handleConfigToggle('anonymize_emails')}
                        />
                        <span>Anonymize email addresses</span>
                    </label>
                    <label className="checkbox-label">
                        <Checkbox
                            checked={config.anonymize_names || false}
                            onCheckedChange={() => handleConfigToggle('anonymize_names')}
                        />
                        <span>Anonymize user names</span>
                    </label>
                    <label className="checkbox-label">
                        <Checkbox
                            checked={config.reset_passwords || false}
                            onCheckedChange={() => handleConfigToggle('reset_passwords')}
                        />
                        <span>Reset all passwords</span>
                    </label>
                    <label className="checkbox-label">
                        <Checkbox
                            checked={config.strip_payment_data || false}
                            onCheckedChange={() => handleConfigToggle('strip_payment_data')}
                        />
                        <span>Strip WooCommerce payment data</span>
                    </label>
                    <label className="checkbox-label">
                        <Checkbox
                            checked={config.remove_transients || false}
                            onCheckedChange={() => handleConfigToggle('remove_transients')}
                        />
                        <span>Remove transients</span>
                    </label>
                </div>
            </div>

            <div className="form-group">
                <Label>Truncate Tables (comma-separated)</Label>
                <Input
                    type="text"
                    value={truncateInput}
                    onChange={e => setTruncateInput(e.target.value)}
                    placeholder="actionscheduler_actions, actionscheduler_logs"
                />
                <span className="form-hint">Tables to empty (structure preserved, data removed)</span>
            </div>

            <div className="form-group">
                <Label>Exclude Tables (comma-separated)</Label>
                <Input
                    type="text"
                    value={excludeInput}
                    onChange={e => setExcludeInput(e.target.value)}
                    placeholder="wp_users, wp_usermeta"
                />
                <span className="form-hint">Tables to skip during sync/promote</span>
            </div>

            <div className="sanitization-editor-actions">
                <Button type="button" variant="outline" size="sm" onClick={onCancel}>
                    Cancel
                </Button>
                <Button type="submit" size="sm" disabled={saving || !name.trim()}>
                    {saving ? <><Spinner size="sm" /> Saving...</> : <><Save size={14} /> Save Profile</>}
                </Button>
            </div>
        </form>
    );
};

export default SanitizationProfileForm;
