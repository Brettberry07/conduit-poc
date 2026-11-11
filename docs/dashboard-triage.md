# Focused dashboard triage

## Initiative and scope

Make daily triage quieter without changing the existing home, theme, sidebar,
detail surfaces, PM monitor, APIs or owner actions. Deliver one read-only slice:
explicit attempt scope, status quick filters, grouped attention, readable titles.
No PR15/PR16 integration, security-gate changes, dependencies, merge or deployment.

Changed files:

- `src/gui/model.ts`: shared attempt derivation, filters, URL update helper and attention conditions.
- `src/gui/client.tsx`: narrow context/URL wiring, native scope select, quick filters and reason groups.
- `src/app/app/gui.css`: wrapping titles and controls using existing tokens.
- `tests/gui.test.ts`, `tests/gui-screens.test.ts`, `tests/gui-triage.test.ts`: model and static-render coverage.
- `docs/dashboard-triage.md`: decisions, evidence and verification.

## Decisions and evidence

The supplied research package reports these observations as of 2026-11-11.
The URLs were **not fetched** in this offline worker; they are supplementary
source attributions, not independently verified claims or proof of improvement.
Decisions were checked against the current local model, polling, URL handling,
screen rendering and tests.

| Decision                                                                | Source and application                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Small status filters compose with existing search and remain in the URL | [Linear Filters](https://linear.app/docs/filters): supplied observations describe composable filters and URL retention. Use five buttons, not a query builder.                                                                                                                            |
| Keep diagnostic evidence close and retain every loaded attempt          | [GitHub workflow logs](https://docs.github.com/en/actions/how-tos/monitor-workflows/use-workflow-run-logs), [gh-hound README](https://github.com/indrasvat/gh-hound): preserve job detail links and explicit history. gh-hound is author-reported experience, not independent evaluation. |
| Group conditions by reason without prescribing owner actions            | [CodeCargo failures](https://docs.codecargo.com/concepts/workflow-failures): recovery/failure, dependencies, review and worker health. Review text explicitly disclaims merge approval.                                                                                                   |
| Show scope, freshness and incomplete reads honestly                     | [NN/G system status](https://www.nngroup.com/articles/visibility-system-status/): keep existing retained-data/error/paused states and add a loaded-window caveat.                                                                                                                         |
| Add hierarchy and readable text within the existing visual system       | [NN/G dashboards](https://www.nngroup.com/articles/dashboards-preattentive/): reason headings, counts, wrapping titles, text and existing status SVGs. No charts or redesign.                                                                                                             |

Local Next guidance read before implementation:
`node_modules/next/dist/docs/01-app/03-api-reference/01-directives/use-client.md`
and the Native History API section of
`01-app/01-getting-started/04-linking-and-navigating.md`.
This installed version supports native pushState with useSearchParams and
Back/Forward; the existing mechanism remains.

## Semantics and limits

- Group only by explicit `root_job_id || id`. Root IDs may equal the job's own
  ID or be null. No title, age, inferred lineage or transitive dependency matching.
- Pick latest by valid `created_at`, then lexical job ID (larger wins).
  Invalid dates sort below valid dates; tied/invalid dates use the same ID rule.
  Execution `attempt_count` is not a revision ordering signal.
- Latest is **within the loaded up-to-100-job window**, never global history.
  All attempts includes older attempts and reports scope-hidden counts. There
  is no deletion, dismissal state or persistence outside the URL.
- Keep raw jobs for detail lookup, so a URL selecting an older loaded job still
  opens even when hidden on the board. Jobs outside the window retain the
  existing explicit unavailable message; this slice does not fetch global history.
- Keep `filter` (text) and `job` (selection); add `status` and
  `attempts=all`. Missing/invalid status means All; missing/invalid attempt
  scope means Latest. Updates preserve the other query parameters.
- Filter counts cover the selected attempt scope before text search; lane counts
  show the resulting status-and-search intersection. Review is a condition that
  can overlap a reported status, not a new job status.
- Review requires a published snapshot with an open, unmerged PR, draft or ready.
  Deduplicate attention review by explicit root; do not fall back to an older
  attempt's publication when the latest has missing or closed evidence.
  Snapshot age does not establish live PR state or merge safety.
- Dependency conditions deduplicate by exact dependency ID and retain links to
  every affected waiting job. A dependency's review evidence belongs in that
  reason group. Missing IDs/evidence and merged-but-still-waiting states stay
  explicit. Independent failure/recovery conditions are not suppressed.
- Offline worker queue warnings require actual `queued` jobs in the selected
  scope. `waiting_dependencies` alone never triggers them. The existing
  15-second staleness threshold and Active worker monitor are unchanged.
- Existing polling retains prior data on whole-refresh failures. Failed
  publication reads leave review evidence unavailable and retain failure signals;
  the existing refresh banner warns that review may be incomplete. No invented
  healthy state or cached publication fallback was added.

## Verification (2026-11-11)

Passed:

- `node node_modules/next/dist/bin/next typegen`.
- `node node_modules/typescript/bin/tsc --noEmit`.
- `node scripts/test-offline.cjs`: **77/77 tests, 14 files**.
- Prettier on changed TypeScript/CSS files.

The configured npm wrapper could not locate npm in the provided toolchain.
The typecheck and offline scripts above were run directly with Node instead.
The first offline run exposed an old test expecting imperative “Merge PR” copy;
the assertion now checks the read-only dependency-review wording.

Coverage includes shuffled revisions, self/null roots, unrelated identical
titles, invalid/tied dates, unknown statuses, scope/filter/search counts,
open/closed/merged/missing publication snapshots, shared dependency conditions,
waiting-only worker warnings, retained failures during partial reads, full title
markup and initial loading/paused/error/empty states. URL tests exercise preserved
parameters and historical URL snapshots plus raw-job lookup; they are **not**
a browser Back/Forward test.

Environment-dependent checks were not run: full database/HTTP/live integration
suites, browser interaction and visual inspection. Loopback sockets are unavailable.
No screenshot, 390px overflow, focus traversal or desktop pixel claim is made.
PM should inspect exact head at desktop and 390px, test native select/buttons and
focus, open older attempts, and exercise Back/Forward across search, scope, status
and job selection. No user study or before/after performance measurement exists.

## Draft publication handoff

Suggested draft title: **Improve dashboard triage and loaded attempt history**

Draft description: Default board and Needs you to the latest loaded attempt per
explicit root, with All attempts history, URL-restorable quick filters and grouped
read-only attention reasons. Preserve raw job detail selection, existing design
tokens and worker monitoring; wrap long titles. Review remains publication
evidence, never merge approval.

Validation: Next type generation and TypeScript pass; supported offline suite
passes 77/77 across 14 files. Browser/mobile and environment-dependent integration
checks remain for PM. This worker did not commit, push, create a PR, merge or
deploy: Conduit manages commits and publication. Publish as **draft only**.
