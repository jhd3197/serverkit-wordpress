import { ProtectionPanel } from 'serverkit-sdk';

// Backups Tab
// Backups tab — now the shared Protection panel (scheduled backups, cost,
// one-click restore). Renders for both the top-level "Backups" tab and the
// Settings → Backups section.
const BackupsTab = ({ siteId, site }) => (
    <ProtectionPanel
        targetType="wordpress_site"
        targetId={siteId}
        targetName={site?.name}
        showMaintenanceModeOption
    />
);

export default BackupsTab;
