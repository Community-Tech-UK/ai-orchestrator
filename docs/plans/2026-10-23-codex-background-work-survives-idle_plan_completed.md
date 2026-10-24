# Codex background work survives idle sleep and wakes the agent when it finishes

**Status (23 October 2026): IMPLEMENTED AND VERIFIED — integrated live checks deferred.** Written from the incident in session `x0alws9dg`
("System Data 2TB Usage", Codex, GPT-6.1-Sol). All six implementation parts, canonical automated checks and the independent completion gate pass. Five checks requiring a newly started Harness and on-screen observation remain in [the live-check document](2026-10-23-codex-background-work-survives-idle_livetest.md). Kept untracked throughout implementation; no commit or push performed.

## 1. What happened (evidence)

All times are local (BST) on 23 October 2026.

| Time | Evidence | Source |
|---|---|---|
| 10:04:48 | Codex starts the Extreme → Crucial copy as one `exec` command: a Python wrapper that launches `caffeinate rsync …` and loops until rsync exits, writing `migration-state.json` every 30 s. The call never returns a result while the session is live, so Codex keeps it as a background terminal. | session state `conversationHistory`, call `exec-a238edba-…` |
| 10:25:18 | Codex calls `Monitor` on the **`claude-code` MCP server** (`claude mcp serve`, configured in `~/.codex/config.toml`). It returns "completed" within 3 s. | same; `~/.codex/config.toml` `[mcp_servers.claude-code]` |
| 10:25:43 | Agent tells James "Background monitoring is active" and ends the turn. 406 GB of 2.39 TB copied. | same |
| 10:55:55.789 | `IdleHibernationSweep` "Auto-hibernating idle root session", `idleMs` 1,811,823 (setting `autoTerminateIdleMinutes` = 30). The Codex process tree is shut down. | `logs/app.log.1` |
| 10:55:55.81 | `copy.log` last modified (mtime 1792749355.81). Wrapper and rsync both die. Last state write 10:55:49. Copy stopped at 909.7 GB (51%). | `_scratch/crucial-migration-2026-10-23/` |
| 14:07:00 | James sends "is this done now?". Session wakes; resume repair inserts a synthetic result for the orphaned Bash call. Agent finds `process_alive: false`. | `app.log`, `lifecycle.ndjson` |

The copy did not fail on its own. Harness killed it by putting the session to sleep.

## 2. Root causes

1. **Harness cannot see Codex background commands.** The "background work in progress" guard
   (`InstanceAsyncWorkRegistry.hasInhibitor`, `src/main/instance/instance-async-work-registry.ts:94`) already blocks
   idle hibernation (`hibernation-manager.ts:216`), the idle monitor (`idle-monitor.ts:321,375`) and the resource
   governor (`resource-governor.ts:355`). Only the Claude adapter ever reports work into it
   (`claude-cli-adapter.ts:1940` emits `async_work`). The Codex app-server adapters never emit `async_work`, so a
   Codex session running a long command looks idle.
   Codex 0.164.0 (installed) offers `thread/backgroundTerminals/list` returning
   `{ itemId, processId, command, cwd, osPid, cpuPercent, rssKb }` per live terminal, plus `…/terminate` and `…/clean`.
   The methods are in our generated protocol list (`codex/generated/app-server-protocol.gen.ts:49-51`). Nothing calls them.
2. **Nothing wakes a Codex session when its command finishes.** The same registry drives
   `InstanceAsyncWorkContinuation` (wake on completion via `async-result`, a single check-in after 10 silent minutes).
   Both are provider-neutral, but nothing feeds them for Codex, so neither runs.
3. **Codex is offered "monitor" tools that cannot call back.** `claude mcp serve` exposes `Monitor`, `ScheduleWakeup`,
   `CronCreate/Delete/List`, `RemoteTrigger`, `Workflow`, `PushNotification`, `Agent`, `SendMessage` and more (probed
   23 Oct). They run inside a separate Claude process whose notifications can only reach a Claude Code session. Called
   from Codex, they report success and do nothing, and the agent then tells the user monitoring is active.

## 3. Fix

### Part A: track Codex background terminals as background work

- New `src/main/cli/adapters/codex/codex-background-terminals.ts` (keep it under the TS max-LOC gate):
  - `listBackgroundTerminals(client, threadId)`: pages `thread/backgroundTerminals/list` until `nextCursor` is null.
    A method-not-found or capability error marks the feature unsupported for that adapter (logged once) and falls
    back to the in-flight-item signal below.
  - `CodexBackgroundTerminalTracker`: holds the last known set per root thread. On each refresh it emits one
    `async_work` `snapshot` (`workId` = `codex-term:<processId>`, kind `background-shell`). For each terminal that
    disappears it emits `terminal` with status `completed` (exit status is unknown at this point; the wake prompt
    asks the agent to check).
