# Doc-review delivery live-test checklist

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

> Prerequisites: rebuild/restart the Electron app after the doc-review delivery changes.
> This checklist validates the implementation plan at
> `2026-07-13-doc-review-delivery-reconciliation-plan_completed.md` against a live CLI session.

## 1. Live idle requester

1. Start `npm run dev`, create an instance, and have it call `request_doc_review` for a valid artifact.
2. Wait until the instance is idle, submit an approved review in the Doc Reviews pane.
3. Expected: the requesting transcript receives one canonical `## Document review feedback` user message; the review displays `Delivery: delivered via direct-send`.

## 2. Busy requester

1. Request a review, then start a long-running turn in that instance.
2. Submit changes requested while the turn is busy.
3. Expected: the review displays a queued delivery and does not interrupt the active turn. When the instance reaches idle, it receives one canonical feedback message and the delivery state changes to delivered.

## 3. Hibernated requester

1. Request a review, hibernate the requester, then submit a decision.
2. Expected: the app wakes the same instance, delivers the feedback, and records `wake` as the delivery mechanism.

## 4. Terminated requester

1. Request a review, terminate the requester, then submit a decision with **Resume sessions when document reviews are submitted** enabled.
2. Expected: a new restored instance appears with the original history-thread identity and the canonical feedback as its next user turn; delivery records `continuity-revive`.
3. Repeat with the setting disabled.
4. Expected: the decision remains visible and pollable with a failed delivery state; enable the setting and choose **Retry delivery** to revive it.

## 5. Paused loop gate

1. Start a loop whose completion path pauses for manual review and has a plan file.
2. Expected: a pending review is created while the loop is paused, not after it reaches a terminal status.
3. Approve the review.
4. Expected: an eligible completion gate invokes loop acceptance. Submit changes requested on another paused loop.
5. Expected: the canonical feedback is queued as an intervention and the loop resumes. A terminal loop review must show a delivery failure and must not restart a loop.

---

## Evidence run — 2026-07-16 (attempt 1, autonomous agent)

**Outcome: BLOCKED across all 5 sections. File NOT renamed to `_livetest_completed.md`.** No expectation was driven to a genuine pass, and none was fabricated.

### Why blocked (verified, not assumed)

This checklist is inherently a human-at-the-GUI live test. Every numbered *Expected* outcome depends on interactive actions and visual observation for which there is **no non-GUI automation surface** available to an autonomous agent:

- **Submitting a review decision** (`DocReviewService.submitDecision`) is a renderer→main **Electron IPC** call handled in `src/main/ipc/handlers/doc-review-handlers.ts`, driven by the Doc Reviews pane. It is **not** exposed by the `aio-mcp` CLI or the `orchestrator-tools` RPC forwarder, which expose only `request_doc_review` and `get_doc_review_result` (see `docs/AIO_MCP_CLI.md`). There is no CLI/RPC/hook to approve, request-changes, reject, or **Retry delivery**.
- **Instance lifecycle** actions the checklist requires — reaching idle, starting a long busy turn, **hibernating**, **terminating**, and **continuity-revive** — and the in-app **Resume sessions when document reviews are submitted** (`docReviewResumeOnSubmit`) toggle are GUI/lifecycle-driven with no external trigger for this scenario.
- **Paused loop gates** (create-review-while-paused, `acceptCompletion`, `intervene`→`resumeLoop`, terminal-loop no-restart) require driving a real loop through its pause-for-review boundary in the UI.
- **Observing** the delivery evidence the checklist asserts — the `## Document review feedback` canonical message, `Delivery: delivered via direct-send`, the queued→delivered transition, and the `wake` / `continuity-revive` / loop-accept / loop-intervene mechanisms — requires reading the rendered Doc Reviews pane and transcript.
- There is **no Playwright / Spectron / WebdriverIO Electron E2E harness** in the repo (verified against `package.json`), so the pane cannot be driven or read headlessly.

### Runtime state observed at attempt time

