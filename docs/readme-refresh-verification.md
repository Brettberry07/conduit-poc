# README refresh evidence

Source inspection on 2026-11-07 used checkout `563ae43`, whose history includes
the three UI overhaul merges: #11 (`dc5b5fa`), #12 (`155011e`) and #13
(`563ae43`). Local `main` and `origin/main` still point to `fe80e63`; no network
fetch was performed, so current remote-main parity is unverified.

The README console description was checked against:

- `src/app/app/gui.css`: the merged light-theme design tokens.
- `src/gui/client.tsx`: Connect, board, Active, Needs you, detail sheets,
  polling, data-window limits and same-origin reads.
- `src/gui/auth.ts`: optional email authentication and session storage.
- `src/app/app/`: redirect, shared layout and the three view routes.
- `docs/gui.md`: viewer-key setup and access boundaries.

The architecture diagram uses three horizontal groups stacked vertically to
keep labels readable without a single long horizontal or vertical chain. Its
GitHub rendering still needs visual inspection.

## Outstanding desktop captures

Screenshot acceptance is **not complete**. No browser tool is available in this
session, network access is restricted and loopback sockets are unavailable.
The existing four PNGs are 1440×900 and are not fresh evidence of the final
merged console; their README embeds were removed. They remain on disk as
historical assets. No replacement images were fabricated or resized.

From a browser-capable review environment, first confirm the deployment matches
the final merged main revision, then capture both at **1440×1000**:

1. Disconnected Connect screen at `/app/board`, with no credentials visible.
2. Connected job board at `/app/board`, using sanitized fixture data and a
   read-only viewer key. Label the image as fixture data when applicable.

Save the captures as `docs/screenshots/desktop-connect.png` and
`docs/screenshots/desktop-board.png`, then embed them in README.md using those
relative paths. Inspect the images and diagram at normal GitHub README width.
No mobile captures are required. Conduit manages commits and publication.

## Screenshot completion (2026-11-08, review environment)

The outstanding captures above were completed from a browser-capable review
environment after the worker run, following the spec in that section:

1. `docs/screenshots/desktop-connect.png` - disconnected Connect screen at
   1440x1000 from a local production build of this branch (code head 2274abd),
   built with the public Supabase Auth env present so the email sign-in form
   renders as it does on the configured deployment. No credentials or personal
   data are visible; the key field is empty.
2. `docs/screenshots/desktop-board-redesigned.png` - connected job board at 1440x1000
   from the same local build, populated entirely with sanitized fixture jobs
   and connected with a non-real demo key.

Both are embedded in README.md under Screenshots with demo-data captions. The
board capture uses a distinct filename (`desktop-board-redesigned.png`) so
GitHub's image CDN cannot serve the cached pre-redesign bytes at the old path.
The four pre-redesign PNGs were removed as obsolete. These docs-only commits
were made through the GitHub web UI as the repository owner; no worker
revision was consumed.
