# Oct-2 Phase E: a calmer screen and plainer words

## Status

On main: no.

Ready for the coordinator’s independent verification. All 12 implementation steps are in the supplied queue checkout, with focused source/runtime checks and the worker’s required typecheck, lint, size and main/renderer build gates passing. The root plan remains active and uncommitted; no completion rename, commit or integration was performed. The full suite and fresh task-completion-gate acceptance belong to the coordinator. Deployed/provider/device checks remain in the linked livetest document. An extra renderer-event inventory audit reports five pre-existing gaps; its checker, registry and reported send sites are unchanged from HEAD. Evidence, decisions and actual command results are in the [history report](2026-10-20-oct2-phaseE-calm-screen_history.md).

**Backlog source:** [`claude_oct-2-todo.md`](../../claude_oct-2-todo.md) items U1-U4, U6 steps 2-5, U7-U12, and the
fact-check's ordering and wording notes (`_scratch/oct2-audit/_verify-3.md` S5, S7, S8 and nits). U5 and U6 step 1 are in
Phase A. **Programme:** [A](2026-10-20-oct2-phaseA-safety-and-truth_plan.md) ·
[B](2026-10-20-oct2-phaseB-land-built-work_plan.md) · [C](2026-10-20-oct2-phaseC-queue-that-finishes_plan.md) ·
[D](2026-10-20-oct2-phaseD-tokens_plan.md) · E (this) · [F](2026-10-20-oct2-phaseF-tooltips_plan.md) ·
[housekeeping](2026-10-20-oct2-housekeeping_plan.md) · [later](2026-10-20-oct2-later_plan.md) ·
[decisions](2026-10-20-oct2-decisions-for-james_completed.md).

## In plain English

The clutter has moved from the session header to system messages and the title bar. Five of the eight screenshots James
pasted between 11 and 18 October show raw error text from the AI companies' tools as the loudest thing on screen. After
this plan:

- each problem shows one plain sentence and what to do, with the raw text behind "Details";
- a usage limit says which account and the day and time it resets, once;
- the title bar shows only what needs attention ("Startup degraded" stops appearing because an unused tool isn't installed);
- each thing has one name (a MiMo account stops having five);
- a short quiet line under each turn says what it did and what failed, and warns when an edit failed but the reply
  glossed over it;
- a failed turn gets a calm card with "Try again" that continues rather than repeats;
- typing in the message box answers a waiting question card, and closed cards leave a one-line receipt;
- the Costs page explains where usage went, using Anthropic's own nine causes.

## Ground rules

1. **Read first**; line numbers are from 20 Oct `main` and will move when Phase 3 lands; re-locate by name.
2. **Prove it first** with the named failing test.
3. **Current checkout only;** no branch or worktree; never stage, revert or stash other sessions' files; commit only when
   James asks.
4. **File size:** 700 for non-allowlisted files (no slack), ceiling + 50 for allowlisted. `instance-communication.ts` is
   at 2,545 of 2,546 lines on 20 Oct: Steps 3 and 10 must leave it net zero or smaller (move the raw-exit and
   `turnErrored` text building into the new presenter modules). Shared presentation logic goes in `src/shared/` modules
   with their own specs. Also tight: `instance-provider-limit-handler.ts` 978/985 and `input-panel.component.ts`
   1,952/1,960, `user-action-request.component.ts` (about 20 lines of room) and `output-stream.component.ts` (about 25)
   (Steps 3, 8, 10 and 11: net zero where possible, logic in new modules).
5. **Angular:** standalone, `OnPush`, `inject()`, signals, `input()`/`output()`; no `zone.js`; no backticks inside inline
   styles.
6. **Words:** plain English, "Harness", no internal codes; tooltips through `appTooltip`, never a new `title=`. Phase F's
   glossary (H7) is the single word list; this plan's name module (Step 4) holds only the name maps.
7. **No browser or desktop app on the Mac.** Test headless in Vitest with seeded stores; eyes-on checks go to this plan's
   livetest document and run on the Windows PC. If it is down, stop and tell James; never fall back to the Mac.
8. Keep the Status block under about 1,500 characters.

## Order of work

| Step | Item | Size | Needs first |
|---|---|---|---|
| 1 | U10 fold routine notices by flag, not by exact text | S-M | Phase 3 landed |
| 2 | U1 data fix: a nonzero Codex exit is not an error | XS | none (needed before Step 9) |
| 3 | U1 the shared error presenter and the first sources | S then M | Step 1 |
| 4 | U3 one name for each thing | S | Step 3 |
| 5 | U4 one status presenter (Phase 3 step 8b), plus the phone app half | S | Step 4 |
| 6 | U2 healthy means hidden | S | Steps 3-4 |
| 7 | U12 small copy fixes | XS | Step 4 |
| 8 | U6 steps 2-5 the browser approval card | S | Phase A Step 12 |
| 9 | U7 a one-line note under each turn | S-M | Steps 1-2 |
| 10 | U8 a calm failure card | S-M | Step 3 |
| 11 | U9 question cards and receipts | M | Phase 3 step 11c landed |
| 12 | U11 "Where your usage went" | M | Phase D Step 10 (prices) |

---

## Step 1. U10: fold routine system notices instead of hiding exact strings

Routine notices are hidden by kind and by two literal strings, `'Interrupted — waiting for input'` and `'Interrupted —
session restarted (resume failed)'` (`display-item-system-events.ts:17-20`, used at `display-item-processor.service.ts:294-
308`); a hidden notice cannot be inspected later, and any rewording (Step 3) would make them reappear.

1. At each emit site of those two notices, set a metadata flag (`audience: 'routine'`), and switch the processor to the
   flag. Delete the string set.
2. Every system message carries `audience: 'routine' | 'attention'` from now on (default `attention`, so nothing new is
   hidden by accident). Consecutive routine messages fold into one "N system events" row showing the worst severity; it
   expands on click. Failed tool calls and approvals never fold.

Tests: processor and system-events specs: a routine pair folds; an attention message between them splits the fold; the
two old strings with no flag now show (proving the string match is gone).

## Step 2. U1 step 5: a nonzero Codex command exit is not automatically an error

`codex-notification-item-events.ts:219` sets `isError` for any nonzero exit, written to `is_error` at `:230`. No renderer
code reads it; its readers are the loop activity record, the tool-loop detector and the correction miner. Set `is_error`
only when the command could not run (spawn failure, killed by timeout); otherwise record the exit status and show "Exited
with status N" in neutral text. Check each reader still flags a real failing test run (the detector's own spec), because a
test runner that exits 1 is a real failure for the loop: keep `exitCode` available to it. This step defines "failed" per tool
kind for Step 9: an edit or write that errored, or a command that could not run or that the caller marks as a check.

## Step 3. U1: one plain message per event, raw text behind "Details"

1. **`src/shared/present-error.ts`:** `presentError(codeOrError, context) → {headline, whatToDo, action?, rawDetail}` from a
   closed list of categories (quota, auth, network, provider-crash, concurrency, tool-server, cancelled, unknown). Only
   whitelisted fields go into the sentence, so private provider text never leaks into it. Every message has the shape "what
   happened", then "What to do: …" or "No action needed: Harness is already retrying."
2. **The sources in James's screenshots first:**
   - **Codex log lines** (`exec-process-runner.ts:417` keys repeats on `${category}:${line}`, and each line carries its own
     timestamp, so repeats never match): strip the timestamp before keying and before showing; add a tool-server rule ("A
     tool server didn't start for this Codex session: <name>"); one line per category per turn; raw line under Details.
   - **The usage limit:** `claude-cli-adapter.ts:1778` (time only, from `toLocaleTimeString()` at `:1767`) and the separate
     "Provider limit reached …" note (`instance-provider-limit-handler.ts:652-657`) become one message: "Your <account>
     Claude account has used its weekly allowance. It resets on Thursday at 23:00. [Switch account]", with day and date when
     the reset is more than 12 hours away. Never print `rejected` or `seven_day`.
   - **Concurrency timeout** (`provider-concurrency-limiter.ts:195-197`): "OpenCode is already running its maximum of N
     sessions; this one waited a minute. [Try again]".
   - **MiMo sign-in:** "Signed out of <account>. [Sign in]".
   - **Removed-account toast:** names the session.
3. **Held messages** (`input-panel-formatters.ts:56-71`): one plain sentence per wait kind with a ticking "waiting 12 s"
   (the wait-reason type already carries start times and deadlines). After two minutes offer "Keep waiting" and "Stop
   waiting and keep my message".
4. **Turn-end notices** (`turn-ending-continuation-policy.ts:36-59`): add `empty_result` ("The model sent no reply");
   every notice says whether James's message and the work were kept (today quota, billing, auth, context_overflow,
   doom_loop, parent_silent, content_filter and completed do not), enforced by a spec that iterates the table; optional action buttons (continue, retry,
   switch model, sign in); the `crash` notice replaces the raw "Process exited unexpectedly with code N"
   (`instance-communication.ts:2202`, `:2215`); split runtime notices that serve both model and user into a model text and a
   user text.
5. **A ratchet:** a lint or spec that fails on new code putting `${error}` or `.message` straight into visible text (about
   188 places today form the baseline, which only goes down).

Tests: `present-error.spec.ts` per category; an `exec-process-runner` spec for timestamp-stripped de-duplication; a
continuation-policy spec that every notice states what was kept.

## Step 4. U3: one name for each thing

`src/shared/display-names.ts` (does not exist yet): `providerName(id, {long?})`, `accountFamilyName`, `computerName(node)`,
`PRODUCT_NAME = 'Harness'`. Replace the 17 local provider maps (four spellings of Codex), with a guard spec that fails on a
new local display map. MiMo reads "MiMo" everywhere, "via OpenCode" only under Details. The quota strip's codes
(`PROVIDER_CODES`, `provider-quota-chip.component.ts:599-608`, where CU means Cursor but Computer Use elsewhere) become
short names plus the worst percentage, with account names in the popover. The shell hints in `PROVIDER_REAUTH_HINTS`
(`:616-625`) move behind Details; a signed-out account reads "Signed out of <name>. [Sign in]". "Your other computers" and
"this Mac" on screen; "node" and "worker" only under Details (the word list itself lives in Phase F's glossary).

## Step 5. U4: one status presenter

Phase 3's step 8b (planned as `src/shared/attention/instance-status-presentation.ts`, not started on its branch):
`presentInstanceStatus(status, waitReason) → {label, tone, detail}` with about eight labels: Working, Thinking, Needs your
answer, Needs your OK, Restarting, Asleep, Stopped, Problem. Use it at all five sites (`status-colors.ts`, which nothing
imports and can be deleted; `status-indicator.component.ts:8-56`; `instance-row.component.ts:357-366`;
`child-instances-panel.component.ts:425-449`; `mobile-gateway-push.ts:89-104`) and in notifications, with a spec that fails
on a new local label map. Colours from one table (respawning is purple in one file and teal in another today).

**Phone app half** (Phase A did the desktop half): `apps/mobile/src/app/core/status.ts:127-132` (a sixth map; update
`status.spec.ts:66`) and the Swift widget's `statusColor` and `shortStatus` (`HarnessLiveActivity.swift:98-120`) learn the
new labels; this needs a phone build and release, so record it as a live check. Note that `apps/` is outside `tsc` but
inside lint and Vitest.

## Step 6. U2: healthy means hidden

1. A missing optional CLI is `disabled` (the status already exists), not `degraded`, unless the user has an account or
   default for it (`capability-probe.ts:177-186`). Only critical or in-use checks make startup "degraded".
2. Hide the "Startup …" chip when ready (`app.component.html:10-21`; `startupStatusChipReport` at `app.component.ts:187`
   has no hide rule). Each check gets its own fix button (Accounts, Remote computers, Browser, Setup) and a plain summary
   ("Cursor isn't installed. You only need it to use Cursor."). Replace developer text such as "Hardened run mode is
   macOS-only (Phase A)" (`capability-probe.ts:96`).
3. The local-model chip shows for every state except healthy and not configured (it has an `unavailable` state too,
   `local-ai-status-chip.component.ts:7-14`), in plain words ("Local helpers paused until 14:20"), under one name, "Local
   models" (today "Local AI", "Local AI Guard" in its label at `:138`, and "Local AI health centre").
4. Anything with both a switch and a live state shows two lines: "On, but not running yet: <why>" and "Running: <what you
   can do now>". Never "unavailable" for something not yet checked: "Checking…" or "Couldn't check: <reason>".

Done when a normal launch shows the quota strip and notifications and nothing else in the title bar.

## Step 7. U12: small copy fixes, in one change

1. "Ask Claude to Address" on every provider's second-opinion panel (`cross-model-review-panel.component.ts:63`) → the
   session's own provider name.
2. "Codex is compacting… your message will send afterwards" for every provider (`input-panel.component.html:458-459`, and
   its copy in `message-format.service.ts:145`) → provider-aware.
3. "Restart AIO" (`computer-use-permission-banner.component.ts:64,67`; `computer-use-settings-tab.component.html:41,44`) →
   "Restart Harness"; update the two specs that query the aria-label on purpose.
4. The clean-up dialog's developer measurement ("The scratch trial took about 2 seconds for 249 MB…").
5. Settings heading "Session process fence" → a plain heading.
6. "iter" and "AIO stops retrying it" in past loop runs (`loop-past-runs-panel.component.ts:121,165`).
7. The wrong code comment about `window.confirm()` (`prompt-modal.component.ts:21`).
8. Effort picker (`model-picker.controller.ts:260-261`): Max → "Thinks as long as it can on every step and uses much more of
   your allowance. Keep it for the hardest problems." Workflow → "Splits every task across many helper agents; each one uses
   its own allowance."
9. The three Codex cost settings in plain words (Trial is the default and splits sessions half and half), and a thin tick
   at 272K on a Codex session's context bar: "Requests above this cost double."

## Step 8. U6 steps 2-5: the browser approval card

1. Reuse the saved-login card layout for every browser request ("Click 'Submit order' on shop.example.com (Windows PC)",
   then reason, website and computer), with the raw tool name, selector, scope and profile under Details
   (`browser-approval-request.component.html:10-57`, `:106-131`).
2. Three buttons in the C3a style, using the CLI card's word "session" (not "task"): "Allow this once", "Allow for this
   session", "Allow without asking (this session)". Keep the typed phrase for publish and delete.
3. One scope word list shared by the CLI, browser and permission-registry cards.
4. Optional, if it fits: only Deny and Allow once as buttons, lasting choices in a "More" menu with their warning, a kind
   label ("Browser action"), "1 of 3", and a "can't be answered any more" state when the provider has gone.

## Step 9. U7: a one-line note under each turn

1. `src/shared/summarise-turn.ts`: `summariseTurn(toolEvents, elapsed)` renders one quiet row at the end of a turn, only when
   tools ran or the turn took over about 10 seconds: "12 s · edited 2 files +18 −3 · read 4 · ran 3 commands · 1 failed".
   Real plurals; failures per Step 2's definition; at most four segments.
2. **This row replaces the collapsed tool group's summary label** (`tool-group.component.ts:240-253`, today "44 calls ·
   900,532 characters · 25 results externalized") rather than repeating it; the group keeps only its expand control and the
   failure count.
3. "Changed 4 files while this reply ran" from a per-turn file comparison in git folders, opening the review panel.
4. When an edit or write failed and no later write to the same path succeeded, one warning under the reply: "2 edits failed
   and were not retried: <path> (<error>). Check before trusting the summary." Only when a text reply exists and the turn was
   not interrupted.
5. Optional: a "Worked for 2m 14s · … · 1 failed" fold for the whole turn, with the reply, approvals and questions outside
   it, opening itself when something failed. The "show tool calls" switch stays.

## Step 10. U8: a calm failure card with "Try again" that continues

The renderer never reads `turnErrored` (produced in main at `instance-communication.ts:1802` and elsewhere).
1. Forward it to the renderer; a `RunFailureNotice` for the latest failed turn: plain title, one sentence from Step 3's
   presenter, Copy error, Details, Try again.
2. "Try again" sends "Continue from where you stopped. Check which actions already completed before retrying anything." It
   never replays the original prompt.
3. Automatic retries show "Retrying in 12 s" in the working row, from a deadline the runtime reports.
4. After an interrupt, the empty composer offers "Continue"; for providers that drop a cancelled turn, attach the original
   request and the last 8 KB of partial output as hidden context.

## Step 11. U9: question cards

1. **Check first** what the main process does today with a message sent while a question card waits, per provider, and
   record it in the history file.
2. A small registry the composer's send path asks first, for agent question cards only (never permission cards): text equal
   to a choice picks it; anything else is the typed answer. `input-panel.component.ts` has no such check today.
3. **Receipts:** this moves the first list's C3 last bullet here, so it is built once. Phase 3 step 11c (on its branch,
   `request-receipts.component.ts`) already turns `input-required-resolved` reasons into a grey line; extend it rather than
   building another: "You allowed once: <tool>", "You answered: <first 60 characters>", "No answer in 5 minutes; nothing
   ran", "Answered elsewhere", "Cancelled when the session closed". Today a closed card is deleted with no trace
   (`user-action-request.component.ts:256-268`).

## Step 12. U11: "Where your usage went"

A card on the Costs page and in the session status card with Anthropic's nine causes, each shown only when at least 10% of
the last 7 days: cache misses over 100K, context over 150K, helper-heavy sessions, 4 or more sessions in parallel, sessions
active 8 hours or more, max effort, workflows, always-on context over 40K, tool results over 10K. Compute from the
transcripts AIO already reads (or the experimental `get_usage` control request as a first version). Each shown cause has one
sentence and, where Harness has one, one button: cache misses → "Compact first"; long context → the long-chat cap (Phase D
Step 5); helper-heavy → helper settings; 8-hour sessions → scheduled jobs; always-on context → context details; large tool
results → the caps (Phase D Step 7). Parallel sessions, max effort and workflows get a sentence only. Lead with percentages
and plan windows, not dollars. Reuse the sentences as tooltip copy on the context ring, effort picker and helper controls.

---

## Final verification

Canonical seven (`npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`,
`npm run build:main`, `npm run build:renderer`, `npm run test:quiet`), summaries in the history file; fresh-eyes completion
gate (a new agent using the `task-completion-gate` skill), repeated with another new agent until `VERDICT: PASS`.

## Live checks

`2026-10-20-oct2-phaseE-calm-screen_livetest.md` (standard header), on the Windows PC: a real usage-limit message; a normal
launch's title bar; the turn note and failed-edit warning on a real turn; the failure card's Try again; a question card
answered from the composer; the phone widget after a phone build (Step 5).

## Finishing

Rewrite the Status block as an as-built summary, rename the history file `_history_completed.md`, then rename this file `_completed` last. Commit only when James asks.

## As built for independent verification

The checklist below describes implemented source and in-loop verification, not deployed acceptance. All earlier requirements remain the acceptance criteria. No standalone spec was linked; the approved plan and backlog supplied the scope.

| Step | Actual worker status |
|---|---|
| 1 | Implemented: explicit audience, default attention, inspectable routine groups; failed tools, approvals and receipts stay outside folds. |
| 2 | Implemented: normal nonzero exits stay neutral; explicit transport failures and marked checks retain failure facts through ACP, loops, mining, history and phone readers. |
| 3 | Implemented: closed error presenter, timestamp-free per-turn diagnostic dedup, one quota notice, real empty-result producer, kept-work notices, held-message timer/actions and a HEAD-derived raw-error ratchet. |
| 4 | Implemented: shared provider/account/tool/computer names, zero local-map exceptions, short quota names and Details for sign-in commands. Computer navigation, settings, sharing controls and help now agree. |
| 5 | Implemented: shared desktop/phone labels and colours, optional widget display fields with old-payload fallback. Mobile tests, typecheck, lint/build and Swift syntax checks pass; signed device/APNs checks remain live. |
| 6 | Implemented: unused optional CLIs do not degrade startup; healthy startup/local-model indicators are hidden; configured/live states and remedy routes remain truthful. |
| 7 | Implemented: every listed copy change, provider-aware review/compaction, shared usage tooltips and a measured Codex 272K context-price tick. |
| 8 | Implemented: reason/website/actual computer, closed technical Details, shared scope words and preserved saved-login/typed-phrase boundaries. Browser once-consumption is tested; CLI once semantics remain the separately owned Phase A prerequisite. |
| 9 | Implemented: four-total-segment turn notes, observed tool outcomes, bounded private git snapshots before dispatch and at first settlement, review binding and persistent failed-edit warnings. The optional whole-turn fold was omitted. |
| 10 | Implemented: latest failed-turn card and exact safe continuation, guarded against active turns/waits/questions; dedicated hidden historical context retains existing recovery context and a UTF-8-safe 8 KiB partial-output suffix. |
| 11 | Implemented: question-only composer routing before slash handling, multi-question drafts, stale-response rejection, durable label-only secret receipts and session-scoped dedup. Workboard closed/late acknowledgements are covered. |
| 12 | Implemented: Costs and collapsed session-status cards, all nine seven-day causes, exact 10% threshold, measured coverage/estimate qualifications and existing action routes. Big-tool caps get no invented button while Phase D’s control is absent. |

Normal worker verification is recorded in the history report and `_commands.jsonl`. The latest changed-spec batches cover 239 files / 4,796 tests; additional provider/cost and integration checks are recorded separately. The full repository suite was deliberately not run by this worker. The independent coordinator must run it and a fresh completion-gate review before acceptance and completion renames.

External/deployed checks: [livetests](2026-10-20-oct2-phaseE-calm-screen_livetest.md). The extra noncanonical `verify:renderer-events` audit fails on three uncovered channels and two unresolved dynamic sends already in HEAD; all seven relevant checker/registry/site files match HEAD. This baseline finding is recorded for the verifier, not deferred as a live test.

Runtime cleanup is verified in `_cleanup.json`: 13 owned runtime paths removed after report/seal creation, no source-hash mismatches, supplied root dependencies/shared cache symlinks and unrelated scratch preserved. Rebuild main before compiled-runtime tests and repeat the recorded mobile install before phone checks. No checkout or dependencies were copied into the plan directory.

> Plan Queue parked work: `queue/2026-10-20-oct2-phasee-calm-sc-bc8207` — 1 commit(s), reason: verifier-unreliable.