- An Angular renderer dev server (`ng serve --port 4567 (ai-orchestrator)`) was running.
- No Electron **main** process was detected (no `node_modules/electron/dist` / `.bin/electron` process). A fresh `npm run dev` was not launched: it could not yield any of the interactive submit/lifecycle/observe evidence the checklist requires, and port 4567 was already bound by an existing renderer. The blocker is not "is the app running" — it is the absence of any way for an autonomous agent to perform the GUI submit/lifecycle actions and read the resulting delivery state.

### Per-expectation status

| Section | Expectation | Status | Observed |
| --- | --- | --- | --- |
| 1. Live idle requester | §1.3 canonical `## Document review feedback` + `Delivery: delivered via direct-send` | BLOCKED | Cannot submit an approved review in the pane; cannot read delivery state. |
| 2. Busy requester | §2.3 queued delivery, no turn interrupt; on idle → one canonical message, state → delivered | BLOCKED | Cannot start a busy turn, submit changes-requested, or observe queued→delivered transition. |
| 3. Hibernated requester | §3.2 wakes same instance, delivers, records `wake` | BLOCKED | Cannot hibernate/submit; cannot observe wake mechanism. |
| 4. Terminated requester (setting on) | §4.2 restored instance keeps original history-thread identity, canonical feedback as next turn, delivery `continuity-revive` | BLOCKED | Cannot terminate/submit; cannot observe revived instance or delivery mechanism. |
| 4. Terminated requester (setting off) | §4.4 decision stays visible/pollable with failed delivery; enable setting + **Retry delivery** revives | BLOCKED | Cannot terminate/submit; no Retry-delivery trigger outside the pane. |
| 5. Paused loop gate | §5.2 pending review created while loop paused, not after terminal | BLOCKED | Cannot drive a loop to its pause-for-review boundary via automation. |
| 5. Paused loop gate | §5.4 eligible completion gate invokes loop acceptance (approve path) | BLOCKED | Cannot approve a paused-loop review. |
| 5. Paused loop gate | §5.5 changes-requested → canonical feedback queued as intervention, loop resumes; terminal loop review shows delivery failure and does not restart a loop | BLOCKED | Cannot submit changes-requested or observe intervention/resume/terminal behaviour. |

### What would unblock this

Either (a) James runs the checklist manually against a rebuilt app and records observations, or (b) a UI-automation path is added — e.g. a dev/test-only IPC or `orchestrator-tools` command to submit a decision and read a review's delivery journal, plus a Playwright-for-Electron harness to drive the pane and instance lifecycle. With (b), sections 1–5 could be scripted end to end and this doc completed autonomously.

### 2026-07-19 Current Note (LT-007 in `docs/plans/livetest-remediation-register.md`)

Correction to an earlier version of this note: it originally claimed "Computer Use tools are now
available in this environment." That was checked and was **false** for this session (OS-level
Computer Use tools were not connected) — stated without verifying first, which is exactly the
mistake this repo's guidance warns against. The actually-available, demonstrated path is
different: a rebuilt dev Electron instance can be driven with `puppeteer-core` connected over its
`--remote-debugging-port` (CDP), combined with directly seeding a `doc_review_sessions` row via
`sqlite3` against the dev app's own RLM database. This is not a Computer Use claim — no OS-level
screen/click automation was used — it's a scripted CDP session against `ng serve` + `electron .`
run locally, the same technique used in this file's own 2026-07-16 evidence run and in
`2026-07-13-doc-review-choice-controls-plan_livetest.md`'s 2026-07-19 evidence (which used exactly
this to verify the embedded artifact renders and its choices survive a real full page reload).

That means the "no GUI automation surface" conclusion above is **no longer the current blocker**
for sections that only need the pane + a seeded session (submitting a decision, observing delivery
state) — those were exercised directly (see the choice-controls file's 2026-07-19 evidence, which
also drove Submit against a seeded session with a non-live `targetInstanceId` and observed a clean
`queued`/`await-idle` delivery outcome, no crash). What genuinely still cannot be scripted this way:
**hibernating/terminating a real instance, a real busy turn, and continuity-revive** (sections 2–5)
depend on a live CLI instance actually existing, which a seeded DB row does not provide. Re-run
those sections against a rebuilt app with a real live instance; the pane-interaction blocker itself
is resolved.

## Triage — 2026-07-29

