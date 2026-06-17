# Codex Reliability Fix Plan (2026-06-11)

## Status: COMPLETED — implemented at HEAD and targeted verification passed on 2026-06-16

Completion note: the Codex reliability fixes in this plan are present in source
and covered by targeted tests. Full-suite verification on 2026-06-16 still had
unrelated failures in default invoker routing, loop defaults/caps, bare-mode
defaults, and auxiliary LLM default settings.

## Background / evidence

User perception: "Codex is far less reliable than Claude in AIO." Investigation of
`~/Library/Application Support/ai-orchestrator/logs/app.log` (Jun 1–11) plus code
tracing found the unreliability is mostly **AIO plumbing**, not the Codex CLI:

| # | Signature (count, current log) | Actual root cause |
|---|---|---|
| 1 | `spawn codex ENOENT` (21×, retried→42 lines) from `CrossModelReviewService`; `spawn claude ENOENT` (59×) from `WarmStartManager` | **Missing cwd, not missing binary.** Reviews/warm-starts of *remote-node* instances spawn locally with the remote machine's working dir (`C:\Users\shutu\Documents\Work` on this Mac). Node reports a nonexistent cwd as `spawn <cmd> ENOENT`. Proof: gemini, cursor-agent and codex all ENOENT'd in the same millisecond while `CliDetection` reported all available. |
| 2 | `Codex exec idle timeout` / `timed out after 120000ms during turn` (14×) killing reviews; `60000ms during startup` (9×) killing loop iterations | The review path passes `crossModelReviewTimeout` (user setting, 120s) as `CodexCliConfig.timeout`, which `resolveTurnIdleTimeoutMs()` (codex-cli-adapter.ts:353) treats as an **idle** budget. Codex exec `--json` emits output only at item boundaries, so any silent reasoning stretch >120s is killed mid-work. Claude streams deltas continuously and never trips its watchdog. |
| 3 | ENOENT logged as `"Codex exec threw transient error, retrying"` | Spawn errors fall through to the generic transient-retry branch (codex-cli-adapter.ts:2416). A spawn ENOENT can never succeed on retry. |
| 4 | `"Reading prompt from stdin..."` surfaced as the user-visible error (~20×) | Stderr-banner leakage. Mostly fixed by commit `57491fa4` (2026-06-08) — but the installed `/Applications/AI Orchestrator.app` build predates it, and one residual leak path remains (see Phase 4). |

Why Claude *feels* solid: it logs 5× more error lines (1225 vs 221) but they are
recoverable warnings on a persistent streaming process. Codex failures are
**terminal to the operation** (review failed, loop iteration failed).

## Key code locations (verified at HEAD)

- `src/main/orchestration/cross-model-review-service.ts:212` — `workingDirectory: instance?.workingDirectory || process.cwd()` (no remote check, no existence check)
- `src/main/orchestration/cross-model-review-service.ts:317-327` — `createAdapter({ options: { workingDirectory, timeout: timeoutSeconds * 1000, ... } })`
- `src/main/instance/instance-lifecycle.ts:1592-1597` — `void wsm.preWarm(warmProvider, instance.workingDirectory)` (no remote check)
- `src/main/cli/adapters/base-cli-adapter.ts:472-496` — `spawnProcess()` (cwd passed unvalidated to `spawn`)
- `src/main/cli/adapters/codex-cli-adapter.ts:2328-2426` — `sendMessageExec()` retry loop
- `src/main/cli/adapters/codex-cli-adapter.ts:2512-2812` — `executePreparedMessage()` (idle watchdog, stdin write, error surfacing)
- `src/main/cli/adapters/codex-cli-adapter.ts:353-359` — `resolveTurnIdleTimeoutMs()` (conflates configured timeout with idle budget)
- `src/main/cli/adapters/codex/exec-error-classifier.ts` — classifiers (new code goes here, NOT in the 3000-line adapter — ts-max-loc ratchet)
- `src/shared/types/worker-node.types.ts:179` — `ExecutionLocation = { type: 'local' } | { type: 'remote'; nodeId: string }`
- Instance has `executionLocation: ExecutionLocation` (`src/shared/types/instance.types.ts:374`)

Adapter-`timeout` producers (audit done): `cross-model-review-service.ts` (120s),
`magic-prompt-service.ts`, `multi-provider-compare-service.ts`,
`auto-title-service.ts`, `default-loop-invoker-helpers.ts` (30 min). **All are
one-shot flows whose intent is a total deadline, not an idle budget.** This makes
Phase 3's semantic change safe-by-intent, but each site must still be re-checked
during implementation.

