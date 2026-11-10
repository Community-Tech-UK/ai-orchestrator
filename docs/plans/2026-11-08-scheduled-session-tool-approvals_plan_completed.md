# Scheduled sessions: tool approvals that work

Status: completed (8 November 2026). Code independently reviewed (round 5 PASS) and all four live checks passed in the
installed Harness. Not committed.

## Problem

A scheduled Harness session (Claude, Auto-approve off) could not call `plan_queue_start` or `automation_result`.
Every call came back within 5 ms as "Claude requested permissions to use …, but you haven't granted it yet.", and
approving the card James saw never let a call through.

## Root cause (evidence)

1. **Claude refuses on its own, before Harness can ask.** Non-auto-approve Claude sessions run
   `--permission-mode acceptEdits` with `--allowedTools` = the session's list plus `HARNESS_READ_ONLY_TOOLS`
   (`src/main/cli/adapters/claude-cli-argv-builder.ts:213,229`). Neither `automation_result` nor any `plan_queue_*`
   tool is on that list (`src/main/cli/adapters/harness-tool-allowlist.ts:6`). In print mode with no
   `--permission-prompt-tool`, Claude refuses such a call at once. The live prompt channel is passed only for
   resident, non-machine sessions with `claudeLivePermissionPrompts` on (`claude-cli-argv-builder.ts:214-215`,
   `src/main/instance/lifecycle/instance-spawn-policy.ts:32`); that setting ships off (`settings-defaults.ts:137`)
   and a scheduled session is a machine session (`machineSession: 'automation'`), so it never had a channel.
   Reproduced with the real CLI 2.1.319 and a probe MCP server (experiment A below).
2. **Only Bash is held for approval.** The defer hook that pauses a call and resumes it after an answer is attached
   with `matcher: 'Bash'` only (`claude-cli-argv-builder.ts:118-126`). MCP tools never reach it.
3. **The card could not approve anything.** Harness spots the refusal text and raises a `permission_denial` card
   (`claude-cli-adapter.ts:1502-1631`). Its "Always allow" writes a `~/.claude/settings.json` rule, which exists only
   for Write/Edit/Read/Bash (`src/shared/permissions/claude-allow-rule-tools.ts:2`). For an MCP tool the card's only
   button is "OK" (`user-action-request.rules.ts:88-91`), and "OK" sends "Permission denied. Please do not perform that
   operation." (`user-action-request.component.ts:895-896`). app.log shows exactly that reply for both cards at
   14:34:49 and 14:34:50 (`isPermissionDenial: true`). The already-refused call was gone either way.
4. **Later attempts raised no card.** The adapter skips a card for a permission key that is already pending
   (`claude-cli-adapter.ts:1533-1541`): the third and fourth `plan_queue_start` attempts logged
   `tool_result_error_received` but no `adapter_emit_permission_denial`.
5. **The run was filed as "needs your answer".** The run record (`automation_runs` row for instance `cxla97dmw`) is
   `failed`, "Automation requires unattended user input", 19 s after start, because the card set
   `waiting_for_input` and the runner fails a run that waits (`automation-runner.ts:552-563`). The reason was wrong:
   no answer could have helped.
6. **Why James's own sessions never hit it:** `defaultYoloMode: true` in his settings; this job's approval snapshot
   had Auto-approve off.

### Answers to the four questions

1. Scheduled sessions start like other Claude sessions but always without the live prompt channel (machine session),
   with `acceptEdits`, the Harness read-only allow list and the Bash-only hold hook. No prompt bridge is connected for
   MCP tools in scheduled or interactive ask-first sessions.
2. The answer to a `permission_denial` card never reaches a waiting call: Claude had already refused and moved on.
   "Always" can save rules only for four built-in tools; "OK" is a refusal. Nothing is saved for MCP tools.
3. No. A tool loaded through ToolSearch goes through the same permission check, the same `PreToolUse` hook and the
   same `PermissionRequest` hook as one listed from the start (experiments A, C, D).
