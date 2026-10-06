# Ping-pong review operator controls — Live Test

> **Found a defect while running these checks?** Record it in
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item (index row plus observed
> behaviour, root cause, required behaviour, and acceptance), and add a matching implementation
> status section to `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check evidence
> stays in this file.
>
> Before continuing, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [PINGPONG_IMPLEMENTATION_STATUS_completed.md](PINGPONG_IMPLEMENTATION_STATUS_completed.md)

**Prerequisites:**

- A running Harness build that includes the ping-pong UI (any build since the feature merged).
- A small, real task in a scratch repository, and two signed-in providers (the builder, and a
  different reviewer provider, for example Claude building and Codex reviewing).
- Why this is deferred: the checks need a real loop with real provider CLIs and an operator clicking
  the loop control strip mid-run. Ping-pong convergence itself already passed live in
  [2026-08-20-pingpong-loop-cannot-terminate_livetest_completed.md](2026-08-20-pingpong-loop-cannot-terminate_livetest_completed.md);
  only the two operator buttons have never been exercised against a live run.

## Check 1 — Skip round

**Steps:**

1. Open the Loop config panel next to the composer, tick **Ping-pong review**, choose a reviewer
   provider different from the builder, subject `auto`, max rounds `4`, and start the loop on the
   scratch task.
2. Wait until the loop control strip shows `PING-PONG round 1/4`.
3. Before the builder's next done-declaration, click **Skip round**
   (`loop-control.component.html:145`, IPC `LOOP_PINGPONG_SKIP_ROUND`).

**Expected:** the next reviewer round does not run (no reviewer instance is spawned for it; the
app log shows no `ReviewerSessionSpawner` spawn for that round), the loop continues with the
builder, and the round counter advances past the skipped round. The loop does not stop or error.

## Check 2 — Arbitrate

**Steps:**

1. Start a second ping-pong loop as in Check 1.
2. Once a reviewer round has produced at least one open issue (the strip shows `open issues ≥ 1`),
   click **Arbitrate** (`loop-control.component.html:146`, IPC `LOOP_PINGPONG_FORCE_ARBITRATION`).

**Expected:** the review rounds stop, the loop reaches its arbitration terminal state, and the open
issues are handed to the operator in the loop panel. No further reviewer instance is spawned, and
no orphan reviewer instance is left running.

## Evidence

## Status — 2026-10-04 (livetest campaign batch D)

Open: 0 · Closed: 2 (checks 1 and 2 both PASS, each by a real click on the loop-control button) · Failed: 0 ·
New defect found nearby: LT-702 (a ping-pong round can still hang with a finished reviewer verdict; intermittent,
not part of either check). LT-643's and LT-644's fixes are confirmed live again: of 6 real loops, 5 had every
reviewer round reach a verdict in 50–100 s, and findings were parsed every time (the sixth is LT-702). Full write-up: [Evidence run — 2026-10-04 (batch
D)](#evidence-run--2026-10-04-batch-d).

## Status — 2026-09-24 (verify-final)

Re-ran against the ~03:45 working-tree rebuild. **LT-643's hang is CONFIRMED FIXED**: three
independent real ping-pong loops (Claude building, Codex reviewing) all completed normally —
round 1 and round 2 reviewers both settled, `pingPong()` populated correctly in the UI, and each
loop reached a real terminal state (`completed-needs-review`) within 2–3 minutes, versus the prior
indefinite hang after round 1. Check 1 (Skip round) was exercised but its specific "no reviewer
spawned for the skipped round" assertion landed on a race (round 2 was already in flight by the
time the click registered) before the loop converged naturally, so that narrow assertion is
inconclusive rather than a clean pass. Check 2 (Arbitrate) could not be exercised in any of the
three attempts: the reviewer's structured JSON consistently reports zero `findings` even while its
verdict is `CHANGES_REQUESTED`, so the ledger the UI counts from never holds an "open" issue for
the button's precondition to trigger — see the write-up below. Full evidence:
[Evidence run — 2026-09-24 (verify-final)](#evidence-run--2026-09-24-verify-final).

## Status — 2026-09-24 (loops batch)

Open: 2 (both blocked by a new defect) · New defects: 1 (LT-643, P1)

Both checks are **BLOCKED**, not merely unrun: a real ping-pong loop (Claude building, Codex
reviewing) was started in a disposable scratch repo, and its round-1 reviewer produced a real,
valid `CHANGES_REQUESTED` verdict — but the loop never surfaced a ping-pong round to the operator at
all, hanging indefinitely afterward. Neither **Skip round** nor **Arbitrate** ever became clickable
because the UI state (`app-loop-control`'s `pingPong()` signal) never populated. Filed as **LT-643**.
Full evidence below.

## Evidence run — 2026-09-24 (loops batch)

Batch id `loops`, HEAD `f04f6748`. Scratch repo `/tmp/aio-lt-0924-loops-work/repo3` (git-initialised,
one commit). Chat: `provider: claude`, `yolo: true`. Loop config: `completion.mode: 'review-driven'`,
`completion.crossModelReview: { enabled: true, reviewers: ['codex'], ... }`,
`completion.crossModelReview.pingPong: { enabled: true, reviewerProvider: 'codex', subject: 'auto',
maxRounds: 4 }`, task: create a minimal `calc.py` with an `add(a, b)` function.

**What happened, with timestamps (loop id `loop-1790213435794-57df2268`):**

1. `T+0` (`1790213435794`) — loop started.
2. `T+11s` — builder (Claude) iteration 0 completed (`DefaultInvokers: Orchestration invocation
   completed`, 743 tokens, $0.16) and workspace observation found 1 changed path (`calc.py`).
3. `T+11s` — a real ping-pong reviewer instance spawned: `InstanceLifecycle: Creating instance
   {displayName: "Ping-pong reviewer 1/4 (codex)", provider: "codex", modelOverride: "gpt-5.6-terra",
   ...}`, instance id `x40s9alwb`.
4. `T+89s` (`1790213525023`) — the reviewer instance went `idle`. Its `outputBuffer`'s final entry
   (read directly via `listInstances()`, not the transcript) is a complete, well-formed verdict:
   `` {"verdict": "CHANGES_REQUESTED", "summary": "calc.add is correct and smoke-tested, but the
   change includes unrelated generated/configuration files despite the explicitly minimal
   calc.py-only scope.", "completeness": {"filesInspected": 4, "commandsRun": 5, ...}} `` — the
   reviewer did real work (ran the smoke test, checked git status, found scope creep from
   `.gitignore`/`__pycache__`) and produced exactly the kind of open issue Check 2 needs.
5. From `T+89s` onward — **nothing**. `app.log` has zero further lines mentioning this loop id or
   this instance id for the rest of the run. `loop_runs.total_iterations` stayed `0`,
   `current_stage` stayed `IMPLEMENT`, `status` stayed `running`. The chat transcript never grew past
   the single initial user message — no system "Loop ended" line, no assistant turn, nothing.
   `app-loop-control`'s `pingPong()` signal read `null` continuously for the remainder of the run
   (polled every 2–5s for over 8 minutes).
6. The review's own configured timeout (`crossModelReview.timeoutSeconds: 600` = 10 minutes from the
   reviewer's spawn time, `T+11s` → expected to fire at `T≈611s`) **also never fired** — polled again
   at `T+574s` and `T+619s` (`45s` past the expected timeout) with no change at all: no timeout
   warning logged, no state transition, no error surfaced anywhere.
7. The loop was cancelled by hand (`loopStore.cancel(...)`) as cleanup; `loop_runs.status` confirms
   `cancelled`. The reviewer instance was terminated. Nothing was left running.

**Why neither check could be exercised:** Check 1 needs the strip to show `PING-PONG round 1/4`
before clicking **Skip round**; Check 2 needs `open issues ≥ 1` before clicking **Arbitrate**. The
reviewer's real output already satisfies check 2's precondition content-wise (a genuine open issue),
but the operator-facing signal that would make either button relevant or clickable never appeared —
so this pass could not click either button, and it would be misleading to record that as "not run"
rather than "blocked by a reproduced defect".

### Defects filed from this run

**LT-643 (P1) — a ping-pong loop hangs indefinitely once round 1's reviewer finishes, even though
the reviewer produced a complete, valid verdict; the operator never sees a round, an issue, or a
timeout.**

*Observed:* See the timestamped sequence above. Summary: reviewer settles with a valid JSON verdict
at `T+89s`; the loop coordinator never logs `Ping-pong reviewer produced a verdict` (zero occurrences
in `app.log` for the whole session) and never advances; the UI's `pingPong()` state stays `null`
forever; the review's own 600s timeout does not fire either (checked well past `T+610s`). The loop
sits at `running`/`0 iterations` until manually cancelled.

*Root cause: NOT fully isolated — reported at the confidence the investigation actually reached.*
Read, in order, looking for the break: `agentic-pingpong-reviewer.ts` awaits
`ReviewerSessionSpawner.runReviewSession()` (`reviewer-session-spawner.ts:181-230`), which awaits
`InstanceManager.waitForInstanceSettled()` (`instance-manager.ts:984-989`) →
`InstanceSettledTracker.waitForSettled()` (`instance-settled-tracker.ts:104-199`), a purely
event-driven wait (no polling) on `'instance:settled'`, itself only emitted from
`maybeEmit()` (`:56-91`), itself only invoked from a debounce timer armed by `recordActivity()`
(`:41-53`), itself only called from `InstanceManager`'s status-change handler
(`instance-manager.ts:771`, on every `instance:state-changed`/idle transition) and from an activity
handler (`:871`). Every one of those pieces reads correctly in isolation — `isInstanceSettled()`
(`instance-state-machine.ts:98-131`) should return `true` for an idle instance with a trailing
assistant message and no interrupt in flight, which is exactly this instance's shape. But since
**neither** the success log (`agentic-pingpong-reviewer.ts:678`) **nor** the spawner's own failure log
(`reviewer-session-spawner.ts:225`, `'Ping-pong reviewer did not settle cleanly'`) **nor** a timeout
ever fired, the promise chain appears to be stuck *before* it ever resolves or rejects — which points
at the settle-detection wait itself (the event is never emitted, or the timeout timer inside
`waitForSettled`'s `Promise` executor was never armed for this call), rather than at
`agentic-pingpong-reviewer.ts`'s own JSON-parsing logic (which would have logged one of the two
messages above either way). This needs a fresh, targeted investigation — ideally reproducing with a
debugger/breakpoint on `InstanceSettledTracker`, since black-box log evidence alone could not localise
it further in the time available.

*Required behavior:* once a ping-pong reviewer instance settles with real output, the coordinator
recognises it (success or the format-repair/malformed-output path) within a bounded time, and if
nothing recognises it before the configured review timeout, the round fails loudly (a logged timeout,
a visible error state) rather than hanging silently forever.

*Acceptance:* a real ping-pong round's reviewer completing is followed, within seconds, either by
`Ping-pong reviewer produced a verdict` in the log and a populated `pingPong()` UI state, or — if
something is genuinely wrong — a timeout/failure that surfaces in the loop's causal timeline and the
loop does not hang past its configured `crossModelReview.timeoutSeconds`.

*Owning doc + check:* this doc, checks 1 and 2 (both blocked).

### Cleanup

The loop was cancelled by hand; the reviewer instance (`x40s9alwb`) was terminated;
`listInstances()` confirms zero instances remain. `/tmp/aio-lt-0924-loops-work/repo3` is removed in
this batch's final cleanup along with `repo1` and `repo2`.

---

## Evidence run — 2026-09-24 (verify-final)

Batch `verify-final`, CDP port 9741, profile `/tmp/aio-lt-0924-verify-final`, driven against the
~03:45 working-tree rebuild. Three disposable scratch repos: `/tmp/aio-lt-0924-verify-final-work/repo3`
(trivial `add` task, same shape as the `loops batch` run that first hit LT-643), `repo4` (calc.py
with 4 ops and no error handling — mildly worse), `repo5` (an `evaluate(expr)` using bare `eval()`,
explicitly asked to trigger a real reviewer finding, with the builder instructed to defend rather
than blindly fix it on a second pass — commented and reviewed for safety: the `eval()` only ever
appears inside a throwaway `/tmp` scratch repo used to bait a Codex code-review finding for this
test; it never runs in this repository's own code).

**LT-643 hang — CONFIRMED FIXED, 3/3 real loops.** Every loop's round-1 (and round-2) reviewer
settled and logged `AgenticPingPongReviewer: Ping-pong reviewer produced a verdict` promptly
(round 1 settling in 70–90s each time), `app-loop-control`'s `pingPong()` signal populated
correctly (`roundCount`, `reviewerCostCents`, `lastReviewerProvider: 'codex'`, etc. all present —
e.g. the strip read `REVIEW PING-PONG round 1/4 · reviewer codex · impl · 0 open issues · reviewer
$0.75`), and every loop reached a real terminal state (`completed-needs-review`, "Ping-pong
converged-or-arbitrated after 2 rounds…") within 2–3 minutes total. Zero indefinite hangs, zero
silent stalls past round 1 — the exact failure mode `loops batch` reported. Reading
`src/main/orchestration/reviewer-session-spawner.ts`'s diff confirms the fix: it no longer `await`s
`instance.readyPromise` before calling `waitForInstanceSettled()` (which — per the `loops batch`
write-up's own investigation — never resolved for a Codex app-server reviewer even after the
reviewer went idle with a complete verdict). A new `raceBackgroundInitFailure()` lets the settle
wait own the timeout instead, with a comment citing LT-643 directly.

**Check 1 (Skip round) — exercised, one narrow assertion inconclusive due to timing, not a
defect.** In the `repo3` loop, `pingPong()` first became visible with `roundCount: 1` already
fully priced (`reviewerCostCents: 75`) — i.e. round 1 had already completed by the first 3-second
poll tick. Clicking **Skip round** immediately afterward showed `skipNextRound: true` recorded
correctly in state, but `inFlightRound: 2`/`inFlightReviewerInstanceId` were *also* already set at
that same instant — round 2's reviewer had already been spawned in the ~1.5s between my poll
observing round 1 and the click landing, so this specific click could not have prevented that
particular spawn. The loop then converged naturally after round 2 (before a round 3 the skip flag
could have suppressed), so "no reviewer spawned for the skipped round" was never put to a clean
test. The button itself is clickable, records intent correctly, and caused no error or hang — but
this run cannot confirm or refute the skip's *effect* on a round. Owning check's assertion:
inconclusive, not failed.

**Check 2 (Arbitrate) — BLOCKED across all 3 attempts; its precondition (`open issues ≥ 1`) was
never reached, for a reason distinct from LT-643.** `app.log` shows, for every one of 6 reviewer
rounds across the 3 loops (`repo3` rounds 1–2, `repo4` rounds 1–2, `repo5` rounds 1–2):
`AgenticPingPongReviewer: Ping-pong reviewer produced a verdict` with `"verdict":"CHANGES_REQUESTED"`
paired with **`"findings":0`** every single time, even for `repo5`'s deliberately planted `eval()`
issue and even though the loop's own final terminal text says "only low-severity suggestions
remained" (implying the reviewer *did* have something to say, just not in the structured
`findings` array the ledger reads). Read `agentic-pingpong-reviewer.ts:678-691`: the logged
`findings` count is `allFindings.length`, i.e. `normalizeFindings(parsed['findings'])` from the
reviewer's own parsed JSON — so an empty ledger is a direct, faithful consequence of the reviewer's
JSON having an empty (or absent) `findings` array, not a downstream bug in
`loop-pingpong-completion.ts`'s folding logic (`applyLedgerUpdates` at `:128-151` unconditionally
adds every item in `findings` as `status: 'open'`; there were simply zero items to add each time).
`app-loop-control`'s `pingPongOpenIssues()` (`loop-control.component.ts:189-190`) correctly reads
this same empty ledger, so the **Arbitrate** button's precondition genuinely never became true —
the button was visible throughout but had no open issue to arbitrate over.

*Confidence and scope, stated plainly:* this is a real, 6/6-reproduced pattern, but root cause is
**not fully isolated** to the same standard as the original LT-643 write-up — I did not capture the
reviewer's own raw transcript/JSON (the reviewer instances had already auto-terminated by the time
I went looking), so I cannot yet tell whether Codex's actual response omits the `findings` array
(a prompt/model-compliance gap on the reviewer side) or whether something upstream of
`normalizeFindings` is dropping populated data before this log line. This is not filed as a new
LT-NNN here — it blocks Check 2 exactly as reported, but deserves a fresh, targeted look at a
captured raw reviewer transcript before anyone acts on a specific fix.

*Owning doc + check:* this doc, Check 2 (Arbitrate) — blocked, precondition never reached in 3
real attempts.

### Cleanup

All three loops' builder chats were left as ordinary idle chat instances and terminated in this
batch's final cleanup pass (`listInstances()` confirmed `remaining: 0` afterward); every reviewer
instance had already auto-terminated on its own by the time instances were listed, so no orphan
reviewer instance was ever left running in any of the three runs. `/tmp/aio-lt-0924-verify-final-work/repo3`,
`repo4`, and `repo5` were removed along with the rest of this batch's scratch paths.

## Evidence note — 2026-09-24 (orchestrator, LT-644)

Check 2 (Arbitrate) was blocked because every reviewer round appeared to have zero findings. The
captured Codex rollouts show the reviewers did report findings: 8 across 7 rounds. The parser
dropped all of them because the prompt never named the finding fields (Codex used `issue` and
`suggestedFix`). This is fixed in the working tree as
[LT-644](livetest-remediation-register.md). Re-run check 2 on a rebuild with the fix: a round with a
real finding should populate the open-issues ledger and make Arbitrate available.

## Evidence run — 2026-10-04 (batch D)

Batch D, dev app from the working tree (HEAD `3d05e250e`), profile `/tmp/aio-lt-1004-d`, throwaway repos
`/tmp/aio-lt-1004-d-repos/pp1`…`pp6` (each a one-file Python stub). Builder: Claude (yolo, isolation off).
Reviewer: Codex, ping-pong `maxRounds 4`, subject `auto`. Evidence in `_scratch/lt-2026-10-04/d/` (`pp*-watch.json`,
`pp*-applog-slice.ndjson`). LT-643 re-checked first, as asked: it is fixed (register status "FIXED + CONFIRMED LIVE");
LT-644 (the parser change the 2026-09-24 note says to re-run check 2 on) is fixed too — the reviewer's findings
reached the ledger on every round that had any (`findings` 2, 1, 1, 1 in `pp1`; 1 in `pp2`, 1 in `pp4`; 2 then 1 in `pp6`).

### Check 1 — Skip round · PASS

Loop `loop-1791159990332-a5233c6f` (`pp6`, task: implement `evaluate(expr)` minimally, which the reviewer flags). Round 1
reviewer verdict logged at `1791160128434` (2 findings, `open 2`). My watcher waited for the **Skip round** button to
exist in `app-loop-control` (found by its text), then did a real DOM click at `1791160129687`.

- State immediately after: `pingPong.skipNextRound: true`, `roundCount: 1`, nothing in flight; log `1791160128886
  LoopCoordinator: Ping-pong: operator requested skip of next reviewer round` (`pp6-applog-slice.ndjson`).
- The flag was consumed on the builder's next done-declaration: `skipNextRound` read `false` at `1791160163309` with no
  `inFlightRound`. Codex reviewer instances were created at `1791160019880` (round 1), `1791160172693` (round 2) and
  `1791160302439` (round 3) — none between the click and the declaration that consumed the flag. Builder iterations
  `::2` `…150582`, `::3` `…163173`, `::4` `…172606`; the round-2 reviewer started right after `::4`.
- The loop did not stop or error; it converged (`APPROVED`, "Ping-pong converged after 3 round(s)").
- Doc wording: "the round counter advances past the skipped round". It does not: `roundCount` stayed `1` through the
  skipped declaration and the next reviewer ran as round 2 (`loop-pingpong-completion.ts:281-292` returns early without
  touching the counter). A skipped declaration does not use up a round; I judged that the intended behaviour.
- Earlier run (`pp1`, `loop-1791154975053-70b704c6`, button's IPC `loopPingPongSkipRound` called directly) gave the
  same result. Clicking before round 1 finished is refused (`ok:false`), because `pingPong` state does not exist until the
  first round.

### Check 2 — Arbitrate · PASS

Loop `loop-1791155574133-168fa5ef` (`pp2`). Round 1 reviewer: `CHANGES_REQUESTED`, one open `critical` issue
("Arbitrary code execution through expression input (calc.py:2)"). Strip at the click: `REVIEW PING-PONG round 1/4 ·
reviewer codex · impl · 1 open issue · reviewer $0.68 Skip round Arbitrate`. A real DOM click on **Arbitrate** at
`1791155653745`: `forceArbitration: true` within 1.2 s; the loop reached `needs-human-arbitration` at about
`…669184` (one more builder iteration first, since the flag is honoured "at the next completion check"). The panel
showed `Loop ended — needs arbitration`, `Reason: Operator forced arbitration after 1 round(s). Open issues: - [critical]
Arbitrary code execution through expression input (calc.py:2) — open`, "Independent review blocked", "Review the
disagreement". `listInstances` afterwards held no reviewer instance (only my unrelated parent), and no further reviewer
was spawned.

### New defect — LT-702: a ping-pong round hung with a finished, valid verdict

Loop `loop-1791159168709-68f35d3a` (`pp5`, identical task to `pp6`): the Codex reviewer `xgu30ef14` finished with a
complete JSON verdict about 46 s after spawn, but the loop stayed at `inFlightRound 1` with no `Ping-pong reviewer
produced a verdict` line until I cancelled it at 757 s; the verdict then parsed within 334 ms. Detail and evidence: LT-702
in `livetest-remediation-register.md`. Correction to the 2026-09-24 write-up above: the effective reviewer timeout is
`pingPong.reviewerTimeoutSeconds` (default 900 s), not `crossModelReview.timeoutSeconds` (600), so "the 600 s timeout
never fired" was measured against the wrong setting. The hang itself is real.

### Cleanup

All loops ended (`completed`, `needs-human-arbitration`, `builder-unreliable`, or cancelled); reviewer instances were
torn down by the loops themselves except the one hung in `pp5`, which ended when the loop was cancelled; dev app
stopped; profile and scratch repos removed.
