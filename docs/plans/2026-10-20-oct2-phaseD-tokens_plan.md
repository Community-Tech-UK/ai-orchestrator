# Oct-2 Phase D: spend fewer tokens

## Status

On main: no.

Round2 source remediation is ready for the coordinator's independent verification in `queue/2026-10-20-oct2-phased-tokens-0e371d`. All14 steps have implementation and focused coverage; as-built statuses are in [history](2026-10-20-oct2-phaseD-tokens_history.md). No independent PASS is claimed.
Main/spec types, lint, LOC, main/renderer/worker builds, worker self-check, generators and wiring checks pass. The385-file targeted run passed384 files with one RTK grouped-case timeout; after a bounded test-only fix,12 affected files/107 tests and spec types/lint pass. Exact results, including the unchanged base renderer-event audit failure, are in the [round2 report](2026-10-20-oct2-phaseD-tokens_evidence/round2/remediation-report.md). The coordinator runs the full suite and fresh gate.
Real three-chat recall fell83.8%->47.5% over40 questions: the300K migration is implemented but remains a strict no-op. RTK stays OFF; native consumption awaits ordinary service after the confirmed account spend limit. Genuine deployed/provider/future checks remain in the live campaign.
Reports, command receipts, seal and cleanup receipt are retained. No commit, integration or completion rename by this worker. Decisions3,4,10,13,16 remain(a).

**Backlog source:** [`claude_oct-2-todo.md`](../../claude_oct-2-todo.md) items T3 steps 2-6, T5, T6, T7, T10, T11, T13, T14,
T16, T17, and K3 items 3, 4 (which owns T2 item 4), 5 (recording), 7 and 8. **Programme:**
[A](2026-10-20-oct2-phaseA-safety-and-truth_plan.md) · [B](2026-10-20-oct2-phaseB-land-built-work_plan.md) ·
[C](2026-10-20-oct2-phaseC-queue-that-finishes_plan.md) · D (this) · [E](2026-10-20-oct2-phaseE-calm-screen_plan.md) ·
[F](2026-10-20-oct2-phaseF-tooltips_plan.md) · [housekeeping](2026-10-20-oct2-housekeeping_plan.md) ·
[later](2026-10-20-oct2-later_plan.md) · [decisions](2026-10-20-oct2-decisions-for-james_completed.md).

## In plain English

Token use per day is 2.7 times last month's and Codex is 81% of it. Phase A stops the biggest avoidable flows. This plan
does the rest, each step measured against the numbers Phase A makes visible:

- a ceiling on runaway Codex rounds (51 rounds of over 100 million tokens held 63% of all volume);
- Codex helpers that start clean instead of as a full copy of the parent chat, and a smaller skills list for machine work;
- Claude helper-agent limits for machine work, Sonnet for research scouts, and the long-chat cap for James's own chats after
  a quality check;
- smaller tool results and tool lists, a size budget for every prompt Harness builds, and the guide trimmed before it is
  sent everywhere;
- Claude compacts before a known long sleep, and gets told what to keep when it summarises;
- correct prices (cache writes, the Codex long-prompt premium) and a daily check against Claude's own cost figure.

## Ground rules

1. **Read first**; line numbers are from 20 Oct; trust names.
2. **Prove it first** with the named failing test.
3. **Current checkout only;** no branch or worktree; never stage, revert or stash other sessions' files; commit only when
   James asks.
4. **File size:** 700 for non-allowlisted files, ceiling + 50 for allowlisted. New logic in new modules.
5. **Machine sessions:** `machineSessionReasonOf` (`src/shared/utils/machine-session.ts:7-15`) treats any session with a
   `parentId` as machine, including ordinary orchestration helpers. Every "machine only" rule below states whether helper
   children are meant to be included; where they are not, test `sessionKindOf` for the specific kinds instead.
6. **Settings** live in seven places (`settings.types.ts`, `settings-defaults.ts`, `settings-metadata-runtime.ts`,
   `settings-surfacing.ts`, `settings-control-policy.ts`, `settings-validators.ts`, `advanced-settings-sections.ts`). A
   changed default reaches James's install only through a marker-guarded migration in `settings-migrations.ts`.
7. **Codex thread config** has one source: `resolveCodexThreadPolicy` (`codex-thread-policy.ts:14-24`), merged into
   thread start and resume by `codex-thread-requests.ts`. Every new key is added to the retry key list there, and the
   policy spec's whole-object assertions are updated on purpose.