4. Allowed by default: `automation_result` (refuses unless the caller is the scheduled job's own root session) and
   `plan_queue_status` (read-only). Still ask, with a working approval: `plan_queue_start` (starts worker sessions),
   `plan_queue_answer` (the parent check does not stop the session answering a worker's question meant for a person,
   and `resume-set-aside` resumes set-aside work; first review round), `plan_queue_control` (pause/cancel/discard/land)
   and every other orchestrator tool.

### CLI experiments (real Claude CLI 2.1.319, `_scratch/permission-repro-20261108/cli-probe`)

- A: `acceptEdits`, allow list = one probe tool. The allowed call ran; the other two were refused with the incident
  text. `PreToolUse` fired for every MCP call; `PermissionRequest` fired only for the refused calls.
- B: a `PermissionRequest` hook that denies with its own message: the model saw that message instead of the CLI text.
- C: the real `defer-permission-hook.mjs` held a ToolSearch-loaded MCP call (`stop_reason: tool_deferred`); after a
  decision file `allow` and `--resume`, the call ran.
- D: negative-lookahead matchers (`^(?!(?:a|b)$)mcp__probe__`) select exactly the intended tools.

## Fix (as built)

1. **Allowed by default** (`src/main/cli/adapters/harness-tool-allowlist.ts`): the list is now `HARNESS_ALLOWED_TOOLS`
   and adds `automation_result` and `plan_queue_status`. `HELD_ORCHESTRATOR_TOOL_MATCHER` is derived
   from the same list: `^(?!(?:<allowed names>)$)mcp__orchestrator__`, so a tool added to the server later is held.
2. **Hold Harness's other tools for approval** (`src/main/cli/adapters/claude-permission-hooks.ts`, used by both
   `claude-cli-argv-builder.ts` and `spawn-worker/cli-adapter-worker-args.ts`, whose parity spec requires equal
   hooks): ask-first sessions get a second `PreToolUse` entry with that matcher and the same hook command as Bash.
   The hook defers it; the existing held-call flow shows a once/session/always card and resumes the waiting call.
3. **Honest refusals in machine sessions**: same module adds a `PermissionRequest` entry (matcher `.*`; Claude asks it
   only about calls it would refuse) when `machineSession` is set. Both hook scripts (`defer-permission-hook.mjs`,
   `rtk-defer-hook.mjs`) refuse:
   - any tool except Write/Edit/Read/Bash with `Harness: nobody was asked about this call. …`, naming the tool, saying
     nothing the user clicks can let it through, and how to allow it (Auto-approve for the session or job, or a Claude
     allow rule). `isPermissionDenialContent` skips both Harness prefixes (`isHarnessRefusal`), so no dead-end card or
     `waiting_for_input` follows;
   - Write/Edit/Read/Bash (the tools Harness's card can save an allow rule for) with Claude's own first sentence, so the
     adapter still raises that card from the call, plus: Harness is showing the user a card that can allow it; if they
     allow it the session restarts and trying again will work; until then nothing will let it through (round 2).
4. **Automatic refusals say so** (`claude-permission-response.ts` `harnessRefusal`, `HARNESS_UNASKED_PREFIX`):
   `ResumeDeferredOptions.autoReason` and `LivePermissionAnswer.autoReason`; the request flow passes it for a saved-rule
   refusal, an adjudicator refusal and the live fail-closed path. The live broker's "no person is watching this loop
   round" refusal now uses the unasked prefix too.
5. **Runner flags a failed report** (`automation-runner-reconcile.ts`): at turn end, an `automation_result` tool call
   in the session history marked `is_error` (the hidden outcome record is folded into the call by
   `turn-tool-outcome-projection.ts`; the record itself never reaches the runner's events, see
   `provider-runtime-event-bus.ts:139-142`) plus no recorded result fails the run, not retried, with
   `Automation could not report its result` (copy in `src/shared/copy/automation-failure-copy.ts`).
6. **A report after the run ended says why it fails** (`automation-runner.ts` `recordResult`): when the owning session's
   run has already ended (for example it ended "needs your approval" while a call was held, and James allowed the call
   later), `automation_result` refuses with "This scheduled run has already ended (failed: …), so Harness cannot record
   its result and nothing will change that. Say what you found in your reply instead." The run is not kept open while
   it waits: that keeps a late approval working (James answered five hours later), where the run time limit would
   have stopped the session.

7. **A held call ends the run only when a person is asked** (`automation-runner.ts`, round 2): the runner used to fail
   the run on the `waiting_for_permission` status, which the adapter sets before the permission flow checks saved
   rules, so a saved "Always allow" still filed every later run "needs your approval". It now ends the run on the
   flow's forwarded ask (`instance:input-required` with `type: 'deferred_permission'`) for Claude sessions; a held call
   answered by a saved rule or the reviewer keeps the run going. Other providers' permission prompts (ACP
   `acp_permission_request`, Codex `codex_mcp_approval`) still end the run on the status, as before (round 4).
   `waiting_for_input` still ends the run at once.
   `reconcileInstanceState` (run at dispatch and after a restart) is unchanged: a session it finds already waiting
   still ends the run. If a saved-rule or reviewer answer cannot resume the session, the flow posts a visible note
   ("… could not resume the session (…). Restart the session to continue.") instead of the old "Permission
   auto-allowed" note, and shows no card: a person's answer takes the same resume path and would fail the same way
   (round 4 replaced round 3's card). A failure during the respawn itself already moves the session to `error`, which
   ends a scheduled run at once; a failure before it (no held call left, resume refused) leaves the run to its time
   limit.
   A resumed turn's completion still counts: `requestCountAtCompletion` is read when the turn finishes
   (`instance-communication.ts:1786`) and the generation is bumped when the new adapter is wired
   (`:1099-1101`); covered by a runner test.
8. The report check also reads Codex's form (a separate `tool_result` named after the tool).

What a scheduled session now does with a held call: Claude stops with `tool_deferred`, the session waits for
permission, the runner ends the run as "needs your approval" (existing behaviour, now accurate), and James's Allow on
the card resumes the session and runs the waiting call.

Not changed: the live prompt channel rollout (`claudeLivePermissionPrompts` stays off), James's settings, other MCP
servers' tools in sessions a person drives (they keep Claude's own refusal and the existing card).