Not run this session. Classified during the campaign sweep and recorded here so the next runner does
not re-derive it. Full context: `docs/plans/2026-07-29-livetest-backlog-status-report.md`.

All five checks turn on delivering a doc-review to a requester in a specific runtime state (idle / busy / hibernated / terminated / paused loop) and observing the result in the UI. Staging four distinct instance states plus a paused loop is agent-driveable in the dev app; the observation half is not. **Partially driveable** — the state machine could be evidenced via IPC even if the UI half waits for James.

## Evidence run — 2026-08-01 — **§4.2 PASSES**; the "cannot submit" blocker is gone

All nine expectations were marked BLOCKED for one reason: *"cannot submit an approved review in the
pane"*. That is no longer true, and it never needed the pane.

**The pane was never the only route.** `docReviewSubmitDecision`, `docReviewRetryDelivery`,
`docReviewGet`, `docReviewList` and `docReviewDismiss` are all exposed on the preload
(`orchestration.preload.ts`), so a decision can be submitted directly over IPC — which is what the
delivery machinery actually reacts to. (The pane's own blocker, the CSP-blocked artifact runtime,
was separately fixed and verified earlier today.)

### §4.2 — terminated requester → `continuity-revive` — ✅ PASS, every assertion

Seeded one pending review against a real instance's identity, let that instance die (app restart),
then submitted `changes_requested` over IPC:

```
docReviewSubmitDecision → success
status                  → "changes_requested"
delivery                → { status: "delivered", mechanism: "continuity-revive",
                            attempts: 1, targetInstanceId: "ckhfyihuy" }
deliveryAttempts        → [ { state: "dispatching", mechanism: "none",
                              targetInstanceId: "c7szacz7y" },      ← the dead original
                            { state: "delivered",   mechanism: "continuity-revive",
                              targetInstanceId: "ckhfyihuy" } ]     ← the revived one
```

| §4.2 assertion | Observed |
| --- | --- |
| restored instance keeps the **original history-thread identity** | ✅ revived `ckhfyihuy` carries `historyThreadId 37a28698-…`, byte-identical to the dead original's |
| canonical feedback arrives as the **next turn** | ✅ its first user message is `## Document review feedback — LT delivery reconciliation probe (review lt-dr-0002)` / `Overall: CHANGES REQUESTED` / `General: …` |
| delivery mechanism is **`continuity-revive`** | ✅ verbatim, after one `none` attempt against the dead instance |

The two-attempt trail is the mechanism working exactly as designed: try the original, find it gone,
revive on the recorded thread identity, deliver there.

### A silent-drop worth knowing before anyone else seeds a review

My first seeded row **never appeared** in `docReviewList` and produced no error anywhere. Cause: I
had written `origin: { kind: 'agent', … }`. `DocReviewOriginSchema` is a **strict discriminated
union of only `instance` and `loop`**, so the row failed validation and was dropped on load,
silently. The valid shape is
`{ kind: 'instance', requestedInstanceId, historyThreadId, sessionId? }`.

Two practical notes for the remaining sections: the store loads at **startup**, so a seeded row needs
an app restart to appear; and instances do not survive that restart, which is precisely why this run
landed on §4.2 (terminated requester) rather than §1.

### What the other sections still need

- **§1 (live idle), §2 (busy), §3 (hibernated)** need the requester instance to be *alive and in the
  right state* at submit time. Since seeding requires a restart and instances do not survive one, the
  practical route is an agent creating the review via the MCP `request_doc_review` tool in the same
  session — not seeding. That is now the only obstacle; the submit half is solved.
- **§5 (paused loop gate)** still needs a loop driven to its pause-for-review boundary.
- **§4.4 (setting off → failed delivery → Retry)** is directly reachable now: `docReviewRetryDelivery`
  is exposed, and the setting can be flipped over the settings CLI.

**Status: 1 of 9 expectations evidenced (§4.2), the blocker on the other eight reduced from "cannot
submit at all" to "need the requester in a specific state". Not renamed.**

### §4.4 — terminated requester with revival OFF → failed delivery → Retry revives — ✅ PASS, both halves

Driven immediately after §4.2, same technique. `docReviewResumeOnSubmit` set to `false` **on the dev
app only** (see the note below), then a decision submitted for a requester whose instance no longer
exists:

```
setting docReviewResumeOnSubmit → false
submit "approved"               → success
status                          → "approved"
delivery                        → { status: "failed", mechanism: "continuity-revive", attempts: 1,
                                    lastError: "Automatic review-session revival is disabled in settings." }
still listed by docReviewList   → true
```

That is §4.4's first half verbatim: **the decision stays visible and pollable while delivery fails**,
with an accurate reason rather than a silent drop.

Then the second half — flip the setting on and hit Retry:

```
updateSettings { docReviewResumeOnSubmit: true }
docReviewRetryDelivery { reviewId }  → success
delivery → { status: "delivered", mechanism: "continuity-revive", attempts: 2,
             targetInstanceId: "c239wnss3" }
```

| §4.4 assertion | Observed |
| --- | --- |
| decision stays visible/pollable with failed delivery | ✅ listed, `status: approved`, `delivery.status: failed` |
| the failure names its cause | ✅ `lastError` is the settings message, not a generic error |
| enabling the setting + **Retry delivery** revives | ✅ `attempts` 1 → 2, `status` failed → delivered |
| the revived instance keeps the original thread identity | ✅ `historyThreadId 7e8d6b45-…`, identical to the dead original |
| canonical feedback lands as the next turn | ✅ `## Document review feedback — LT 4.4 retry-delivery probe (review lt-dr-44)` / `Overall: APPROVED` |

Note the attempt counter goes **1 → 2** rather than resetting: the retry is recorded as a second
attempt on the same review, which is what makes the failure/recovery history readable afterwards.

#### A setting-scope trap, recorded so nobody repeats it

`$AIO_MCP settings set` writes to the **packaged** app's profile, not the dev app's. I set
`docReviewResumeOnSubmit false` there first, which would have changed behaviour on James's live app
rather than the one under test. Reverted to `true` within the same minute and confirmed
(`oldValue: false, newValue: true`), then set it on the dev app via `electronAPI.updateSettings`,
which is the correct route when driving a dev instance. **The packaged app's setting is back to its
original value.**

**Status: 2 of 9 expectations evidenced (§4.2, §4.4).** Both terminated-requester paths now pass.
The remaining seven need the requester alive in a specific state (§1–§3) or a loop at its
pause-for-review boundary (§5). Not renamed.

## Correction: seeding does **not** need a restart — §1 and §2 also PASS

I claimed above that "the store loads at **startup**, so a seeded row needs an app restart to
appear", and used that to argue §1–§3 were still blocked. **That was wrong**, and the error is worth
recording because it is the kind that closes doors that are actually open.

`DocReviewStore.list()`/`get()` (`doc-review-store.ts:36-47`) run a **live SQL query on every call** —
there is no cache, at the store or the service (`doc-review-service.ts:140`). My first seeded row did
not appear because its `origin` was invalid (`kind: 'agent'`), not because of caching. I restarted,
saw it appear, and wrongly credited the restart. Verified directly this run: a valid row seeded into
a **running** app is returned by `docReviewList` immediately, no restart
(`visibleWithoutRestart: true`).

That removes the obstacle I had described for §1–§3.

### §1 — live idle requester → `direct-send` — ✅ PASS

Instance `cqvr0ud2t` alive and `idle`, review seeded against its real identity, decision submitted:

```
delivery → { status: "delivered", mechanism: "direct-send", attempts: 1,
             targetInstanceId: "cqvr0ud2t" }
instanceCount → 1        ← no revival: the same session received it
first user msg → "## Document review feedback — LT 1 live-idle probe (review lt-dr-1)
                  Overall: APPROVED / General: …"
```

| §1.3 assertion | Observed |
| --- | --- |
| canonical `## Document review feedback` block | ✅ verbatim |
| `Delivery: delivered via direct-send` | ✅ `status: delivered`, `mechanism: direct-send` |
| delivered to the **same** live instance, not a revival | ✅ target is `cqvr0ud2t`; instance count stays 1 |

### §2 — busy requester → queued, no interrupt, delivers on idle — ✅ PASS

Same instance, long generation started, decision submitted **mid-turn**:

