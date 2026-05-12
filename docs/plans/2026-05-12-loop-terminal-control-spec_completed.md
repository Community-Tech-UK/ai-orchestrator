# Loop Terminal Control Contract Spec

Date: 2026-05-12
Status: Draft, Claude-reviewed and cross-reviewed (Copilot+Gemini-3.1-Pro) with packaging, restart, lifecycle, and persistence-ordering revisions; partial implementation underway
Owner: Loop Mode / orchestration

## Summary

Loop Mode currently decides that work is done by reconstructing intent from
filesystem and text signals: completed plan-file renames, `DONE.txt`,
`<promise>DONE</promise>`, checklist state, self-declared output, verify
results, and fresh-eyes review. That design is robust against optimistic model
claims, but it is fragile because the coordinator has to infer child intent
from side effects that may be missed, stale, ambiguous, or stage-gated
incorrectly.

Add an explicit child-to-coordinator terminal control contract. The child
process can declare one of:

- `complete`: "I believe the work is ready for inspection."
- `block`: "I need operator input before useful progress can continue."
- `fail`: "This loop cannot complete under the current constraints."

The most important design constraint is that `complete` is not a bypass. It is
a first-class completion intent that triggers the existing verification gate:

1. record the intent;
2. finish the current iteration normally;
3. run the configured verify command;
4. run the fresh-eyes cross-model review gate when configured;
5. terminate as `completed` only if the same gate accepts it.

Existing forensic signals remain fully supported. They are not removed and they
do not become second-class fallbacks in behavior. They become peer completion
sources that feed the same completion gate, with clearer observability around
which source fired.

## Validation Notes

Claude reviewed the direction and agreed with the underlying goal, with one
important correction: the explicit CLI signal should be treated as a strong
"ready for inspection" signal, not the canonical terminal decision. The
coordinator's gate remains the canonical decision point.

A second cross-model fresh-eyes pass through Copilot/Gemini-3.1-Pro surfaced
three concrete gaps that this revision fixes:

1. The packaged-runtime story for the helper CLI cannot ship as a raw `.js`
   file — `electron-builder` does not bundle a Node interpreter for child
   processes. Use the Node SEA precedent from `build-worker-agent-sea.ts`.
2. The resume-import rule had an off-by-one. `state.totalIterations` is only
   incremented after `invokeChild()` returns, so an intent written during a
   crashed iteration has `iterationSeq === state.totalIterations`, not
   `<= state.totalIterations - 1`.
3. `terminalIntentPending` needs an explicit lifecycle (clear/transition
   rules) so `LoopCompletionDetector.observe()` cannot re-fire
   `declared-complete` on later iterations.

Two smaller framing items were also tightened: the `verify` + fresh-eyes
review gate is only the safety boundary for `complete` intents (not for
`block`/`fail`, which intentionally bypass verify), and the BLOCKED.md
handshake needs explicit cleanup when a structured `block` intent supersedes
it so the next pre-flight does not re-pause.

Gemini standalone CLI validation was attempted with `gemini-2.5-pro` and
`gemini-2.5-flash`. Both failed after the CLI's full retry loop with HTTP 429
`MODEL_CAPACITY_EXHAUSTED`. The Copilot/Gemini-3.1-Pro pass above served as
the cross-model independent review.

A third cross-model fresh-eyes pass (Copilot/Gemini-3.1-Pro re-review of the
revised draft against the in-flight partial implementation in
`src/main/orchestration/loop-control.ts`, `loop-control-cli.ts`, and
`loop-control.spec.ts`) tightened five further items now reflected below:

1. SEA packaging is not currently in the production build pipeline. The
   `worker-agent` SEA script exists but is not invoked by `npm run build`,
   and `electron-builder.json` does not ship the SEA binary in
   `extraResources`. The Implementation Touchpoints section now requires
   adding `dist/loop-control-cli-sea/...` to `extraResources` per OS and
   wiring the SEA build into the packaging path.
2. A crash window existed between intent file import (archive into
   `imported/`) and the DB row in `loop_terminal_intents` being committed.
   The Coordinator Flow now requires DB-row-before-archive ordering, with
   a startup reconciler for any pre-existing `imported/` orphans.
3. Directory-level I/O failures during intent import (`mkdir(intentsDir)`)
   now have an explicit terminate-with-error behavior, distinct from
   per-file validation failures which continue.
4. `BLOCKED.md` archive error handling now distinguishes `ENOENT`
   (operator deleted, ignored) from any other error (logged, treated as
   archive failure, retry on next boundary).
5. Schema, type, and CLI-argument drift between spec and the in-flight
   implementation has been reconciled: `control.json` uses `promptVersion`
   (not `helperVersion`), the file format includes `controlDir`/
   `updatedAt`/`cliPath`; `LoopTerminalIntent` uses `statusReason` plus
   `filePath` (not `rejectionReason`); CLI evidence is
   `kind:label=value`. Only `claude` and `codex` are valid
   `LoopProvider`s today, so adapter env hooks for `gemini`/`copilot` are
   listed as forward-looking only.

## Problem

The current completion system is a forensic detector. It asks "what side
effects did the child leave behind?" rather than "what state transition did the
child explicitly request?"

That caused the recent failure:

1. The child completed the work and renamed a plan file under `docs/plans/`.
2. The watcher only watched the workspace root, so it missed the rename.
3. The detector also required some sufficient signals to happen during
   `IMPLEMENT`, while the relevant iteration was recorded as `REVIEW`.
4. The coordinator did not accept completion.
5. It spawned a follow-up Claude invocation.
6. That later provider failure became the terminal loop status, even though the
   semantic work had already finished.

The immediate watcher/stage bug has been fixed. This spec addresses the
larger architectural weakness: completion intent should be explicit and
structured, while file/text signals should remain compatibility evidence.

## Goals

- Give child agents a simple, explicit way to declare terminal intent.
- Keep verify-before-stop and fresh-eyes review as the final authority.
- Preserve current `_completed`, `DONE.txt`, checklist, and promise behavior.
- Make completion source visible in logs, stream events, iteration history,
  persisted state, and UI.
- Prevent provider failures after an accepted terminal intent from overwriting
  true completion.
- Validate terminal-control calls against loop ownership, iteration, workspace,
  and freshness.
- Make failures loud to the child process. A broken control call must return a
  clear nonzero result instead of silently doing nothing.
- Roll out additively with no migration cliff.

## Non-Goals