8. **Trials:** an arm is fixed for a session's life, keyed so related sessions share it, written to the session-policy log.
9. **No browser or desktop app on the Mac** (if the Windows PC is down, stop and tell James; never fall back to the Mac);
   never write to James's databases or settings from a script.
10. **Angular** (cost page, pickers): standalone, `OnPush`, `inject()`, signals, `input()`/`output()`.
11. Keep the Status block under about 1,500 characters.

**Settings keys:** `settings.types.ts` has about 4 lines of room (885/889): every new key in this plan goes in a separate
settings-types module that the main settings type extends, never in that file.

## Order of work

| Step | Item | Size | Needs first | Main files |
|---|---|---|---|---|
| 1 | T3.4 Codex per-turn token ceiling | S | Decision 16; Phase B Step 5 | *`codex-turn-token-ceiling.ts`*, `codex-app-server-notification-adapter.ts` |
| 2 | T3.2, T3.3, T3.5 Codex helpers start clean; "ultra" explained and clamped; helper share stored | S | Step 1 | `codex-thread-policy.ts`, `turn-input-dispatch.ts`, model picker |
| 3 | T5 Codex skills cap for machine work | XS | none | `codex-thread-policy.ts` |
| 4 | T6 Claude helper limits and research scouts on Sonnet | XS-S | Phase 1 landed (A18) | `claude-env-pack.ts`, fan-out guidance |
| 5 | T7 long-chat cap for James's own chats | S | Decision 4; recall check | settings migration, `context-ceiling.ts` |
| 6 | T3.6 Codex standing notes and trial report | XS | Phase 1 landed | (on the Phase 1 branch) |
| 7 | T10 AIO's own tools | S-M | none | `mcp-server.ts`, `spawn-config-builder.ts`, `orchestrator-mcp-deferral.ts` |
| 8 | T11 prompt size budgets, authoring rules, guide diet | S | before A12 delivers the guide everywhere | *`prompt-budgets.spec.ts`*, house style, `orchestration-protocol.prompts.ts` |
| 9 | T13 Claude idle and compaction levers | S-M | Step 5 | `claude-cli-argv-builder.ts`, `loop-context-survival.ts` |
| 10 | K3.3, K3.4 correct prices | S | none | `model-pricing.ts`, `model-call-recorder.ts` |
| 11 | K3.5, K3.7, K3.8 Codex credits, Claude daily reconcile, helper models | S | Phase A Step 6 | *`codex-credit-reader.ts`*, *`claude-cost-reconcile.ts`* |
| 12 | T14 Gemini and Antigravity prompt repeat | S | none | `gemini-cli-adapter.ts`, `antigravity-cli-adapter.ts` |
| 13 | T16 RTK counting | XS | none | `rtk-tracking-reader.ts`, `rtk-awareness.ts` |
| 14 | T17 say the cost before a restarting change | S-M | Phase 1 landed (A8.3) | *`runtime-change-cost.ts`*, `runtime-reconciler-plan.ts` |

---

## Step 1. T3 step 4: a ceiling for runaway Codex turns (Decision 16)

**Why.** 51 turns of at least 100M processed tokens held 63% of all AIO token volume since 10 Oct; the four biggest used
1.56-1.84B each. All but two were Codex with helpers.

