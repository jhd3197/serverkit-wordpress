// WordPress-flavored wrapper over the shared RepoConnectForm: same form, just
// pre-dressed with the WordPress intro copy and the wp-content tracked-path
// defaults. The reusable component lives in components/git/RepoConnectForm.jsx.
import { RepoConnectForm } from 'serverkit-sdk';

const GitConnectForm = (props) => (
    <RepoConnectForm
        {...props}
        idPrefix="wp"
        intro={{
            title: 'Connect a Git repository',
            subtitle: 'Manage themes and plugins for this site with version control — push to deploy.',
        }}
        showPaths
        defaultPaths={['wp-content/themes', 'wp-content/plugins']}
        pathsLabel="Tracked paths"
        pathsHint="Paths relative to the WordPress root that should be tracked."
    />
);

export default GitConnectForm;
