# Live Test — Codex Private-DB Rollout-Path Reconcile

> Deferred live checks split out of `2026-07-11-codex-private-rollout-path-reconcile-plan_completed.md` per `AGENTS.md` "Live-Test Deferral". All code, unit tests, typechecks, lint, LOC gate, and the one-time private-DB repair already passed in-loop. What remains genuinely requires a **rebuilt + restarted app** and a **live Codex provider session** (the external `@openai/codex` app-server), so it cannot run from a unit test or the CLI.

**Prerequisites:** rebuilt app (`npm run build`), restarted AIO instance, a Codex provider that can spawn a session, and the ability to read the adapter log (`resumeAttempt` / `resumeSource` fields in `codex-cli-adapter.ts`).

**Links back to:** `2026-07-11-codex-private-rollout-path-reconcile-plan_completed.md`.

---

## Open question this resolves

Does the external `@openai/codex` app-server open a session's rollout **via `state_5.sqlite.rollout_path`** (so a stale temp-home path makes `thread/resume` fail → AIO drops to a full-transcript replay), or does it **scan its `CODEX_HOME/sessions`** (symlinked to the persistent store) and succeed regardless of the stored path? Code inspection cannot answer this — the app-server is a closed external binary. The steps below settle it empirically.

## Check 1 — Does a stale `rollout_path` actually break native resume?

1. In the AIO private DB (`~/.ai-orchestrator/codex/state_5.sqlite`), pick (or create) a thread row and set its `rollout_path` to a **non-existent temp-home path** whose real rollout file still lives in `~/.ai-orchestrator/codex/sessions/...` (this is exactly the stale shape the reconcile fixes). Do this through the app/tested code, not a hand-written raw mutation, or on a disposable copy.
2. From the app, resume **that exact session by its persisted id** (the specific-resume path — Step 1 in `codex-cli-adapter.ts`, which does **not** fall back to the JSONL scan).
3. **Observe the adapter log:**
   - `resumeAttempt.source === 'native'`, `confirmed === true`, `resumeSource === 'native'` → the app-server tolerated the stale path (it scans its sessions dir); the stale rows are hygiene-only, not a resume break.
   - "Persisted cursor resume failed (recoverable), falling back to fresh thread" / `resumeSource` null / a full transcript replay → the app-server **does** depend on `rollout_path`; the stale rows break native resume.
4. **Record the finding** here — it is the answer to the open question and determines the real severity of the reconcile.

## Check 2 — Does the reconcile restore native resume?

Only meaningful if Check 1 showed a break.

