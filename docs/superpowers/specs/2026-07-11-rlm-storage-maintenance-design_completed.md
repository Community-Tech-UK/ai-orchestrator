# RLM Storage Maintenance Design

**Date:** 2026-07-11
**Status:** Implemented — all agent-runnable gates passed 2026-07-12; live UI/runtime checks deferred to `docs/superpowers/plans/2026-07-11-rlm-storage-maintenance-plan_livetest.md`

## Problem

Harness pauses every loop before its next iteration when the shared RLM SQLite database reaches 12 GiB. The pause applies to brand-new loops because the resource governor measures the application-wide database, not data owned by the current loop.

The database currently has no automatic stale-store retention policy. Ordinary session stores remain after their RLM sessions end, and `search_index` creates one row for each distinct term on each source line. Over time, retained session stores and their cascading search data can grow the database past the hard limit. A normal loop resume immediately encounters the same resource check and pauses again.

Harness needs an operator-visible warning before the hard limit and a safe, explicit maintenance action that removes old session data and compacts SQLite.

## Goals

- Warn in the loop HUD when the RLM database reaches 10 GiB.
- Let the operator preview, confirm, and run maintenance from the warning.
- Delete ordinary session stores that have not been accessed for at least 60 days.
- Never delete stores belonging to currently open or running instances.
- Never delete stores whose `config_json.kind` is `codebase-auto`.
- Create a restorable backup before any deletion.
- Compact SQLite after pruning so reclaimed pages return to the filesystem.
- Report exact results and failure stages without claiming unverified success.
- Resume the loop that initiated maintenance when the database is healthy again.

## Non-goals

- Automatic deletion without an operator click.
- Redesigning RLM indexing or replacing `search_index`.
- Pruning `codebase-auto`, learning, observation, knowledge-graph, or other non-session data.
- Deleting recent stores merely to force the database below 12 GiB.
- Managing Codemem storage; its existing maintenance path remains separate.
- Restoring backups from this banner. The backup is for recovery through the existing RLM backup facilities or a later dedicated restore flow.

## Thresholds and retention policy

The thresholds are constants shared by resource evaluation, health reporting, and UI formatting:

- Warning threshold: `10 * 1024 * 1024 * 1024` bytes.
- Hard loop-pause threshold: `12 * 1024 * 1024 * 1024` bytes.
- Stale-store cutoff: 60 calendar days before the maintenance preview or execution timestamp.

A store is eligible only when all of the following are true:

1. `context_stores.last_accessed <= cutoffTimestamp`.
2. Its `instance_id` is not the `sessionId` of any instance currently known to `InstanceManager` as open or running.
3. `json_extract(config_json, '$.kind')` is absent or is not `codebase-auto`.

The service must recompute eligibility immediately before deletion. The preview is informative and must not become an authorization token for a stale candidate list.

Persisted `rlm_sessions.ended_at IS NULL` is not sufficient evidence that a store is active. Historical rows can remain unended after crashes. The live `InstanceManager` state is the source of truth for store protection.

## Architecture

### RLM maintenance service

Add a focused main-process `RlmMaintenanceService`. It owns health inspection, preview calculation, single-flight execution, backup naming, pruning, compaction, progress events, and result reporting.

The service receives its dependencies rather than importing renderer or loop state:

- RLM database facade or a narrow maintenance database port.
- A function that returns protected live session IDs from `InstanceManager`.
- Clock and filesystem/backup-path dependencies for deterministic tests.
- A maintenance gate callback used by the loop coordinator.

The public contract provides:

- `getHealth(): RlmStorageHealth`
- `preview(request): RlmMaintenancePreview`
- `run(request): Promise<RlmMaintenanceResult>`
- progress subscription through main-process events forwarded over IPC
- `isRunning(): boolean`

`run` is single-flight. A second invocation while maintenance is active returns the current operation identity/status rather than starting another backup, delete, or `VACUUM`.

### Database work

Maintenance uses the existing native SQLite connection and backup primitives.

Execution order:

1. Acquire the maintenance single-flight guard.
2. Engage the loop maintenance gate so no new loop iteration begins.
3. Checkpoint WAL and record database/content sizes.
4. Recompute protected IDs and eligible stores.
5. Create a timestamped backup under the Harness user-data RLM backup directory.
6. Include the external RLM content directory so the backup is restorable.
7. Verify that the backup file exists and is a valid SQLite database.
8. Delete eligible stores through foreign-key cascades in one transaction.
9. Remove external content files belonging to the deleted stores.
10. Checkpoint WAL and run `VACUUM` outside the deletion transaction.
11. Reload `RLMContextManager` from persistence so its in-memory maps no longer contain deleted stores or sessions.
12. Record final sizes and return the verified result.
13. Release the maintenance gate and single-flight guard in `finally`.

The deletion transaction must not start if backup creation or verification fails. If deletion succeeds but `VACUUM` fails, the result reports a `compacting` failure and does not claim reclaimed bytes. The deleted data remains recoverable from the backup.

### Loop coordination

The loop coordinator checks the maintenance gate at the same pre-iteration boundary as the resource governor. While maintenance is active, loops wait in a maintenance state rather than starting child work or repeatedly emitting resource-blocked signals. Existing agent processes are not stopped.

After successful maintenance, the initiating renderer asks the coordinator to resume its loop. The coordinator re-evaluates the resource governor normally; it does not receive a bypass. Automatic resume occurs only when the new database size is below 12 GiB. Otherwise the loop remains paused and the result explains that additional cleanup is required.

## IPC and shared contracts

Add validated IPC channels for:

- RLM storage health.
- Maintenance preview.
- Maintenance start/status.
- Maintenance progress events.

