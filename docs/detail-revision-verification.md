# Detail sheet revision verification

Verified in the approved worktree on 2026-11-07:

| Command                                         | Actual result                                                         |
| ----------------------------------------------- | --------------------------------------------------------------------- |
| `node node_modules/typescript/bin/tsc --noEmit` | Passed, no diagnostics                                                |
| `node scripts/test-offline.cjs`                 | Passed, 69/69 tests across 13 files                                   |
| `node node_modules/next/dist/bin/next build`    | Passed, production compilation, TypeScript and static page generation |

The offline suite retains the previous 67 tests, including blocked and failed
job badge checks, and adds server-render checks for offline and stale workers.
Both worker cases render a neutral Offline badge without a Blocked badge.

The modal fixes preserve native `showModal`, Escape cancellation and trigger
focus restoration. Opening fixes the body at its existing visual offset and
clips root overflow; closing restores inline styles and the original scroll
position. Tab and Shift+Tab explicitly traverse currently visible, enabled
controls inside the dialog. Sheet headings wrap, including unbroken titles;
job cards retain truncation.

Interactive browser acceptance remains unverified here: no browser tool is
available and the offline sandbox disallows loopback sockets. Follow-up browser
checks should cover desktop and 390px viewports, opening from a scrolled page,
programmatic `window.scrollTo` while open, forward/reverse Tab cycles with Raw
JSON open and closed, Escape, and trigger focus/scroll restoration.

No dependencies, APIs, routes or read flows changed. No commit or publication
was performed; Conduit manages those steps for the existing draft PR.