**Change.** `codex-turn-token-ceiling.ts`, fed from the live token notification path
(`codex-app-server-notification-adapter.ts:159-224`, `usageAccounting.observe` at `:174`; `isChild` at `:172` separates
helper threads). Sum root and helper processed tokens per root turn.
1. At about 150M: steer once, "Wrap up now: report what is done and what is left."
2. At about 300M: interrupt the turn, for Harness's own work only (plan queue, loops, scheduled jobs, reviews). This is a
   deliberate stop: queue jobs park with the `stopped-by-harness` reason that Phase B Step 5 creates ("Stopped by
   Harness: this turn passed 300M tokens"), which Phase C's retries never retry. James's own chats get only the steer at
   150M and are never interrupted, unless he chooses Decision 16(b); then the chat shows a plain notice with "Continue"
   (Phase E's failure card).
3. Both thresholds are settings, separately for Harness's own work and for chats.
4. A "Biggest turns this week" list on the Costs page (top 10 by processed tokens, with session and kind).

**Tests (fail today).** Fixture notifications: crossing 150M sends one steer; crossing 300M interrupts once; helper tokens
count toward the root turn.

## Step 2. T3 steps 2, 3 and 5: helpers start clean, "ultra" is explained, the helper share is a number

1. **Start-clean arm for chats.** `spawn_agent` defaults `fork_turns` to all, so each helper re-reads the whole parent
   conversation. Add a chat trial arm that sets `features.multi_agent_v2.multi_agent_mode_hint_text` to: "Start helpers only
   when asked or when the work is independent and long. Pass fork_turns="none" and put everything the helper needs in the
   message." Optionally `agents.default_subagent_model` set to the cheaper catalogue model. Confirm both keys against the
   installed Codex CLI's protocol snapshot before use. Under Decision 3(a) Phase A's window cap does not touch chats; only
   if James chose 3(c) do the chat arms restart after that change, because it moves their operating point.
2. **"Ultra".** The effort picker says "Lets Codex start helper agents by itself; uses much more of your allowance."
   Clamp scheduled jobs and Harness-started work to at most "max" (`turn-input-dispatch.ts:15` passes effort through today).
3. **Helper share per turn.** Store child-thread tokens against root tokens per turn in the session-policy log, so "helpers
   cost X%" is measured.

## Step 3. T5: cap Codex's skills list for machine work

Codex sizes its skills block at 2% of the window when `skills.max_context_tokens` is unset (median about 5.3K tokens in root
threads, 10K in helper threads, re-read on every request). Add `skills.max_context_tokens: 1500` for non-chat kinds in
`resolveCodexThreadPolicy`, and try `skills.include_instructions: false` for plan-queue checkers. If a worker prompt names a
skill, keep it listed through the per-skill config. Add both keys to the retry list.

## Step 4. T6: Claude helper agents

1. **Start the A18 trial** as soon as Phase 1 lands (general-purpose helpers on Sonnet when the parent is Opus; reviewers and
   the fresh-eyes gate stay on the parent's model).
2. **Native limits for queue, loop and scheduled sessions,** in `applyClaudeHygieneEnv` (`claude-env-pack.ts:52-79`).
   That function receives `options.machineSession`, the machine-session reason string, not a session kind: apply the
   limits when the reason is `plan-queue`, `loop` or `automation`, and not for `child` (ordinary helpers):
   `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=2` (1 for plan-queue workers), `CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION=60`,
   `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=6`, and `CLAUDE_CODE_FORK_SUBAGENT=0` for loop and queue workers until the trial
   shows forks cost no more. Confirm each variable name against the installed CLI's changelog; caller values are never
   overwritten (the existing pattern at `:57-59`).
3. Record fork, depth and foreground or background per helper (from the transcript's `.meta.json`) beside Phase 0's
   helper-size record.
4. **Research fan-outs:** scouts on Sonnet at `high` effort; Opus and `max` for the lead and the synthesis. Put this in AIO's
   fan-out guidance and the child-spawn default, and show a running cost for the fan-out in the session header.

## Step 5. T7: the long-chat cap for James's own Claude chats (Decision 4)

1. **Recall check first:** three real long chats (read-only copies of transcripts) taken through a compaction at about
   300K, with 10-15 questions each about earlier detail, answered before and after. Record the score in the history file.
   No cap ships if recall is clearly worse.
2. Then a settings migration sets `ownChatContextCeilingTokens` to 300,000 on James's install (his stored value is 0; a
   default change alone would not reach him). Claude subtracts its own buffer, so it triggers near 267K.
3. `machineContextCeilingTokens` stays 0. Do not extend the cap to helper agents.
4. Settings text: "Claude summarises earlier chats at this size. Saves roughly a quarter of the cost of very long chats and
   keeps recent work."
5. The replay script runs quarterly (housekeeping K9's measurement kit).

## Step 6. T3 step 6: land Codex standing notes and the trial report

Both are on the Phase 1 branch. Confirm after Phase B's landing that the standing notes re-send after Codex compacts (a
spec on `main`) and that the trial report runs. Nothing to build if they landed intact.

## Step 7. T10: AIO's own tools

1. Cap browser snapshot and click echoes and the orchestrator list and read tools at about 8K characters, ending "More
   available: call X with offset N."
2. Role-aware tool sets: `SpawnConfigBuilder.getMcpConfig` (`spawn-config-builder.ts:132-236`) has no role parameter; look
   the instance up through `deps.getInstance` and, for `planQueueRole` checker and triage, skip browser, desktop, `imap` and
   codemem servers. The guidance blocks already disappear when those bridges are not attached
   (`adapter-spawn-helpers.ts:313-315`). The builder is 699 lines (cap 700): put the role rule in a new module and keep the builder's edit net zero.
3. Hide the four remote-worker tools from the always-visible core (`orchestrator-mcp-deferral.ts:16-23`) when no worker is
   connected; they stay findable through search.
4. A CI ratchet on full and visible schema bytes using `measureToolSchemaBytes` (`browser-mcp-deferral.ts:53-69`) and
   `measureOrchestratorToolSchemaBytes` (`orchestrator-mcp-deferral.ts:28-44`).
5. `orchestrator.tool_search` returns names and one-line descriptions only (today full schemas, `:53-59`, `:112`);
   `tool_describe` returns the schema. Status tools such as `plan_queue_status` accept `sinceVersion` and return
   `{unchanged: true}`.
6. Tool annotations: add an `annotations` field to `McpServerToolDefinition` and pass it in `tools/list`
   (`mcp-server.ts:106-115`); `readOnlyHint` on reads, `destructiveHint` on terminate and close; a spec that every tool
   declares one.

## Step 8. T11: a size budget for every prompt, written authoring rules, and the guide diet

1. `prompt-budgets.spec.ts`: renders each prompt surface with pinned inputs and asserts `chars <= BUDGET[surface]`, one
   table for all budgets. Surfaces: orchestration guide (`orchestration-protocol.prompts.ts:56`), reminders, child prompt
   (`:348`), loop first round, continuation and re-anchor, the five plan-queue prompts, review prompts, the RTK note, helper
   and title prompts. Seed at today's sizes; lower a budget in the same change that cuts the prompt; every raise needs a
   reason comment. Existing per-surface caps (`instruction-cap.spec.ts`, `budgeted-system-prompt.spec.ts`,
   `loop-recycle-handoff.spec.ts`) stay.
2. One debug log line per injection (surface, characters, session).
3. Seven authoring rules in `docs/prompt-engineering-house-style.md`: the delete test; rules over reasons; structure beats
   prose; one source of truth; no sediment; measure before and after; each added line names the failure it prevents and
   goes when that failure is impossible. Remove the duplicated autonomy rule in `plan-queue-prompts.ts` as the first example.
4. **Before A12 (from Phase 1) delivers the guide on every path,** cut it to an always-on core of about 4,500 characters:
   gate Automations and Consensus sections on intent, turn Cross-LLM into one line, drop Code Navigation, show the worker
   section only when a worker is connected. If Phase 1 lands first, this step blocks turning A12's "everywhere" delivery on.
   *Note (20 Oct, Phase 1 session):* Phase 1's A12 already replaces that guide with a 1,515-character `HARNESS_GUIDE`,
   with scheduling and consensus rules added only on intent and no Code Navigation or worker roster. This item is met by
   Phase 1; only the budget table (item 1) still needs to include the new surfaces.

## Step 9. T13: Claude idle and compaction levers

1. **Compact before a known sleep:** when a loop, scheduled job or set-aside queue job will not run again for longer than
   the cache lifetime and holds at least 200K, compact (or recycle with the hand-off note) before sleeping.
2. **Idle hint:** after 75 idle minutes at 100K or more, "Starting something new? A fresh session would skip re-reading
   about N tokens." Quiet while a wake-up, background agents or a dialog is pending.
3. **Per-reply cache lifetime:** read `usage.cache_creation` (`ephemeral_1h_input_tokens` / `ephemeral_5m_input_tokens`;
   the type exists at `api-features.types.ts:41-43`, nothing reads it) and use it in place of the hard-coded one hour
   (`loop-context-survival.ts:29`).
4. **`PreCompact` hook for queue, loop and scheduled sessions:** add it to `buildClaudeSettingsOverlay`
   (`claude-cli-argv-builder.ts:65-112`, which carries only a `PreToolUse` hook today). It prints a short role-specific block
   (a queue worker: job, plan path, changed files, last check, next step; a loop round: open task ids and state folder).
5. **Probe once** openclaw's recipe: `claude -p … --resume <id> "/compact"` as a separate call after retiring the warm
   process, checking for `compact_boundary`. If it works, use it for Claude's "Compact now". The probe uses the CLI only, a
   few cents and a throwaway session created for it (never one of James's real sessions). It runs `claude` directly from a
   shell, not through the live Harness, so it may run on the Mac.
6. `precomputeCompactionEnabled: false` in the machine overlay until a transcript count shows whether it costs anything.

## Step 10. K3 items 3 and 4: correct prices

1. **Claude cache writes:** `getCacheWriteMultiplier` (`model-pricing.ts:208-219`) returns 1 for every non-GPT model;
   Anthropic bills 1.25 times for the 5-minute cache and 2 times for the 1-hour cache. Add `cacheWrite5mTokens` and
   `cacheWrite1hTokens` to `TokenCostInput` (`:23-29`), fill them from `usage.cache_creation` through
   `model-call-recorder.ts:21`, and fall back to about 1.6 times when only the total is known.
2. **Codex long-prompt premium (owns T2 item 4):** for gpt-6.1-sol and gpt-6-astra, price a request above 272K input at the
   higher rate for the whole request, per request, from `thread/tokenUsage/updated`. Re-read OpenAI's published page for the
   exact multipliers before coding them, and cite the page and date in a comment.
3. Note in the history file how much each change moves the helper estimates, the $2-a-day helper cap and audits.

## Step 11. K3 items 5, 7 and 8: measure against the providers' own figures

1. **Codex credits:** after Phase A's one-off check, record `account/usage/read` credits per root thread at thread end and use
   them as the helper trial's unit.
2. **Claude daily reconcile:** compare AIO's Claude cost store with the CLI's own running cost in each transcript
   (`cost-state`) once a day, and flag drift above 5% in the Costs page.
3. **Helper models:** record each Claude helper's own model (frames with `parent_tool_use_id`) next to its size, so helper
   cost is priced on the right model.

## Step 12. T14: Gemini and Antigravity re-send the whole system prompt every turn

Each turn is a fresh process: Gemini wraps `[SYSTEM INSTRUCTIONS]` around the full system prompt plus the RTK note every
call (`gemini-cli-adapter.ts:520-538`); Antigravity prepends it to every `--print` (`antigravity-cli-adapter.ts:359-367`).
For these two, drop James's global `CLAUDE.md` from the prompt (they read their own `GEMINI.md`) or send a short safety
digest, and send memory blocks on the first turn only. Test in `antigravity-cli-adapter.spec.ts` and a new Gemini spec.

## Step 13. T16: RTK counting

Add `rtk bypass` beside `rtk proxy` in the "ran in full" query (`rtk-tracking-reader.ts:290-291`), so the first 1.x binary
does not inflate "filtered". Land the queued A13 steps as designed and add no new RTK surface. Rename the queued trial a
"harm check" (catches harm of about 25% or more, judged on Bash calls per session). The awareness note
(`rtk-awareness.ts:23`) changes only when the 1.x decision (Decision 10) is made.

## Step 14. T17: say the cost before a change that restarts the session

`computeRuntimeDiff` (`runtime-reconciler-plan.ts:24-71`) has seven change flags; Claude model changes always replay.
`runtime-change-cost.ts`: `describeRuntimeChangeCost(diff, contextTokens, idle)` returns zero or one plain sentence per
change kind, shown in the picker or toggle that causes it. Confirm only when the re-send is large ("The next message will
re-send about 230K tokens at full price"). When the switch replays text, say before the click what carries over, sized
from the target model's window. Check after Phase B that the false "Conversation context has been preserved" notice
(`runtime-change-notices.ts:83`) was replaced by Phase 1's truthful one; if not, fix it here.

---

## Final verification

Canonical seven (`npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`,
`npm run build:main`, `npm run build:renderer`, `npm run test:quiet`), summaries in the history file; then the fresh-eyes
completion gate (a new agent using the `task-completion-gate` skill), repeated with another new agent until `VERDICT: PASS`.

## Live checks

`2026-10-20-oct2-phaseD-tokens_livetest.md` records rebuilt-instance/provider adoption and future usage checks with exact steps, expected results and reasons. Step5's real recall experiment already ran and failed; the300K migration remains inactive rather than being deferred. Native RTK consumption awaits ordinary provider service; RTK remains OFF.

## Finishing

The Plan Queue coordinator owns the following lifecycle actions after independent verification. This worker leaves the active filenames and untracked root documents unchanged.

Rewrite the Status block as an as-built summary, rename the history file `_history_completed.md`, then rename this file `_completed` last. Commit only when James asks.

> Plan Queue parked work: `queue/2026-10-20-oct2-phased-tokens-0e371d` — 2 commit(s), reason: verifier-unreliable.
