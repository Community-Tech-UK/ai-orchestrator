# October Phase 1 token levers: pending live checks

**Status (19 Oct 2026):** active live-test document, already tracked and modified on arrival. The native worker candidate
in `queue/2026-10-10-oct-phase1-token-le-528c17` is ready for independent queue verification; the full suite, base
integration, broader source-audit reconciliation and final whole-item gate remain coordinator-owned. The 21 currently
listed audit findings, including the Codex mail-measure continuation, have native worker repairs and controlled runtime evidence in the root plan's as-built notes.
No rebuilt-app/provider check, release or trial clock
has begun in this native resume. The 16 Oct Step 18 rewrite-only command-line observation is historical and partial:
pipeline and deny-path receipts are still missing. The trial setting's code default is now `off` (19 Oct repair) until complete Live check 1, including the deny-rule preconditions, passes.
The deliberately gated 16b, 17b, 17c and 18c are unbuilt; 18d is probe-only, 13f needs measured triggers, 9b's deletion
sweep needs choice 11, and 12d stays dropped. The Claude waiting-rule flag is off by default pending fork-cache proof.

**Plan:** [2026-10-10-oct-phase1-token-levers_plan.md](2026-10-10-oct-phase1-token-levers_plan.md).

**Prerequisites:** after the coordinator synchronizes the accepted base and completes the full suite and independent
whole-item gate, rebuild and restart the specific disposable Harness instance used for live testing from the integrated
code. Record its revision and CLI versions; the worker's pinned Codex protocol check used CLI 0.162.1. Start trial clocks
only from eligible observed exposure in that rebuilt app, never from historical rows or a smoke report. Screen/browser
work runs on Windows worker `windows-pc` after Browser Gateway health/preflight. A Mac screen check requires James's
explicit permission for this task. Do not restart James's running app or deploy from this worker merely for these checks.
Deterministic fixtures, renderer integration and report integrity were checked in-loop in the current remediation:
142 focused files / 1,786 passed, zero failed, one existing non-macOS Seatbelt control skipped on macOS. Portable
review-server parity passed. The actual Vitest child closed with code 0 and no signal. These checks are not deferred here; historical counts in
older plan checkpoints describe earlier verification, not the current source delta.

**Remediation flow:** before the campaign, read [livetest-campaign-runbook.md](livetest-campaign-runbook.md). A reproduced
defect receives a new `LT-NNN` index row and acceptance entry in
[livetest-remediation-register.md](livetest-remediation-register.md), with a matching implementation-status section in
[2026-07-19-livetest-failure-remediation-followup_plan.md](2026-07-19-livetest-failure-remediation-followup_plan.md). Keep per-check evidence here.
Rename this document `_livetest_completed.md` only when every recorded check passes with evidence.

## Step 1a: new and resumed Codex chats

- [ ] **Fresh chat:** in the rebuilt Harness instance, select Codex 0.162.1 and create a scratch chat in a scratch folder.
  Send “Reply with the word ready.” Expected: the first reply arrives; no `protocol-invalid`, unsupported-parameter or
  thread-start error occurs. Record the build revision, CLI version, instance/thread identity, observed reply and relevant
  redacted app-log lines.
- [ ] **Native resume:** after the fresh chat has finished its turn, hibernate it and wake/resume the same conversation
  through Harness. Send “Reply with the word resumed.” Expected: the same provider conversation resumes and the first
  follow-up reply arrives; there is no metadata-only-resume validation error or unexpected fresh-thread fallback. Record
  the before/after provider thread identity, reply and redacted app-log evidence.

**Why deferred:** unit tests verify the generated request contract and both production builds pass, but no running Harness
instance has been rebuilt/restarted from this queue worktree. The provider lifecycle and first real reply must be checked
in that rebuilt app.

## Step 1c: the Codex thread policy reaches Codex