- **When to refresh:**
  - on `turn/completed`, if any `commandExecution` item that started in the turn has no `item/completed` (this is
    exactly how the copy looked), or the tracker already holds terminals;
  - every 60 s while the tracker holds at least one terminal, on an `unref`'d timer, stopped on adapter exit;
  - on demand from Part B.
- **Fallback when the list method is missing:** treat an unfinished `commandExecution` item at turn end as started
  work. Clear it on a later `item/completed` for that item id or on adapter exit. The 10-minute stalled check-in
  stops this from leaving a session awake indefinitely without the agent being asked.
- Wire the tracker into `codex-app-server-adapter.ts` / `codex-app-server-turn-adapter.ts` so it emits through the
  existing `'async_work'` adapter event (`base-cli-adapter.types.ts:382,400`). `bindRawAdapterProviderEvents` already
  routes it to the registry (`instance-communication.ts:1482-1488`). The routing code stays as it is.
- Check whether Codex sends `item/completed` for the command between turns when the process exits. If it does,
  emit `terminal` straight away rather than waiting for the next poll. Verify this live before relying on it.
- Make sure `clearInstance` runs on adapter exit or replacement, so a restarted session does not inherit stale work.

### Part B: final check before sleep, and no silent kills

- In `runIdleHibernationSweep` (`src/main/process/idle-hibernation-sweep.ts`), before hibernating a Codex instance,
  call a new adapter method `refreshBackgroundWork()` (a Part A refresh with a short timeout). Skip the instance if it
  reports live terminals or the refresh fails. Failing closed matters here because the cost of being wrong is lost user work.
- Every path that kills a Codex adapter (hibernate, user terminate, restart, provider/model swap, memory-pressure
  eviction) checks the tracker first. If terminals are live and the kill goes ahead anyway (user action, critical
  memory), log `Stopping session also stops background commands` with the count and add one plain transcript line,
  e.g. "Closing this session also stopped 1 background command (rsync …)". A kill should never be silent again.
- Keep the existing exclusions in the sweep (on-loan adapters, live loops, remote instances).

### Part C: wake the Codex agent when its command finishes

- Part A's `terminal` events let `InstanceAsyncWorkContinuation.onTerminal` fire for Codex as well, because it already
  accepts `idle`, `ready` and `hibernated`.
- Codex never starts its own turn, so the 15 s provider-resume grace only adds delay. Skip the grace for adapters that
  never emit `provider-resumed`. Use an adapter capability flag; don't check the provider name.
- Give the wake prompt the command: add an optional `detail` on the `terminal` event, so the prompt can read "A
  background command you started has finished: `<first 120 chars of command>`. Check its output, then continue the work
  you were waiting to complete." Without `detail`, Claude keeps the current text.
- The 10-minute stalled check-in then works for Codex unchanged.

### Part D: stop offering Codex tools that cannot call back

- In `CodexHomeManager` / `CodexTomlEditor` (`codex-home-manager.ts`), for any user MCP server whose command is the
  Claude CLI with `mcp serve`, add
  `disabled_tools = ["Monitor","ScheduleWakeup","CronCreate","CronDelete","CronList","RemoteTrigger","Workflow","PushNotification","SendMessage","ListAgents","TaskStop"]`
  in the generated home only. James's `~/.codex/config.toml` is never edited.
- Check that Codex 0.164 honours per-server `disabled_tools` (if not, use `enabled_tools` as an allowlist), and that
  `tools/list` from inside a Harness Codex session no longer shows them.
- Leftover risk, written down: `claude-code` `Bash` with `run_in_background` still hides work in the Claude process.
  Part E's prompt points the agent to Codex's own terminals.

### Part E: one prompt rule for Codex sessions

- Add one rule to the Harness developer instructions for Codex, following `docs/prompt-engineering-house-style.md`:
  start long commands as your own background command and end the turn; Harness keeps the session awake and messages
  you when the command exits; don't use another agent's monitor or schedule tools to watch your work.
- Only claim the work is being monitored when Harness shows it as background work (Part F).

### Part F: show it on screen

