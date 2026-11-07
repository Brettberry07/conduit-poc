# Conduit web console

Connect also offers email/password **Sign in** and **Sign up** when both `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are configured. These use GoTrue REST directly. Email confirmation may be required before sign-in. Signing up grants no workspace access: an administrator must explicitly link the Auth user UUID to a principal. Unlinked accounts see “This account isn't linked to any Conduit workspace yet.” Linked accounts have exactly `jobs:read` for that principal and cannot create, revise, claim or update jobs.

Unlike the memory-only key option below, email sessions (including access and refresh tokens) persist in localStorage under `conduit.auth.session`, so refreshing keeps you signed in. **This makes the tokens reachable by any script on the origin while the strict CSP is deferred.** Use a trusted device. Sign out calls GoTrue logout and clears localStorage even if remote logout fails. A 401 triggers one refresh attempt; failure drops the session. With either public environment variable absent, email forms are hidden and the key option remains available.

Open `/app` (redirects to `/app/board`). Paste a **viewer key with only `jobs:read`** into Connect. The browser keeps it in React memory only; refresh, disconnect, or closing the page loses it. It is never sourced from server configuration, persisted, or placed in a URL. Reads use same-origin GET requests with a Bearer header. Use a trusted device and HTTPS deployment.

Issue a viewer key locally with the [key-management CLI](operator-guide.md#persistent-api-keys), using the same principal as the job owner:

```sh
npm run key -- create --type viewer --principal ID --name NAME
```

Run this in a private interactive terminal; noninteractive creation requires `--out` with a private file path. Viewer keys use role `submitter` and exactly `jobs:read`. They allow GET requests for jobs, workers, job detail, revisions, executions, changes, diff, publication, and recorded activity; they cannot create, revise, claim, or update jobs. Use Connect on `/app/board`, `/app/active`, or `/app/needs-you`.

- **Job board** groups queued and dependency-waiting jobs, running jobs, completed jobs, and failed / blocked jobs separately. Search title, id, or status; open a card for instructions, results, checks, executions, files, publication, and the latest 20 recorded activity events in chronological order. Events show recording times and matching GitHub links when available.
- **Active** lays out every reported worker, freshness, busy state, jobs, lease countdowns, execution attempts, checks and publication state. The job detail sheet loads durable phase transitions from the [Phase 5C event store](phase-5c-events.md).
- **Needs you** derives draft PR reviews, failures, recovery signals, known unmerged dependencies and offline workers with queued jobs. Commands are selectable text only. GitHub links are validated; no merge, retry, approval or cleanup actions exist.

Polling runs about every three seconds while visible and pauses when hidden. Errors retain the last successful snapshot with a warning. The board reads the latest 100 jobs; counts and needs-you signals cover that window. Dependencies are read individually where authorized; missing publication information cannot establish a review or merge requirement. Files show the endpoint's first 100 files for the latest attempt. Detail sheets load evidence on opening. The recorded activity section refreshes every five seconds while visible. Reopen the sheet to refresh the remaining evidence.

Cmd/Ctrl+B toggles the desktop sidebar. Cmd/Ctrl+K opens navigation and filtering. Enter activates cards; Escape closes native modal dialogs with focus restored. Mobile uses bottom navigation and full-screen detail sheets. This console is read-only.

The visual foundation lives in `src/app/app/gui.css`: warm light neutrals, one indigo accent ramp, semantic status colors, a 4px spacing scale, and shared type, radius, shadow, and motion tokens on `.console`. Media-query breakpoints remain literal because CSS custom properties cannot be used in media conditions. Inline, decorative 16px SVGs in `src/gui/client.tsx` share a 1.5 stroke and inherit text color. Buttons use the secondary surface style by default; `.primary` identifies the main connection action.

Typography currently uses the system-ui fallback permitted for offline builds, with tight heading tracking and tabular counts, IDs, and timestamps. `next/font/google` Inter was attempted, but the build environment could not reach Google Fonts; the CSS `--font-inter` hook remains available for a future font-enabled build. No font CDN request or new dependency is shipped.

Visual review still needs fresh desktop (1440 × 1000) and mobile (390 × 844) screenshots of `/app/board` while disconnected, including desktop sidebar and mobile bottom navigation. Also capture the collapsed desktop sidebar using its toggle. Screenshot capture was attempted with installed headless Chrome, which exited before rendering in the restricted worker. Existing screenshots below predate this foundation and are not evidence of the new appearance.

Offline verification retry: TypeScript checking and all 54 tests across the 11 service-independent test files pass. `tests/events.test.ts` and `tests/initiatives.test.ts` require embedded PostgreSQL and allocate a loopback port with `server.listen(0, "127.0.0.1")`. This sandbox denies even loopback sockets: a standalone Node socket probe returns `EPERM`. Rerunning those files also aborts with a Node `InternalCallbackScope::Close` assertion. They remain unmodified and must be verified in an environment that permits their database service; this is not a fully passing configured test run.

Security headers apply only to `/app` routes. A strict script CSP is deferred: Next's inline bootstrap scripts require a coordinated nonce strategy; a static policy would break hydration. No inline eval policy is added. Existing API-key authentication behavior is unchanged.

## Board and monitoring rebuild

The three monitoring screens now use title-first cards, SVG-and-color status badges, short IDs and relative timestamps. Running cards show a subdued progress bar; detailed evidence remains in the job sheet. A completed job with an open draft PR is marked Awaiting review. Failed and blocked badges remain distinct. Navigation badges count all loaded jobs, running jobs and attention items respectively. Lane counts reflect the current search. Below 1000px the board becomes one vertically grouped list; the existing mobile bottom navigation remains.

The `filter` and `job` query parameters hold search and selection. Browser history records changes; closing the sheet clears only `job`. Navigation preserves these parameters. Links to jobs outside the latest 100 loaded jobs show an explicit notice. Credentials remain in memory and never enter the URL. Connection validation and API reads are unchanged.

Initial skeletons wait 200ms and remain for at least 300ms once shown. Background refreshes retain the existing content. Hidden tabs show paused copy; real fetch failures show retry copy. Successful empty responses have screen-specific empty states. A polite live region announces changed job/attention counts without announcing the ticking relative timestamp.

### Screenshot acceptance still pending

No new screenshots were captured in this offline worker: no browser capture tool is available and loopback sockets are prohibited. Existing PNGs predate this rebuild. They must not be used as evidence for this change. Publication is managed externally; no PR was created here.

Capture `/app/board`, `/app/active`, and `/app/needs-you` at **1440 x 1000** and **390 x 844**, for each of the following states (24 captures total):

| State     | Read responses / setup                                                                                                                    | Verify                                                                                        |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Populated | Use the realistic job titles and worker/publication evidence in `tests/gui-screens.test.ts`; include a completed job without a PR as well | All six badges, running progress, counts, worker freshness, draft review and failure evidence |
| Empty     | Successful `{ jobs: [] }` and `{ workers: [] }`                                                                                           | Honest empty copy; no failure banner                                                          |
| Loading   | Delay the initial GET responses at least 1 second                                                                                         | Skeleton appears after 200ms, no unavailable copy                                             |
| Error     | Fail initial jobs/workers GET                                                                                                             | Fetch failure and automatic retry copy; no caught-up claim                                    |

Also verify hidden-tab pause/resume, retained content on background failure, 320px and wide-screen layouts, reduced motion, keyboard focus, and mobile bottom navigation. Open a job, change the filter, reload, share the URL, and use Back/Forward to verify selection and filtering. Connect with a viewer key and confirm all requests remain same-origin GETs, no credential appears in the URL, and disconnect clears loaded data. No mutation controls were added.

Local rebuild verification: `node node_modules/typescript/bin/tsc --noEmit`, `node scripts/test-offline.cjs` (59 tests in 12 files), and `node node_modules/next/dist/bin/next build` pass. The service-dependent full integration suite requires a separate environment permitting local database sockets.