---

## Phase 1 — Stop spawning local CLIs with remote/invalid working directories

### 1a. CrossModelReviewService: skip in-session reviews of remote instances

`onInstanceIdle()` (cross-model-review-service.ts:155): after fetching
`instance`, add:

```ts
if (instance?.executionLocation?.type === 'remote') {
  logger.info('Skipping cross-model review for remote instance', {
    instanceId, nodeId: instance.executionLocation.nodeId,
  });
  return;
}
```

Rationale: reviewers get the content in the prompt, but they run with
`workingDirectory` for file context. For a remote instance the files don't exist
locally — a local review would be both crash-prone (ENOENT) and *wrong* (no file
access). Skipping is correct; routing reviews to the node is a follow-up (see
"Out of scope").

### 1b. CrossModelReviewService: validate cwd exists for local instances

Replace line 212 with a resolved, validated directory:

```ts
const workingDirectory = resolveReviewWorkingDirectory(instance?.workingDirectory);
```

New helper (put in `cross-model-review-service.helpers.ts`, which already exists):

```ts
export function resolveReviewWorkingDirectory(candidate: string | undefined): string {
  if (candidate) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch { /* fall through */ }
    logger.warn('Review working directory missing or not a directory — falling back', { candidate });
  }
  return process.cwd();
}
```

### 1c. WarmStartManager call site: skip pre-warm for remote instances / missing dirs

`instance-lifecycle.ts:1592`: guard the fire-and-forget:

```ts
if (this.deps.warmStartManager && !config.resume
    && instance.executionLocation?.type !== 'remote') {
  ...
}
```

Belt-and-braces: inside `WarmStartManager.preWarm()` (warm-start-manager.ts:46),
verify the directory exists before calling `spawnAdapter`; log + return if not.
This protects every current and future caller, including races where a worktree
was deleted after instance creation.

### 1d. Centralized guard in `BaseCliAdapter.spawnProcess()`

This is the layer that converts *all* future occurrences of this class of bug
from a misleading `spawn <cli> ENOENT` into an actionable error. In
`spawnProcess()` (base-cli-adapter.ts:472), before `spawn()`:

```ts
if (this.config.cwd && !directoryExists(this.config.cwd)) {
  throw new CliSpawnCwdError(this.config.command, this.config.cwd);
}
```

`CliSpawnCwdError` message: `Working directory does not exist: <cwd> (cannot
spawn <command>)`. Put the error class + `directoryExists` helper in
`base-cli-adapter-utils.ts`.

**Edge cases — Phase 1:**
- `executionLocation` undefined (legacy/persisted instances) → treat as local. Use optional chaining; never throw.
- Windows-style path on macOS (`C:\...`) → `statSync` throws → handled by fallback/skip.
- cwd exists but is a *file* → `isDirectory()` check covers it.
- Worktree deleted between check and spawn (TOCTOU) → rare; Phase 2's fatal classification still produces a sane non-retried error.
- `process.cwd()` of a packaged Electron app can be `/`. Spawning there works (reviews carry content in the prompt); identical to today's fallback behavior, so no regression. Do NOT use `os.homedir()` — it changes behavior for the headless review CLI entrypoint.
- Headless path (`runHeadlessReview` → `ProviderReviewExecutionHost.dispatchReviewerPrompt`, review-execution-host.ts:64): `cwd` comes from the request (CLI entrypoint / loop gate). Apply the same `resolveReviewWorkingDirectory` validation in `runHeadlessReview` before dispatch. Do NOT add a remote check there (no instance concept).
- `spawnProcess` is also used by claude/gemini/copilot/cursor adapters and the scripted adapter used in tests — the new throw must be exercised in `base-cli-adapter` specs and must NOT fire when `config.cwd` is undefined (spawn falls back to the process cwd; leave that path untouched).
- Remote instances legitimately spawn via `RemoteCliAdapter` (no local process) — confirm during implementation that `RemoteCliAdapter` does not extend the base `spawnProcess` local-spawn path with a remote cwd (it routes via RPC; the guard must not break it).

---

## Phase 2 — Classify spawn errors as fatal (never retry) and disambiguate the message

### 2a. New classifier in `codex/exec-error-classifier.ts`

