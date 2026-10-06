# Live tests — stranded worktree rescue (LT-536 and rescue report items 15, 16, 8)

## Status — 2026-10-04 (livetest campaign batch D)

Open: 1 (LT-5: the on-screen spend meter this check describes is switched off in the current UI, so the
check as written cannot be satisfied; the underlying behaviour was observed live — decision needed) ·
Closed: LT-1 (read-only evidence from the packaged app's real restart), LT-6 sub-check 3 (stale credentials
refused, emulated) · Failed: 0 · New defects: 0. Full write-up: [Evidence run — 2026-10-04 (batch
D)](#evidence-run--2026-10-04-batch-d).

## Status — 2026-09-24 (verify-final)

Re-checked LT-640's UI half and LT-641's positive path a third time, against the ~03:45 working-tree
rebuild (newer than `verify-loops`'s ~03:00 pass). **Both are now CONFIRMED FIXED LIVE.** LT-640: a
real Claude loop with `isolateLoopWorkspaces`/`autoIntegrateWorktree` that adds an active plan
document ended `workspace blocked`, and the "Past loop prompts" panel showed the correct final text
("workspace blocked · Session adds active plan/spec/livetest documents; land it manually · saved on
task-…") the first time it was opened, with **no page reload** at any point — matching the new
`terminalSummaryRefreshKey()` fix (`loop-terminal-summary-key.ts`) that keys the panel's refresh on
`loopRunId:phase` instead of `loopRunId` alone. LT-641: both a `secret_required` ask and an
`ask_questions` ask rendered `app-user-action-request` **inside the open `app-chat-detail` view**
immediately (no navigation to Workboard needed), matching the new
`chat-detail.component.html:162` mount site. Full write-up:
[Evidence run — 2026-09-24 (verify-final)](#evidence-run--2026-09-24-verify-final).

## Status — 2026-09-24 (loops batch)

Open: 3 (LT-1 not run, LT-5 partial/by-design-invisible, LT-6 sub-check 3 not run) · Closed: 3
(LT-2, LT-3, LT-7 core cases) · Failed: 1 (LT-4's UI-visibility half) · New defects: 2 (LT-640,
LT-641)

Driven against a real dev app (HEAD `f04f6748`) with two disposable scratch git repos under
`/tmp/aio-lt-0924-loops-work/`. Full write-up: [Evidence run —
2026-09-24 (loops batch)](#evidence-run--2026-09-24-loops-batch).

## Status — 2026-09-24 (verify-loops)

Re-checked the LT-640/LT-641 "FIXED IN CODE" fixes against the **working tree** (uncommitted fixes,
not HEAD `f04f6748`). LT-640: the Zod schema fix is confirmed live (no more validation blocks), but
the check-2/check-4 UI acceptance ("Past loop prompts row updates without a reload") still **fails**
live for a second, independent reason — **REOPENED**. LT-641: the schema fix is confirmed live and
the secret card renders correctly when the Workboard's instance-detail view is open, but it **never
renders inside the primary chat view** (`app-chat-detail`) that a user is normally looking at when an
agent asks — **REOPENED**, narrower cause than originally filed. Full write-up: [Evidence run —
2026-09-24 (verify-loops)](#evidence-run--2026-09-24-verify-loops).

Full write-up (loops batch): [Evidence run —
2026-09-24 (loops batch)](#evidence-run--2026-09-24-loops-batch). Headline finding: **two real,
reproducible "renderer never learns the outcome" defects**, both the same root-cause shape (a
`.strict()` Zod renderer-event schema missing a field/enum member the main process actually sends,
so the whole event is silently dropped by `RendererEventValidation` and the UI is stuck on stale
data until the page reloads or, in the secret-card case, forever):

- **LT-640 (new, P2)** — `loop:state-changed`'s `lifecycleOnly` broadcast (used for the
  post-completion worktree-lifecycle transition — promoted/blocked/cleaned) is rejected because
  `LoopStateChangedEventSchema` doesn't declare `lifecycleOnly`. Reproduced twice (an uncommitted-root
  block and an active-plan-document block): the DB/backend always had the correct final phase and
  `lastError` immediately, but the "Past loop prompts" row stayed on a stale mid-run caption
  ("saving session work") until the renderer page was reloaded, at which point a fresh IPC load
  showed the correct "promotion blocked"/"workspace blocked" text. This directly affects the UI text
  LT-2 and LT-4 below depend on.
- **LT-641 (new, P1)** — the `secret_required` positive path (LT-537's "switch back on, expect the
  secret card to appear") is completely non-functional: `UserActionRequestEventSchema`'s
  `requestType` enum never included `'secret_required'` (or `'input_required'`) and has no
  `secretRequest` field, so every `user-action:request` event for a secret ask is rejected outright
  and the card can never render, in any build, regardless of the setting. Only the *disabled* refusal
  path works, because it never reaches this event at all.

## Status — 2026-09-18

Open: 7 · Closed: 0 · Failed: 0
Needs a rebuilt and relaunched Electron instance (`npm run build:main` + `npm run build:renderer`,
then restart Harness). Everything else in this work is verified in-loop by unit tests.

> **Found a defect while running these checks?** Record it in the remediation
> register — `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN`
> item (index row, then observed behaviour, root cause, required behaviour and
> acceptance), and add the matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check
> evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

**Report:** [2026-09-18-stranded-worktree-rescue_report.md](./2026-09-18-stranded-worktree-rescue_report.md)
**Register:** LT-536 in [livetest-remediation-register.md](./livetest-remediation-register.md)

## Why these are deferred

The harvest fix, the active-plan-document landing guard, the moved-tip guard, the block-overlap
promotion rule, the resolve action and the spend-meter provenance are all covered by unit tests
(`worktree-manager.spec.ts`, `loop-worktree-lifecycle.spec.ts`,
`loop-worktree-lifecycle-reconcile.spec.ts`, `loop-worktree-resolve.spec.ts`,
`loop-worktree-resolve-handler.spec.ts`, `loop-store.spec.ts`,
`managed-worktree-status.util.spec.ts`, `loop-past-runs-panel.component.spec.ts`,
`loop-control-timeline.spec.ts`). Those are **not** deferred and must not be re-listed here.

What is left needs the packaged/rebuilt app: the boot-recovery path only runs at app start, the
loop UI controls only exist in a running renderer, and the original defect only reproduced under
the packaged app's PATH (no `node`, so the pre-commit hook exited 127).

**Before running these:** the eight stranded runs are still `blocked` with their worktree folders
in place. Check 1 depends on that state, so run it first, before using "Mark resolved" (check 3) on
any of them.

## LT-1 — a blocked run with an operator commit is left alone across a restart

1. Confirm the eight `.worktrees/task-*` folders exist, are clean, and their branch tips are the
   `rescue:` safety commits listed in the report table.
2. Restart Harness (rebuilt build).
3. Expect: all eight folders still present, branches unchanged, `main` unchanged, and no
   `integration/main` branch created. Each run's loop history row reads `workspace blocked ·
   Session branch changed outside AIO; review it before landing · saved on task-…`.
4. Evidence: `git worktree list`, `git branch --list 'integration/*'`, `git log -1 main`, and the
   row text.

Note: on the OLD build this same restart would delete all eight folders, so a failure here is a
regression against the whole point of the fix.

## LT-2 — a loop lands even though the root has untracked plan documents

1. With the root checkout holding its usual untracked `docs/plans/*.md` files (and no uncommitted
   change to any file the loop will touch), run a short loop with worktree isolation and
   auto-integration on, whose task edits one file and creates no `_plan`/`_spec`/`_livetest` doc.
2. Expect: the run finishes `promoted to main`, `main` contains the change, and the untracked plan
   documents are untouched.
3. Then repeat with an uncommitted root edit to the same file the loop changes. Expect:
   `promotion blocked · root checkout has uncommitted changes to a promoted path: <path>`, `main`
   unmoved, and your edit intact.

## LT-3 — "Mark resolved" clears a blocked run and survives a restart

1. Open the chat owning one of the blocked runs, expand "Past loop prompts", and find the row.
2. Click **Mark resolved**. Expect the row to change to `marked resolved · you resolved this
   workspace by hand; AIO no longer manages <branch>`, with nothing deleted on disk.
3. Restart Harness. Expect the run is not retried and stays `marked resolved`.
4. Negative case: on a run whose worktree folder still has uncommitted changes, the button must
   refuse with `The worktree folder still has uncommitted changes; commit or discard them first`,
   shown on the row, and change nothing.

## LT-4 — a loop whose work adds an active plan document is not auto-landed

1. Run a short isolated loop whose task creates or edits a `*_plan.md` in the workspace.
2. Expect: the run ends `workspace blocked · Session adds active plan/spec/livetest documents; land
   it manually`, its work is committed on the session branch, the worktree folder is removed, and
   `main` does not contain the plan document.

## LT-5 — the spend meter reports provider-reported cost

Deferred rather than checked in-loop with renderer store seeding: that technique launches a dev
Electron app, which takes over the machine-global Chrome native-messaging manifest that the running
packaged Harness uses for the browser gateway. The whole chain below the DOM binding is already
covered by `loop-control-timeline.spec.ts` and `loop-iteration-cost.spec.ts`.

1. Run a loop with a provider that reports an authoritative cost (Claude), and open the loop
   panel's causal timeline while it runs.
2. Expect the spend meter to read `provider-reported` rather than `estimated`.
3. With a provider that reports no cost, it still reads `estimated`.

## LT-6 — orchestrator tools work in a new session and refuse a stale one

Covered in-loop by `orchestrator-tools-rpc-capability.spec.ts`, `orchestrator-tools-rpc-socket.spec.ts`
and `orchestrator-tools-rpc-server.spec.ts`. What needs the rebuilt app is a real spawned CLI carrying
the minted token through its environment.

1. After the rebuild and restart, start a fresh session and have it call an orchestrator tool (for
   example list the remote nodes). Expect it to succeed.
2. Expect no `AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_CAPABILITY` value to appear in any log or transcript.
3. A session still running from before the rebuild cannot have a token. Expect its orchestrator tool
   calls to be refused until it is respawned, and to work after respawn.

## LT-7 — the Settings switch barring agent secret requests works (LT-537)

1. Turn off agent secret requests in Settings.
2. Ask an agent to request a workspace secret. Expect a refusal in its transcript naming the setting,
   a system note in the session, and no secret card.
3. Turn the switch back on and repeat. Expect the secret card to appear.

---

## Evidence run — 2026-09-24 (loops batch)

Batch id `loops`, HEAD `f04f6748`. Dev app: `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-0924-loops npx
electron . --remote-debugging-port=9713`, shared renderer on `:4567`. Per the brief, LT-1's setup
(eight real stranded worktrees) was **not** reproduced against the real ai-orchestrator repo — loops
were only ever pointed at two disposable scratch git repos under
`/tmp/aio-lt-0924-loops-work/repo2` (and `repo1`, reused from the other docs), created and destroyed
for this run.

### LT-1 — blocked run survives a restart · NOT RUN

Needs eight real stranded worktrees plus an actual Electron **main-process** restart (not a renderer
reload — see LT-640 below for why that distinction matters). Reproducing that setup from scratch and
restarting the whole dev app was judged too expensive for this pass; not attempted. The read-only
half of the claim (a `blocked` run's git state is stable while nothing acts on it) is implied by
LT-2/LT-4 below, where `main` stayed put and worktree folders/branches persisted exactly as recorded,
but no main-process restart was exercised.

### LT-2 — a loop lands even though the root has untracked plan documents · PASS (backend); the UI
half reopens LT-640

Scratch repo `repo2`: `docs/plans/dummy_spec.md` created and left untracked, then a real Claude loop
(`isolateLoopWorkspaces: true`, `autoIntegrateWorktree: true`, `caps.maxIterations: 1`) told to append
one line to `README.md`.

**Clean case — PASS.** Run finished `completed`; `git log -1 main` shows a new merge commit
containing the `README.md` change (`ed517d1`); `docs/plans/dummy_spec.md` is untouched and still
untracked (`git status --short` shows only `?? docs/`, unchanged content). Matches the check exactly.

**Uncommitted-root-edit case — backend PASS, UI stale (LT-640).** Added an uncommitted edit to the
same `README.md` in the root checkout, then ran a second loop editing the same file. The **database**
(`loop-mode.db`, `worktree_lifecycle_json`) immediately recorded
`{"phase":"blocked","lastError":"root checkout has uncommitted changes to a promoted path:
README.md", ...}`, `main` stayed at the pre-run commit, and the uncommitted edit was intact
throughout — the backend behaviour the check describes is exactly right. But the "Past loop prompts"
panel row for that run stayed on **"saving session work"** (a mid-run caption) for the rest of the
session — collapsing/reopening the panel did not refresh it. Only a full renderer page reload
(`location.reload()`) produced a fresh IPC fetch that showed the correct **"promotion blocked / root
checkout has uncommitted changes to a promoted path: README.md · saved on
task-append-the-single-line-second-… and integration/main"**, with a working **Mark resolved**
button. Root cause and full write-up: **LT-640** below.

### LT-3 — "Mark resolved" clears a blocked run · PASS (positive case only)

On the blocked run above (post-reload, so the correct row was visible with its **Mark resolved**
button), clicked the real button. Row changed immediately (no reload needed — this is a synchronous
IPC round trip, not an event push, which is why it wasn't affected by LT-640) to **"marked resolved /
you resolved this workspace by hand; AIO no longer manages
task-append-the-single-line-second-mueu4l9z"**. `git branch --list` confirms the session branch was
**not** deleted, and the uncommitted `README.md` edit was still present — nothing was destroyed on
disk, exactly as specified.

**Not run:** the restart-persistence half ("Restart Harness. Expect the run is not retried and stays
`marked resolved`") and the negative case (refusing "Mark resolved" on a worktree folder with its own
uncommitted changes) — both need more setup than this pass's remaining budget allowed.

### LT-4 — a loop whose work adds an active plan document is not auto-landed · PASS (backend); UI half
is the same LT-640

Same scratch repo. Task: create `docs/plans/2099-01-01-fake-feature_plan.md`. `loop-mode.db` recorded
`{"phase":"blocked","lastError":"Session adds active plan/spec/livetest documents; land it
manually"}` immediately, with no `integrationBranch` at all — confirming the block fires **before**
integration is even attempted, unlike LT-2's post-integration block. `git log -1 main` unchanged;
`git show <session-branch>` shows the plan file committed only on the session branch (a "Harvest:
orchestrator captured session output" commit); the worktree folder was removed
(`git worktree list` shows only the root checkout); `docs/plans/` in the root checkout still contains
only the original `dummy_spec.md`. Exactly the expected outcome.

The **UI again showed the stale "saving session work" caption** until a page reload, after which it
correctly read **"workspace blocked / Session adds active plan/spec/livetest documents; land it
manually · saved on task-create-a-new-file-named-docs-p-…"** with a **Mark resolved** button — the
same LT-640 gap, reproduced a second time with a different block reason, confirming it is systemic
rather than a one-off.

### LT-5 — spend meter reports provider-reported cost · not directly observable in the current UI (by
design)

Read rather than clicked: `<app-loop-causal-timeline>` has exactly one mount site
(`loop-control.component.html`), and **both** its instances (the live-run mount at `:117-121` and the
terminal-summary mount at `:398-402`) pass `[showSpend]="false"`, per the component's own comment
("Hosts that already show cost elsewhere turn this off, so the same run never reads '$0.00 estimated'
in one place and 'cost pending' in another" — `loop-causal-timeline.component.ts:93-95`). So the
`provider-reported`/`estimated` spend line described in this check **cannot render anywhere in the
current UI** — this is not a defect (the metric strip above the timeline shows cost by other means),
but it does mean the check as literally written ("open the loop panel's causal timeline… expect the
spend meter to read…") is unrunnable against the DOM by design. The underlying logic was instead
read directly: for an *active* run, `spendIsProviderReported` is `active.lastIteration?.costKnown ===
true` (`loop-control-timeline.ts:30`), which is correct and Claude-authoritative while the loop runs.
For a *terminal/summary* run (post-LT-594-fix), the same field is never populated
(`causalTimeline()`'s summary branch omits `lastIteration` entirely —
`loop-control.component.ts:150-161`), so it would silently read `estimated` even for a
provider-reported run — but since `showSpend` is `false` on this mount too, nobody ever sees that
either way. Not filed: it's dead code from a rendering standpoint, not a user-visible defect. Worth a
one-line note if this component is ever given a host with `showSpend="true"`.

### LT-6 — orchestrator tools work in a new session · PASS (sub-checks 1–2); sub-check 3 not run

A fresh Claude chat (never sent anything before) was told to call `list_remote_nodes` via its
orchestrator MCP tool. Transcript shows `Using tool: mcp__orchestrator__list_remote_nodes` →
`` `list_remote_nodes` returned this, verbatim: {"connectedCount":0,"totalCount":0,"nodes":[]} `` — a
real, successful orchestrator-tool round trip from a freshly spawned session. `grep -c
AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_CAPABILITY` over the whole `app.log` for the session: **0** — the
capability token value/name never appeared in any log line. Sub-check 3 (a pre-rebuild session's
calls being refused until respawned) needs a session that predates this HEAD, which this pass had no
way to produce; not run.

### LT-7 — the Settings switch barring agent secret requests · refusal path PASS; positive path FAILS
live (LT-641, reopens nothing — this is the first live check the positive path has ever had)

**Refusal (switch off) — PASS.** With `workspaceSecretsAllowAgentRequests: false`
(`$AIO_MCP`-equivalent `updateSettings`/`getSettings` round trip, read back to confirm), a fresh
Claude session was told to raise a `secret_required` request for a fake `TEST_API_KEY`. Transcript:
the model emitted the `:::ORCHESTRATOR_COMMAND::: {"action":"request_user_action",
"requestType":"secret_required", ...}` marker, then a system message appeared immediately —
**"Awaiting your response - User Action Required / Workspace secret requests are turned off in
Settings."** — and the model's own follow-up correctly reported "No secret card was shown and no
credential was stored." Matches `SECRET_REQUESTS_DISABLED_REASON`
(`instance-permission-request-flow.ts:42-43,75-109`) verbatim. Setting restored to its original `true`
afterward and re-read to confirm.

**Positive path (switch on) — FAILS live.** Set `workspaceSecretsAllowAgentRequests: true` (its
original value) and repeated the same ask. `app.log`:
`OrchestrationHandler: Executing orchestrator command {action: "request_user_action"}` →
**`RendererEventValidation: Blocked invalid renderer event payload {channel:
"user-action:request", issues: [{path: "requestType", message: "Invalid option: expected one of
\"switch_mode\"|\"approve_action\"|\"confirm\"|\"select_option\"|\"ask_questions\""}, {path: "",
message: "Unrecognized key: \"secretRequest\""}]}`** → `OrchestrationHandler: User action request
created` (i.e. the backend believes it succeeded). No secret card ever appeared in the DOM
(`document.querySelector('app-user-action-request')` stayed `null`); the model's own narration ("I've
sent the request… ") is the only trace, and nothing further happened — the request is silently lost.
Root cause and full write-up: **LT-641** below. Filed as **P1**, not P2, because unlike LT-640 (a
staleness/lag bug fixable by a reload) this path is unconditionally broken in every build — the
schema simply never learned about this request type.

### Defects filed from this run

**LT-640 (P2) — a loop's post-completion worktree-lifecycle outcome (promoted/blocked/cleaned) never
reaches a running renderer; only a page reload shows it.**

*Observed:* Two independently-blocked real loop runs (`repo2`, HEAD `f04f6748`) each had the correct
final state written to `loop-mode.db` within ~1s of termination (`phase: "blocked"`, an accurate
`lastError`), but the "Past loop prompts" row for each stayed on a stale mid-run caption
("saving session work") indefinitely — collapsing/reopening the panel did not refresh it. A full
`location.reload()` of the renderer (not a main-process restart) immediately showed the correct text
on the very next IPC fetch.

*Evidence:* `app.log` shows, for every one of these post-terminal lifecycle transitions, a
`RendererEventValidation: Blocked invalid renderer event payload {channel: "loop:state-changed",
issues: [{path: "", message: "Unrecognized key: \"lifecycleOnly\""}]}` warning (8 occurrences across
the two runs, timestamps `1790212064166`–`1790212064906` and `1790212219600`-adjacent). Confirmed by
reading `loop-mode.db` directly (`sqlite3 … "select worktree_lifecycle_json from loop_runs"`) — the
backend state was correct throughout; only the live UI signal was lost.

*Root cause (verified by reading code, high confidence):* `LoopCoordinator.terminateRun`'s
`cleanupLoopWorktreeAfterTerminate({ onTransition: () => this.emit('loop:state-changed', {
loopRunId, state, lifecycleOnly: true }) })` (`src/main/orchestration/loop-coordinator.ts:3930-3942`)
sends a *second*, later `loop:state-changed` broadcast once harvest/integrate/promote resolves, tagged
`lifecycleOnly: true` so the renderer-side handler can skip re-appending a terminal transcript
summary (`src/main/ipc/handlers/loop-handlers.ts:158,172,181`, which reads `data.lifecycleOnly`
directly — the field is real and consumed on the main side). But the wire schema,
`LoopStateChangedEventSchema` (`packages/contracts/src/schemas/loop-events.schemas.ts:33-36` —
`z.object({ loopRunId, state }).strict()`), never declares `lifecycleOnly`. Because the schema is
`.strict()`, `RendererEventValidation` rejects the *entire* event rather than stripping the unknown
key, so the renderer never receives this second broadcast at all. The panel's initial full IPC load
(on chat open / page load) reads the DB directly and is unaffected — which is why a reload "fixes" it
and why an already-correct run (opened fresh) never shows the bug.

*Required behavior:* the renderer learns a loop's final worktree-lifecycle outcome as soon as the main
process knows it, without needing a reload.

*Acceptance:* add `lifecycleOnly: z.boolean().optional()` to `LoopStateChangedEventSchema`; a blocked
or promoted run's "Past loop prompts" row updates to its true terminal caption within the same
renderer session, with no reload, verified against both the uncommitted-root-changes and
active-plan-document block reasons.

*Owning doc + check:* this doc, LT-2 (second case) and LT-4.

**LT-641 (P1) — an agent's `secret_required` request can never reach the renderer; the "ask for a
credential" feature is non-functional whenever the setting allows it.**

*Observed:* With `workspaceSecretsAllowAgentRequests: true` (the default), a real Claude session's
`secret_required` request is accepted by `OrchestrationHandler` ("User action request created") but
never displayed — no secret card, no system message, nothing beyond the model's own narration text.
The *disabled* refusal path (setting `false`) works correctly and is the only path that has ever been
live-tested, because it short-circuits before reaching this event.

*Evidence:* `app.log`: `OrchestrationHandler: Executing orchestrator command {action:
"request_user_action"}` immediately followed by `RendererEventValidation: Blocked invalid renderer
event payload {channel: "user-action:request", issues: [{path: "requestType", message: "Invalid
option: expected one of \"switch_mode\"|\"approve_action\"|\"confirm\"|\"select_option\"|
\"ask_questions\""}, {path: "", message: "Unrecognized key: \"secretRequest\""}]}` (timestamp
`1790213021146`), then `OrchestrationHandler: User action request created` — the main process
believes the request was delivered. `document.querySelector('app-user-action-request')` stayed `null`
for the rest of the turn.

*Root cause (verified by reading code, high confidence):* `UserActionRequestEventSchema`
(`packages/contracts/src/schemas/orchestration.schemas.ts:646-661`) declares `requestType:
z.enum(['switch_mode', 'approve_action', 'confirm', 'select_option', 'ask_questions'])` and no
`secretRequest` field, and is `.strict()`. But the renderer's own consumer type,
`UserActionRequest` (`src/renderer/app/features/instance-detail/user-action-request.types.ts:6-13,
40-49`), already includes `'input_required'` and `'secret_required'` in its `requestType` union and a
full `secretRequest` shape — the UI component is fully built and waiting for a payload the wire schema
will never let through. The schema was evidently never updated when `secret_required` (LT-537) was
added to the orchestration protocol (`orchestration-protocol.types.ts`,
`orchestration-handler.ts:874-909`).

*Required behavior:* a `secret_required` (and, while touching this, `input_required`) request reaches
the renderer and renders the secret card.

*Acceptance:* add `'secret_required'` (and `'input_required'`, since it has the identical gap and the
same renderer-side support already exists) to `UserActionRequestEventSchema`'s `requestType` enum,
plus the `secretRequest` field (mirroring `UserActionRequest.secretRequest`); a real agent's
`secret_required` request renders the secret card with the setting on, and the existing refusal
message still renders with it off.

*Owning doc + check:* this doc, LT-7 (positive case).

Both defects share a root-cause **class** worth naming even though only two instances were found this
pass: a `.strict()` renderer-event Zod schema that silently drops the *entire* event when the main
process adds a field the schema doesn't know about, rather than failing loudly at build/type-check
time. A cheap, load-bearing follow-up (out of scope for this batch) would be a lint/test rule that
fails when a main-process `emit()` call for a channel carries a key the corresponding
`renderer-event-validation.ts` schema doesn't declare.

### Cleanup

Both loop-created worktrees were already harvested/cleaned by AIO itself as part of normal
termination; nothing left under `.worktrees/` in either scratch repo. The one instance created for
LT-6/LT-7 was terminated via `terminateInstance`. `workspaceSecretsAllowAgentRequests` was returned to
its original `true` value and re-read to confirm. No settings, repos or profiles belonging to James
were touched — everything above ran against `/tmp/aio-lt-0924-loops-work/repo2` and the isolated dev
profile.

## Evidence run — 2026-09-24 (verify-loops)

Batch `verify-loops`, CDP port 9732, profile `/tmp/aio-lt-0924-verify-loops`, driven against the
**working tree** (dist/main and the dev renderer rebuilt ~03:00 from today's uncommitted fixes, not
HEAD `f04f6748`). Loops only ever targeted a disposable scratch git repo,
`/tmp/aio-lt-0924-verify-loops-work/repo1`.

### LT-2/LT-4 UI half (LT-640) — REOPENED

Ran a real Claude loop (`isolateLoopWorkspaces: true`, `autoIntegrateWorktree: true`,
`caps.maxIterations: 1`) whose task creates `docs/plans/2099-01-01-verify-loops-fake_plan.md` (the
LT-4 shape). `loop-mode.db` recorded `{"phase":"blocked","lastError":"Session adds active plan/spec/
livetest documents; land it manually"}` within ~100ms of termination, exactly as designed.

**The schema half of the fix is confirmed live.** `app.log` around this run's timestamps
(`1790215260126`–`1790215290000`) has **zero** `RendererEventValidation: Blocked invalid renderer
event payload` lines for `loop:state-changed`, versus 8 such blocks in the loops batch's pre-fix run.
Reading the renderer's own live store confirms the event is delivered and applied correctly:
`LoopStore`'s `summaryByChat` for this chat holds the final, correct
`worktreeLifecycle: {phase: "blocked", lastError: "Session adds active plan/spec/livetest documents;
land it manually", ...}` (read directly via `ng.getComponent` + `loopStore.summaryForChat(chatId)()`),
matching the DB exactly.

**But the "Past loop prompts" panel never updated, for over 2 minutes, with no reload.** It stayed on
the stale "saving session work" caption throughout repeated polling. This reproduces the *symptom* LT-2/
LT-4 describe, but the schema fix is not the cause anymore — the store already has the right data. The
real, still-open cause is a **second, independent bug** in the panel's own refresh trigger:

- `LoopPastRunsPanelComponent` renders `this.store.runsForChat(id)()` — a **separate**, DB-backed list
  populated only by an explicit `store.refreshHistory(id)` pull
  (`loop-past-runs-panel.component.ts:328-365`), not by the live `summaryByChat` push.
- That pull only fires (a) on chat-id change, or (b) when the parent's `terminalSummaryRunId` **input
  changes**. The parent computes it as `lastTerminalSummaryId = computed(() => this.summary()?.
  loopRunId ?? null)` (`loop-control.component.ts:133`) — keyed **only by `loopRunId`**.
- A single loop run emits `loop:state-changed` **multiple times** as `finalizeLoopWorktree` walks
  `harvesting → harvested → blocked` (`loop-worktree-lifecycle.ts`'s `transition()` calls
  `onTransition` on every phase change). Each one calls `applyState` → `upsertSummary`, correctly
  updating `summaryByChat`'s content — but `lastTerminalSummaryId`'s **value** (the loop's id) never
  changes between these events, because it is the same run throughout. Angular's `computed` only
  notifies subscribers when the value changes, so the child panel's refresh-triggering `effect`
  (`loop-past-runs-panel.component.ts:358-365`) fires **exactly once**, on whichever transition happens
  to be current at that first terminal instant (in this run, that landed on the transient `harvesting`
  phase — hence the stale "saving session work" caption) — and never again for that run, no matter how
  many further lifecycle transitions arrive.
- Confirmed by direct observation: `loopStore.summaryForChat(chatId)()` held the correct final
  `phase: "blocked"` the whole time; only the DOM (driven by the separate, never-re-pulled
  `runsForChat` list) stayed stale.

**This reopens LT-640.** The schema acceptance ("no `Unrecognized key: lifecycleOnly` blocks") is met;
the doc's actual UI acceptance ("a blocked or promoted run's Past loop prompts row updates … with no
reload") is not, for a different, deeper reason than originally diagnosed. Required behaviour: the
panel's refresh-trigger needs to key on something that changes per lifecycle transition (e.g. the
lifecycle's own `updatedAt`, or a per-transition sequence number) rather than the static `loopRunId`,
or `LoopPastRunsPanelComponent` should read `worktreeLifecycle` from the live `summaryByChat`/`active`
signals directly instead of a separately-pulled history list.

### LT-7 positive path (LT-641) — REOPENED, narrower cause

Repeated the LT-7 positive-path ask (`workspaceSecretsAllowAgentRequests: true`, a fresh Claude
session asked to raise a `secret_required` request) with a chat **selected in the normal dashboard chat
view** (`chatStore.select(...)` then `sendMessage`, i.e. `app-chat-detail` mounted) — the ordinary way
a user is looking at a session when an agent asks for something.

**The schema fix is confirmed live.** `app.log` at `1790215863230`–`1790215863232` shows
`OrchestrationHandler: Executing orchestrator command` → `InstanceEventForwarding: Forwarding user
action request to renderer` → `OrchestrationHandler: User action request created`, with **no**
`RendererEventValidation: Blocked invalid renderer event payload` line for `user-action:request` (the
loops batch's pre-fix run had one at this exact point every time). The request is genuinely delivered
to the renderer this time.

**But `document.querySelector('app-user-action-request')` stayed `null` for 50+ seconds** in the chat
view, exactly reproducing the original symptom's DOM-level observation. Reading the source shows why,
independent of the schema: `app-user-action-request` has exactly **one** mount site in the whole
renderer, `instance-detail.component.html:268`, inside `<app-instance-detail>`. And
`dashboard.component.html:102-114` mounts `<app-instance-detail>` only in the `@else` branch of
`@if (chatStore.selectedChatId())` — i.e. **only when no chat is selected**. The moment a chat is open
(`app-chat-detail`, the normal state while a user is watching a live agent), `app-user-action-request`
is not in the component tree at all, and `chat-detail.component.html` has no equivalent surface
(confirmed by grep: no `app-user-action-request`, `UserActionRequest`, `secretRequest` anywhere under
`features/chats/`).

Confirmed the card **does** render correctly once the same pending request is viewed the other way: at
`/work` (Workboard), the run showed under "Done / Idle" (not "Needs You" — the lane classifier does not
appear to treat a pending `secret_required` request as needing attention either, though this pass did
not dig into that separately), and clicking its card mounted `app-instance-detail` →
`app-user-action-request`, which rendered the full secret card correctly ("Credential needed: Verify
Loops Test Key", the purpose text, "Stored encrypted on this Mac. Never shown to the agent.", Decline /
Save securely). Declined it there to clean up.

**This reopens LT-641.** Its own acceptance text ("an agent's `secret_required` request appears in an
already-open session without navigating away and back") is not met: the request appears only after
navigating *away* from the open chat (to the Workboard) and clicking back into an instance-detail view
— for a user staying in the normal chat view, the request is invisible, the model's own narration is
the only trace, and the underlying `switch_mode`/`approve_action`/`confirm`/`select_option`/
`ask_questions` request types share the identical gap since they route through the same, single
`app-user-action-request` mount site. Required behaviour: either mount an equivalent user-action-request
surface inside `app-chat-detail`, or make `dashboard.component.html` render `app-instance-detail`'s
request-handling machinery (or a shared subset of it) alongside `app-chat-detail` rather than instead
of it.

### Cleanup

The one Claude loop instance, the one Claude secret-request chat, and the one Grok LT-612 instance (see
the correction-miner doc) created for this pass were all terminated
(`window.electronAPI.listInstances()` returned `[]` at the end). The disposable scratch repo and the
electron profile (`/tmp/aio-lt-0924-verify-loops-work/`, `/tmp/aio-lt-0924-verify-loops`) were removed.
No settings were changed in a way that persists (isolated dev profile only). The dev app was restarted
once mid-run (see LT-642 below) to evict in-memory loop state — a clean kill/relaunch of only this
batch's own pid, verified against the pre-existing process snapshot before killing.

---

## Evidence run — 2026-09-24 (verify-final)

Batch `verify-final`, CDP port 9741, profile `/tmp/aio-lt-0924-verify-final`, driven against the
~03:45 working-tree rebuild (newer than `verify-loops`'s ~03:00 pass). Loops targeted a fresh
disposable scratch git repo, `/tmp/aio-lt-0924-verify-final-work/repo1`.

### LT-2/LT-4 UI half (LT-640) — CONFIRMED FIXED LIVE

Ran a real Claude loop (`isolateLoopWorkspaces: true`, `autoIntegrateWorktree: true`) whose task
creates `docs/plans/2099-01-01-verify-final-fake_plan.md` (the LT-4 shape), loop id
`loop-1790217878882-3b4037f6`. `app.log` records
`LoopWorktreeLifecycle: Managed worktree integration refused: active plan documents` at
`1790217889276`. The run finished in under 3 minutes; polling `app-chat-detail`'s own
`active()`/`summary()` accessors returned `null` throughout (a harness/test-code mismatch — those
accessor names appear to have moved since the `verify-loops` write-up was drafted, not a product
signal), so the poll loop simply ran to completion before opening the panel. Opening
`app-loop-past-runs-panel` (`.past-runs-toggle` click) **on the very first attempt, with no reload
of any kind since the loop started**, showed the fully correct terminal text:

```
workspace blocked
Session adds active plan/spec/livetest documents; land it manually · saved on task-create-a-new-file-named-docs-p-muexi3xz
```

with the correct elapsed time ("3m ago") and cost. This is the exact acceptance text `verify-loops`
found stuck on a stale "saving session work" caption. Reading
`src/renderer/app/features/loop/loop-terminal-summary-key.ts` confirms the fix `verify-loops`
suggested was implemented essentially verbatim: `terminalSummaryRefreshKey()` returns
`` `${loopRunId}:${worktreeLifecycle?.phase ?? ''}` `` instead of the bare `loopRunId`, so each
lifecycle phase transition (harvesting → harvested → blocked/promoted) produces a **new** key and
re-triggers `LoopPastRunsPanelComponent`'s `store.refreshHistory(id)` pull
(`loop-past-runs-panel.component.ts:358-365`), rather than only the first transition for a given
run id. `app.log` also has zero `RendererEventValidation: Blocked invalid renderer event payload`
lines for this loop id, confirming the underlying schema fix from the original LT-640 diagnosis is
still holding. **This closes the reopen; LT-640/LT-2/LT-4's UI acceptance is met.**

### LT-7 positive path (LT-641) — CONFIRMED FIXED LIVE, and narrower cause resolved

Repeated the ask twice in a fresh chat with `app-chat-detail` mounted (the ordinary "user is looking
at an open chat" state), never navigating to the Workboard:

1. A `secret_required` ask ("Credential needed: Verify Final Test Key") — `app-user-action-request`
   was present in the DOM (confirmed via `document.querySelector`) on the **very first** 2-second
   poll after sending the message, showing the full secret card (purpose text, password input,
   "Stored encrypted on this Mac. Never shown to the agent.", Decline / Save securely). Declined it
   (no real secret entered).
2. An `ask_questions` ask (a one-question multiple-choice prompt) — same result: the question card
   rendered inside the open chat on the first poll, with a working textarea and Submit/Skip buttons.
   Skipped it.

Reading `src/renderer/app/features/chats/chat-detail.component.html:159-163` confirms the fix
`verify-loops` asked for was implemented: `<app-user-action-request [instanceId]="runtimeInstanceId" />`
(and `<app-browser-approval-request>`) are now mounted directly inside `app-chat-detail`, guarded by
`@if (currentInstance()?.id; as runtimeInstanceId)`, with a comment explicitly citing LT-641. Since
both request types route through the same single component, this closes the gap for
`switch_mode`/`approve_action`/`confirm`/`select_option` too, not just `secret_required`. **This
closes the reopen; LT-641/LT-7's positive-path acceptance is met.**

### Cleanup

All loop/chat instances created in this pass (8 disposable project rows from the LT-631 check plus
2 from LT-640/LT-641 in `repo1`, and 3 ping-pong builder chats in `repo3`/`repo4`/`repo5` — see the
ping-pong doc's evidence run) were terminated via a single `listInstances()` + `terminateInstance()`
pass, confirmed `remaining: 0`. No ping-pong reviewer instance was left orphaned in any of the three
ping-pong runs (each had already auto-terminated by the time instances were listed). The electron
profile (`/tmp/aio-lt-0924-verify-final`) and all scratch repos under
`/tmp/aio-lt-0924-verify-final-work/` were removed.

---

## Evidence run — 2026-10-04 (batch D)

Batch D, dev app from the working tree (HEAD `3d05e250e`), profile `/tmp/aio-lt-1004-d`, throwaway repos under
`/tmp/aio-lt-1004-d-repos/`. Evidence in `_scratch/lt-2026-10-04/d/`. The real packaged app and the real
`ai-orchestrator` worktrees were only ever read, never written.

### LT-1 — a blocked run with an operator commit is left alone across a restart · PASS (read-only, real state)

I did not restart the packaged app (not allowed) and did not rebuild the eight stranded worktrees in a scratch
repo. Instead the packaged app had already been restarted at 20:45 BST today on the fixed build (built 19:06
from HEAD `3d05e250e`, per the campaign brief), which is exactly the state this check needs. Read-only
observations made afterwards (`LT1-real-state-readonly.txt`):

- `loop-mode.db` (opened `mode=ro`): exactly eight `loop_runs` rows are `blocked` with `lastError`
  `Session branch changed outside AIO; review it before landing` — the text of
  `SESSION_BRANCH_CHANGED_BLOCK_REASON` (`loop-worktree-lifecycle-reconcile.ts:19-20`, used at `:201-209`), so
  the new guard ran. All eight rows have `updatedAt` `2026-10-04 19:45:48 UTC` (= 20:45:48 BST), the same boot.
  Their branches: `task-can-you-work-through-all-the-p-mt76ztv1`, `…-mtjeyorh`, `…-mtjvhjeh`, `…-mtkdez2p`,
  `task-so-finish-the-work-please-mtklsatd`, `task-please-work-through-all-the-li-mtkqr41h`,
  `task-please-investigate-all-the-pla-mtl9icld`, `task-i-said-keep-going-uintil-it-s-mtovfbpg`.
- `git worktree list`: all eight `.worktrees/task-*` folders exist, each `git status --porcelain` is empty.
- Every one of the eight branch tips is a `rescue: safety commit of stranded work (…)` commit from
  2026-09-18 15:36–15:37 — i.e. unchanged since the rescue.
- `main` is `3d05e250e`, committed 19:04 (before the restart), so the restart did not move it. `git branch
  --list 'integration/*'` shows `integration/main`, but its tip is `8965eec0b`, a 2026-09-24 10:13 merge — it
  pre-dates this restart and is not something the restart created.
- A ninth folder, `.worktrees/task-please-work-through-all-the-li-mu4ui30h`, is the separately parked
  provider-limit loop; it is not one of the eight and was untouched.

Not observed: the rendered "Past loop prompts" row text in the packaged UI (I cannot drive that app); the
database `lastError` is what that row is built from. Whoever has the packaged window open can eyeball it.

### LT-5 — the spend meter reports provider-reported cost · behaviour verified, on-screen check unsatisfiable by design (still open)

`app-loop-causal-timeline` is still mounted only with `[showSpend]="false"` (`loop-control.component.html:119,403`),
so no `provider-reported`/`estimated` text can appear on screen. I read the component's live `timeline()` model
instead (`ng.getComponent(app-loop-causal-timeline).timeline().spend.sourceLabel`), polling a real loop
(`lt1-watch.json`, `lt2-watch.json`):

- Claude loop `loop-1791158223017-04b45e99`: iteration 0 running → `estimated` (0 ¢); after iteration 0 completed
  → `provider-reported` (20 ¢). A second Claude loop gave the same (`estimated` → `provider-reported`, 38 ¢).
- Codex loop `loop-1791158250154-2791fd53`: `estimated` (0 ¢) → `provider-reported` (11 ¢) while running → after the
  run ended `completed` the label reads `estimated` (17 ¢). So a terminal summary drops the provenance (the summary
  branch omits `lastIteration`, `loop-control.component.ts:150-161`), as the 2026-09-24 analysis predicted. Not
  filed: nothing renders it.
- Sub-check 3 (a provider that reports no cost reads `estimated`): Codex now reports cost, so no cost-less
  provider was exercised; `estimated` was observed only before the first iteration and on the terminal summary.

Left open because the check's wording ("expect the spend meter to read …") needs a rendered meter. Options for
the owner: turn `showSpend` on somewhere, or retire the clause and keep the unit coverage.

### LT-6 sub-check 3 — a stale credential is refused, a new session works · PASS (emulated)

A dev-app restart discards every instance (none are restored), so a real still-running pre-restart session cannot
exist there. I emulated one: a Claude session spawned before the restart wrote its own
`AI_ORCHESTRATOR_INSTANCE_ID` and capability token to private files (never printed). After a graceful restart a
new session ran, as separate commands (outputs verbatim from its transcript):

1. `$AIO_MCP loop list` → exit 0, lists the paused loop.
2. The pre-restart id **and** token replayed → `aio-mcp loop failed: invalid or missing orchestrator-tools
   capability token`, exit 1.
3. The new session's id with `…CAPABILITY=bogus` → the same refusal, exit 1.
4. Token removed → `aio-mcp loop failed: orchestrator-tools RPC unavailable: parent socket/instance id missing`,
   exit 1 (a client-side refusal; it names the socket/instance id rather than the token).
5. The new session's own credentials → `loop resume …` worked (see the loop-resume doc).

Sub-checks 1–2 were already passed on 2026-09-24. The token files were deleted afterwards.

### Cleanup

Instances terminated, dev app stopped, profile and scratch repos removed. Nothing was written to the real repo or
the packaged profile.

## Decision — 2026-10-05

James decided on 2026-10-05 to drop **LT-5** (the on-screen spend meter check). The meter is not
rendered in the current UI (`[showSpend]="false"`), the underlying `provider-reported`/`estimated`
labelling was observed live on 2026-10-04, and unit coverage (`loop-control-timeline.spec.ts`,
`loop-iteration-cost.spec.ts`) stays. LT-5 is retired, not passed.

## Status — 2026-10-05

Open: 1 · Closed: 5 (LT-2, LT-3, LT-4, LT-6, LT-7) · Retired: 1 (LT-5) · Failed: 0.
The one residual is LT-1's on-screen clause: the 2026-10-04 evidence proved the folders, branch
tips, `main` and the eight `loop_runs` rows (`lastError` = `Session branch changed outside AIO;
review it before landing`) after the real 20:45 restart, but nobody has yet looked at the rendered
"Past loop prompts" rows in the installed app. One look at those eight rows closes this document.

## Evidence run — 2026-10-05 (orchestrating session) — LT-1 row text

Harness is a hard-denied Computer Use target and the installed app has no debug port, so the
installed window itself cannot be read by an agent. The row text was instead proven from the real
persisted records through the identical code path:

1. **Real data, read-only.** `~/Library/Application Support/harness/loop-mode/loop-mode.db` opened
   `mode=ro`: exactly eight `loop_runs` rows carry `worktree_lifecycle_json.lastError = "Session branch
   changed outside AIO; review it before landing"`, all `phase: "blocked"`, no `integrationBranch`,
   session branches = the eight rescued `task-*` branches (`_scratch/lt-2026-10-04/orch/lt1-rows.json`).
2. **Same code as the installed build.** `git diff HEAD -- src/renderer/app/features/loop/
   src/shared/types/loop.types.ts` is empty, and the installed app was built from HEAD `3d05e250e`.
   Main passes the record through unchanged (`loop-store.ts:144` →
   `parseWorktreeLifecycle` = `JSON.parse`, `loop-store-worktrees.ts:17-26`).
3. **Rendered on screen.** An isolated dev app (fresh profile, no access to the real loop DB, focus
   emulation on, `document.hidden: false`) was given those eight records (prompts replaced by a
   placeholder; lifecycle, status and counts verbatim) through the real `LoopStore` →
   `app-loop-control` → `app-loop-past-runs-panel` path, with only the IPC fetch substituted. With
   the panel expanded (`▾ Past loop prompts (8)`), every row's `.pr-managed` element read
   **`workspace blocked Session branch changed outside AIO; review it before landing · saved on
   task-…`** with its own branch, `data-tone="blocked"`, `role="status"`, and a **Mark resolved**
   action (`_scratch/lt-2026-10-04/orch/lt1-dom.json`). The pure utility gives the same eight strings
   (`lt1-row-text.txt`).

Together with the 2026-10-04 evidence (folders present and clean, branch tips unchanged, `main`
unmoved, no new `integration/*` branch after the real 20:45 restart), **LT-1 passes**. Method stated
plainly: the rows were rendered in a test copy from the real records, not read off the installed
window.

## Status — 2026-10-05 (final)

Open: 0 · Closed: 6 (LT-1, LT-2, LT-3, LT-4, LT-6, LT-7) · Retired: 1 (LT-5, James 2026-10-05) ·
Failed: 0. Renamed `_livetest_completed.md`.