## Verification

- Before the fix, in a temporary copy of HEAD: the reduced regression spec failed 6 of 6 (`refused`).
- Targeted specs: `harness-tool-allowlist.spec.ts`, `claude-cli-argv-builder.spec.ts`,
  `cli-adapter-worker-args.spec.ts`, `defer-permission-hook.spec.ts` (PermissionRequest answer for both scripts),
  `scheduled-session-tool-approval.spec.ts` (new regression: listed-from-start `automation_result` runs;
  search-revealed `plan_queue_status` runs; search-revealed `plan_queue_start` is held and the same call runs after an
  approval written by the production `DeferDecisionStore`; a policy refusal says nobody was asked; a third-party tool
  gets the honest refusal and raises no card), `deferred-permission-handler.spec.ts`,
  `instance-permission-request-flow.spec.ts`, `automation-runner.spec.ts` (history built with the real projection),
  `automation-phasec.spec.ts` (report after the run ended). 343 files / 4211 tests in the touched areas passed before
  review; after the review fixes, 77 files / 917 tests (automations, argv, worker, hooks) pass.
- Real CLI 2.1.319 with the argv the current code builds for a scheduled session (`_scratch/permission-repro-20261108/
  after-fix`, run3/run4, regenerated after round 2): `automation_result` and `plan_queue_status` ran;
  `mcp__linear__save_issue` got the "nobody was asked" refusal; a Write outside the project got Claude's sentence plus
  the card wording; `plan_queue_start` stopped with `tool_deferred`; an `allow` decision plus `--resume` ran that same
  call. The model retried nothing.
- `npm run checks`: all 7 passed (Windows PC).
- `npm run test:quiet`: 47 of 47218 failed, all in files other sessions are editing in this checkout
  (`instance-tool-loop-wiring.ts`, mobile gateway) or Windows-only (instance-row, worker exec policy pass on the Mac);
  the one in my area (`cli-adapter-worker-args.spec.ts` parity) is fixed above.

## Progress

- [x] Reproduced in the CLI (A-D) and in a real scheduled Harness session
- [x] Fix items 1-5
- [x] Tests and gates (see Verification)
- [x] Real scheduled-session check after the fix: all four live checks passed (see Live checks)
- [x] Completion gate: round 5 `VERDICT: PASS`, no actionable findings (earlier rounds below). Round 5 notes kept as known
  trade-offs: a rare failed automatic resume leaves a scheduled run to its time limit; a Claude allow rule for a
  Harness tool in `~/.claude/settings.json` is no longer honoured in ask-first sessions (the hold runs first; Harness's
  own saved rules answer it); every approved hold restarts the CLI, as Bash already does.
