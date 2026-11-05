# Conduit web console

Open `/app` (redirects to `/app/board`). Paste a **read-only Instinct key with jobs:read** into Connect. The browser keeps it in React memory only; refresh, disconnect, or closing the page loses it. It is never sourced from server configuration, persisted, or placed in a URL. Reads use same-origin GET requests with a Bearer header. Use a trusted device and HTTPS deployment.

- **Job board** groups queued and dependency-waiting jobs, running jobs, completed jobs, and failed / blocked jobs separately. Search title, id, or status; open a card for instructions, results, checks, executions, files, and publication.
- **Active** lays out every reported worker, freshness, busy state, jobs, lease countdowns, execution attempts, checks and publication state. Phase changes observed during this connection appear with observation times; polling can miss transitions. The API does not expose a historical phase event stream or live Codex thought / command feed.
- **Needs you** derives draft PR reviews, failures, recovery signals, known unmerged dependencies and offline workers with queued jobs. Commands are selectable text only. GitHub links are validated; no merge, retry, approval or cleanup actions exist.

Polling runs about every three seconds while visible and pauses when hidden. Errors retain the last successful snapshot with a warning. The board reads the latest 100 jobs; counts and needs-you signals cover that window. Dependencies are read individually where authorized; missing publication information cannot establish a review or merge requirement. Files show the endpoint's first 100 files for the latest attempt. Detail sheets load on opening; reopen to refresh their extra data.

Cmd/Ctrl+B toggles the desktop sidebar. Cmd/Ctrl+K opens navigation and filtering. Enter activates cards; Escape closes native modal dialogs with focus restored. Mobile uses bottom navigation and full-screen detail sheets. This console is read-only.

Security headers apply only to `/app` routes. A strict script CSP is deferred: Next's inline bootstrap scripts require a coordinated nonce strategy; a static policy would break hydration. No inline eval policy is added. Existing API and authentication behavior is unchanged.
