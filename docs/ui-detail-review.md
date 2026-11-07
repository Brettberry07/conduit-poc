# Job detail and public surface review

The detail sheet now presents execution history, verification outcomes, changed
files and publication metadata as structured content. Original job and detail
payloads remain available inside a closed “Raw JSON” disclosure. Missing evidence
is labeled as unreported. Publication state is explicitly a recorded observation.

The root route serves static HTML without client JavaScript. The public pages use
the console's warm neutrals, indigo accent, system font stack and spacing scale.
The `/info` JSON descriptor and Accept negotiation are preserved. No dependencies
or API handlers under `/api` changed.

## Validation

- Next route type generation passed.
- TypeScript checking passed.
- Offline suite passed: 67 tests across 13 files.

## Required visual evidence before PR acceptance

Screenshots have **not** been captured. The implementation session has no browser
tooling and worker verification forbids loopback sockets. Capture these from the
review deployment and attach them to the PR:

| Surface              | Viewports                 | Review points                                                                                                                                                         |
| -------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Job detail           | 1440 × 1000 and 390 × 844 | Long title truncation, wrapped prose, status icons, check outcomes, file counts, branch and short SHA, relative times with absolute hover text, JSON closed initially |
| Landing `/`          | 1440 × 1000 and 390 × 844 | Navigation, primary console link, readable feature columns/stack, no horizontal overflow                                                                              |
| Capabilities `/info` | 1440 × 1000 and 390 × 844 | Shared typography/palette, readable endpoint table, no horizontal overflow                                                                                            |

Also use keyboard navigation to check visible focus on links, close button and
JSON summary; open and dismiss the detail sheet and confirm focus returns to its
trigger. Include populated, failed and missing-detail job examples. Verify both
public pages without authentication and `/info` with `Accept: application/json`.
