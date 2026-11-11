# Owner console actions

Verified console JWT subject `9b56ae7e-8d6b-44d2-be89-0903e9c6b820` is the sole entry in the source-controlled console action allowlist. Its linked session receives `jobs:read`, `console:action`, and `console:create`. All other linked subjects, including future logins, receive exactly `jobs:read`; unlinked subjects remain denied. API-key authentication and role scopes are unchanged.

`console:action` accepts only job retry, revision requests, and initiative lifecycle PATCH. Lifecycle transitions are limited to pause, resume, and cancellation, with existing ownership and state-machine checks preserved. It cannot edit plans, complete initiatives, review, acknowledge events, or operate worker endpoints. `console:create` accepts only job creation, not initiative creation or activation. There is no merge control.

The dashboard gates the six action types on `/api/console/identity`, defaults to hidden while identity is unavailable, and clears permission visibility on a write 403. The server remains authoritative. Creation uses the existing development job API and registered projects. No database, environment, dependency, or GitHub credential changes are needed.