- Codex sessions get the existing background-work indicator (`InstanceBackgroundWork` summary via
  `instance-async-work-publisher.ts`) automatically. Check it renders for Codex and that the wording follows
  `docs/screen-and-wording-guide.md`, e.g. "1 background command running".

## 4. What could break

- Sessions with leaked or forgotten terminals (a dev server left running) stop going to sleep. That is the right result;
  the 10-minute check-in asks the agent to stop them, and the indicator shows why the session is awake.
- The poll costs one JSON-RPC call a minute per session with live terminals, and nothing otherwise.
- Wake prompts could duplicate if both the poll and an out-of-turn `item/completed` report the same exit. The
  registry already dedupes on `workId:status`; both sources must use the same `workId`.
- Older Codex builds without the method take the fallback path; the protocol snapshot check must not fail on that.

## 5. Checks

Targeted specs (new or extended):
- `codex-background-terminals.spec.ts`: paging, snapshot/terminal diffing, unsupported-method fallback, timer stops on exit.
- Codex adapter spec: an unfinished `commandExecution` at `turn/completed` triggers a refresh and an `async_work` snapshot.
- `idle-hibernation-sweep.spec.ts`: Codex instance with live terminals is skipped; refresh failure skips; no terminals hibernates.
- `instance-async-work-continuation` spec: Codex terminal event wakes an idle and a hibernated instance without the
  15 s grace and uses the command detail prompt.
- `codex-home-manager.spec.ts`: `disabled_tools` added only for `claude … mcp serve` servers; user file untouched.
- Kill-path spec: terminate with live terminals logs and adds the transcript line.

Then the full checklist in `AGENTS.md` (tsc, typecheck:spec, lint, max-LOC, ui-hints, build:main, build:renderer,
test:quiet).

Live checks requiring a newly started Harness main process and real provider turns are recorded in [the live-check document](2026-10-23-codex-background-work-survives-idle_livetest.md).

## 6. Out of scope

- Restarting James's copy. That is happening in session `x0alws9dg` itself; the copy is resumable (`--partial`, same
  destination) and the source drive is untouched.
- Claude-side background tracking, which already works.

## Implementation ledger

No separate spec is linked; the six parts above are the acceptance contract.

- [x] A: tracker, synchronous unfinished-item protection, paginated refresh, fallback, poll and reset; targeted tests passing.
- [x] B: fail-closed sweep, post-refresh eligibility checks, and retained transcript reporter across detached adapter kill paths; regression tests passing.
- [x] C: capability-driven completion continuation and command detail; busy completions defer until idle; polling snapshots do not reset the stalled check-in clock; targeted tests passing.
- [x] D: generated-home callback filter; installed 0.164.0 strict-config runtime probe confirms filtering without inference.
- [x] E: actual managed Codex binding opts into the rule; persistent app-server selection applies it, including warmed adapters; exec fallback and unbound reviews get no monitoring promise.
- [x] F: existing provider-neutral publisher/indicator retained; Codex snapshot publication and actual Angular row rendering verified.
- [x] Canonical verification and independent fresh completion gate; final evidence below.

Ruling: use the existing checkout and keep all work uncommitted, as James requires; generic skill worktree/commit steps do not apply.
Ruling: connection-level notifications feed the tracker, covering Harness-started and Codex-started turns without duplicating turn routing. The real-provider smoke verified completion notifications between turns; polling remains the fallback.
Ruling: preserve all user servers/settings; filter only the requested Claude-only callbacks in generated configuration, consistent with the rejected-decision register.