```
status at submit     → "busy"
delivery while busy  → { status: "queued", mechanism: "deferred-idle", attempts: 1 }
status after submit  → "busy"          ← the running turn was NOT interrupted
…turn completes…
final status         → "idle"
delivery             → { status: "delivered", mechanism: "direct-send", attempts: 2 }
```

| §2.3 assertion | Observed |
| --- | --- |
| delivery is **queued**, not attempted mid-turn | ✅ `queued` / `deferred-idle` |
| the in-flight turn is **not interrupted** | ✅ still `busy` immediately after submit; the essay completed |
| on idle → **one** canonical message | ✅ exactly 2 feedback messages across the whole run (one for §1, one for §2) — the queued delivery landed once, not twice |
| state transitions queued → delivered | ✅ `attempts` 1 → 2, `queued` → `delivered` |

The attempt counter incrementing rather than resetting is the same readable-history behaviour seen
in §4.4.

**Status: 4 of 9 expectations evidenced — §1, §2, §4.2, §4.4.** All four delivery mechanisms are now
covered by live evidence: `direct-send`, `deferred-idle` (queued), `continuity-revive`, and a
`failed` state with its retry. Remaining: §3 (hibernated), and §5's three paused-loop expectations.
Not renamed.

### §3 — hibernated requester → `wake` — ✅ PASS

Same instance, hibernated first (`hibernateInstance` → `status: "hibernated"`), then the decision
submitted:

```
delivery      → { status: "delivered", mechanism: "wake", attempts: 1,
                  targetInstanceId: "cqvr0ud2t" }
instanceCount → 1               ← the same instance, not a revival
status after  → "idle"          ← genuinely woken, not left hibernated
```

| §3.2 assertion | Observed |
| --- | --- |
| wakes the **same** instance | ✅ target `cqvr0ud2t`, count stays 1 |
| delivers the feedback | ✅ third canonical `## Document review feedback` block in this instance's transcript |
| records mechanism `wake` | ✅ verbatim |

**Status: 5 of 9 expectations evidenced — §1, §2, §3, §4.2, §4.4.**

All five delivery mechanisms are now covered by live evidence on a real app:

| Requester state | Mechanism | Section |
| --- | --- | --- |
| live + idle | `direct-send` | §1 ✅ |
| live + busy | `deferred-idle` (queued → delivered) | §2 ✅ |
| hibernated | `wake` | §3 ✅ |
| terminated, revival ON | `continuity-revive` | §4.2 ✅ |
| terminated, revival OFF | `failed` → Retry → `continuity-revive` | §4.4 ✅ |

Remaining: **§5's three paused-loop expectations only.** Those need a loop driven to its
pause-for-review boundary, which is a different fixture entirely (a running loop, not a seeded
review) — the one thing in this doc that seeding cannot stand in for.

### §5.5, second clause — terminal loop review fails and does **not** restart a loop — ✅ PASS

§5's three expectations mostly need a live loop paused at its review gate, which is a real fixture
and not seedable. But §5.5's second clause — *"terminal loop review shows delivery failure and does
not restart a loop"* — is testable without one, because a terminal/absent loop hits the same guard as
a no-longer-paused loop (`doc-review-delivery-coordinator.ts:153-156`).

Seeded two loop-origin reviews (`origin.kind: 'loop'`) pointing at a loop run that is not paused, and
submitted one of each verdict:

```
approved          → { status: "failed", mechanism: "none", attempts: 1,
                      lastError: "The associated loop is no longer paused at a review gate." }
changes_requested → { status: "failed", mechanism: "none", attempts: 1,
                      lastError: "The associated loop is no longer paused at a review gate." }

instances before: 0   instances after: 0        ← nothing was started
both reviews still listed: 2
```

| §5.5 assertion (second clause) | Observed |
| --- | --- |
| terminal loop review shows **delivery failure** | ✅ `status: failed`, with the specific gate reason rather than a generic error |
| does **not restart a loop** | ✅ instance count unchanged at 0 across both submissions — no revival, no spawn |
| the decision survives the failure | ✅ both still listed and pollable |