- [ ] **One chat and one plan-queue item:** in the rebuilt instance, leave both Codex helper-agent settings at their
  "trial" defaults and `codexContextTuning` at its "harness" default (context tuning is not trialled). Start one Codex chat
  and run one disposable plan-queue item to a decision. Then read
  `<userData>/session-policy/<today>.jsonl`. Expected: one line per Codex thread start/resume (the chat, the item's worker
  and verifier rounds), each carrying `sessionKind`, `level`, `arm`, `armKey`/`armSource`, the caps and `applied: true`.
  The three round lines of one item share one `armKey` (the item id) and one `arm`.
- [ ] **Helper threads per root:** in Codex's state database (`~/.ai-orchestrator/codex/state_5.sqlite`,
  `thread_spawn_edges`, read-only), check helper threads under each root thread. Expected: a chat in the cheaper/economy
  arm shows helper rollouts at medium effort unless the spawn asked otherwise; a plan-queue item in the off arm shows no
  helper threads under its root.
- [ ] **Windows PC (only if it runs Codex for Harness):** one remote Codex session starts normally. `applied` may be
  false there if its Codex is older and rejects the config.

**Why deferred:** the policy log, per-thread `config` and fallback are unit-tested (including the no-cap-retry path), but
proving the policy reached a real Codex and reading the log from the rebuilt app needs the running instance.

## Step 1e: standing notes after a Codex compaction

- [ ] **A long Codex chat that compacts:** in a disposable Codex chat, send work that keeps durable notes flowing (a
  plan-queue follow-up or a child-announcement reaching the session) and let the conversation grow until Codex summarises.
  Expected: the rollout shows one standing-notes developer item after the compaction item (look for
  `harness_standing_notes`), and it is not repeated later without another compaction. Record the rollout excerpt.

**Why deferred:** the re-inject is unit-tested for both the mid-turn and idle compaction paths, but a real compaction in a
real Codex thread is the only proof the notes survive Codex's own summary handling.

## Step 1d: the Codex helper trial (time, not a rebuild)

The trial clock starts when the rebuilt app carrying Step 1c is in use with both helper settings on "trial". It runs at
least 21 days (stop at 35), and until each comparison has 40 chat threads with 3+ turns and 20 decided plan-queue items
per group.

- [ ] **Trial verdict (James):** run `npm run audit:codex-helpers -- --since <trial start>` and attach the output. The
  report prints both comparisons (Harness work off-vs-full from the plan-queue landing rule; chats cheaper-vs-full from
  the token and wall-clock rules) and its rule verdicts. James answers one question: "were Codex's answers in your chats
  any worse?" The verdict then sets `codexHelperAgentsChats` and `codexHelperAgentsHarnessWork` (a one-time settings
  migration if a stored value still says `trial`, or James changes it in Settings). Until the verdict is applied the
  settings stay at "trial".

**Mail/cache measurement already verified in-loop:** the report now consumes actual typed descendant-to-parent mailbox delivery receipts and subsequent per-request cache deltas. CLI paired chronology tests and a read-only 18-file current sample (330 deliveries / 234 measured next requests / zero zero-cache misses) pass. Future trial output must retain measured denominators and unknown coverage; this sample does not start or decide the trial. Historical unsupported/prose-only mail is not reconstructed, and no cache-based verdict rule was added.

**Why deferred:** the verdict needs weeks of real use and James's own judgement. The report script, its fixture tests and
the one-page verdict rules are done and agent-verified.

- [ ] **Harness-record measurement (added 20 Oct, plan 1d amendment):** after the rebuild, run one Full-arm plan-queue
  item that spawns Codex helpers. Confirm the session-policy log has `helper-count` lines with the instance id; the cost
  rows for that instance include the helpers' tokens (compare with a durable chat or automation thread with helpers,
  where rollout tokens are ground truth); and `npm run audit:codex-helpers` shows the item as measured, not unknown.

## Step 3: the A4 replay's one-week re-read (after the ceilings ship)