- Do not remove completed-file rename detection.
- Do not remove `DONE.txt` or `<promise>DONE</promise>` compatibility.
- Do not allow a child's `complete` call to bypass verification.
- Do not interrupt or kill a child process immediately when it declares
  completion.
- Do not introduce an always-on HTTP listener for loop control.
- Do not require every provider to support native tool calls before the feature
  is useful.
- Do not redesign Loop Mode's stage machine in this change.
- Do not run verify or fresh-eyes review for `block` or `fail` intents. Both
  are explicit loop-control terminations whose authority is the structured
  intent itself; the operator (for `block`) or the recorded failure reason
  (for `fail`) is the final say. Verify exists to protect against optimistic
  `complete` claims, not to second-guess a declared block or impossibility.

## Core Design

Introduce a `LoopTerminalIntent` record. Child processes can submit one intent
per iteration through a local loop-control channel. The coordinator records the
intent on the live `LoopState`; after the child iteration returns, the
completion detector emits a new completion signal from that pending intent.

The contract is intentionally two-phase:

1. **Intent phase:** the child declares terminal intent while it is still
   running.
2. **Decision phase:** after the child exits, the coordinator evaluates that
   intent with the same verification and review gates as existing signals.

This avoids the dangerous mid-iteration interrupt model. If the child calls
`complete` before its final writes flush, it still exits normally and the
coordinator sees the final workspace state before verifying.

## Terminal Intent Model

Add these shared types:

```ts
export type LoopTerminalIntentKind = 'complete' | 'block' | 'fail';

export type LoopTerminalIntentStatus =
  | 'pending'
  | 'accepted'
  | 'deferred'
  | 'rejected'
  | 'superseded';

export interface LoopTerminalIntentEvidence {
  kind: 'command' | 'file' | 'test' | 'summary' | 'note';
  label: string;
  value: string;
}

export interface LoopTerminalIntent {
  id: string;
  loopRunId: string;
  iterationSeq: number;
  kind: LoopTerminalIntentKind;
  summary: string;
  evidence: LoopTerminalIntentEvidence[];
  source: 'loop-control-cli' | 'imported-file';
  createdAt: number;
  receivedAt: number;
  status: LoopTerminalIntentStatus;
  /**
   * Free-form reason associated with the current status. Populated when
   * the status is `rejected` (validation failure detail), `deferred`
   * (e.g. "consumed-interventions"), or `superseded` (id of the winner).
   * Optional for `pending` and `accepted`.
   */
  statusReason?: string;
  /**
   * Absolute path of the intent file on disk at import time. Retained so
   * post-decision archival can move the file deterministically and so the
   * UI can link back to the raw artifact when debugging.
   */
  filePath?: string;
}
```

`summary` is required and capped at 4 KiB.
`evidence` is optional but capped at 20 items and 16 KiB total.
Each evidence value is plain text, not arbitrary JSON, so the renderer and
review prompt can safely display it without schema churn.

## State Changes

Extend `LoopState`:

```ts
terminalIntentPending?: LoopTerminalIntent;
terminalIntentHistory: LoopTerminalIntent[];
```

`terminalIntentHistory` should be capped in memory to the last 50 records, like
iteration history. Persist it either:

- in a new `loop_terminal_intents` table, preferred for queryability; or
- inside `loop_runs.end_evidence_json`, acceptable only for a small first pass.

Preferred SQLite table:

```sql
CREATE TABLE IF NOT EXISTS loop_terminal_intents (
  id TEXT PRIMARY KEY,
  loop_run_id TEXT NOT NULL REFERENCES loop_runs(id) ON DELETE CASCADE,
  iteration_seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  status_reason TEXT,
  file_path TEXT,
  created_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_loop_terminal_intents_run_seq
  ON loop_terminal_intents(loop_run_id, iteration_seq);

CREATE UNIQUE INDEX IF NOT EXISTS idx_loop_terminal_intents_run_seq_accepted
  ON loop_terminal_intents(loop_run_id, iteration_seq)
  WHERE status = 'accepted';
```

The partial unique index enforces "at most one accepted intent per
`(loop_run_id, iteration_seq)`" at the SQL layer, defending against duplicate
acceptance after a race or restart bug.

## Terminal Intent Lifecycle

Each terminal intent moves through an explicit state machine. The coordinator
must always advance the intent to a final state before the next iteration
spawns, so `LoopCompletionDetector.observe()` cannot re-emit
`declared-complete` on a later iteration from a stale `terminalIntentPending`.

```text
                            +--> accepted   --> (terminal, loop completes)
                            |
import + validate --> pending --> deferred   --> (cleared, retry next iter)
                            |
                            +--> rejected   --> (cleared, surfaced to user)
                            |
                            +--> superseded --> (cleared, history only)
```

Transition rules:

