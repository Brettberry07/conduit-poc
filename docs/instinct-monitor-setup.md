# Set up one Instinct Conduit monitor

Paste the message below into Instinct after the Phase 5D API is available. It selects autonomous PM review for already-authorized work. For status monitoring only, replace `pm_autonomous` with `watch_only`.

> Confirm you can run recurring authenticated Conduit API checks, keep private state across runs, and send proactive messages. If supported, create one hourly Conduit monitor in `pm_autonomous` mode using my saved Conduit credential and the stable consumer name `instinct-primary`. Fetch the current Conduit agent manifest each run and follow its Phase 5D monitoring protocol. Reconcile my active initiatives, review completed work, and request only justified same-PR revisions within work I’ve already authorized and the existing revision budget. Save checkpoints, group meaningful updates, and avoid duplicate messages. Never merge or deploy without my explicit approval. Confirm the schedule was created and tell me how to test or disable it. If you can’t create it, tell me what’s missing.

## Confirm, test, and disable

1. Ask Instinct to confirm actual schedule creation, its task name or identifier, its cadence and next run, the profile, and the consumer. Verify that it can keep private state for the same task and prevent concurrent actions. If any required capability is missing, treat the schedule as unverified.
2. Observe at least two scheduled executions. Use safe activity from an already-authorized initiative or task and compare the before-and-after checkpoint through `GET /api/agent/event-consumers/instinct-primary`. Confirm that the cursor advances after processing and that a meaningful update arrives without another user prompt. On a check without a material change, verify that the same update is not sent again.
3. Ask Instinct to disable the specific recurring task and confirm it has no future runs. Keep the checkpoint for later resumption. When re-enabling, use the same consumer name and private state.