Step 3's replay itself ran against this Mac's real history (table in the plan's as-built notes). Its own deferred check
belongs to Step 5:

- [ ] **One-week re-run:** a week after the context ceilings ship (Step 5a's settings), run
  `npm run audit:context-ceiling -- --since <date> --resume-cache --cold-returns` again and compare. Expected: own-chat
  spend above the ceiling falls, and the cold-returns numbers move with the "Compact first" offer (Step 12c). Why
  deferred: it needs a week of the rebuilt app's real use.

**Why deferred (the check above):** it measures post-change behaviour that does not exist until Steps 5 and 12c ship.

## Step 2: Claude helper agents (A18)

- [ ] **One chat per trial group:** start two new Claude chats in the rebuilt app and check the last hex digit of each
  native session id (0-7 = Sonnet helpers, 8-f = same-as-session). In each, ask for one general-purpose helper and one
  fork. Expected: the Sonnet-group helper's transcript `message.model` is Sonnet; the fork and any named-model agent keep
  their models on both sides. Record the ids and models.
- [ ] **Reviewer rule:** run a completion check through a helper agent. Expected: the helper runs on the parent's model
  family.
- [ ] **Fork cache sharing (ship-or-not gate for the flag):** the waiting-rule CLI flag is **disabled by default** in
  this worker candidate. In an isolated flagged probe, confirm a fork's first request reads the parent's cached prefix
  rather than rewriting it. Only after that proof, run a helper through a six-minute command and check that it reports
  back within four minutes without a cache rewrite. Record both receipts before considering rollout. If the fork
  rewrites, keep `--append-subagent-system-prompt-file` disabled and record the failed gate.
- [ ] **Windows PC:** one Claude session there starts normally (its CLI version is unknown, so the gates should just
  leave everything unchanged).

**Why deferred:** all of this needs sessions in the rebuilt app and transcript inspection; the policy, the flag file and
the `--subagents` report are unit/fixture tested.

## Step 4: read-only Claude reviewers and the security plugin (A5)

- [ ] **One automatic second opinion with a Claude reviewer:** in its transcript the first request still lists connector
  tools as names only (deferred) and is close to today's reviewer first request in size (~60K); there is no Edit, Write,
  Bash or Agent tool; the structured verdict returns within the 8-turn cap. Ask the reviewer to use one of James's skills
  and note whether it runs or is refused (a skill with special properties is expected to be refused).
- [ ] **Plugin off in machine sessions:** run one Claude loop round and one automation run; their transcripts have no
  `security_reminder_hook` in `stop_hook_summary`, while a chat of James's still does. This also proves flag settings
  switch plugins off on 2.1.296.
- [ ] **Resume-cache guard:** `npm run audit:context-ceiling -- --resume-cache` reports at least 90% (24 of 26 in the
  pre-change read).

**Why deferred:** reviewer argv/settings are unit-tested and both builds compile, but the argv log line, the transcript
tool list and the plugin's absence only appear in a running session.

## Step 5: context ceilings, loops and the quiet note (A4)

**Ceiling prerequisite (James's Decision 4, 20 October):** both defaults ship at 0 (Claude's own limit). James's own
chats move to about 270,000 only after Phase D's recall check; Harness-started work stays on Claude's own limit
(`2026-10-20-oct2-decisions-for-james_completed.md`). This replaces the 19 October replay-rule choice of 250,000 / 200,000.
Existing stored settings are unchanged and may still be 0. Before the boundary and near-limit probes below, record the
effective ceiling in the disposable rebuilt test instance; configure a nonzero value there if needed, then restore that
instance's previous setting afterwards. A stored-zero session must not be expected to hit a positive ceiling. The
cold-cache loop restart is independent of that setting.

- [ ] **A real chat crossing the chat ceiling:** the transcript shows `compact_boundary` with `pre_tokens` close to the
  ceiling minus 33K, and the chat carries on. This validates the note's constants.
- [ ] **A paused Claude loop:** pause a same-session Claude loop for more than an hour with over 150K of context. The next
  round starts a fresh session and the activity line gives the cold-cache reason.
- [ ] **The near-limit note on screen:** seed/observe a Claude session near its ceiling; the quiet line ("Claude will
  summarise this conversation in about N tokens") appears beside the context banner. Screen check runs on the Windows PC,
  or on the Mac with James's explicit OK for that task.
- [ ] **One-week re-run of the replay** (also listed under Step 3 above).

- [ ] **Read-only purpose count:** after one plan-queue run in the rebuilt app, count the day's cost-attribution rows by
  `purpose` (read-only). Expected: `plan-queue` rows appear and `chat`/`child` no longer include them (the old task-type
  prefix still reads `child:`/`chat:`, by design).

**Why deferred:** the resolver, tagging and the createInstance guard are tested; the proof is a live run's log rows.

## Step 7: one daily helper limit (A0-H)

- [ ] **Compression-slot limit at $0.01 (automatic compaction):** in the disposable rebuilt app set the daily helper
  limit to $0.01, disable the local helper or use a deliberately unavailable local endpoint, then drive a compaction
  the app performs **itself** on a disposable session that needs a summary — for example force an overflow (Step 16's
  shape) or let the automatic compaction policy fire. Do not use **Compact now**, the compaction-boundary Confirm or a
  typed `/compact`: those are explicit user actions and are exempt from the cap (plan Step 7 item 5; round-7 Y3 — the
  check below covers the exemption). Expected: the paid compression fallback is blocked, a usable basic summary is
  produced, and one notice appears ("Helper models: daily limit reached. Paid fallbacks resume tomorrow."). Repeat once
  and confirm no second notice in the same throttle window.
- [ ] **Manual compaction is exempt by design (added 23 Oct):** at the same $0.01 limit and helper-down setup, choose
  **Compact now** on another disposable session that needs a summary. Expected: the daily limit does **not** refuse it
  — `trigger:'manual'` carries `userInitiated`, so `auxiliary-daily-spend-cap` records the cost instead of refusing and
  `authorizeFallback` skips the shared limit — so the paid compression fallback may run and its cost is recorded for
  the day. A block here would be a defect, not a pass. Restore the prior limit and helper setting afterwards.

**Why deferred:** the running app's notification surface and real helper availability need a rebuilt disposable instance.
The $0.01 compression fallback, unknown five-cent reservation, one notice across two compactions, and basic summary are
already covered by in-loop integration tests. Step 14b disables paid title CLI spawning, so a title check cannot exercise
the paid daily limit. *(Corrected 23 Oct: the first wording pressed **Compact now** and expected the paid fallback to be
blocked, but the plan exempts explicit user compactions on purpose (Step 7 item 5, round-7 Y3). The capped probe now
drives an automatic compaction and the manual exemption is a separate check, so the campaign cannot misclassify intended
behaviour as a defect.)*

## Step 8: scheduled-job checks (A15)

- [ ] **A checked job ticks twice:** create a disposable scheduled job with a check command the test controls. First tick
  with unchanged output: no AI starts, the run shows greyed as "Nothing changed" and does not raise the unread badge; the
  "checked N, started M" line reads correctly. Second tick with changed output: the AI runs with the change note and the
  comparison advances only after the successful run.
- [ ] **Run now ignores the check; a failing check runs the AI anyway** with one notice per failure streak.
- [ ] **Screen checks (Windows PC):** the greyed rows, the Sonnet suggestion on a new checked job, and the "about N times
  a day" line on the automations page.
- [ ] **Quiet reply (added 20 Oct from the plan's Step 8 live checks):** a disposable scheduled job "Reply that all is
  well." Expect a greyed "Quiet" row, no unread badge, and the full reply kept with the run.
- [ ] **Thread wake-up into a busy session:** start a long turn in a scratch Codex chat, then fire a thread-destination
  scratch automation at it. Expect "That conversation was busy…" and the prompt arriving after the turn ends (not a
  `failed` run).
- [ ] **One-week failed-run count (time):** after a week on the rebuilt app, a read-only count finds no `failed` runs
  with "already has an active turn" and no retries of `target_missing` or a Codex stall.

**Why deferred:** the check runner (with real commands in temp dirs), gate, store and display logic are integration
tested; the page and notification behaviour need the rebuilt app.

## Step 9: output caps and the compact tab listing (A19, A17.4)

*(Added 20 Oct: the plan's Step 9 live checks had not been carried into this document.)*

- [ ] **Command-output cap:** rebuilt app, a scratch Claude chat in James's default auto-approve mode, and again in a chat
  that asks for approval: run `seq 1 12000` (about 50,000 characters). Expect a short preview and a saved-file path in the
  transcript, not the whole output. Note the Claude CLI version (the cap needs 2.1.261 or later).
- [ ] **Compact tab listing (Windows PC only):** ask the agent to list browser tabs; the result has no `id` / `lastSeenAt`
  fields and still closes a scratch tab by `profileId` + `targetId`.
- [ ] **Long page snapshot (Windows PC only, optional):** snapshot a long page; expect a 12,000-character preview plus
  a saved-file path whose full text is readable.
- [ ] **One-week transcript re-scan (time):** the `browser_list_targets` median is under 20K characters and Bash
  results over 12K are replaced by previews.

**Why deferred:** the caps, backstop, projection and redaction are unit and integration tested; the real CLI output,
browser and transcripts need the rebuilt app and the Windows PC.

## Step 13: helper batch reports and tool listing (A17)

- [ ] **One batch of helpers:** a scratch parent starts three helpers together. Expected: one `all_children_completed`
  after the last finishes (no per-helper `child_completed` for finished burst-mates), each helper's result appears once on
  the parent, and a failing helper wakes the parent immediately. A hung helper's batch releases after 10 minutes.
- [ ] **Windows PC browser session:** a Claude session with its own tool search enabled sees Harness's eager tool list a
  turn or two sooner (the double-hiding is gone).
- [ ] **Tool search off (added 20 Oct from plan 13d):** repeat the session with `ENABLE_TOOL_SEARCH=false` in the
  Claude profile's settings `env`; Harness's bridge entries stay deferred (the guarded detection reads "off") and the
  "Claude MCP tool search resolved" log line says so.

**Why deferred:** the batcher and tool-listing rules are unit-tested; live helper runs and a real browser session are the
only proof of the message shape on screen and the listing timing.

## Step 10: the Harness guide reaches sessions (A12)

- [ ] **Fresh Claude root session:** in the rebuilt instance, type "Every weekday at 9am, check this repo's CI and tell
  me what failed." Expected: the session creates a Harness automation (`create_automation` marker or MCP tool), not a
  CLI `/schedule`; the automation appears in Automations; one `Harness guidance added` log line with `path: first-message`.
- [ ] **Same in a Codex root session** (first-message block path).
- [ ] **Before/after prompts (optional, real models):** run the plan's six fixed prompts on today's build and the new
  build; record whether the right command was used.

## Step 11: OpenCode's own levers (A6)

- [ ] **Title off:** a rebuilt OpenCode 2.x root session, one message: OpenCode keeps its default title (no title request
  in OpenCode's log) and the reply is normal.
- [ ] **Step cap:** an OpenCode loop with `maxTurnsPerIteration: 3` on a task that needs more steps ends the round with a
  text-only summary after 3 steps.
- [ ] **Native compaction:** "Compact now" on an OpenCode session with history: same OpenCode session id afterwards, one
  "OpenCode compacted this conversation." notice, no restart-with-summary for that instance, lower context reading after
  the next turn. Note whether the summary streams into the chat as an assistant message.
- [ ] **Compact now right after a switch (added 20 Oct, round-6 fix):** on an OpenCode 2.x session, switch model or
  account (which queues a runtime-change notice), then press "Compact now". OpenCode must receive `/compact` as the
  only prompt text (OpenCode's log shows a compaction, not a chat turn), and the queued notice must reach the next real
  turn once. Also confirm a real 2.0.18 compaction streams NO assistant answer text over ACP: Harness now treats an
  answer-text reply to `/compact` as "not compacted" and falls back to restart-with-summary. If a genuine compaction
  does stream text, every native compaction would fall back, which is safe but wasteful, and must be corrected.
- [ ] **Retry markers (2.0.2x or a MiMo long turn):** a long silent turn shows "retrying (attempt 2)" notices. For
  privacy the reason is only `Provider returned HTTP N.`; a timeout retry has no HTTP status, so it shows no reason. Confirm
  the timeout from OpenCode's own log (A6.6). *(Amended 19 Oct; the earlier wording expected OpenCode's error text.)*

## Step 12a/12b: model facts and duplicate attachments (A9.4, A9.2)

*(Added 20 Oct: these plan live checks had not been carried into this document.)*

- [ ] **Model facts and switch note (Windows PC, or the Mac with James's OK):** rebuilt app, open the model picker in a
  new session and in a live Claude and a live Codex conversation; read the speed/size/price facts and the switch note;
  compare two or three prices with the Models page. A session with only system notices shows no switch note.
- [ ] **Paste one screenshot twice:** paste or drop the same screenshot twice before sending; one chip remains and
  "Already attached." appears; two different screenshots both attach.

## Step 12c: compact-first on a cold return (A9.3)

- [ ] **The offer:** a real Claude session of 100K or more reported tokens, left idle for over 70 minutes (or the two
  constants lowered in a dev build): the chip appears with the idle time and token count; a younger or smaller session
  shows nothing.
- [ ] **Compact path:** with the toggle on, Send compacts first (a boundary divider appears), then the message is
  answered. Compare the next request's cache-write size in the transcript with and without the chip.
- [ ] **Full-history path and failure:** "Send with full history" sends at once; a forced compaction failure (stop the
  helper model) returns the text to the box and sends nothing. With the setting off, nothing is shown.

## Step 14: live-session side jobs (A8)

- [ ] **Control-protocol probe (step 14a, do before trusting the screens):** start
  `claude --print --input-format stream-json --output-format stream-json --verbose` in a scratch folder, run one short
  turn, then write one control request at a time on stdin and save the raw stdout lines: `side_question` (with and
  without a running turn), `generate_session_title {description, persist:false}`, `set_model`, `get_settings`,
  `apply_flag_settings {settings:{effortLevel:"low"}}`. Record exact reply shapes, any extra line types, and whether
  `control_cancel_request {request_id}` cancels a side question. *(20 Oct: the outer envelope
  `{type:'control_response', response:{subtype, request_id, response:<data>}}`, the error shape `{subtype:'error',
  request_id, error, error_code?}` and the `get_settings` / `apply_flag_settings` replies were confirmed against the real
  2.1.303 CLI without a model call; the `side_question` `{response, synthetic, refusal_fallback?}` and
  `generate_session_title {title}` data shapes come from the CLI's own SDK client and still need this live receipt.)*
- [ ] **Quick ask:** with a running Claude session (first reply done), "Quick ask" returns an answer in under 30 seconds
  for a small context while a long turn keeps streaming; afterwards the session transcript has no trace of the question
  (search `~/.claude/projects` for a unique word) and the Costs page shows one `quick-ask` call with no cost figure.
- [ ] **Titles:** starting a new Claude chat produces an AI title with no new Claude process (process list unchanged);
  with no live session the instant title stays and no CLI is spawned (log line present).
- [ ] **Title while the helper model is down (added 20 Oct):** stop the local helper model (or let two helper failures
  show the helper pause), then create a Claude chat WITH a first message. Expected: the instant title first, then within
  a few seconds an AI title from the live session; no new Claude process; "AI title upgrade skipped" logged at most once
  and only for non-Claude chats; a rename made while it waits is kept.
- [ ] **Quick ask fallbacks (added 20 Oct):** if Claude returns its placeholder "No answer available…" (`synthetic: true`)
  the panel shows "No answer came back", not the placeholder; a reply answered by a different model after a refusal shows
  the small notice naming both models.
- [ ] **Model switch:** switch Opus to Sonnet on a session that has read a file; the session id and process are unchanged;
  a follow-up question about the file is answered; the notice says the conversation was kept; the next turn's
  `cache_creation` shows one big write. On a remote or non-resident session the notice says it restarted from a summary
  of N messages and that tool results were not carried over.
- [ ] **Effort switch:** change low to high on a live session and confirm `get_settings.applied.effort` changes (this
  fixes the effort key). With James's real hooks: confirm no `PreModelSwitch` hook blocks the switch; if one does, the
  fallback restart works.

## Step 15: build-in-a-new-session (A21)

- [ ] **The hand-off:** run a real Plan-agent session on a small task in a scratch repo until it emits "Ready to
  Implement". Click "Build in a new session", edit one line of the plan, start. Confirm: the new session's first message
  has the edited plan, the planning session gets no extra turn, the card disappears, and the build finishes the task.
- [ ] **The numbers:** compare the two sessions' first-turn token counts in the Costs page or cost log.
- [ ] **Plan Mode page:** pick the session, Enter plan mode, edit plan text, Approve, then "Build in a new session"; and
  Exit. (The page needs no typing — it opens on the selected session.)

## Step 16: overflow and local-model compaction (A1)

- [ ] **Local models:** Compact now on a real LM Studio or Ollama session (the Windows PC's models are fine): the history
  shrinks in place ("Compacted in place"), and a follow-up question about an early detail is answered from the summary.
- [ ] **Overflow recovery:** reproduce an overflow on Gemini or Antigravity (and Cursor if available) in the rebuilt app:
  one summary, one continued request (no silent drop), the provider session id changed. Claude behaves as before
  (buffers only). An overflow on a local model shrinks the adapter history and the single retry succeeds.

## Step 18: RTK / output compression (A13)

- [x] **Historical Live check 1 observation — rewrite-only single command (16 Oct 2026, command line, macOS).** Scratch git
  repo; `claude -p --dangerously-skip-permissions` with the rewrite-only hook overlay and
  `ORCHESTRATOR_RTK_ENABLED=1 ORCHESTRATOR_RTK_PATH=<bundled 0.51.0> ORCHESTRATOR_RTK_REWRITE_ONLY=1
  ORCHESTRATOR_RTK_LOG_DIR=<scratch>/hook-decisions`. Evidence: (1) `git status` run was rewritten — the hook decision
  log recorded `{"decision":"rewritten","rtkExit":3,"elapsedMs":54,"mode":"rewrite-only"}` (exit 3 = "no rule matched,
  rewritten" on 0.51, allowed with `updatedInput`, no stall and no prompt); the model's reply was intact and the run
  finished normally. (2) A failing command (`git nonexistentcommand`) reached the model with its real failure and exit
  code, producing the expected FAILCASE reply; a second decision-log line recorded it. (3) The old Homebrew 0.42.4
  `rtk gain` still opens the shared history database afterwards (no schema break from the 0.51 runs). `claude` 2.1.296,
  bundled `rtk` 0.51.0. This observation informed the former `rtkAutoApproveScope: trial` code default (now `off`, 19 Oct); it did not prove the
  complete pipeline/deny behavior, a rebuilt-app rollout, a release, or a trial start.
- [ ] **Complete Live check 1 before trial interpretation:** in an isolated, disposable auto-approve session, record
  rewrite-only hook receipts for a simple command, a pipeline/multi-command case, a genuine deny/failure path and the
  unchanged approval behavior. Preserve the original command-line observation above as historical; attach the new
  redacted decision and transcript receipts here. Missing or denied rewrite evidence must not be counted as exposure.
  **Deny-rule preconditions (added 19 Oct from a fresh review):** with `Bash(git push*)` in a disposable project's
  `.claude/settings.local.json`, RTK 0.51.0 itself refuses (exit 2) plain, piped, chained and subshell `git push`, but
  REWRITES these variants (exit 3): `FOO=1 git push`, `timeout 5 git push` and `git -C /tmp push`. Claude evaluates its
  deny rules against the hook's rewritten command, not the original. For each of those three variants, record whether
  Claude blocks the rewritten command in a disposable repo with a non-existent remote, so nothing can be pushed. If any
  variant runs, the hook must refuse to rewrite wrapper/prefix forms before the trial can be enabled. Probe evidence:
  `_scratch/changed-plans-queue-2026-10-18/phase1-06b9a87-fresh-whole-gate-20261019/E-14a-18d/deny-probe.txt`.
  Until this check passes in full, `rtkAutoApproveScope` ships `off` (changed from `trial` on 19 Oct).
- [ ] **Packaged binary:** build the app (or `npm run fetch:rtk` plus a dev launch); the log shows `rtk runtime resolved
  … bundled 0.51.0` and `rtk --version` runs from the app's Resources folder without a security prompt on macOS.
- [ ] **Trial plumbing:** set scope to `trial`, start ten short Claude sessions and two loop iterations; both groups
  occur, each session keeps its group after a respawn (interrupt a turn), and the cost rows carry `rtkArm`.
- [ ] **Live check 4 (before 18c can be built):** in a temp `CODEX_HOME` with James's `config.toml` and a merged
  `hooks.json`, run a Codex app-server turn that executes `git status` and a multi-command code-mode cell. Expected: a
  filtered `rtk git status`, no extra approval prompt, and James's `protect-files.sh` hook still firing. Record
  `codex --version`.
- [ ] **Live check 5 (probe only, decides 18d):** in a scratch `COPILOT_HOME`, install RTK's Copilot hook, start a
  Harness Copilot session (ACP) and ask for `git status` and `git log -5`. One transparent call means adopt a hook;
  a blocked call followed by a re-sent call means stay on instructions only. Note whether the hook runs at all under ACP.
- [ ] **Savings tab with real data (Windows PC, or the Mac with James's OK):** layout and wording check — the capped
  numbers (about 25M tokens over 90 days), the "Where it applies" table, the 7/30/90-day selector, no "60-90%" or
  "Reduce Token Count" anywhere.
- [ ] **One-week reads:** the transcript re-scan (Step 9), the tool-search call count (Step 13d), the before/after
  prompts (Step 10), the failed-run count (Step 8), the resume-cache guard (Step 4), the replay re-run (Step 5), the
  rows-by-purpose count (Step 6) — all need a week of the rebuilt app in real use.
- [ ] **Real-world read after the trial:** `npm run audit:rtk-trial -- --since <start>`; attach the output here. The
  verdict sets `rtkAutoApproveScope` (`on`, `off`, or `sessions-only` if only the loop guardrail fails or is unmeasured).
  If the verdict changes a stored `trial` value, apply the one-time settings migration or have James change it in
  Settings.

## Gated items (not built — the gate is the recorded decision)

- [ ] **Step 16b (Claude's own `/compact`):** gated on the real Claude `/compact` probe, which has not run for this
  decision. The accepted Phase 0 summary/restart interfaces are present; their former absence is a historical checkpoint,
  not the current gate. Claude stays on restart-with-summary. If the probe passes, 16b can be built as the plan
  specifies (`claude-native-compaction.ts`).
- [ ] **Step 17b (Copilot instruction file):** gated on Phase 0's Copilot instruction-folder probe, which never ran.
  Copilot keeps the first-message route.
- [ ] **Step 17c (the honest `[SYSTEM INSTRUCTIONS]` label):** gated on its side-by-side trial (six prompts each on
  Codex and OpenCode, one Gemini) which needs the rebuilt app and real models. The old label remains in production
  until that trial passes.
- [ ] **Step 18c (Codex native RTK hook):** gated on Live check 4 above and a clean first week of the 18b trial. Not
  built; `CODEX_NATIVE_HOOK_ENABLED` does not exist yet and must not be assumed.
- [ ] **Step 18d (Copilot RTK):** probe only — run Live check 5 and record the decision here.
- [ ] **Step 9b old-folder sweep (choice 11):** deleting old spill files under `~/.orchestrator/tool-output` and the temp
  fallback ships only with James's yes. Not built; `cleanupOldOutputs` still sweeps only `<userData>/tool-output`, so
  12K spills written by stdio MCP servers are not cleaned until this is decided.

## The three trials (time, not a rebuild)

- [ ] **Codex helpers (Step 1d report):** `npm run audit:codex-helpers -- --since <date>` after ≥21 days / the plan's
  sample gates. The verdict sets `codexHelperAgentsChats` and `codexHelperAgentsHarnessWork` (plus a settings migration
  if a stored `trial` value must change).
- [ ] **Claude helpers (Step 2 report):** `npm run audit:claude-cost -- --subagents --since <date>` after ≥14 days and
  300 general-purpose helpers per group. The verdict sets `claudeHelperAgentModel` and decides the waiting rule.
- [ ] **RTK auto-approve hook (Step 18b report):** `npm run audit:rtk-trial -- --since <start>` after ≥14 days and 150
  sessions per group (stop at 28). The verdict sets `rtkAutoApproveScope`.