1. **import + validate.** After `invokeChild()` settles, the coordinator
   scans `intents/` for the matching `loopRunId` and `iterationSeq`. The
   newest valid intent for that iteration becomes `pending`; older valid
   intents for the same iteration are marked `superseded` immediately
   (with `statusReason` set to the winner's id). Invalid intents are
   marked `rejected` with a `statusReason` capturing the validation
   failure detail.
2. **pending → accepted.** Reached only for `complete` intents that pass the
   full gate (verify + belt-and-braces + fresh-eyes review). Triggers
   terminal status `completed` with `endReason='signal=declared-complete'`.
   For `block` and `fail`, "accepted" is reached as soon as the intent is
   imported and validated; no gate runs.
3. **pending → deferred.** Reached when a `complete` intent arrives in an
   iteration that consumed operator interventions
   (`consumedInterventions.length > 0`). The intent is recorded with
   `status='deferred'` and **cleared from `state.terminalIntentPending`**.
   The next iteration runs as normal; the child must re-declare completion
   if the work is still done.
4. **pending → rejected.** Reached when the gate explicitly fails (verify
   fails twice, or fresh-eyes review blocks). The intent is recorded with a
   `statusReason` (e.g. `'verify-failed:<exit code>'` or
   `'fresh-eyes-blocked:<finding count>'`) and cleared. The coordinator
   emits `loop:claimed-done-but-failed` and continues iterating (existing
   behavior, just attributed to the declared intent rather than a forensic
   signal).
5. **superseded.** Always cleared at the same time as the iteration that
   produced it is sealed.

Unconditional clear rule: before each iteration enters its "spawn child"
phase, `state.terminalIntentPending` must be `undefined`. Any intent that has
not transitioned out of `pending` by then is a bug; the coordinator must
log loudly and treat as rejected.

`terminalIntentHistory` retains the last 50 records regardless of final
status, for UI inspection.

## Completion Signal Changes

Add a new completion signal id:

```ts
export type CompletionSignalId =
  | 'declared-complete'
  | 'completed-rename'
  | 'done-promise'
  | 'done-sentinel'
  | 'all-green'
  | 'self-declared'
  | 'plan-checklist';
```

`declared-complete` is a qualifying signal. It means the child explicitly
requested completion inspection. It does not mean the loop is done.

In the existing `CompletionSignalEvidence` shape, `sufficient: true` means
"this signal is sufficient to trigger the verify/review gate." It must never
mean "skip verification" or "terminate immediately." If implementation work
finds that any caller treats `sufficient` as a gate bypass, that caller must be
fixed before adding `declared-complete`. `declared-complete` should behave like
`completed-rename`: it qualifies the loop for the existing gate and the loop
only terminates when that gate accepts completion.

`block` and `fail` are not completion signals. They are loop-control intents
handled before normal completion evaluation:

- `block` pauses the loop with a structured intervention, equivalent to a
  richer `BLOCKED.md` handshake.
- `fail` terminates the loop as a new `failed` terminal status.

For `block` and `fail`, the declared intent takes precedence over any
concurrent forensic completion signals found in the same iteration. Do not run
verify or fresh-eyes review for those two intents. For `complete`, declared
intent and forensic signals are peers: both feed the same gate, and
observability records every active source.

Add a distinct `failed` terminal status rather than overloading `error`.
`error` should mean infrastructure/provider/runtime failure; `failed` should
mean the child reached a reasoned impossibility under current constraints. This
is a broader schema/UI change, but it keeps provider failures and reasoned loop
failure separate in every place that consumes terminal status.

## Transport

Use a local filesystem control channel, not HTTP.

The coordinator creates per-loop control metadata at loop start:

```text
<workspace>/.aio-loop-control/<loopRunId>/
  control.json
  intents/
```

Note: in earlier drafts a per-loop `aio-loop-control` launcher script was
written into this directory. That approach is superseded by the SEA binary
(see Distribution and Invocation); the coordinator no longer writes a
per-loop launcher.

`control.json` contains:

```json
{
  "version": 1,
  "promptVersion": 1,
  "loopRunId": "loop-...",
  "workspaceCwd": "/absolute/workspace/path",
  "controlDir": "/absolute/workspace/.aio-loop-control/loop-...",
  "intentsDir": "/absolute/workspace/.aio-loop-control/loop-.../intents",
  "currentIterationSeq": 3,
  "secret": "random 32-byte base64url",
  "cliPath": "/absolute/path/to/aio-loop-control",
  "updatedAt": 1747000000000
}
```

- `version`: control-file structural version (incremented on breaking format
  changes). Readers must reject unknown versions.
- `promptVersion`: separate counter for the agent-facing prompt contract.
  Readers can use this to feature-gate prompt updates without forcing a
  full control-file migration.
- `controlDir` and `intentsDir`: absolute paths, both inside
  `<workspaceCwd>/.aio-loop-control/<loopRunId>/`. The CLI rejects either
  one that resolves outside that root.
- `cliPath`: absolute path to the SEA binary (or dev shim) the coordinator
  resolved at `startLoop`. Mirrored into `ORCHESTRATOR_LOOP_CLI` env.
- `updatedAt`: coordinator wall-clock when this file was last rewritten.
  Useful for stale-file diagnostics.

The child receives durable values through environment variables:

```text
ORCHESTRATOR_LOOP_RUN_ID
ORCHESTRATOR_LOOP_CONTROL_FILE
ORCHESTRATOR_LOOP_CONTROL_SECRET
ORCHESTRATOR_LOOP_CLI
```

Do not place the secret in the prompt. Environment variables are not perfect,
but they are less likely to be hallucinated or copied from transcript text.

Do not pass `ORCHESTRATOR_LOOP_ITERATION_SEQ`. Same-session adapters spawn the
provider CLI once and reuse it across iterations, so spawn-time environment
variables can become stale. The CLI must read `currentIterationSeq` from the
mutable `control.json` each time it runs.

The first implementation can use atomic JSON files instead of a named pipe:

1. CLI validates env/control file.
2. CLI writes intent JSON to a temp file in `intents/`.
3. CLI atomically renames temp file to `<iterationSeq>-<uuid>.json`.
4. Coordinator scans `intents/` after the child exits and imports valid
   records.

This is simpler than a pipe and works across app restarts. A named pipe can be
added later if live mid-iteration UI feedback is needed.

## Distribution and Invocation

Do not use `npx ai-orchestrator-loop` for v1. There is no published package bin,
and packaged Electron builds run child CLIs inside arbitrary user workspaces
where `npx` cannot resolve an app-private command. A raw `.js` helper is also
insufficient: `electron-builder.json` does not bundle a Node interpreter that
the spawned AI CLI's subshell can invoke, and we cannot assume the user has a
working `node` on `PATH` inside the workspace.

Ship a self-contained executable using Node's Single-Executable-Application
(SEA) packaging, following the existing `worker-agent` precedent:

1. Bundle `src/main/orchestration/loop-control-cli.ts` to a single CommonJS
   file (esbuild) at `dist/loop-control-cli/index.js`. This mirrors
   `build:worker-agent` (`build-worker-agent.ts`).
2. Build a Node SEA from that bundle to
   `dist/loop-control-cli-sea/aio-loop-control` (or `.exe` on Windows). This
   mirrors `build:worker-sea` (`build-worker-agent-sea.ts`): copy
   `process.execPath`, run `--experimental-sea-config`, then `postject` the
   blob into the copied binary with the canonical sentinel fuse. The output
   is a single executable that does not need a system Node interpreter.
3. Do not rely on `electron-builder.json`'s `files: ["dist/**/*"]` alone.
   Those files are packaged into `app.asar` by default, and a binary inside
   `app.asar` is not a real executable path that a child shell can run. Add
   the SEA binary to `extraResources` (preferred) or `asarUnpack`, and resolve
   the executable from outside the asar, for example
   `process.resourcesPath/loop-control-cli/aio-loop-control` on macOS/Linux
   and `process.resourcesPath/loop-control-cli/aio-loop-control.exe` on
   Windows. For macOS hardened-runtime builds, ensure the copied binary is
   signed/notarization-compatible in the same packaging pass as other shipped
   executables.
4. At `startLoop`, the coordinator resolves the absolute path of the
   packaged binary (`process.resourcesPath/loop-control-cli/...` in production,
   `path.resolve(__dirname, '../dist/loop-control-cli-sea/...')` in dev) and
   sets `ORCHESTRATOR_LOOP_CLI` to it. No per-loop launcher script is
   required in production.
5. The child prompt instructs agents to run `"$ORCHESTRATOR_LOOP_CLI" ...`.
   That path is absolute, durable for restart recovery, and independent of
   the child's current directory.

Cross-platform / cross-arch note: SEA binaries are host-platform-specific.
The build host's platform/arch must match the target's. The existing
`electron-builder.json` only ships `arm64` for macOS, AppImage/deb for Linux,
nsis/portable for Windows — produce SEA binaries matching those targets in
the same build matrix. Add the SEA build to the `build` script
(`npm run build`) so it runs before `electron-builder`.

The implementation should still unit-test the helper TypeScript directly via
vitest (the bundle is a transparent wrapper). The production contract is the
absolute SEA-binary path exposed through `ORCHESTRATOR_LOOP_CLI`, not the
bundle source.

Invariant: `ORCHESTRATOR_LOOP_CLI` must always be a single executable path.
The prompt quotes it as `"$ORCHESTRATOR_LOOP_CLI" complete ...`; a compound
command string such as `node /path/to/index.js` would be treated as one
nonexistent executable and fail.

Fallback for local dev: if the SEA binary is absent (e.g. `npm run dev`
without a prior `npm run build:loop-control-sea`), the coordinator may write a
small dev-only shim script under `.aio-loop-control/<loopRunId>/aio-loop-control`
with mode `0700`. The shim invokes `process.execPath` with the bundled JS file
and forwards `"$@"`. `ORCHESTRATOR_LOOP_CLI` points at the shim path,
preserving the single-executable-path invariant. Production builds must always
have the SEA binary; the shim exists only so contributors are not forced to run
the SEA toolchain for every dev iteration.

## CLI UX

Expose a small command that the child can run:

```bash
"$ORCHESTRATOR_LOOP_CLI" complete \
  --summary "Implemented source-control phase 2 and all checks pass" \
  --evidence command:typecheck="npx tsc --noEmit passed" \
  --evidence command:lint="npm run lint passed" \
  --evidence file:plan="docs/plans/foo_completed.md"

"$ORCHESTRATOR_LOOP_CLI" block \
  --summary "Need GitHub token with repo scope to verify PR creation"

"$ORCHESTRATOR_LOOP_CLI" fail \
  --summary "Cannot complete: target API is unavailable and no mock contract exists"
```

Evidence flag format: `--evidence <kind>:<label>=<value>`. `kind` must be
one of `summary`, `command`, `file`, `test`, `note`. `label` is a short
human-readable tag (≤256 chars). `value` is the body (plain text). The
`--note "..."` shorthand is equivalent to
`--evidence note:note="..."` for quick free-form additions.

The executable path comes from `ORCHESTRATOR_LOOP_CLI`. The loop prompt should
show the command verbatim.

All outcomes print structured JSON:

Success:

```json
{
  "ok": true,
  "intentId": "intent-...",
  "kind": "complete",
  "message": "Completion intent recorded. The coordinator will verify after this iteration exits."
}
```

Failure:

```json
{
  "ok": false,
  "error": "ORCHESTRATOR_LOOP_CONTROL_SECRET did not match control file"
}
```

Failures exit nonzero. The child sees the error immediately and can fall back
to the existing durable markers.

## Coordinator Flow

At `startLoop`:

1. Prune stale `.aio-loop-control/<deadLoopRunId>/` directories whose run IDs
   are not in `loop_runs` with status `running` or `paused`.
2. Create `.aio-loop-control/<loopRunId>/` and `.aio-loop-control/<loopRunId>/intents/`.
3. Generate and store a per-loop secret.
4. Add the control directory to `.gitignore`.
5. Resolve the absolute SEA-binary path (or dev fallback — see Distribution
   and Invocation) and stash it for export via `ORCHESTRATOR_LOOP_CLI`.
6. Store control metadata on `LoopState`.

Before `invokeChild`:

1. Update `control.json` with the current iteration sequence.
2. Pass durable loop-control env vars through the invocation payload.
3. Add a prompt section explaining the control command.

After `invokeChild` settles and before completion detection:

1. Scan the control `intents/` directory for the current loop and iteration.
2. Validate each intent (per-file failures are caught, recorded as
   `rejected` with `statusReason`, and the source file is moved to
   `<controlDir>/rejected/`).
3. **Persist before archive.** For each accepted intent, write the
   `loop_terminal_intents` row (`status='pending'`, `file_path` populated)
   inside a single SQLite transaction before moving the source file from
   `intents/` to `<controlDir>/imported/`. If the DB write fails, leave
   the source file in `intents/` so the next boundary will re-attempt.
   This closes the crash window where an intent could be archived but
   never persisted, leaving nothing for resume to find.
4. Choose the newest valid intent for that iteration using coordinator
   `receivedAt`, not child-controlled `createdAt`.
5. Mark older valid intents for the same iteration as `superseded` (DB
   row written with `status='superseded'` and `statusReason` set to the
   winner's id).
6. Store the chosen intent on `state.terminalIntentPending`.

Directory-level I/O failures behave differently from per-file validation
failures: if `mkdir(intentsDir)` or `readdir(intentsDir)` throws for a
reason other than "no entries" (e.g. EACCES, EIO, EROFS), the coordinator
treats this as an infrastructure failure of the loop-control channel,
logs loudly, and terminates the loop with `status='error'` and
`endReason='loop-control-io-failed'`. Continuing to iterate with a broken
channel would silently degrade to "forensic signals only" without the
operator noticing.

On app startup (independent of any `resumeLoop()` call), the coordinator
runs a one-time reconciler that scans every active loop's
`<controlDir>/imported/` for files whose `id` is not present in
`loop_terminal_intents`. Any orphan (archived but not persisted) is
imported as if it had just been written, then re-archived. This closes
the residual crash window where the DB transaction committed but the
file move had not yet completed.

Intent import is unconditional. It must run in a `finally` block or
equivalent boundary before the coordinator resolves either the success
path or the error path of `invokeChild`. This is the hardening that
prevents a valid child completion intent from being lost behind a later
provider error. In code today this corresponds to the `finally` block at
`loop-coordinator.ts:827–832` calling `importTerminalIntentsForBoundary`.

Then:

- If pending kind is `complete`, `LoopCompletionDetector.observe()` emits
  `declared-complete` with `sufficient: true`.
- If pending kind is `block`, pause the loop and surface the summary/evidence
  as an operator intervention. Do not run verify.
- If pending kind is `fail`, terminate with declared failure. Do not run verify.

If a provider invocation throws after a valid `complete` intent was already
written, the coordinator should import the intent before deciding terminal
status. If the imported intent is a valid `complete`, it should run the
completion gate and prefer accepted completion over the provider error. This is
the specific hardening against "finished but marked error."

If the just-completed iteration consumed operator interventions, defer a
`complete` intent rather than running the completion gate. Record the intent
with `status='deferred'`, surface that the child declared completion after
operator input, and require one clean follow-up iteration to re-validate and
re-declare completion. This preserves the existing behavior where completion is
suppressed for intervention-consuming iterations.

`BLOCKED.md` and `block` intents interact as follows:

- If `BLOCKED.md` exists before an iteration starts, keep the existing behavior:
  pause before spawning the child.
- If a `block` intent is written during the iteration, pause after import and
  surface the structured intent summary/evidence.
- If both are present at the same boundary, prefer the structured `block`
  intent because it has explicit loop ownership and evidence.
- When a structured `block` intent supersedes a `BLOCKED.md` file at the same
  boundary, archive `BLOCKED.md` by renaming it to
  `.aio-loop-control/<loopRunId>/blocked-handled-<iterationSeq>.md` (move
  into the loop-control directory, not delete, so the operator can still
  read what the child originally wrote). Without this archive step, the
  next `runLoop` pre-flight (the `readBlockedFileIfPresent` call at
  `loop-coordinator.ts:767`) re-reads `BLOCKED.md` and re-pauses on every
  resume, defeating the point of the structured intent path.
- Archive error handling: `rename(BLOCKED.md, blocked-handled-<seq>.md)`
  failures fall into two buckets. `ENOENT` (operator manually deleted
  `BLOCKED.md` between the iteration ending and the archive running) is
  benign — log at debug and continue; the structured intent path proceeds.
  Any other error (`EACCES`, `EBUSY`, `EXDEV` if the workspace and
  control dir somehow span filesystems, `EEXIST` if the target name
  collides) is logged at warn, surfaced through the existing
  `claimed-done-but-failed` event so the operator knows the archive
  failed, and `BLOCKED.md` is left in place. The structured intent's
  pause still applies for the current boundary, but the next pre-flight
  will pause again on the residual `BLOCKED.md` until the operator
  resolves it manually.
- If only `BLOCKED.md` is present (no structured intent), leave the file in
  place — the existing pre-flight behavior is unchanged.

On `resumeLoop()`, before the next `invokeChild`, scan the loop control
`intents/` directory for unimported valid intents matching the current
`loopRunId` and any `iterationSeq <= state.totalIterations`. The inclusive
bound matters: the coordinator sets `seq = state.totalIterations` *before*
spawning a child (`loop-coordinator.ts:801–802`) and only increments
`state.totalIterations` *after* the child returns (`loop-coordinator.ts`
around the iteration-record assembly). An app crash mid-iteration
therefore leaves the intent at `iterationSeq === state.totalIterations`.
An exclusive bound (`<= totalIterations - 1`) would silently miss exactly
the case this whole restart story exists to handle.

Import the newest eligible intent (by coordinator-side `receivedAt`, with
filesystem mtime as fallback when no `receivedAt` is recorded) as if it had
been imported at the boundary of the iteration that produced it. If multiple
files match the same `(loopRunId, iterationSeq)`, mark all but the newest as
`superseded` and log a warning if the kinds differ (e.g. child wrote
`complete` then later `fail`). This is the same newest-wins idempotency rule
used at normal post-iteration import time.

Restart caveat: `consumedInterventions` is ephemeral — it only lives in
the `runLoop` closure (the splice at `loop-coordinator.ts:816`) and is not
persisted. After a crash, the coordinator cannot reconstruct whether the
just-completed iteration consumed operator interventions. v1 accepts this
limitation: on resume, an imported `complete` intent is treated as
`pending` and the gate runs normally. If pre-crash interventions exist
that should have caused a deferral, the operator can re-issue them with
`intervene` after resume; the fresh-eyes review gate is the safety net
for "an intent landed despite interventions in flight." A future version
may persist `iterationConsumedInterventionsAtCrash: boolean` on
`loop_runs` to restore the deferral guarantee across restarts; this is
out of scope for v1.

## Validation Rules

Reject an intent if any of these fail:

- `loopRunId` does not match the active loop.
- loop status is already terminal.
- `iterationSeq` is not the current in-flight sequence.
- control secret does not match.
- intent file is outside the loop control directory after path resolution.
- `summary` is missing or exceeds cap.
- `evidence` exceeds item or byte caps.
- `createdAt` is more than 10 minutes before loop start or more than 2 minutes
  in the future.
- `kind` is not one of `complete`, `block`, `fail`.

`createdAt` is child-controlled. Use it only for skew diagnostics and broad
freshness rejection. Use coordinator-assigned `receivedAt` for ordering,
newest-intent selection, and terminal-eligibility decisions.

Already-terminal loops are idempotent:

- If the same accepted intent is submitted again, return success with
  `alreadyAccepted: true`.
- If a different intent arrives after terminal state, reject it with a clear
  error.

## Prompt Contract

Update the loop prompt's IMPLEMENT completion section:

```text
When you believe the work is complete:
1. Run the appropriate verification commands.
2. Leave durable evidence in the workspace when applicable:
   - rename completed plan files to *_completed.md;
   - write DONE.txt for no-plan loops.
3. Call:
   "$ORCHESTRATOR_LOOP_CLI" complete --summary "..." --evidence ...
4. Exit the iteration.

The command does not end the loop immediately. It records your completion
intent. The coordinator will verify and run fresh-eyes review after you exit.
If the command fails, read its JSON error and use the existing durable markers
as fallback.
```

Update blocked guidance:

```text
If genuinely blocked, prefer:
  "$ORCHESTRATOR_LOOP_CLI" block --summary "..."

If the command is unavailable, write BLOCKED.md as fallback.
```

## Fresh-Eyes Review Integration

Declared completion evidence should be included in the fresh-eyes review
request:

```text
## Child-declared completion intent
Summary:
...

Evidence:
- command: npx tsc --noEmit passed
- file: docs/plans/foo_completed.md
```

This gives reviewers a stronger map from claim to artifacts without trusting
the claim as proof.

## Stream and UI Changes

Add stream events:

```ts
| {
    type: 'terminal-intent-recorded';
    loopRunId: string;
    intent: LoopTerminalIntent;
  }
| {
    type: 'terminal-intent-rejected';
    loopRunId: string;
    intent?: Partial<LoopTerminalIntent>;
    reason: string;
  }
```

The Loop UI should show:

- completion source: `Declared by child`, `Plan renamed`, `DONE.txt`,
  `Checklist`, etc.;
- declared summary/evidence in the completed run details;
- block/fail summaries as first-class messages, not generic provider errors.

Do not add new controls to the renderer for v1. This is primarily a child
contract and observability improvement.

## Compatibility and Rollout

Phase 1: Additive only.

- Add types, schemas, store support, control file writer, CLI parser, and
  detector signal.
- Keep existing forensic signals unchanged.
- Prompt says "prefer loop-control command" but still documents existing
  durable markers.
- No existing loop config becomes invalid.

Phase 2: Prefer explicit intent in telemetry.

- Completion logs and UI should distinguish `declared` vs `forensic` source.
- Start measuring how often fallback signals are used because the control
  command failed or was omitted.

Phase 3: Tighten prompts only if telemetry supports it.

- Never remove forensic support without a separate migration spec.
- Consider warning when a loop completes via forensic signal but no declared
  intent exists.

## Failure Modes and Expected Behavior

### Child calls `complete` too early

Coordinator records intent, then verify or fresh-eyes review fails. The loop
continues with an intervention that includes the failed verification/review
output. This matches current behavior for premature `DONE.txt`.

### Child writes multiple intents

Use the newest valid intent for the current iteration. Mark earlier valid
intents as `superseded`.

### Child writes `complete`, then provider exits with code 1

Coordinator imports the intent before finalizing the provider error. If verify
and review pass, terminal status is `completed`. If verify/review fail, the
loop continues or pauses according to the existing gate. Only if the intent is
invalid or the gate fails due infrastructure should the provider error remain
the terminal reason.

### Control file missing

CLI exits nonzero with JSON error. The child can still use `_completed`,
`DONE.txt`, and promise markers.

### App restarts mid-iteration

Because intents are written as files, the restarted app can inspect
`.aio-loop-control/<loopRunId>/intents`. If the run is marked paused on restart,
the next resume should import any valid intent before spawning another child.

### Child consumes an intervention and declares completion

Coordinator records the intent as `deferred` and does not run the completion
gate for that iteration. The next clean iteration must re-run verification and
submit a fresh `complete` intent or produce a forensic completion signal.

### `BLOCKED.md` and `block` intent race

If `BLOCKED.md` is present before spawning, pause before invoking the child. If
a `block` intent appears during the just-completed iteration, pause after
import. If both are present at the same boundary, prefer the structured
`block` intent.

### Malicious workspace process writes an intent

The control secret is required and is not in prompt text. This is not a hard
security boundary against arbitrary same-user processes, but it prevents
accidental or prompt-only spoofing. The final verify/review gate remains the
main safety boundary.

## Security and Path Rules

- Control directory must be inside `workspaceCwd`.
- Resolve real paths before accepting intent files.
- Refuse symlinked intent files.
- Enforce file-size caps with `fs.stat()` before JSON parsing or full reads.
- Never execute evidence values.
- Never interpolate evidence into shell commands.
- The secret is written to `control.json` at loop start and read from there on
  restart. Do not persist the secret in long-lived SQLite rows.
- The secret is a sanity check against accidental same-user processes and
  prompt-only spoofing, not a security boundary. Any workspace tool that can
  read files can read `control.json`. The verify + fresh-eyes review gate is
  the safety boundary **for `complete` intents only**. `block` and `fail`
  intents intentionally bypass verify (see Non-Goals), so their only
  defenses are the structured-intent validation rules (secret, loop id,
  iteration seq, size caps, path containment). The most a forged `block`
  can do is pause the loop and surface a spurious operator intervention;
  the most a forged `fail` can do is terminate the loop. Both are
  recoverable by the operator. A forged `complete` cannot itself terminate
  the loop because verify and fresh-eyes still gate it.
- Cleanup of `control.json` and intent files happens only when the loop reaches
  terminal status.
- Clean up control directories on terminal loop status.
- Add `.aio-loop-control/` to `.gitignore`.

## Implementation Touchpoints

Expected files:

- `src/shared/types/loop.types.ts`
  - add terminal intent types;
  - add `declared-complete` signal id;
  - add `failed` to `LoopStatus`;
  - add state fields and stream event variants, including a `failed` event if
    terminal status is emitted through the stream.

- `packages/contracts/src/schemas/loop.schemas.ts`
  - mirror all new shared types with Zod;
  - add `failed` to `LoopStatusSchema`;
  - update schema tests for type/schema drift.

- `packages/contracts/src/channels/loop.channels.ts`
  - add channel constants for `terminal-intent-recorded`,
    `terminal-intent-rejected`, and `failed` if it is a stream event.

- `src/preload/generated/channels.ts`
  - regenerate via `npm run generate:ipc`; do not hand-edit generated output.

- `src/preload/preload.ts` and generated bridge consumers
  - ensure new loop channels are exposed through the preload API if the
    generator does not cover all required subscription methods.

- `src/main/orchestration/loop-control.ts` (new)
  - create/read/write control metadata;
  - validate intent files;
  - import pending intent for a loop/iteration;
  - prune stale workspace control directories for non-active run IDs.

- `src/main/orchestration/loop-control-cli.ts` (new) — helper entrypoint
  - parse `complete`, `block`, `fail`;
  - read env/control metadata;
  - read `currentIterationSeq` from `control.json`, not from env;
  - validate path containment of `ORCHESTRATOR_LOOP_CONTROL_FILE` against
    the workspace before reading;
  - atomically write intent JSON (`<tmp> → fsync → rename`);
  - print JSON success/failure;
  - exit nonzero on validation/write failure.

- `build-loop-control-cli.ts` (new) and `build-loop-control-cli-sea.ts` (new)
  - mirror `build-worker-agent.ts` (esbuild bundle to
    `dist/loop-control-cli/index.js`) and `build-worker-agent-sea.ts`
    (Node SEA → `dist/loop-control-cli-sea/aio-loop-control[.exe]`);
  - add `build:loop-control-cli` and `build:loop-control-sea` scripts to
    `package.json`;
  - extend the top-level `build` script to invoke both before
    `build:renderer` / `build:main`;
  - also add a `preelectron:build` script that invokes
    `build:loop-control-sea`. The existing top-level `build` only runs
    `build:worker-agent` today (`package.json:19`) and the `build:worker-sea`
    script is not wired into any production pipeline. Without an explicit
    `preelectron:build` hook, a release engineer who runs
    `npm run electron:build` directly (skipping `npm run build`) would
    package a DMG with a missing SEA binary. The `preelectron:build` hook
    closes that hole.

- `electron-builder.json`
  - add the SEA binary to `extraResources` (preferred) or `asarUnpack` so it
    is available as a real executable outside `app.asar`;
  - choose a stable packaged path such as `loop-control-cli/aio-loop-control`
    (or `.exe` on Windows) and make the coordinator resolve that exact path;
  - confirm macOS hardened-runtime signing/notarization treatment for the
    extra executable.

- coordinator loop-control plumbing
  - resolve the absolute SEA-binary path at `startLoop`:
    `process.resourcesPath/loop-control-cli/aio-loop-control[.exe]` in
    production, or `path.resolve(__dirname, '../../dist/loop-control-cli-sea/...')`
    in dev. If the SEA binary is absent in dev, create a dev-only executable
    shim and point `ORCHESTRATOR_LOOP_CLI` at the shim path.
  - export the resolved path via `ORCHESTRATOR_LOOP_CLI`.

- `src/main/orchestration/loop-coordinator.ts`
  - create/cleanup control directory;
  - pass loop-control env through `loop:invoke-iteration`;
  - import intents after child return and before completion detection;
  - prefer valid accepted completion intent over later provider error;
  - include intent evidence in fresh-eyes review input;
  - add `failed` to `isTerminalStatus()`;
  - defer `complete` intents when `consumedInterventions.length > 0`;
  - import eligible persisted intents on `resumeLoop()` before spawning.

- `src/main/orchestration/default-invokers.ts`
  - extend invoke payload to include loop-control env vars;
  - pass env vars to CLI adapters through the `env` field on each adapter's
    spawn options. V1 Loop Mode currently supports only `LoopProvider =
    'claude' | 'codex'`; wire those two paths first. Concretely:
    - Claude: `ClaudeCliSpawnOptions.env` (constructed in
      `claude-cli-adapter.ts:261–277`). Add the four loop-control env vars
      alongside the existing RTK passthrough.
    - Codex: `CodexCliConfig.env` (`codex-cli-adapter.ts:148`) — merged
      into spawn env at `codex-cli-adapter.ts:287` and `:830`.
    - If a separate change expands `LoopProvider` to Gemini or Copilot, wire
      their existing env hooks at that time: `GeminiCliConfig.env` and
      Copilot's `buildCopilotSpawnEnv`/ACP config path.
  - the loop-control env vars are durable per-adapter-spawn. For
    `same-session` persistent adapters, the env is frozen at the first
    iteration's spawn; `currentIterationSeq` is read from mutable
    `control.json` on each child invocation, not from env (already specified
    in Transport).
  - add `failed` to the local `isTerminalLoopStatus()` copy (function
    body at `default-invokers.ts:858`; not the same as the
    `isTerminalLoopStatus` declaration at `:854`, which is unrelated map
    state in the same scope) so persistent adapters are torn down
    consistently when a loop ends via `fail` intent.

- `src/main/orchestration/loop-completion-detector.ts`
  - emit `declared-complete` when `state.terminalIntentPending.kind === 'complete'`.

- `src/main/orchestration/loop-store.ts`
  - persist terminal intents in a single `INSERT` per intent; expose a
    `recordTerminalIntent(intent)` method the coordinator calls *before*
    the importer archives the source file from `intents/` to `imported/`.
    The store must surface insert failures (e.g. unique-index conflict
    from the partial index on `accepted`) so the coordinator can react.
  - expose a `reconcileImportedOrphans(loopRunId)` method called once at
    app startup per active loop: list files in `<controlDir>/imported/`
    and insert rows for any not already present in `loop_terminal_intents`.
  - include terminal intent in run summaries or detailed state where useful;
  - support `failed` in persisted summaries.

- `src/main/orchestration/loop-control.ts`
  - the importer (`importLoopTerminalIntents`) MUST NOT archive a source
    file until the coordinator has confirmed the DB row is committed.
    Refactor `archiveIntentFile(..., 'imported')` out of the per-file
    loop and require the caller to invoke it after `recordTerminalIntent`
    returns. Per-file validation failures still archive to `rejected/`
    immediately because there is no DB row to lose.

- `src/main/orchestration/loop-schema.ts`
  - add the next sequential migration for a new `loop_terminal_intents` table;
  - do not modify existing tables;
  - no backfill is required.

- `src/renderer/app/core/services/ipc/loop-ipc.service.ts`
  - add subscribe methods for new loop stream events following the existing
    `onLoop...` pattern.

- `src/renderer/app/core/state/loop.store.ts`
  - handle new stream events and render intent details;
  - add `failed` to `LoopFinalSummary.status` and terminal checks.

- `src/renderer/app/features/loop/loop-formatters.util.ts`
  - add a user-facing `failed` label if the formatter remains status-specific.

- `src/renderer/app/features/loop/*`
  - display completion source and declared evidence in run detail/past run UI.

Alias note: keep new schemas inside the existing `@contracts/schemas/loop`
surface. Do not add a new `@contracts/schemas/...` subpath unless the three
alias surfaces are updated together: `tsconfig.json`,
`tsconfig.electron.json`, and `src/main/register-aliases.ts`. If tests import a
new subpath, also update `vitest.config.ts`.

## Test Plan

Unit tests:

- `loop-control` rejects wrong loop id.
- rejects wrong iteration sequence.
- rejects wrong secret.
- rejects symlink intent file.
- rejects an `ORCHESTRATOR_LOOP_CONTROL_FILE` path that resolves outside
  `workspaceCwd` through `..` traversal.
- rejects overlarge summary/evidence.
- rejects overlarge intent files before JSON parse.
- imports newest valid intent and marks older ones superseded.
- ignores stale intent files from prior iterations.

Completion detector tests:

- `declared-complete` emits sufficient signal.
- `declared-complete` still requires verify.
- `declared-complete` still runs fresh-eyes review.
- forensic signals still work when no declared intent exists.
- child writes `complete` intent and renames a plan file to
  `*_completed.md`; coordinator records both signals, runs the gate once, and
  reports `declared-complete` as the primary source.

Coordinator tests:

- child writes complete intent; verify passes; loop completes with
  `signal=declared-complete`.
- child writes complete intent; verify fails; loop continues and emits
  `claimed-done-but-failed`.
- child writes complete intent; fresh-eyes blocks; loop continues with
  intervention.
- child writes block intent; loop pauses with structured block message.
- child writes block intent while `BLOCKED.md` also exists; coordinator prefers
  structured intent evidence.
- child writes fail intent; loop terminates with declared failure reason.
- child writes complete intent and callback returns provider error; coordinator
  imports intent and completes if verify/review pass.
- child writes complete intent in an iteration that consumed interventions;
  coordinator records it as deferred and does not run the completion gate.
- existing `_completed` rename regression still passes.

CLI tests:

- success writes atomically named JSON file.
- failure prints JSON and exits nonzero.
- command works from nested working directories.
- command refuses when env vars are absent.
- command reads `currentIterationSeq` from `control.json` on every invocation.

Integration tests:

- default invoker passes env vars to child adapter for each provider
  currently supported by Loop Mode (Claude and Codex).
- same-session and fresh-child context strategies both receive durable control
  env.
- same-session adapter runs multiple iterations and the helper uses the updated
  `currentIterationSeq` from `control.json`, not stale spawn-time env.
- app restart/import path does not spawn a second child when a valid intent is
  already present.

Resume-import tests (critical regression coverage for the off-by-one fix):

- child writes `complete` intent for iteration N; coordinator crashes before
  importing; on resume, the intent is imported at `iterationSeq === N ===
  state.totalIterations` (inclusive bound), not skipped.
- multiple intent files exist for the same iteration on restart; newest by
  `receivedAt` wins; older are marked `superseded`; differing kinds produce
  a warning log.
- v1 acceptance: on resume after an intervention-consuming iteration crashed,
  the imported `complete` intent runs the gate (no persisted
  `consumedInterventions` to honor). Test that the fresh-eyes review path
  still gates this case.

Terminal Intent Lifecycle tests:

- `terminalIntentPending` is cleared after `accepted`/`deferred`/`rejected`/
  `superseded` transitions.
- a stale `terminalIntentPending` carried into the next iteration's spawn
  boundary is logged and treated as rejected (defensive bug-catch).
- `complete` intent in intervention-consuming iteration → `status='deferred'`,
  no gate run, history records the intent.
- partial unique index rejects a second `accepted` row for the same
  `(loop_run_id, iteration_seq)`.

BLOCKED.md interaction tests:

- structured `block` intent + `BLOCKED.md` present at the same boundary:
  loop pauses with structured surface; `BLOCKED.md` is archived to
  `.aio-loop-control/<loopRunId>/blocked-handled-<iterationSeq>.md`;
  next pre-flight does NOT re-pause.
- only `BLOCKED.md` present (no structured intent): existing behavior is
  unchanged, file remains in place.

SEA build tests:

- `npm run build:loop-control-sea` produces a runnable binary on the host
  platform/arch.
- packaged build exposes the SEA binary outside `app.asar` at the path the
  coordinator exports through `ORCHESTRATOR_LOOP_CLI`.
- `preelectron:build` invokes `build:loop-control-sea` so a release engineer
  running `npm run electron:build` directly (skipping `npm run build`)
  still gets a packaged binary, not a missing-file failure.
- SEA binary validates env, writes intent JSON, and exits 0 on success.
- SEA binary exits nonzero with structured JSON on validation failure.
- in dev (no SEA binary present), the dev shim is executable, invokes
  `process.execPath` + bundle path, forwards arguments, and preserves
  `ORCHESTRATOR_LOOP_CLI` as a single executable path.

Import-failure and durability tests:

- per-file validation failure → intent marked `rejected` with
  `statusReason`, source file moved to `<controlDir>/rejected/`, iteration
  continues normally.
- directory-level I/O failure (`mkdir(intentsDir)` throws EACCES) →
  coordinator terminates the loop with `status='error'` and
  `endReason='loop-control-io-failed'`, not silent fallback to forensic
  signals.
- persist-then-archive ordering: simulate a crash *after* the
  `loop_terminal_intents` insert but *before* `archiveIntentFile` —
  startup reconciler imports nothing new (row already exists), source
  file is moved to `imported/` on first successful pass.
- persist-then-archive ordering: simulate a crash *between* read+validate
  and DB insert — source file stays in `intents/`, next boundary
  re-imports cleanly.
- startup reconciler: orphan file in `<controlDir>/imported/` with no
  matching DB row gets imported and a row is created (covers the residual
  "DB committed but rename failed" crash window).

BLOCKED.md archive error-handling tests:

- archive succeeds: BLOCKED.md renamed to
  `blocked-handled-<iterationSeq>.md`; next pre-flight does not re-pause.
- archive ENOENT (operator deleted manually): debug-log only, structured
  intent proceeds, no error event.
- archive EACCES / EBUSY / EEXIST: warn-log, `claimed-done-but-failed`
  emitted to surface the archive failure, BLOCKED.md stays in place,
  structured intent's pause still applies for the current boundary.

Required verification after implementation:

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npx tsc --noEmit -p tsconfig.electron.json
npm run lint
npm run test
```

## Open Questions

All previously-open questions in this spec have been resolved into the body
above:

- Control metadata lives under `.aio-loop-control/` workspace-local, with
  `.gitignore` protection (see Coordinator Flow).
- Intent import happens after child exit for v1 (see Coordinator Flow).
- Distribution is via Node SEA binary (see Distribution and Invocation).
- `failed` terminal status is adopted as the explicit path (see Completion
  Signal Changes); not collapsed into `error`.
- `consumedInterventions` is intentionally not persisted in v1; restart
  behavior is documented in Coordinator Flow (Restart caveat). A future
  spec can introduce persistence if telemetry shows the gap matters.

## Acceptance Criteria

- A child can declare completion through a structured command without relying
  on plan-file rename detection.
- The loop still does not stop until verify and configured fresh-eyes review
  pass.
- Existing forensic completion paths continue to work.
- A provider error after a valid completion intent cannot overwrite accepted
  completion.
- Operator-visible loop history shows the completion source and declared
  evidence.
- Invalid control calls are loud, structured, and nonzero.
- Full TypeScript, lint, and test suites pass.