Note the guard fires **before** any acceptance or intervention call
(`deliverLoop` checks `loop.status !== 'paused'` first), which is why nothing is started — the
"does not restart" property is structural, not incidental.

The approve path's *other* guard is also worth recording for whoever runs §5.4 properly: an approve
on a genuinely paused loop that is not awaiting completion fails with
`"The paused loop is not awaiting completion acceptance."` (`:161`), gated on
`lastCompletionOutcome === 'unverifiable' || terminalIntentPending?.kind === 'complete'`. That is the
eligibility condition §5.4 exercises.

**Status: 6 of 9 expectations evidenced — §1, §2, §3, §4.2, §4.4, §5.5 (second clause).**
Remaining: §5.2, §5.4, and §5.5's first clause — all three need a loop actually paused at its
review gate.

### §5.2 / §5.4 / §5.5-first — the loop fixture: recipe found, run blocked on the child CLI

Attempted to build the missing fixture (a loop actually paused at its review gate) rather than leave
these three as "needs a loop". Got most of the way; recording the recipe so the next runner starts
from here.

**The route in, which the error messages themselves name.** `loopStart` refuses an implementation
loop with no verification authority:

> *"Implementation loops need a verification authority… or explicitly enable operator-reviewed
> completion (pauses for your sign-off; requires a finite estimated cost cap)."*

That escape hatch is exactly §5's fixture — `resolveLoopVerification`
(`loop-verify-command.ts:78-81`) returns `authority: 'operator-reviewed'`, and
`loop-start-config.ts:89-97` notes these loops *"sit paused waiting for a human Accept"*. So:

```jsonc
config.completion.allowOperatorReviewedCompletion = true
config.caps.maxCostCents = <finite>   // required; unbounded is refused by design
```

**Two IPC-shape traps worth knowing.** The prompt field is `initialPrompt`, not `goal`. And
`LoopConfigInputSchema` makes `caps`/`completion` optional *as whole objects* — but if you supply
either, every field inside is required. Hand-building them fails field by field. The working recipe
is to generate a full config from `defaultLoopConfig(workspaceCwd, initialPrompt)`
(`src/shared/types/loop-config-defaults.js` in `dist/`), then overlay the two settings above and
delete `audit`. That produced a successful `loopStart`.

**Where it stopped.** The loop started and reached iteration 0, then died:

```
[LoopCoordinator] Iteration invocation failed { seq: 0, attempt: 2 }
  message: 'Claude CLI exited with code null'
[LoopCoordinator] Loop terminated { status: 'error', reason: 'Claude CLI exited with code null' }
```

Exit code `null` means the child was killed by a signal, after a retry (`attempt: 2`) — an
environment/child-spawn failure in this sandbox, not something these three checks are testing. The
loop never reached a review gate, so it could not pause.

**So §5.2, §5.4 and §5.5's first clause remain unrun** — but the blocker is now specific and small:
a loop child that survives its first iteration. The fixture recipe above is the part that was
previously unknown.

For §5.4 specifically, note the eligibility gate the next runner must satisfy: approve only
succeeds when `lastCompletionOutcome === 'unverifiable'` **or**
`terminalIntentPending?.kind === 'complete'` (`doc-review-delivery-coordinator.ts:158-162`);
otherwise it fails with *"The paused loop is not awaiting completion acceptance."*

## Evidence run — 2026-08-12 — §5.2, §5.4, §5.5 first clause all reproduced live; the child-spawn blocker does not recur

Driven against a genuinely isolated dev app (`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-batchD-userdata`,
port 9454; see the sibling WS12 evidence for how that isolation was obtained), using the fixture
recipe the previous session worked out (`defaultLoopConfig` overlaid with
`completion.allowOperatorReviewedCompletion = true`, a finite `caps.maxCostCents`, `audit` deleted,
plus `planFile` set — the previous session's fixture never actually set `planFile`, which turns out
to matter, see below). The `Claude CLI exited with code null` failure **did not recur** — every loop
below ran its child to a real, observed completion. That earlier failure looks environment-specific
to that session, not a standing blocker.