- History (round 1: FAIL, 5 findings, all addressed; round 2: FAIL, saved Always allow still failed later
  runs, and Write/Edit/Read text; both fixed in items 7 and 3; round 3: FAIL, a failed automatic resume left the run
  waiting unseen (fixed in item 7) and no proof that a resumed turn's completion counts (code traced, runner test and
  live check 4 added); round 4: FAIL, non-Claude permission prompts no longer ended runs, and round 3's fallback card
  could not be answered; both fixed in item 7)

## Reproduction in Harness

One-time automation "Permission repro (disposable, 8 Nov)" (id `8ffabc0e-…`) in
`_scratch/permission-repro-20261108/project`, Auto-approve off, prompt: load and call `plan_queue_status`, then
`automation_result`. Run `be8430d9-…` (instance `cvk5vb448`) at 15:21 UTC: both calls refused at once with the
incident text, `permissionMode: acceptEdits`; run filed `failed`, "Automation requires unattended user input", 20 s
after start. Same as the incident.

## Live checks

Run 8 Nov 2026 ~21:08 UTC in the installed Harness after James's restart (`/Applications/Harness.app`, repackaged
20:50 from this checkout; its hooks and `harness-tool-allowlist.js` contain the fix). Note: new automations created
from an Auto-approve session now inherit Auto-approve (another session's change in `automation-agent-authority.ts`), so
the first two check jobs ran in `bypassPermissions` and proved nothing; the jobs below were switched to Auto-approve
off before firing (`acceptEdits` confirmed in their transcripts).

- Check 1: PASS. Job C, run on instance `c2gyrmp2k`: `plan_queue_status` and `automation_result` ran, run `succeeded`,
  result `{"outcome":"no_change","notify":false}` recorded.
- Check 3: PASS. Same run: `mcp__claude_ai_Linear__whoami` got "Harness: nobody was asked about this call. …"; no card;
  the run was not ended by it.
- Check 2: PASS. Job D, instance `c1ry97upu`: `list_automations` held at 21:08:13 (`Tool use deferred by hook`,
  `toolu_018GXtbkPRgmbY1AvjFY2HsK`), card forwarded (`manager_forward_to_renderer`), run filed `failed`, "Automation
  requires unattended permission approval". James chose "Always allow"; `Resuming after deferred permission` →
  `Resumed … successfully`; the same tool_use id got its result (59 automations) at 21:10:25, still `acceptEdits`. The
  model's later `automation_result` got "This scheduled run has already ended (failed: …)". (The session switched to
  Auto-approve at 21:31:33 with a later message from James, not with the approval.)
- Check 4: PASS. Job D run again at 21:35, instance `caz4a1cry`, `acceptEdits` throughout: held call answered by the
  saved rule (`manager_auto_decision_deferred`), resumed in 2.5 s, no `manager_forward_to_renderer`, run `succeeded`
  with `{"outcome":"done","notify":false}` recorded.

All check jobs were deleted afterwards. James's saved "Always allow" for `list_automations` remains (Settings >
Permissions > Rules).


Needs Harness rebuilt and restarted with this code (James's running app holds live sessions, so it is not restarted
here). In a fresh one-time automation with Auto-approve off in a throwaway folder:
1. Calls `automation_result` (no_change) and `plan_queue_status`: both run; the run is `succeeded` with the result
   recorded.
2. Calls a held orchestrator tool that starts nothing (for example `list_automations`): a once/session/always card
   appears; the run ends "needs your approval"; Allow runs the same call (visible in the transcript as a successful
   result for the original tool_use id).
3. Calls a third-party MCP tool not on the allow list: the model receives the "nobody was asked" refusal; no card.
4. After choosing "Always allow" for the held tool in check 2, run the automation again: the held call is answered by
   the saved rule, the session resumes on its own, no card appears, and the run ends `succeeded` with its
   `automation_result` recorded.

Known edge: for Write/Edit/Read the hook text says a card is shown; if the adapter already recorded an approval for
that exact permission key it shows a hint instead of a new card.
