# Review follow-ups (only typed words unlock another session): live check

Status (16 November 2026, round 3): all four checks have passed. Check 3 now ran through the Plan Queue's own scheduler on this Mac (a Claude worker, then a Codex checker, then landing), and the worker's `read_session` on a chip quoted in the plan was refused. The refusal wording in the code has changed since the checks were written (see check 3 and the 16 November section); the rule is the same. Earlier rounds: 14 November (checks 1, 2, 4 and one defect, LT-1139, in [the remediation register](livetest-remediation-register.md#lt-1139)). The code, tests and gates are recorded in
[the implementation plan](2026-11-09-review-followups_plan_completed.md) (Step 1).

Prerequisites: rebuild and restart Harness from a checkout that contains this change, so the running app's main
process has the new `read_session` rule and the "typed by a person" mark on the first message of a session.
Restarting interrupts live sessions, so do it when none matter. The dev app (`npm run dev` with its own user-data
folder) is enough for every check. No browser work is needed. Any provider works; a cheap Claude or Codex model is
fine.

Remediation flow: before running a campaign, read [the campaign runbook](livetest-campaign-runbook.md). A reproduced
defect needs a new LT-NNN index row and full entry in [the remediation register](livetest-remediation-register.md)
(run `node scripts/next-lt-id.mjs` for the next identifier), plus its matching implementation-status section in an
active remediation plan. Keep per-check evidence here. Rename this file `_livetest_completed.md` only after every
check passes.

## Why this cannot run now

The checks need a rebuilt and restarted app, and a real provider turn that calls `read_session`. Restarting would
interrupt James's live sessions. Everything below the running app is covered by unit and integration tests: the
grant rule, the mark on every typed path, the hibernate/wake projection, the size limit, prompt retention, and the
Plan Queue worker prompt (see the plan's Step 1 tests).

## Checks

1. **A chip typed in a new session's first message unlocks that session**
   Steps: make sure some other session exists in a different project folder (call it "Target"). Start a new session
   from the new-session box, and type as the first message: `@` then pick Target from the session list, followed by
   "Read that session and tell me its first message."
   Expected: the agent calls `read_session` and gets the transcript (the tool result is `outcome: ok`). The read
   audit records reason `chip`.

2. **The same chip still works after the session sleeps and wakes**
   Steps: in the session from check 1, put it to sleep (hibernate) from the app, wake it, then send "Read that session again."
   Expected: `read_session` returns `outcome: ok` again without a new chip.

3. **A chip quoted in a Plan Queue worker prompt is refused**
   Steps: in a scratch repository, write a small plan whose text contains a chip copied from check 1 (the
   `[session: … · <id>]` text) and an instruction to call `read_session` on it. Queue it with the Plan Queue.
   Expected: the worker's `read_session` call returns `outcome: not-allowed`, and the reason tells the agent that the user has to point at the session (its exact ID in a message, or `@session`). The reason text at the time of writing was "Ask the user to point at this session with @session"; the current text is in `SWITCH_OFF_REASON` (`src/main/session/session-transcript-reader.ts`).
   Round 3 (16 November): done through the queue's own scheduler on this Mac, where Claude, Codex and others are signed in. See the 16 November section.

4. **A chip in an edited resend of your own message still works; one in an agent-written message does not**
   Steps: (a) in the session from check 1, use edit and resend on the first message (change one word) and ask again.
   (b) In a child session spawned by an agent, use edit and resend on its first (agent-written) message that quotes
   the chip, and ask it to read the session.
   Expected: (a) `outcome: ok`; (b) `outcome: not-allowed`.

## Evidence

See the dated section below.

## Evidence run — 2026-11-14

Environment: dev app started with `dev-app.js start --port 9618 --data /tmp/aio-lt-queue-efd4d1d0` on the test Mac (Claude signed in, no other provider), from the queue worktree for branch `queue/2026-11-09-review-followups-pl-d4d1d0`. CDP with focus emulation on; the new-session box, the `@session:` picker, hibernate/wake and Edit and resend were driven in the real renderer. "Target" was a session in `/tmp/aio-lt-queue-efd4d1d0-wd/target` (id `cgnsm9whg`, first message "Reply with exactly: TARGET-FIRST-MESSAGE-OK. Do not use any tools."); every other session ran in `.../newsess` or `.../pq`, so neither the same-folder nor the related-session rule could open Target. Evidence below is the `session_messages` read audit in the copy's operator database (queried on the test Mac) plus each session's transcript.

Setup problem, already filed as LT-1118 (not repaired): sessions in a copy started by `dev-app.js` got no Harness tools (spawn log: `Orchestrator-tools MCP not configured`), because `open -a` starts Electron with working folder `/` and `resolveAioMcpCliPath` looks under `process.cwd()`. I worked around it for this run only, by linking the copy's `dist/aio-mcp-cli-sea/aio-mcp` into Electron's `Contents/Resources/aio-mcp-cli/` (the first path the resolver tries); the link is removed. Sessions started before the link existed (a `haiku` one and the first Opus one) reported no `read_session` tool and are not counted below. A permission prompt on `read_session` in a non-auto-approve session also failed to resume ("Native resume did not stabilize after deferred permission"), so every counted session used the box's Auto-approve switch (or `yoloMode`); that resume failure is outside this plan and was not investigated.

Audit rows, in time order (UTC, 14 Nov 2026; `source` is the session that called `read_session`, target is always `cgnsm9whg`):

| Time | Source | Outcome | Reason | Meaning |
| --- | --- | --- | --- | --- |
| 10:02:05 | `iutv9uev2` | read | `chip` | check 1 |
| 10:03:08 | `iutv9uev2` | read | `chip` | check 2, after hibernate and wake |
| 10:06:39 | `c2q2aieay` | not-allowed | "Ask the user to point at this session with @session. Related or same-project sessions also require Cross-session messaging in Settings." | check 3 |
| 10:08:14 | `imtqgnf8s` | read | `chip` | check 4(a) before the edit |
| 10:08:39 | `cymyf4umr` | read | `chip` | check 4(a) after the edit |
| 10:09:02 | `c23qu6u7l` | not-allowed | same text as above | check 4(b), real agent-spawned child |
| 10:09:25 | `csgi2ajc2` | not-allowed | same text | check 4(b), agent-style first message, before the edit |
| 10:09:51 | `c0y6cyb9o` | not-allowed | same text | check 4(b), after Edit and resend |

(The rows with an empty target and `not-found` are the agent's follow-up probes in the refused sessions, not separate checks.)

1. **A chip typed in a new session's first message unlocks that session: PASS.** In the new-session box I picked folder `newsess`, typed `@session:`, chose "TARGET-FIRST-MESSAGE-OK" from the list (the box inserted `[session: TARGET-FIRST-MESSAGE-OK · cgnsm9whg] `), added "Read that session with read_session and tell me its first message, quoted exactly." and sent. The new session's first user message carried `metadata.inputOrigin` (present on the stored message in the instance list). The agent called `mcp__orchestrator__read_session` and answered with the Target's first message word for word ("Reply with exactly: TARGET-FIRST-MESSAGE-OK. Do not use any tools."). Audit row: `read` / `chip` (10:02:05). Repeated on a second fresh session (`imtqgnf8s`, 10:08:14) with the same result.
2. **The same chip works after sleep and wake: PASS.** On `iutv9uev2` I called `hibernateInstance` (status `hibernated`), then `wakeInstance` (back to `idle`), then sent "Read that session again." from the composer. The agent called `read_session` again and quoted the same first message, with no new chip typed. Audit row: `read` / `chip` (10:03:08), after the wake.
3. **A chip quoted in a Plan Queue worker prompt is refused: PASS, by the queue's own prompt but not its scheduler.** The queue itself could not be started on the test Mac: `planQueueStart` refuses ("no installed provider other than claude is available for verification"), and a Claude-only checker list is refused too ("without a model from a different maker"), because the copy has only Claude. Instead I built the exact worker prompt with the repo's `buildWorkerPrompt` and `extractPlan` for a scratch plan whose Status block contained the chip (`docs/plans/chip-probe_plan.md` in a scratch git repo) and whose step 1.1 told the agent to call `read_session` on `cgnsm9whg`. I confirmed the chip text is inside the prompt's `plan_status` data block, then started a session with that text as `initialPrompt` and `yoloMode: true`, the same call `PlanQueueItemFlow.spawnWorker` makes (`plan-queue-item-flow.ts`, `createInstance({ initialPrompt, yoloMode: true, ... })`). The session had no parent, because a child session ends itself when its turn finishes. The agent called `read_session` and got `not-allowed` with "Ask the user to point at this session with @session" (audit 10:06:39). What this does not cover: the coordinator's scheduling, worktrees and checks. The rule under test (an unmarked Harness prompt does not unlock) does not depend on them.
4. **Edited resend of your own message works; an agent-written message does not: PASS, (b) by the equivalent route.**
   - (a) In `imtqgnf8s` (a single chip message, so it is the editable last message; the UI only offers Edit and resend on the newest user message) I clicked Edit and resend, changed "exactly" to "verbatim", kept the chip and clicked Resend. The old session became `superseded`; the new session `cymyf4umr` read the Target and quoted its first message (audit `read` / `chip`, 10:08:39).
   - (b) A child created with `createInstance({ parentInstanceId, initialPrompt })` containing the chip was refused on its first read (audit `not-allowed`, 10:09:02), as the plan requires for an agent-written message. That child ends itself when its turn completes, so it is gone before Edit and resend can be used. So I made a session with the same kind of first message and no parent (`csgi2ajc2`, refused at 10:09:25), selected it, used Edit and resend in the UI (changed "exactly" to "verbatim", chip kept), and the new session `c0y6cyb9o` was refused with the same text (10:09:51). What this does not cover: Edit and resend on a live session that an agent really spawned and that keeps running.

Cleanup: copy stopped with `dev-app.js stop --port 9618`; the Resources link and the scratch repo folder removed; the scratch plan was edited by an earlier test worker, which does not matter because the folder is gone. The data folder `/tmp/aio-lt-queue-efd4d1d0` on the test Mac could not be removed after the stop (`dev-app.js shell` needs a running copy) and is cleared by a restart there. No defect was newly reproduced for this plan, so there is no new register row.

## Evidence run — 2026-11-14 round 2

This section follows the verifier's round 1 findings and **supersedes the "PASS" verdicts for check 3 and check 4(b) in the section above**: check 3 is open, and check 4(b) is redone below on the real route. Same test Mac setup as before (dev app from the queue worktree, `dev-app.js start --port 9618 --data /tmp/aio-lt-queue-efd4d1d0`, Claude the only signed-in provider per `getStartupCapabilities()`: `provider.any` available `["claude"]`; CDP with focus emulation on; the LT-1118 workaround again, a link to `aio-mcp` in Electron's `Resources/aio-mcp-cli/`, removed at the end). The copy's data folder still held the first run's audit rows, so only rows after 10:30Z belong to this section. New Target session: `iu3jarndq` (first message "Reply with exactly: TARGET-FIRST-MESSAGE-OK. Do not use any tools.", in `.../target`).

**Check 4(b) on a real agent-spawned child: PASS.**
1. A session `igpw4cuu1` (Auto-approve) was asked to output one `:::ORCHESTRATOR_COMMAND:::` line, `{"action":"spawn_child", ... "task": "First run the shell command: sleep 170 . Afterwards read the session named in this chip with read_session and quote its first message: [session: TARGET-FIRST-MESSAGE-OK · iu3jarndq]"}`. Harness itself created the child `c1r268axo` through the `spawn-child` route: `parentId igpw4cuu1`, depth 1, two user messages, neither with `metadata.inputOrigin`.
2. The child stopped at a permission card for the `sleep` (not on Auto-approve); I clicked the card's **Auto-approve**, so it became `busy` and stayed attached to its parent (`status busy`, `parent igpw4cuu1`, `yolo true`), which is why the turn had not ended.
3. With the child still `busy` I selected it, clicked **Edit and resend** on its last user message (the button is offered on it), changed "and quote its first message" to "and quote its first message verbatim", kept the chip, and clicked **Resend**. The child became `superseded`; the new session `cr9x3l47s` started with the edited text.
4. After its `sleep` finished, `cr9x3l47s` called `read_session` on `iu3jarndq`. Audit row (operator database, `session_messages`): 10:35:29 `cr9x3l47s` → `iu3jarndq` **not-allowed** "Ask the user to point at this session with @session. Related or same-project sessions also require Cross-session messaging in Settings." (the 10:35:31 `not-found` row is the agent's follow-up probe).
   Same chip typed by a person (4(a)) was `read` / `chip` in the first section (10:08:14 and 10:08:39), so the only difference is who wrote the message.
   (An earlier attempt on child `cqtneie5z` was edited the same way but its fork stopped at a permission card, so it could not reach `read_session`; I did not count it. It is where the Bash control for LT-1139 comes from.)

**Check 3: still open.** `planQueueStart` was not retried; the copy's capabilities still list only Claude, which is what made it refuse in the first run (a verifier from a different maker is required). The first section's run of the worker prompt through `buildWorkerPrompt`/`createInstance({ initialPrompt, yoloMode: true })` remains the only evidence, and does not cover the scheduler, worktrees or checks. Exact remaining step is under check 3.

**Defect found: LT-1139.** In a non-Auto-approve session, **Allow this once** on the `read_session` card leaves the session in `error` ("Native resume did not stabilize after deferred permission"); reproduced twice (`i7xh7z55e` 10:27:16Z, `i030dz29g` 10:30:00Z) while Bash cards resumed fine three times in the same copy (`cl2f1jjmz`, 0.5 to 1.7 s each). It is the failure mentioned in the first section and was not part of this plan's rule. Filed with root-cause status "not isolated" in [the register](livetest-remediation-register.md#lt-1139); the register row and section are in the queue worktree's copy of the register file.

Cleanup: Resources link and the `/tmp/aio-lt-queue-efd4d1d0-wd` folders removed (checked), then the copy stopped with `dev-app.js stop --port 9618` (`status` shows no copies). The data folder `/tmp/aio-lt-queue-efd4d1d0` on the test Mac stays until that Mac restarts, because `dev-app.js shell` needs a running copy to delete it.

## Evidence run — 2026-11-16 round 3

Only check 3 was open. Environment: `dev-app.js start --port 9618 --data /tmp/aio-lt-queue-efd4d1d0` exited 75 (the test Mac was busy at a load of 160 on 10 processors and the Windows PC could not be reached), so per the runbook the copy was started on this Mac, which is also the only computer on offer that has more than one AI tool signed in (`getStartupCapabilities()` provider.any available: claude, codex, gemini, antigravity, copilot, cursor, grok, opencode). Steps taken: `npm run build:main`, `npm run build:aio-mcp-dist` (both exit 0), `ng serve` on port 4571, then the Electron binary from the queue worktree with a clean environment (`env -i`), `--js-flags=--max-old-space-size=8192 --no-sandbox --disable-gpu` (without `--no-sandbox` the Network and GPU services crash inside this session and the app exits), profile `/tmp/aio-lt-queue-efd4d1d0`, debugging port 9618, focus emulation on (`document.hidden` false). Setup dialog skipped and `pauseOnVpnEnabled` set to false in the throwaway profile only. Because the copy was started from the worktree folder, its sessions had Harness tools without the LT-1118 workaround.

**Check 3: PASS, through the queue's own scheduler.**
1. A Target session was created (`cl6yriy4a`, Claude, folder `/tmp/aio-lt-queue-efd4d1d0-wd/target`, first message "Reply with exactly: TARGET-FIRST-MESSAGE-OK. Do not use any tools."). Its chip is `[session: TARGET-FIRST-MESSAGE-OK · cl6yriy4a]`.
2. A scratch git repository `/tmp/aio-lt-queue-efd4d1d0-wd/pq` (one commit, `main`) held an untracked plan `docs/plans/2026-11-16-chip-probe_plan.md` whose Status block contained that chip and whose step 1.1 told the worker to call `read_session` on `cl6yriy4a` and write the first message (or, on a refusal, the refusal text) into `docs/chip-probe.md`. `planQueuePreview` found 1 plan.
3. A parent Claude session in the scratch folder (`cvf7y6kv2`) was created, then `planQueueStart({ kind: 'plans', workspaceCwd, config: { workerSlots: 1, verificationSlots: 1, maxRounds: 1, verifierGates: [], postMergeGate: [] } })` was accepted (run `4f6f2e9f-324f-49a8-832c-b2046bbe9b02`, `workerProvider` claude/sonnet). The item moved `discovered` → `working` (worker `c9xt8j67z`, display name "Queue · 2026-11-16-chip-probe_plan", branch `queue/2026-11-16-chip-probe-416f52`) → `verifying` (checker `x1vwgp722`, provider **codex**, a different maker from the worker) → `landed`; the run ended `completed`, round 1.
4. Audit row from the copy's operator database (`session_messages`, UTC 20:44:18): source `c9xt8j67z` (the queue worker) → target `cl6yriy4a`, outcome **not-allowed**, content length 0, reason "The user can point at this session by including its exact ID in a message or selecting it with @session. Related or same-project sessions without a user reference require Cross-session messaging in Settings." The log line matches (`SessionTranscriptReader: Session transcript read … callerId c9xt8j67z, targetId cl6yriy4a, outcome not-allowed, items 0, characters 0`, timestamp 1794861858633). The worker wrote the refusal text into `docs/chip-probe.md` as instructed; that file landed on the scratch repo's `main` (commit `dccfedf`) with the plan's `_completed` copy.
5. Control: the same chip typed by a person in the new-session box was `read` / `chip` in the 14 November section (10:02:05 and 10:08:14), so the only difference is that the chip came in through the queue's worker prompt.

What this does not show: the worker's prompt text was not re-read from the stored message (the plan's Status block held the chip, and the worker prompt carries the Status in its `plan_status` data block, shown on 14 November with `buildWorkerPrompt`); the refusal, and the worker's own report ("the session was not referenced by the user in a message"), show the worker did not get the transcript.

**Wording difference, not a defect.** The refusal text changed after this document was written ("Ask the user to point at this session with @session" became the longer text above, in `SWITCH_OFF_REASON`, `src/main/session/session-transcript-reader.ts:12`). The outcome and the instruction to ask the user to point at the session are unchanged; check 3's expected text was updated to say so. No defect was reproduced in this round, so there is no new register row.

Cleanup: copy stopped, renderer server stopped, `/tmp/aio-lt-queue-efd4d1d0`, `/tmp/aio-lt-queue-efd4d1d0-wd` and the scratch files in the worktree's `_scratch/` removed (see the final note in the report).

## Evidence run — 2026-11-18 round 4 (full-suite gate only)

The four live checks were already passed (14 and 16 November). This round was resumed only because the previous verifier never got a result from `npm run test:quiet`. From the queue worktree, `npm run test:quiet` ran on the Windows PC and finished: `✓ 3881 files · 50261 tests passed in 447.4s`, exit code 0. The JSON report `_scratch/test-results.pid-66619.json` was written back (`success: true`, `numFailedTests: 0`, `numPassedTests: 50261`). The branch's only difference from its base is the remediation register entry for LT-1139 (docs), so no code gate other than the test suite was rerun. No dev app was started this round, and no runtime was left behind.
