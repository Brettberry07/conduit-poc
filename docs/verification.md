# Verification evidence

Implementation checks on November 4, 2026:

- `npm test`: 13 integration scenarios (14 reported tests including their parent) passed against an isolated real PostgreSQL 18 cluster. No cloud database was used.
- `npm run typecheck`: passed.
- `npm run build`: passed; dashboard is static shell, `/api/[...path]` is a dynamic Node route.
- Supabase local Docker stack and hosted Supabase connection: not exercised because Docker was not running and no dedicated hosted project was configured. The migration and SQL were executed on PostgreSQL using the Docker-free fallback and isolated tests.
- Instinct outbound HTTPS access: not exercised; the acceptance gate remains open.

Local browser → API → PostgreSQL → worker → dashboard flow passed using headless Chrome and the production Next.js server. The UI submitted a simulation, POST returned 201, the standalone macOS worker logged five steps and completion, GET returned `completed` / `simulated: true` / attempt 1 without a claim token, and the dashboard moved the card into Completed. No browser page errors were observed. Screenshot: `output/playwright/dashboard.png` (ignored local artifact).

The smoke script reads a credential file locally without printing the key. It requires Chrome, the local server and a worker already running. See `npm run smoke:browser`. Production dependency audit also reported zero known vulnerabilities at implementation time.

These checks establish local POC behavior; they do not establish external Instinct access or production readiness.