```ts
const FATAL_SPAWN_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR']);

export function isFatalSpawnError(error: unknown): boolean {
  const err = error as NodeJS.ErrnoException | undefined;
  if (err?.code && FATAL_SPAWN_CODES.has(err.code) && err.syscall?.startsWith('spawn')) return true;
  // Fallback for errors that lost their errno shape through wrapping:
  return /spawn .+ (ENOENT|EACCES|EPERM|ENOTDIR)/.test(String(err?.message ?? error));
}
```

### 2b. Use it in `sendMessageExec()` retry loop

In the `catch` block (codex-cli-adapter.ts:2378), after the `CodexTimeoutError`
check and before the transient-retry fallthrough:

```ts
if (isFatalSpawnError(lastError)) {
  logger.error('Codex spawn failed — not retrying', {
    attempt, errorMessage: lastError.message, cwd: this.config.cwd,
  });
  throw enrichSpawnError(lastError, this.config.command, this.config.cwd);
}
```

### 2c. `enrichSpawnError` — say *what* is missing

Node's `spawn x ENOENT` is ambiguous (missing binary vs missing cwd). Add a
helper (also in `exec-error-classifier.ts` or `base-cli-adapter-utils.ts`, since
it is useful to all adapters):

```ts
export function enrichSpawnError(error: Error, command: string, cwd?: string): Error {
  if (cwd && !directoryExists(cwd)) {
    return new Error(`Working directory does not exist: ${cwd} (spawning ${command}). Original: ${error.message}`);
  }
  return new Error(`CLI binary "${command}" not found on PATH. Original: ${error.message}`);
}
```

Note: with Phase 1d in place the missing-cwd branch should rarely be reached
(TOCTOU only) — keep it anyway.