All request payloads use Zod schemas in the shared IPC schema layer. Results use explicit shared types rather than `unknown` or generic records.

The maintenance request includes the initiating loop ID when invoked from a loop banner. The main process validates that the loop exists before attempting automatic resume. Retention duration is not renderer-controlled in the first version; it is fixed at 60 days.

Progress stages are:

- `preparing`
- `backing-up`
- `pruning`
- `compacting`
- `reloading`
- `complete`
- `failed`

Failure results include the failed stage, a human-readable error, and the backup path only when a verified backup exists.

## User experience

### Warning banner

The loop HUD queries RLM health when it opens, refreshes after relevant loop state changes, and receives maintenance progress events.

At or above 10 GiB it shows:

> **RLM storage needs maintenance**  
> 10.4 GiB is in use. Prune session stores unused for 60+ days and compact the database to keep loops running.

Actions:

- **Review cleanup**
- **Dismiss until restart**

Dismissal is renderer-session-only. It is not persisted and does not hide the existing critical resource-block banner at 12 GiB.

### Confirmation preview

`Review cleanup` opens the existing application modal style. The preview contains:

- Current database size.
- Current external content size.
- Number of eligible stores.
- Number of protected live stores.
- Number of protected `codebase-auto` stores.
- The exact 60-day cutoff date.
- A warning that backup and compaction may take several minutes.
- The backup destination directory.

The primary action is **Back up, prune & compact**. If no stores are eligible, the action remains available only when compaction can reclaim free pages; otherwise the modal explains that there is nothing safe to prune.

### Progress and completion

During maintenance, the warning becomes a non-dismissible progress panel showing the current named stage. Starting another maintenance operation is impossible.

Successful completion reports:

- Stores deleted.
- Database/content size before and after.
- Verified bytes reclaimed.
- Backup location.
- Whether the initiating loop resumed.

If the database remains at or above 12 GiB, the UI says so explicitly and leaves the loop paused. It offers no unsafe threshold bypass.

Failures show the failed stage and whether a verified backup exists. Retry starts a new preview and recomputes eligibility.

## Error handling and recovery

- Backup failure: delete nothing, release the maintenance gate, report `backing-up` failure.
- Candidate-query failure: delete nothing, report `preparing` failure.
- Delete transaction failure: roll back all database deletions, retain the backup, report `pruning` failure.
- External content cleanup failure: report affected paths/counts without printing content or secrets; continue to compaction only when database deletion committed successfully.
- Compaction failure: retain the backup, reload surviving database state, report `compacting` failure, and do not report reclaimed bytes.
- Reload failure: report `reloading` failure and require app restart; do not claim automatic loop resume.
- App shutdown during maintenance: do not begin new stages; SQLite transaction and backup guarantees remain authoritative. The next launch re-evaluates actual storage health.

Logs include operation ID, stage, counts, durations, and byte sizes. They must not include section content, prompts, credentials, or backup contents.

## Testing strategy

### Service unit tests

- Health is `healthy` below 10 GiB, `warning` at exactly 10 GiB, and `critical` at exactly 12 GiB.
- A store last accessed exactly 60 days before execution is eligible.
- Stores newer than 60 days are not eligible.
- Live instance session stores are protected regardless of age.
- `codebase-auto` stores are protected regardless of age.
- Stale persisted sessions with `ended_at IS NULL` do not override live `InstanceManager` truth.
- Backup failure prevents deletion.
- Eligibility is recomputed between preview and execution.
- A concurrent `run` call does not start a second operation.
- Every failure reports its exact stage and releases the maintenance gate.

### SQLite integration tests

Use a real temporary native SQLite database with representative stores, sections, vectors, sessions, search rows, and external content files.

- Pruning a stale store cascades to its sections, vectors, sessions, and `search_index` rows.
- Protected and recent stores survive.
- A valid backup contains the pre-prune rows.
- External content belonging to deleted stores is removed while protected content survives.
- `VACUUM` reduces the database file after deleting a sufficiently large fixture.
- The reported before/after sizes match filesystem measurements.

### IPC and preload tests

- Request schemas reject invalid loop IDs and malformed payloads.
- Every channel is registered and exposed through the memory preload domain.
- Progress subscriptions return working unsubscribe functions.
- Main-process errors are serialized without leaking stack traces or paths not intended for the UI.

### Loop tests

- Active maintenance prevents a new iteration from starting.
- Completing maintenance releases waiting loops.
- The initiating loop resumes only after a healthy resource recheck.
- A database still above 12 GiB remains blocked.

### Renderer tests

- The banner appears at exactly 10 GiB and not below it.
- Dismissal lasts only for the renderer session.
- The critical blocked banner cannot be dismissed by the warning dismissal.
- Preview renders counts, sizes, cutoff, and backup destination.
- Confirmation, progress, success, partial failure, retry, and resume states render correctly.
- Repeated clicks cannot start concurrent maintenance.

### Final verification

Run targeted tests during implementation, then the canonical project gates:

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run check:ts-max-loc
npm run test:quiet
```

A live check against a disposable copied database should verify progress rendering and that an actually resource-blocked loop becomes resumable after maintenance. The production RLM database must not be used as an implementation test fixture.

## Success criteria

- Operators receive an actionable warning at 10 GiB rather than discovering the problem only at the 12 GiB hard block.
- One explicit action produces a verified backup, removes only approved stale session stores, compacts the database, and reports factual results.
- Live and `codebase-auto` stores survive maintenance.
- Loops cannot start new iterations during database mutation.
- A successfully reduced database allows the initiating loop to resume through the normal resource check.
- Failures never silently delete without a backup or falsely claim that space was reclaimed.