**A real trap found and worked around, worth recording:** the first attempt supplied a `PLAN.md`
whose one checklist item was already checked off (`- [x] Reply with …`). The loop's own real Claude
agent — correctly, per the loop's completion-file-rename convention
(`completedFilenamePattern: '*_[Cc]ompleted.md'`) — renamed `PLAN.md` to `PLAN_completed.md` on its
own initiative before the loop paused, even though the task prompt never asked it to touch any file.
`maybeCreateDocReviewForPausedLoop` then failed silently (`ENOENT … PLAN.md`, only visible in
`app.log`, not in any IPC response) because the configured `planFile` path no longer existed. Fixed
by using a plan with **no checklist items** (prose only, explicitly telling the agent not to modify
any files) — not a product defect, but a fixture-authoring trap real enough that the next runner
should not rediscover it the hard way.

### §5.2 — pending review created while paused, not after terminal — ✅ PASS

Started a real loop (`loop-1786491569556-bc9a3f47`) with `planFile: 'PLAN.md'`. It ran one real
Claude iteration and reached:

```
{"status":"paused","stage":"IMPLEMENT","totalIterations":2,"lastCompletionOutcome":"unverifiable"}
```

`docReviewList` immediately showed a new **pending** review (`dr_56f74d3e-…`) targeting the loop's
own chat/instance identity — created **while the loop is `paused`**, not after any terminal state,
exactly as the check requires. `PLAN.md` was confirmed still present on disk (the fixture fix held).

### §5.4 — approve invokes loop acceptance — ✅ PASS, both halves

```
docReviewSubmitDecision({ reviewId: 'dr_56f74d3e-…', overall: 'approved' })
→ delivery: { status: "delivered", mechanism: "loop-accept", attempts: 1 }
```

`mechanism: "loop-accept"` is the decisive signal — the delivery coordinator genuinely routed
through loop acceptance, not a generic instance-message delivery. The loop's own state confirms the
accept was real, not just recorded: within seconds it transitioned

```
paused (lastCompletionOutcome: unverifiable) → completed-needs-review (lastCompletionOutcome: accepted)
```

### §5.5, first clause — changes-requested queues an intervention and the loop resumes — ✅ PASS

A second, independent loop (`loop-1786491677300-ecef3fb5`) reached the same paused/unverifiable
state with its own pending review (`dr_e9b6a324-…`). Submitted:

```
docReviewSubmitDecision({ reviewId: 'dr_e9b6a324-…', overall: 'changes_requested' })
→ delivery: { status: "delivered", mechanism: "loop-intervene", attempts: 1 }
```

`mechanism: "loop-intervene"` matches the schema's dedicated enum value for exactly this path. The
loop's own state proves it was not just recorded but actually acted on — within seconds:

```
paused → running (totalIterations 2, same run)
```

The loop genuinely resumed processing the queued feedback as its next turn. (The second clause of
§5.5 — a terminal loop review fails and does not restart a loop — was already proven live on
2026-08-01; not re-run here since nothing in that path changed.)

### Disposition: all 9 expectations across this checklist now have live evidence. Renaming to `_livetest_completed.md`.

| Requester/gate state | Mechanism | Section | Evidenced |
| --- | --- | --- | --- |
| live + idle | `direct-send` | §1 | 2026-08-01 |
| live + busy | `deferred-idle` → `direct-send` | §2 | 2026-08-01 |
| hibernated | `wake` | §3 | 2026-08-01 |
| terminated, revival ON | `continuity-revive` | §4.2 | 2026-08-01 |
| terminated, revival OFF → retry | `failed` → `continuity-revive` | §4.4 | 2026-08-01 |
| loop paused, pre-terminal | review created while paused | §5.2 | today |
| loop paused, approve | `loop-accept`, loop → `completed-needs-review` | §5.4 | today |
| loop paused, changes requested | `loop-intervene`, loop resumes | §5.5 (1st) | today |
| loop terminal/not-paused | `failed`, no restart | §5.5 (2nd) | 2026-08-01 |

Cleanup: both loops cancelled, both seeded/created reviews dismissed, `listInstances()` confirmed
empty of anything from this run, `/tmp/aio-lt-batchD-loop` removed. `docReviewResumeOnSubmit` and
all other settings touched by earlier sessions were already restored per their own evidence notes;
nothing in today's run changed any persistent setting.
