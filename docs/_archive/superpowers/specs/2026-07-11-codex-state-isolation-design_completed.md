# Codex State Isolation Design

## Problem

AIO creates temporary `CODEX_HOME` directories for Codex CLI processes and redirects rollout history to `~/.ai-orchestrator/codex`. The home mirroring helper still symlinks `state_5.sqlite` from the user's `~/.codex`, so AIO thread metadata is registered in the database used by the Codex app while the corresponding rollout files live outside it. When the temporary home is removed, Codex shows prompt-only AIO sessions that cannot be resumed.

## Decision

AIO will own a complete persistent Codex runtime-state boundary under `~/.ai-orchestrator/codex`:

- rollout and history artifacts remain in the existing AIO store;
- `state_5.sqlite` and its SQLite sidecars are never mirrored from `~/.codex`;
- prepared AIO homes link those database files to AIO-owned paths;
- if platform symlink support is unavailable, Codex may create ephemeral database files inside the prepared home, preserving isolation at the cost of cross-home database persistence;
- prepared homes are created even when the user has no existing `~/.codex`; if preparation itself fails, the adapter aborts rather than spawning Codex against the default user home;
- authentication, configuration, plugins, skills, and other non-session user assets continue to be mirrored as before.

This keeps AIO sessions resumable without exposing them in the Codex app.

## Existing-Leak Cleanup

At AIO startup, a cleanup step will inspect `~/.codex/state_5.sqlite` only when it exists and has the expected Codex `threads` table. It identifies leaked rows only when the normalized rollout path has the complete AIO-owned shape under the current OS temporary root: `<temp-root>/<owned-prefix><suffix>/sessions/<rollout path>`. Merely containing an AIO-looking substring elsewhere in a legitimate custom path is not sufficient. The owned prefixes are:

- `/codex-browser-mcp-`
- `/codex-nomcp-`
- `/codex-aio-`

Before the first mutation, AIO creates a consistent SQLite backup under `~/.ai-orchestrator/codex/backups`. It migrates the exact discovered thread IDs, AIO-to-AIO references, dynamic tools, and the connected job graph into the private AIO database, rewriting temporary rollout paths to `~/.ai-orchestrator/codex/sessions/...`. A first migration seeds the private database and prunes user-only threads and jobs; later migrations transactionally upsert the same graph by primary key. Assignments to threads outside the migrated AIO set are cleared so private state has no dangling user-thread references. The user database is mutated only after the private database contains every leaked thread.

Discovery captures a stable fingerprint of every selected thread and its related spawn edges, dynamic tools, job items, and job row. Cleanup obtains an immediate write transaction and captures the state again before deletion. Any added, removed, or same-ID updated record aborts cleanup without mutating the user database. Deletion is parameterized by the original exact ID set; it never reruns a broad path predicate at mutation time.

Cleanup will then run in one transaction, explicitly deleting related `thread_spawn_edges` rows before deleting matching `threads`. It will also clear any matching optional references that exist in the detected schema. Missing databases, incompatible schemas, locked databases, backup failures, and migration failures will be logged and left unchanged rather than blocking application startup.

The cleanup is idempotent. Legitimate Codex sessions are not selected by title, working directory, source, age, or missing files.

## Components

`CodexHomeManager` owns the prepared-home exclusion and private runtime-state links. A focused cleanup module owns schema detection, backup, private-state migration, and transactional deletion through the repository's injected SQLite driver abstraction. The existing application initialization sequence invokes cleanup alongside the stale temporary-home sweep.

## Verification

Tests will prove that:

1. all prepared-home variants keep AIO rollouts and `state_5.sqlite` outside `~/.codex`;
2. the private database target persists after temporary-home cleanup;
3. cleanup migrates leaked metadata before deleting it and rewrites rollout paths to the persistent AIO store;
4. cleanup recognizes only complete AIO temp-home rollout paths and preserves AIO-like custom paths elsewhere;
5. cleanup is idempotent and safely skips missing or incompatible databases;
6. backup or migration failure prevents mutation;
7. application initialization wires the cleanup step;
8. same-ID, same-count, newly added, and related-job concurrent changes abort deletion;
9. first and repeat migrations retain only a consistent connected AIO job graph;
10. missing user state still creates an isolated home, while preparation failure aborts the Codex spawn;
11. targeted tests pass and the canonical TypeScript, lint, LOC, and full-suite gates are run with any unrelated worktree blockers reported separately.
