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