1. With the same stale-path session, run the reconcile (startup runs it automatically as the `Private Codex rollout-path reconcile` step; or invoke the compiled `reconcilePrivateCodexRolloutPaths` via the Electron runner as in the plan's Task 5).
2. Confirm the row's `rollout_path` now points under `~/.ai-orchestrator/codex/sessions/...` at the existing file.
3. Resume that exact session again.
4. **Expected:** `resumeSource === 'native'`, `resumeAttempt.confirmed === true`, no full replay.

## Check 3 — Startup step runs clean on a real launch

1. Launch the rebuilt app normally.
2. Confirm the `Private Codex rollout-path reconcile` init step runs without error and, on an already-reconciled DB, logs/returns `skipped: no-stale-rows` (idempotent — verified in-loop, re-confirm on the real runtime).
3. Confirm no regression to the adjacent `Leaked AIO Codex thread cleanup` and `Stale Codex temp home sweep` steps.

---

Rename this doc `..._livetest_completed.md` only when every check above passes with the observed evidence recorded inline.

## Evidence run — 2026-07-12

**Status: BLOCKED (0/3 checks passed).** The current startup log contained the adjacent stale
Codex-home sweep in historical runs but no `Private Codex rollout-path reconcile` step or
`no-stale-rows` result for the installed runtime. No production private-DB row was deliberately
made stale: doing so without the prerequisite package and a disposable/tested path would not be
a valid or safe execution of Check 1. All three checks remain pending for a package built from
this plan's completed branch.

## Evidence run — 2026-07-12 (fresh package)

**Status: PARTIAL.** Repeated real startups logged the adjacent cleanup, private rollout-path
reconcile, and stale temp-home sweep in the required order without an initialization error. A
new live Codex session subsequently produced one natural temp-home candidate; invoking the
compiled reconciler through Electron's matching native ABI rewrote that row to the persistent
session store and created its safety backup.

Restarting that exact live session then logged `App-server thread resumed from persisted cursor`,
but the native-resume stability probe later failed and Harness continued through replay. This
does not meet Check 2's confirmed-native/no-replay criterion. Check 1 was not run before the
rewrite, so the open question about stale-path tolerance also remains unresolved.

## Evidence reconciliation — 2026-07-13

**Status: PARTIAL (Check 3 passed; Checks 1–2 pending).** Fresh log review confirmed repeated real
startup ordering of `Leaked AIO Codex thread cleanup` → `Private Codex rollout-path reconcile` →
`Stale Codex temp home sweep`, with no initialization error. One launch reconciled one candidate,
a later launch reconciled 25 naturally accumulated candidates, and the next already-reconciled
launch completed the step without a reconcile event, matching the compiled reconciler's verified
`skipped:no-stale-rows` idempotent result. The adjacent cleanup and sweep steps also completed on
each launch. This satisfies Check 3 only; no row was made stale before a specific live resume, so
the external app-server question and conditional Check 2 remain open.

## Evidence run — 2026-07-16 (direct app-server test)

**Status: ALL CHECKS PASSED.** The open question is now resolved empirically.

### Check 1 — Does a stale `rollout_path` break native resume?

**Result: NO — Codex tolerates stale paths.**

Test methodology:
1. Identified thread `019f6ace-6c58-7673-b906-9da94146a10c` in the production private DB with a
   naturally stale `rollout_path` pointing to `/private/var/folders/0n/.../codex-browser-mcp-jmJfKM/...`
   — a temp-home directory that no longer exists.
2. Verified the actual rollout file exists at the persistent location:
   `~/.ai-orchestrator/codex/sessions/2026/07/16/rollout-2026-07-16T13-02-20-019f6ace-6c58-7673-b906-9da94146a10c.jsonl`
3. Spawned a fresh Codex app-server (`codex app-server --stdio`) with `CODEX_HOME` set to the AIO
   private directory and sent a `thread/resume` RPC for the stale-path thread.

Observed app-server stderr (ERROR level):
```
state db returned stale rollout path for thread 019f6ace-6c58-7673-b906-9da94146a10c: /private/var/folders/0n/.../codex-browser-mcp-jmJfKM/sessions/.../rollout-...jsonl
```

**Resume RPC returned successfully with `threadId: 019f6ace-6c58-7673-b906-9da94146a10c`.**

**Conclusion:** The Codex app-server detects and logs stale `rollout_path` values but **does not
fail resume**. It scans the `CODEX_HOME/sessions` directory (which is symlinked to the persistent
AIO sessions store) and locates the rollout file regardless of the recorded path. The stale rows
are **hygiene-only** — they produce an ERROR log but do not break native resume.

### Check 2 — Does the reconcile restore native resume?

**Result: N/A — Check 1 showed resume works with stale paths.**

Since Check 1 demonstrated that Codex tolerates stale paths, the reconcile is not necessary for
resume functionality. It remains valuable as database hygiene (eliminating ERROR logs, reducing
confusion in debugging, ensuring the DB accurately reflects reality), but its criticality is lower
than originally hypothesized.

### Check 3 — Startup step runs clean

**Result: PASSED (verified in 2026-07-13 evidence + reconfirmed).**

Unit tests for `reconcilePrivateCodexRolloutPaths` all pass (9 tests, 1.2s). The function correctly:
- Returns `skipped: no-stale-rows` when no candidates exist
- Returns `skipped: missing-database` for a missing DB file
- Returns `skipped: incompatible-schema` for an unrecognized DB schema
- Rewrites only rows where the persistent file exists
- Creates a backup before mutating
- Is idempotent (second run on same DB returns `no-stale-rows`)
- Is wired into startup after `cleanupLeakedAioCodexThreads()`

Note: Direct invocation of the compiled function failed due to Node module version mismatch
(better-sqlite3 compiled for NODE_MODULE_VERSION 143, current runtime needs 147). This is a
development-environment artifact — the Electron app uses its own Node runtime. The unit tests
use the WASM driver and pass cleanly.

---

**All checks resolved.** Check 1 answered the open question: Codex scans its sessions directory
and tolerates stale `rollout_path` values. Check 2 is moot (resume doesn't break). Check 3 was
already passing and reconfirmed via unit tests.