Verification evidence so far (all exit 0 unless noted):
- Codex adapter app-server/provider-turn regression set: 150 tests, `_scratch/test-run.pid-21197.log`.
- Latest tracker/adapter/communication regression set: 18 tests, `_scratch/test-run.pid-33091.log`.
- Config/prompt focused set: 48 tests, `_scratch/test-run.pid-79028.log`.
- Lifecycle/continuation/communication focused set: 75 tests, `_scratch/test-run.pid-42026.log`; stale-work follow-up 49 tests, `_scratch/test-run.pid-54644.log`.
- Codex indicator Angular render set: `_scratch/test-run.pid-6900.log`.
- Installed Codex 0.164.0 callback filter no-inference probe: `_scratch/codex-callback-filter-probe.log`; strict config accepted, only allowed Read returned.
- `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, file-size/UI-hint gates, both production builds passed. Renderer retains its existing initial-bundle budget warning. Final full-suite and fresh-gate evidence is recorded below.

Ruling: extract attachment preparation and the existing recoverable-turn predicate unchanged, and separate the shutdown notice sink, to remain below the existing TypeScript file-size ceiling without weakening the gate.
Ruling: stopped-work notices use a retained callback into the normal transcript publisher; ordinary adapter listeners are deliberately detached before several shutdown paths, so relying on `output` events alone would lose the notice.

Self-review follow-up: stopped-work transcript reporting now awaits its async durable sink before intentional adapter termination completes. Hibernating sessions append the stable-ID notice to existing continuity state and checkpoint it, without starting a new continuity service. Real-file regressions verify wake and fresh-manager restart restoration with ordinary forwarding both enabled and disabled (17 tests, `_scratch/test-run.pid-96370.log`). A failed transcript sink is logged and does not abort process shutdown (adapter regression `_scratch/test-run.pid-86360.log`).

Fresh review round 1: FAIL (`_scratch/codex-background-completion-review.md`). Independent typecheck caught a missing explicit return on the async hibernation reporter; corrected and both production/spec typechecks re-ran green. Reviewer reproduced a valid TOML Unicode-escape configuration causing startup failure; replaced JSON assumptions with TOML-aware string/table scanning, retained unrelated text, and assembled edits once. Unicode/multiline fixtures accepted by Python tomllib and installed Codex; 34 focused tests passed (`_scratch/test-run.pid-42874.log`). Shared TOML editor restored; no dependency change.

Own-review Part E follow-up: the shared instance prompt is built before provider resolution, so a requested-provider check misses default/auto/fallback Codex. Guidance was moved to the actual managed Codex adapter binding, gated on persistent app-server mode. Existing exec-native-resume prompt behavior remains intact; exec fallback has no persistent terminal tracking and receives no promise that ending a turn preserves background commands.

The first full suite was interrupted (exit 130) after reaching a regression against its earlier transformed code. It is not passing evidence. After implementation stabilizes, rerun the complete suite from a fresh runner and require an independent fresh PASS.

Part E final wiring: `CodexBaseAdapter.enableHarnessBackgroundWorkInstructions` records managed ownership through `InstanceCommunication` binding; actual app-server mode selection applies the rule before first input. Binding an already-spawned warm adapter applies it immediately when its resident-session capability is true. Config is copied and appending is idempotent. Shared prompt assembly no longer guesses the eventual provider. Real resolver/factory/spawn/RPC tests cover automatic/default/explicit/fallback Codex, resumed threads and warm-before-bind; managed fresh/resumed exec fallback and unbound reviewers receive no monitoring promise. Latest 35-test set: `_scratch/test-run.pid-3677.log`.

Ruling: keep the existing exec-native-resume prompt contract and restrict the background end-turn promise to managed persistent app-server sessions, because only that mode reports persistent commands to the registry. This avoids teaching an untracked or ephemeral process to end its turn while work is still running.

Fresh review round 2: FAIL (`_scratch/codex-background-completion-review-round2.md`). Installed Codex accepts dotted-root and parent-table inline MCP server declarations, but the table-header-only filter missed them. The fresh unfiltered run was stopped early (exit 130) because implementation was still incomplete; it is not passing evidence.

Ruling: replace the hand-written TOML reader with the maintained `toml-eslint-parser` runtime dependency, pinned at 1.0.3, using AST source ranges for surgical edits. Native-valid alternative declarations proved the previous strategy insufficient. Decode only scalar/array values, collect paths in Maps, and never convert user tables into plain objects. Keep unrelated text/comments and unknown values byte-for-byte rather than reserializing the full configuration. Package/lock changes add only this parser and its visitor-key dependency; no existing dependency pins change. OSV queries for parser1.0.3 and resolved visitor-keys5.0.1 returned no advisories. The production npm audit still reports existing advisory packages (none on the two additions), recorded in `_scratch/codex-background-dependency-audit.json`; do not apply unrelated audit fixes in this task.

AST correction verified: `toml-eslint-parser` decodes TOML 1.1 syntax (also accepted by installed Codex); Map-backed path collection handles tables, dotted leaves, root/parent/nested inline tables and quoted/prototype-like server names. Only decoded string/array leaves are used; no plain-object table conversion. Source ranges preserve unrelated content. The final injected-home composition is filtered too, including retained inline user servers the existing stripper does not remove. Native no-inference probes passed all eleven forms and an actual two-server generated home (`_scratch/codex-callback-all-forms-probe.log`, `_scratch/codex-callback-prepared-home-probe.log`). Focused 45 tests and both typechecks pass (`_scratch/test-run.pid-4938.log`). Electron's own Node 24.19.0 loaded the exact pinned ESM parser through CommonJS require successfully.

Post-refresh sweep rechecks now use a direct production instance lookup rather than rebuilding/scanning all sessions per candidate. Legacy callers keep the list fallback; removed/currently active sessions still fail closed. Dynamic live-loop guards remain. Focused sweep/startup regression set: 26 tests, `_scratch/test-run.pid-17488.log`.

Fresh review round 3: source/acceptance review had no actionable task-source findings, with 157 independently rerun focused tests, production typecheck, dependency security checks, secret scan and native probes passing. Its gate verdict is FAIL because the full suite exposed packaging failures under global Homebrew Node26.12.1 (no SEA fuse), plus one account-login timeout. Full run was interrupted (130), not claimed green. The project pins official self-contained Node24.22.1 in `.nvmrc`/`.mise.toml`; it is already installed under NVM and its SEA fuse was directly verified. No source/test/timeout changes are needed for runtime selection. All 32 reviewed source/package fingerprints remain unchanged. Rerun all gates and the full suite with that pinned Node prepended to PATH; then obtain a new fresh verdict.

Pinned-runtime verification: all seven non-test canonical gates pass under project-pinned NVM Node24.22.1. The exact failed SEA repeatability/account-login specs reran green without changing tests/timeouts (13 tests, `_scratch/test-run.codex-background-pinned-runtime.log`).

Live native-provider smoke (real model request, isolated ephemeral thread and harmless timer command): GPT6.1-Sol emitted `commandExecution` started/inProgress, left it unfinished at turn end, and triggered automatic tracker refresh/snapshots with one native terminal. Natural exit emitted `item/completed` between turns; tracker delivered completed and cleared work. No spontaneous provider turn resumed. This directly verifies the native signal and immediate completion path, while polling remains the fallback (`_scratch/codex-background-live-provider-probe.log`). Temporary private home/thread/client were cleaned up. Initial nested read-only/workspace sandbox probes could not launch due `sandbox-exec: sandbox_apply: Operation not permitted`; the successful probe uses the normal non-hardened full-auto app-server mode required by this feature. Integrated new-Harness five/ten-minute/UI checks remain in the live-test doc.

## Final verification and as-built status

- All seven canonical non-test gates completed with exit 0 under the repository-pinned Node 24.22.1: production typecheck, spec typecheck, lint, TypeScript size limits, UI hints, main build and renderer build. Raw logs are `_scratch/codex-background-{tsc,spec-types,lint,loc,ui-hints,build-main,build-renderer}-final.log`. The renderer retains its existing bundle-budget warning; no production renderer code changed.
- The current unfiltered `npm run test:quiet` completed with actual exit 0: 2,746 files, 34,987 passed tests and seven existing skips. Independently parsed raw JSON reports `success: true`, zero failed tests and zero failed suites. Evidence: `_scratch/test-run.codex-background-pinned-full.log` and `_scratch/test-results.codex-background-pinned-full.json`. Earlier interrupted runs are not passing evidence.
- Fresh independent completion review round 4 returned **VERDICT: PASS**, with no unresolved actionable finding: `_scratch/codex-background-completion-review-round4.md`. It independently traced A–F, reviewed test integrity, dependencies/security, lifecycle/persistence, async/state, performance and the existing rendered indicator; reran 157 focused tests and production typecheck; checked the native consumer and scanned the scoped changes for secrets. It separately parsed the final full-suite JSON/log and confirmed all 32 reviewed source/package fingerprints remained unchanged.
- The generated Codex home filters the specified Claude callbacks using the maintained TOML AST parser. Native strict-config probes cover eleven equivalent declarations and the final retained-plus-injected two-server home. User configuration remains untouched. The background instruction is restricted to managed persistent app-server sessions; exec fallback and unbound review workers receive no survival promise.
- Task-created probe homes and temporary bundles were removed; small logs, scripts and review evidence remain in ignored scratch storage. Work stayed in James's existing checkout, uncommitted; no branch/worktree, commit, push, deployment, app restart, idle-setting change or drive-copy action was performed.
- Remaining integrated live observations are recorded only in [the live-check document](2026-10-23-codex-background-work-survives-idle_livetest.md). They are deferred, not verified. The original Claude MCP Bash background-command limitation remains as recorded there.

This plan is closed after the code, all agent-runnable gates and the independent review passed. Reopen it or create a follow-up before adding new implementation scope.
