# Conduit web console

Connect also offers email/password **Sign in** and **Sign up** when both `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are configured. These use GoTrue REST directly. Email confirmation may be required before sign-in. Signing up grants no workspace access: an administrator must explicitly link the Auth user UUID to a principal. Unlinked accounts see “This account isn't linked to any Conduit workspace yet.” Linked accounts have exactly `jobs:read` for that principal and cannot create, revise, claim or update jobs.

Unlike the memory-only key option below, email sessions (including access and refresh tokens) persist in localStorage under `conduit.auth.session`, so refreshing keeps you signed in. **This makes the tokens reachable by any script on the origin while the strict CSP is deferred.** Use a trusted device. Sign out calls GoTrue logout and clears localStorage even if remote logout fails. A 401 triggers one refresh attempt; failure drops the session. With either public environment variable absent, email forms are hidden and the key option remains available.

Open `/app` (redirects to `/app/board`). Paste a **viewer key with only `jobs:read`** into Connect. The browser keeps it in React memory only; refresh, disconnect, or closing the page loses it. It is never sourced from server configuration, persisted, or placed in a URL. Reads use same-origin GET requests with a Bearer header. Use a trusted device and HTTPS deployment.

Issue a viewer key locally with the [key-management CLI](operator-guide.md#persistent-api-keys), using the same principal as the job owner:

```sh
npm run key -- create --type viewer --principal ID --name NAME
```

Run this in a private interactive terminal; noninteractive creation requires `--out` with a private file path. Viewer keys use role `submitter` and exactly `jobs:read`. They allow GET requests for jobs, workers, job detail, revisions, executions, changes, diff, and publication; they cannot create, revise, claim, or update jobs. Use Connect on `/app/board`, `/app/active`, or `/app/needs-you`.

- **Job board** groups queued and dependency-waiting jobs, running jobs, completed jobs, and failed / blocked jobs separately. Search title, id, or status; open a card for instructions, results, checks, executions, files, and publication.
- **Active** lays out every reported worker, freshness, busy state, jobs, lease countdowns, execution attempts, checks and publication state. Phase changes observed during this connection appear with observation times; polling can miss transitions. The API does not expose a historical phase event stream or live Codex thought / command feed.
- **Needs you** derives draft PR reviews, failures, recovery signals, known unmerged dependencies and offline workers with queued jobs. Commands are selectable text only. GitHub links are validated; no merge, retry, approval or cleanup actions exist.

Polling runs about every three seconds while visible and pauses when hidden. Errors retain the last successful snapshot with a warning. The board reads the latest 100 jobs; counts and needs-you signals cover that window. Dependencies are read individually where authorized; missing publication information cannot establish a review or merge requirement. Files show the endpoint's first 100 files for the latest attempt. Detail sheets load on opening; reopen to refresh their extra data.

Cmd/Ctrl+B toggles the desktop sidebar. Cmd/Ctrl+K opens navigation and filtering. Enter activates cards; Escape closes native modal dialogs with focus restored. Mobile uses bottom navigation and full-screen detail sheets. This console is read-only.

Security headers apply only to `/app` routes. A strict script CSP is deferred: Next's inline bootstrap scripts require a coordinated nonce strategy; a static policy would break hydration. No inline eval policy is added. Existing API-key authentication behavior is unchanged.