**Edge cases — Phase 2:**
- Order matters in the catch block: `CodexTimeoutError` → **fatal spawn** → recoverable-thread-resume → model-unavailable → max-attempts → transient. A spawn error must never be mistaken for a resume error (resume classifier is message-regex based — verify `spawn codex ENOENT` doesn't match `isRecoverableThreadResumeError`; add a spec asserting it).
- Windows + `shell: true`: cmd.exe spawning succeeds even when the CLI is missing; failure surfaces as exit code + stderr, not ENOENT. The classifier simply won't fire there — that's fine (`resolveWindowsCliLauncher` handles binary resolution on Windows). Don't try to message-match cmd.exe's "not recognized" text in this phase.
- EACCES on the binary (not executable) → correctly fatal.
- The model-unavailable retry in `sendMessage()` (line 2305) calls `sendMessageExec` again — a fatal spawn error thrown from the second call must still propagate (it does; no change needed, but add a spec).
- The circuit breaker in `executeOneReview` (`cross-review-codex`, threshold 3) now opens faster on genuine install problems — desired.

---

## Phase 3 — Separate "total deadline" from "idle watchdog" in codex exec mode

### Problem recap

`CodexCliConfig.timeout` is consumed by `resolveTurnIdleTimeoutMs()` as the
**idle** budget. Every producer (reviews 120s, loop 30 min, magic-prompt,
compare, auto-title) intends a **total** deadline. For codex's bursty output,
idle(120s) ≈ guaranteed kill on any long generation.

### Design

In exec mode (`executePreparedMessage`):

1. **Idle watchdog** uses ONLY the built-in constants:
   startup `EXEC_STARTUP_MS` (60s) escalating to `EXEC_TURN_MS` (900s) on first
   stdout — exactly the current escalation logic, but no longer overridable by
   `cliConfig.timeout`.
2. **New absolute deadline timer**: `deadlineMs = cliConfig.timeout ?? EXEC_TURN_MS`
   measured from spawn. On expiry, same kill path as the idle timeout
   (partial-output return when `allowPartialOnTimeout`, else
   `CodexTimeoutError`), with a distinct reason: `phase: 'deadline'` so logs and
   the UI can distinguish "hung silent" from "ran out of total budget".
3. `resolveTurnIdleTimeoutMs()` becomes: `min(EXEC_TURN_MS, deadlineMs)` — the
   idle budget never exceeds the total deadline (a 30s deadline shouldn't wait
   60s idle to report).
4. **App-server mode**: `resolveNotificationIdleTimeoutMs()` currently inherits
   the configured timeout as the active-item idle budget. Apply the same
   principle: notification idle uses `NOTIFICATION_IDLE_MS` /
   `NOTIFICATION_IDLE_ACTIVE_MS`, both capped by the deadline. (Reviews use
   one-shot exec so this is secondary, but keeps semantics coherent.)

`CodexTimeoutError` gains `kind: 'idle' | 'deadline'` (keep the existing
`phase` field for startup/turn).

### Why not a new config field

A separate `deadlineMs` option would need plumbing through
`ProviderRuntimeStartInput` → `adapter-factory` (6 sites) → every caller, and
leaves the old `timeout` field with a trap semantics. Since every existing
producer already *means* "total deadline", redefining `timeout` for the codex
adapter matches intent with zero call-site churn. Claude/gemini/copilot adapters
are untouched (their `timeout` semantics stay as-is).

**Edge cases — Phase 3:**
- **Per-attempt vs per-message deadline**: the retry loop runs up to 2 attempts; the deadline applies per `executePreparedMessage` call (per attempt). Document this; a review with a 120s setting can take ~240s worst case across retry — acceptable, matches today's behavior for other error classes.
- Loop mode (`default-loop-invoker-helpers.ts`, 30 min): idle becomes 900s under an 1800s deadline. Today's effective behavior was idle=1800s — slightly tighter now. 900s silent is already the tuned "genuinely hung" threshold for instance turns, so this is an improvement, but call it out in the PR description.
- Reviews with codex still need to FINISH within 120s of total work. If real codex reviews routinely need longer, that's a settings problem, not a watchdog problem — the new `kind: 'deadline'` error message must say so explicitly: `Codex review exceeded the configured crossModelReviewTimeout (120s) — consider raising it`. This converts an opaque failure into a user-actionable one.
- Partial-output-on-deadline: review responses must be complete JSON, so partial returns don't help reviews (parse just fails). Only honor `allowPartialOnTimeout` (loop mode) as today.
- `timeout: 0` / negative / `NaN` → treat as unset (existing `Number.isFinite(x) && x > 0` guard pattern; keep it).
- Constructor default trap: `adapterConfig.timeout: config.timeout || 300000` (line 306) feeds the **base** adapter config, while exec mode reads `this.cliConfig.timeout`. Verify nothing in the base class applies the 300s default to exec turns (it doesn't today — keep it that way, add a spec).
- Don't start the deadline timer before stdin is written; start it at spawn (cold-start time counts toward the deadline — that's what callers mean).
- Clear the deadline timer in every exit path: `close`, `error`, idle-fire, interrupt/terminate. Audit `terminate()` interplay (review `finally` blocks call `adapter.terminate(false)`).

---

## Phase 4 — Error-surfacing polish

### 4a. Fix the multi-line stderr-remainder leak

At process close (codex-cli-adapter.ts:2763), the unterminated stderr remainder
is classified as ONE diagnostic: `classifyCodexDiagnostic(state.partialStderr)`.
If that blob is `"Reading prompt from stdin...\nError: thread/resume failed..."`,
then either (a) the benign filter (`isBenignCodexStdinNotice`, anchored `^`)
matches and the REAL error is filtered out with it, or (b) it doesn't match and
the banner leaks into the surfaced message. Fix: split the remainder into lines
first:

```ts
if (state.partialStderr.trim()) {
  for (const line of state.partialStderr.split('\n')) {
    if (line.trim()) state.diagnostics.push(classifyCodexDiagnostic(line));
  }
}
```

### 4b. Make `CodexTimeoutError` messages actionable

Current: `Codex exec timed out after 60000ms during startup`. The watchdog
already collects rich diagnostics (network error count, last network error,
stderr tail — lines 2559-2578) but only logs them. Include them in the error:

- idle/startup, zero bytes: `Codex produced no output for 60s during startup
  (possible auth or network hang)` + last network error if present.
- idle/turn: `Codex went silent for 900s mid-turn after <stdoutBytes> bytes` +
  network info.
- deadline: see Phase 3 wording.

These strings end up in `Review failed` / `Loop iteration invocation failed`
log lines and the UI — that's where James actually sees them.

**Edge cases — Phase 4:**
- Keep messages single-purpose and machine-greppable; don't change the `CodexTimeoutError` class name or the `instanceof` checks (retry loop, loop coordinator, provider-notice handling may match on it — grep consumers first: `rg CodexTimeoutError src`).
- `isProviderNotice()` interplay (memory: throttled CLIs return rate-limit text as content): error message changes must not accidentally start matching provider-notice patterns. Check `src/main/cli/provider-notice.ts` patterns against new strings.
- Diagnostics can contain user prompt fragments echoed by codex — the stderr tail in *log* lines is fine (already logged today), but keep tails out of the user-facing error `message` except the last classified error line.

---

## Phase 5 — Tests

All Vitest, colocated specs. Singletons reset via `_resetForTesting()`.

1. `cross-model-review-service.spec.ts` (exists — extend):
   - remote instance (`executionLocation: { type: 'remote', nodeId }`) → no adapter created, review skipped, no `review:started` emitted.
   - missing/`C:\`-style/file-not-dir workingDirectory → adapter created with `process.cwd()` fallback, warn logged.
   - legacy instance without `executionLocation` → treated local (review proceeds).
   - headless `runHeadlessReview` with bad `cwd` → validated fallback.
2. `warm-start-manager.spec.ts` (exists — extend): `preWarm` with nonexistent dir → no `spawnAdapter` call, no throw.
3. `instance-lifecycle` spec (find existing): remote instance spawn → `preWarm` not invoked.
4. `base-cli-adapter` specs: `spawnProcess` throws `CliSpawnCwdError` for missing cwd; undefined cwd unaffected.
5. `exec-error-classifier.spec.ts` (new file or extend existing spec dir):
   - `isFatalSpawnError` truth table: errno-shaped ENOENT/EACCES with `syscall: 'spawn'`; message-only fallback; NOT matching plain "file not found" tool errors or resume errors.
   - `spawn codex ENOENT` does NOT satisfy `isRecoverableThreadResumeError` (cross-check).
   - `enrichSpawnError` cwd-missing vs binary-missing branches.
6. `codex-cli-adapter.spec.ts` (exists — extend, uses scripted child-process mocks):
   - spawn-error rejection → single attempt, no transient retry, enriched message.
   - idle watchdog uses EXEC constants when `timeout` configured (120s config no longer kills at 120s idle pre-escalation… assert idle budget = min(EXEC_TURN_MS, 120s) per design — i.e. deadline dominates for small configs).
   - deadline fires at configured total with `kind: 'deadline'`; idle fires with `kind: 'idle'`.
   - deadline + `allowPartialOnTimeout` returns partial transcript.
   - timers cleared on close/error/terminate (no unhandled timers — vitest fake timers).
   - multi-line stderr remainder split: blob with banner + real error → real error surfaced, banner filtered.
7. App-server path: `resolveNotificationIdleTimeoutMs` capped by deadline (unit test on the method or via app-server spec helpers).

## Phase 6 — Verification & rollout

1. `npx tsc --noEmit` && `npx tsc --noEmit -p tsconfig.spec.json`
2. `npm run lint` (ng lint + oxlint — NOT raw eslint) and `npm run check:ts-max-loc`
   — codex-cli-adapter.ts is near the ratchet; all new logic lives in
   `codex/exec-error-classifier.ts` / helpers files.
3. Targeted vitest runs for the specs above, then full `npm run test`.
4. **Live verification** (required before claiming done):
   - `npm run dev`; with the Windows remote node connected, run a remote
     instance to idle → confirm log shows "Skipping cross-model review for
     remote instance" and zero `spawn * ENOENT`.
   - Local instance review with codex reviewer → completes (or fails with the
     new actionable message), no idle-kill at 120s while codex is mid-burst.
   - Temporarily rename the codex binary → review fails ONCE with "binary not
     found", no retry, breaker counts it.
5. **Re-baseline**: the installed `/Applications/AI Orchestrator.app` predates
   commit `57491fa4` — several logged signatures are already fixed at HEAD.
   After packaging (no new contracts subpaths, no native deps → standard
   `npm run build`), watch `app.log` for 2–3 days: expect `spawn codex ENOENT`
   → 0, `timed out after 120000ms` → replaced by deadline messages or
   successes.
6. Beware the concurrent loop-writer hazard (memory): check for in-repo
   `claude --print` writers before starting the campaign.

## Out of scope / follow-ups (do NOT bundle)

- **Routing reviews to the owning remote node** (run the reviewer CLI on the
  node where the files live). Real feature; needs remote-node RPC design.
- Loop-level retry/backoff for startup-phase codex timeouts (one network blip
  currently terminates a loop iteration; the loop coordinator could retry the
  iteration once). Separate change in `loop-coordinator.ts`.
- Per-provider review timeouts (`crossModelReviewTimeoutByProvider`) if codex
  reviews genuinely need more than the shared setting.
- Windows `shell:true` missing-binary detection (cmd.exe "not recognized").

## Implementation order

Phase 1 → 2 → 4a (small, independent, kill the top failure mode) — then
Phase 3 (semantic change, biggest review surface) — then 4b — tests alongside
each phase, full suite + live verification at the end.
