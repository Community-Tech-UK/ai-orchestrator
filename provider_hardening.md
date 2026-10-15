# Provider hardening ideas

Ideas for making Harness sessions survive the ways Copilot, Codex, Claude, OpenCode, and the other ACP providers actually die. Drawn from the three sessions that died on 1–2 Oct 2026, from what Harness already does, and from the sibling checkouts under `orchestrat0r/`.

This is a backlog of ideas, not an implementation plan. Nothing here is scheduled.

Sibling checkouts surveyed: `opencode`, `oh-my-opencode-slim`, `Actual Claude` (Claude Code source), `claude-code` (docs/plugins only, no runtime source), `codex`, `oh-my-codex`, `copilot-sdk`, `hermes-agent`, `openclaw`, `nanoclaw`, `pi`, `t3code`, `claw-code`, `CodePilot`, `tura`, `agent-orchestrator`, `CodexDesktop-Rebuild`, `online-orchestrator`. The last few are thin on provider-loop logic; the useful patterns came from OpenCode, Claude Code, OpenClaw, NanoClaw, Hermes, and oh-my-opencode-slim.

## The three deaths

All three were OpenCode MiMo, ACP `session/prompt` returning success, Harness going idle. None of them was a crash, a socket drop, or the crash-turn auto-continue path.

| Session | What the provider actually did | What Harness saw |
|---|---|---|
| `iaki24ipc` | Reasoning collapsed into thousands of identical `Hmm.` lines. Finish reason `length`, 0 output tokens, ~32k reasoning tokens. OpenCode logged `exiting loop` and returned a clean turn. | `end_turn`. Idle. Hibernated ~30 minutes later. |
| `iuxohtji2` | Provider content filter. Finish `content-filter`, error `ContentFilterError`, one output token. The visible text is the status narration with `The request was rejected because it was considered high risk` glued on the end. | `end_turn`. Idle. |
| `ipbrmlyp0` | Two live child `task` sessions (gate runs). The parent ACP stream emitted the task tool, then nothing, because child progress is not forwarded. Harness cancelled the parent prompt at 60 minutes. The user typed continue and the same thing happened again. Children were still writing log lines minutes before the cancel. | `ACP session/prompt request timed out after 3600000ms without a session/update`. |

A fourth shape showed up in the same screenshot: crash-turn auto-continue had already fired ("Continuing the interrupted turn automatically") before the task timeout. That path is working. It does not cover a turn the provider reports as finished, or a turn we ourselves abort because the parent went quiet.

## What Harness already does

Do not rebuild these. Extend them.

- Crash-turn auto-continue, root orchestrated sessions only, two attempts (`instance-crash-turn-continuation.ts`).
- Reasoning-collapse and content-filter detection on the ACP complete path, with a shared two-attempt continuation (`reasoning-collapse.ts`, `content-filter-ending.ts`, `instance-reasoning-collapse-continuation.ts`). These are in the working tree and are not in the running app until a rebuild.
- Delegated-task lease: an OpenCode `task` tool (ACP kind `think`, title `task`, or a think call whose raw input has both `prompt` and `description`) keeps the prompt lease for 4 hours instead of 60 minutes (`acp-prompt-timeout-policy.ts`). Ordinary execute tools stay at 60 minutes. Also not live until a rebuild. This is a ceiling, not liveness.
- Stall notice at 5 minutes of no `session/update` while a tool is in progress. It warns. It does not refresh the lease and it does not look at the child.
- Cursor-only transport recovery for HTTP/2 stream cancel (`instance-transport-recovery-policy.ts`).
- Trailing-text classifier for transport truncation and quota refusal (`acp-transport-failure.ts`). Notices only. No auto-continue.
- Doom-loop detector on observed tool calls: identical tool+args+result, ping-pong, runaway, stricter after compaction (`doom-loop-detector.ts`). Warn by default. Auto-interrupt is a setting that defaults off. Harness cannot veto a call inside the CLI.
- Idle hibernation around 30 minutes. This is what made `iaki24ipc` look dead the next morning after a silent `end_turn`.
- OpenCode YOLO permission block sets `doom_loop: allow`. OpenCode's own default is `doom_loop: ask` at three identical calls (`processor.ts`, `DOOM_LOOP_THRESHOLD = 3`). Harness currently turns that brake off.
- MiMo prompt timeout is 45 minutes until a tool goes in progress, then the active-tool lease replaces it.
- `acp-cli-adapter.ts` is on the line-count ceiling (2487, slack exhausted). New policy belongs in small modules such as `acp-prompt-timeout-policy.ts`, not in the adapter.

## The structural gaps

1. **A clean `end_turn` is not a finished task.** OpenCode's loop exits on any assistant finish that is not `tool-calls` or `unknown` (`prompt.ts`). `length` and `content-filter` both exit. Current OpenCode source maps `ContentFilterError` to ACP `refusal` and `MessageOutputLengthError` to `max_tokens` (`acp/service.ts` `promptResponse`). Nothing in the session loop constructs `MessageOutputLengthError` when the finish reason is `length`, so a length cut still comes back as `end_turn` even on the newer source. The installed CLI that ran these sessions is `opencode` 1.18.34, which returned `end_turn` for both the length collapse and the content filter. Harness has to classify the turn from text, thinking, finish metadata, and stop reason together, and keep the text detectors after the CLI is upgraded.

2. **Parent silence is not child death.** OpenCode maps the `task` tool to ACP kind `think` (`acp/tool.ts`). Bash forwards running output as `tool_call_update`. A foreground task blocks inside the tool until the child session ends, and the parent ACP connection emits nothing in between. Background tasks return immediately and notify later, which is a different contract (`tool/task.ts`). Harness's lease is driven only by parent `session/update`.

3. **YOLO disables the provider's own doom loop.** OpenCode asks at three identical tool calls. Harness allows them. The collapse in `iaki24ipc` was reasoning, not a tool loop, so this would not have saved that session. It will save the sessions that hammer the same bash command.

4. **Each recovery is a separate listener with a copy of the same guards** (root, orchestrated, not paused, not a managed loop, no async-work inhibitor, request-count fence, cancel on user input). The next cutoff kind should be another row in one table, not another class.

## Ideas

Each idea says where it was stolen from, which providers it covers, and what "done" looks like. Priority at the end.

### 1. One turn-ending classifier, many reasons

OpenClaw freezes a failover taxonomy (`auth`, billing, overloaded, rate limit, server, timeout, request-size ceiling, context overflow, provider-completed finish) and a corpus test that locks one retry decision per row (`openclaw/src/agents/failover/`, `src/llm/utils/retry.ts`). Harness has the pieces scattered: transport truncation, quota refusal, reasoning collapse, content filter, crash, delegated-task timeout.

Build one classifier that runs on every ACP (and non-ACP) complete and error, and returns a reason:

- `completed` — real end. Idle is correct.
- `max_output` — stop reason `max_tokens`, finish `length`, or collapsed reasoning.
- `content_filter` — stop reason `refusal`, finish `content-filter`, or the known trailing sentence.
- `truncated_transport` — already detected.
- `quota` — already detected. Do not auto-continue.
- `auth` — do not auto-continue. Surface the re-login.
- `doom_loop` — identical tool calls, whether OpenCode asked or we observed them.
- `parent_silent` — lease expired with a delegated task still running.
- `crash` — process or socket died.
- `unknown_error` — keep the text, do not pretend it completed.

Auto-continue policy is a table on that reason, with a shared budget (Claude Code uses 3 for max-output recovery, Harness uses 2). Notices always emit, including for child sessions and managed loops where auto-continue stays off. Idle hibernation must not be the first time the user learns the turn stopped.

Providers: all of them. The ACP ones get stop reason plus text. Codex and Copilot get their own finish fields mapped into the same reasons.

### 2. Honour native stop reasons, keep the text detectors

When OpenCode (or any ACP agent) returns `max_tokens` or `refusal`, treat that as the reason. Do not wait for the sentence. Keep `isContentFilterEnding` and `hasCollapsedReasoning` because:

- Installed 1.18.34 returned `end_turn` for both failures.
- Current OpenCode source still does not construct `MessageOutputLengthError` on finish `length`, so a length cut stays `end_turn` until upstream changes.
- The content-filter sentence is glued onto status text (`import.The request was rejected...`). The detector already allows a preceding newline, space, or sentence boundary and rejects the sentence when more text follows. Keep that.

Upstream change worth sending to OpenCode: on finish `length` with no tool calls, set `MessageOutputLengthError` before exiting the loop, the same way content-filter sets `ContentFilterError`. Then ACP `max_tokens` becomes trustworthy.

Also pass through finish reason and token counts on the complete metadata (`finish`, `outputTokens`, `reasoningTokens`). The collapse had output 0 and reasoning 32004. That ratio is a cheaper signal than scanning 100k of `Hmm.`.

### 3. Reasoning-collapse detector, second generation

What shipped: last 4000 characters, last 24 non-empty lines identical, each line at most 40 characters, a final strict prefix of the previous line dropped so a mid-token cut still matches. The real `iaki24ipc` tail matches.

Steal the rest from Claude Code's max-output recovery (`Actual Claude/query.ts`):

- Recovery limit 3 there, 2 here. Keep 2 until we see a third continuation actually finish work. Claude's prompt is the right shape: resume directly, no apology, no recap, pick up mid-thought, break the rest into smaller pieces. Our prompt already says the step ended for length and not to repeat the reasoning. Add the "smaller pieces" line. A collapsed reasoning trace is often the model trying to plan the entire remainder in one thought.
- Escalate the output cap once before the multi-turn dance. Claude retries the same request at 64k (`ESCALATED_MAX_TOKENS`) when the default 8k cap was hit, with no meta message, once per turn. Harness does not set `max_tokens` for OpenCode MiMo. Hermes already special-cases this family: OpenCode Zen's default 262144 exceeds what Xiaomi accepts for `mimo-v2.5-pro` and returns 400, so Hermes caps that model at 131072 (`hermes-agent/plugins/model-providers/opencode-zen`). For MiMo, set an explicit reasoning and output budget instead of inheriting the relay default. A 32k reasoning trace of `Hmm.` means the reasoning budget was large enough to degenerate and the output budget was never reached.
- Detector holes to close: the same short phrase repeated on one line (`Hmm. Hmm. Hmm.`), a two-token alternation (`Hmm.` / `Wait.`), and a long run of identical lines that is not at the tail because a tool result was appended after. Check each thinking block, which we already do, and also a single-line run-length.
- Do not continue when the visible answer is complete and only the thinking collapsed. If output tokens are non-zero and the text ends on a finished sentence with no open tool call, notice it and leave the turn. `iaki24ipc` had 0 output tokens, so continue was right.

### 4. Content filter: continue without the blocked source

What shipped: trailing-sentence detector, two continuations, prompt says do not quote or paste the blocked source, refer by position, date, and field name.

Next:

- If stop reason is `refusal` or finish is `content-filter`, skip the text detector. The sentence is the fallback for old CLIs.
- Before the retry, drop or redact the tool result that was in the last request. Claude Code withholds the error from the stream and only surfaces it if recovery exhausts. Re-sending the same tool output is how a filter continuation loops until the budget of 2 is spent and then stops forever.
- A filter on user-supplied source material (the gratitude import) is not a crash. The continuation prompt must not contain the source text. The notice can name the provider and the finish reason. It should not echo the blocked sentence into a place that gets re-fed to the model. The current notice does not echo it. Keep it that way.
- Provider differences: Anthropic uses `refusal` / content-filter stop reasons. OpenAI-compatible relays (MiMo via OpenCode) sometimes return HTTP 200 with a finish reason and a canned sentence, which is what we saw. Copilot and Codex may return a policy error on the stream instead. All three should land on `content_filter` in the classifier. Do not auto-continue a filter that is about the user's own instruction (jailbreak-shaped). Do auto-continue when the blocked span is tool output or a file the user asked to process. Heuristic: the canned sentence is the entire new assistant text, or it is glued onto status narration, and the last tool was a read of a user file.

### 5. Delegated task liveness, not a longer blind lease

The 4-hour lease stops us killing a live gate run at 60 minutes. It also means a stuck task now sits for 4 hours. NanoClaw already solved the shape (`nanoclaw/src/reconcile-session.ts`):

- Absolute ceiling: no heartbeat for `max(30 min, declared bash timeout)` kills the container.
- Message-scoped stuck: a claim with no heartbeat since the claim, past `max(60s, bash timeout)`, kills that message.
- A missing heartbeat file falls back to spawn time, so a process that never writes a heartbeat still ages out.
- Kill resets the claim with backoff and a try cap (`MAX_TRIES = 5`), and the existing retry machinery continues.

For OpenCode tasks:

- The child is a real session with `parentID`. OpenCode already updates `time_updated` as the child works. A small poller (or an OpenCode event subscription on the child id, which the task tool already has) should refresh the parent lease only while the child's `time_updated` moves.
- Forward a lightweight `tool_call_update` from the parent whenever the child emits a step, even if ACP itself does not. That is an OpenCode change: `acp/event.ts` updates the parent session only. Child events never become parent `session/update`. Until that exists, Harness can poll the child's session row. Do not couple to OpenCode's sqlite path long-term. Prefer the HTTP API the CLI already exposes (`session` status by id), which is what the task tool uses internally.
- If the child has not moved for the ordinary 60-minute active-tool lease, cancel. If it has moved, keep going up to the 4-hour ceiling.
- Stall warning at 5 minutes should say "child session still running" versus "no child activity", not a generic in-progress line.
- Background tasks are a different contract: the tool returns immediately and OpenCode notifies on completion. Those should not hold the parent prompt lease at all. Today a background task that never calls back looks the same as a foreground task that is working. Record `background: true` on the observed call if the raw input has it, and do not apply the delegated lease to those.

Claude Code's task tool has the same parent-silence problem when a subagent runs. The same liveness rule should apply to Claude's `Task` / agent tool and to any ACP tool whose kind is `think` and whose input is a prompt, not only OpenCode's title `task`.

### 6. Stop allowing OpenCode's doom loop under YOLO

OpenCode asks the user at three identical recent tool parts (`processor.ts`). The default agent permission is `doom_loop: ask` (`agent/agent.ts`). Harness's permission block sets `doom_loop: allow` so unattended runs are not stuck on a prompt.

Better policy, stolen from the split OpenCode already made (reads allow, doom loop ask):

- Leave `doom_loop` at `ask` for mutating tools (`bash`, `edit`, `write`). An ask that Harness auto-denies with a tool result of "blocked: identical call repeated" is better than allow. The model then has to change approach. Auto-deny is the unattended equivalent of ask.
- Allow doom loop for read-only tools (`read`, `grep`, `glob`) so a search retry is not punished.
- Keep Harness's own detector as the backstop for providers that have no native brake (Copilot, older Claude, Cursor ACP). Turn auto-interrupt on for `critical` repeat-no-progress when the provider is OpenCode or Claude and the tool is not read-only. The setting can stay off globally and on for those pairs.
- oh-my-opencode-slim exposes doom loop in its config schema. Read that before inventing a third threshold. OpenCode's threshold of 3 identical calls is the one to match so the two layers do not disagree.

The `iaki24ipc` collapse was not a tool doom loop. This item saves a different, common death: the same bash command forever, which YOLO currently permits.

### 7. Claude: max-output escalation and reactive compact

From `Actual Claude/query.ts` and `utils/conversationRecovery.ts`:

- On max output tokens, retry the same request once at a higher cap (8k to 64k) with no meta message, then up to 3 meta continuations: "Output token limit hit. Resume directly. Pick up mid-thought. Break remaining work into smaller pieces."
- Prompt-too-long withholds the error and tries reactive compact once. If that fails, it returns `prompt_too_long` and deliberately does not run stop hooks, because hooks inject tokens and the cycle becomes error, hook, retry, error.
- Streaming persistence stores `stop_reason: null` at content-block stop, before `message_delta`. Recovery therefore does not trust stop reason on disk. It treats a trailing assistant (after dropping unresolved tool uses) as a completed turn, and a trailing user tool-result as an interrupted turn unless it is a terminal tool. Harness's crash continuation should use the same rule when the transcript ends on a tool result with no assistant after it, instead of only on process death.
- Synthetic API-error assistant messages are skipped so a retry-exhausted error is not read as a completed turn. Our classifier should do the same with transport-failure notices.

Harness already compacts some providers. The Claude-specific steal is: one escalate-in-place, then a capped resume, and never run another injector (skill hook, title, summary) on a turn that just died of context.

### 8. Codex: compaction boundaries, thread goals, and stream stall

Codex failures in this repo have been compaction and thread-goal continuation, not content filters.

- A stop must also stop Codex resuming by itself. `provider-auto-continuation.ts` already pauses an active thread goal on interrupt, and leaves it alone on steer. Extend that: a content-filter or length continuation must not stack on top of a thread goal that is about to start its own next turn. One owner of "the next prompt".
- Compaction that splits a turn needs the boundary usage recorded (there is a completed plan for this). A post-compaction canary already tightens the doom-loop threshold. Also re-arm the reasoning-collapse detector on the first assistant message after compaction, because a summary plus "continue" is when MiMo and GPT both dump a long repetitive plan.
- Codex's exec-server retries registry recovery with a delay (`codex-rs/exec-server`). Harness should not add a second retry around a retry. If the Codex CLI returns a retryable recovery error, surface "Codex is retrying" and refresh the lease. Do not send our own continue until Codex has given up.
- oh-my-codex keeps workflow state across `PreCompact` / `PostCompact` so a review loop does not skip or double-fire across the handoff. Any Harness continuation budget must be keyed to the logical user turn, not the provider thread id, or a compaction resets the "2 attempts" counter and we continue forever.

### 9. Copilot: stdout backpressure and silent ACP

The Copilot ACP stdout EAGAIN failure already has a completed plan. The pattern to generalise:

- A full pipe is not an idle model. Refresh the lease on bytes written even when they are not a parseable `session/update`, and surface a distinct notice ("provider output is blocked") instead of the generic stall.
- Copilot's SDK is JSON-RPC to the CLI (`copilot-sdk`). Timeouts belong on the RPC call and on the stream separately. A 60-minute tool lease that resets only on `session/update` will kill a Copilot tool that prints only at the end, the same way it killed OpenCode tasks. Apply the delegated-task rule to Copilot's agent/subagent tools once we know their ACP kind. Until then, any in-progress tool whose title or kind is not `execute` should use the longer lease only if we can see child progress. Blind 4 hours for every unknown tool is how a stuck Copilot shell lives until the afternoon.
- Hermes's provider profiles are the right place for model caps (see the MiMo 400). Copilot model ids that reject `max_tokens` or need `max_completion_tokens` should be a table, not a branch in the adapter. Hermes already special-cases OpenAI families that 400 on `max_tokens` (`utils.py`).

### 10. Stream and process recovery

OpenClaw classifies timeout, 429, 5xx, and context overflow separately, and the retry decision is pure data. Steal the table, not the code.

- Retry in place, no user-visible continue: HTTP 429 with `Retry-After`, 502/503/504, HTTP/2 stream cancel (Cursor already). Cap and backoff. Reset the cap when a `session/update` arrives (agent-orchestrator's cloud client resets `retryAttempt` when an event is received).
- Do not retry: 401, 403, billing, content filter that is about the instruction, context overflow after one compact attempt.
- Context overflow: one reactive compact, then stop with `prompt_too_long`. Do not append a continue that makes the prompt longer. Claude Code is explicit that stop hooks on this path are a death spiral.
- Process exit mid-turn: crash continuation, already built. Add the conversation-recovery rule so a dirty transcript (dangling tool use, trailing user message) is continued even when the process exit was clean and the adapter reported `end_turn`.
- Cursor transport recovery stays Cursor-specific until another provider emits the same HTTP/2 cancel signature.

### 11. Idle hibernation should not hide a bad ending

`iaki24ipc` was idle for ~30 minutes and then hibernated. The work was intact and looked dead.

- If the last complete was classified as anything other than `completed`, do not hibernate on the idle timer. Leave the notice up.
- Hibernation copy should include the last stop reason when it is not a normal end.
- Waking a hibernated session whose last reason was `max_output` or `content_filter` and whose continuation budget is not exhausted should offer the continue, not a blank composer. Do not auto-send on wake. The user may have hibernated on purpose. The budget check stops a wake from becoming a third hidden attempt.

### 12. One continuation owner

Crash, reasoning-collapse, content-filter, async-work, and announce-then-halt are separate listeners. They reimplement the same guards. A new reason means a new file and a new chance to forget "not a managed loop".

Replace the copies with one table:

| Reason | Notice | Prompt | Budget | Who |
|---|---|---|---|---|
| crash | already written | already written | 2 | root orchestrated |
| reasoning-collapse | already written | already written | shared 2 with content-filter | root orchestrated |
| content-filter | already written | already written | shared 2 | root orchestrated |
| max_output (stop reason, no collapse) | new | Claude's resume-directly text | same budget | root orchestrated |
| dangling tool result | new | "The previous tool result never got a reply. Continue from that result." | crash budget | root orchestrated |

Child sessions, managed loops, and paused sessions still get the notice and never the prompt. User input cancels the pending prompt. The request-count fence stays.

Sharing the budget between collapse and filter is correct: they are both "the provider ended the turn early" and a session that hits both in one evening should not get four automatic prompts.

### 13. Model-specific budgets

Hermes keeps a per-model max-token table because a relay default can 400 or can fund a 32k-token reasoning collapse.

- MiMo v2.6 Pro via the Xiaomi token plan: set a reasoning budget that is large enough for real work and small enough that a degenerate loop hits the cap in seconds, not after 100k characters. The `iaki24ipc` trace was ~368k characters of thinking. A cap near the largest healthy trace we have seen, plus the collapse detector as backstop, is the pair.
- Do not apply that cap to Claude or GPT. Claude's failure is the opposite: an 8k output cap cutting a long edit. Escalate up, once.
- Record the budget in the turn metadata so a later death is explainable ("stopped because reasoning budget hit" versus "provider cut the stream").

### 14. Observability that would have made these obvious

The diagnosis needed sqlite, OpenCode's db, lifecycle ndjson, and a thinking-block dump.

- Log one line on every complete: provider, model, stop reason, finish, output tokens, reasoning tokens, active tool kind, lease that was in force, classifier reason. No prompt text.
- When the classifier overrides `end_turn`, log why (collapsed tail hash, content-filter sentence, token ratio). The tail hash is enough. Do not log the thinking.
- Child task: log parent session, child session, last child `time_updated`, and whether the lease refresh came from a parent update or a child poll.
- The 5-minute stall notice should include the tool title and the lease remaining. The screenshot showed the timeout with no earlier explanation that the child was alive.

### 15. What not to do

- Do not raise every tool lease to 4 hours. Execute stays at 60 minutes. Only delegated tasks, and only while the child is moving.
- Do not auto-continue quota, auth, or billing.
- Do not put the blocked source text, or the canned filter sentence, into the continuation prompt.
- Do not add another listener class. Extend the table.
- Do not add lines to `acp-cli-adapter.ts`. It is on the ceiling.
- Do not read OpenCode's sqlite as the long-term liveness API.
- Do not turn doom-loop auto-interrupt on for read-only tools.
- Do not treat a rebuilt-source OpenCode behaviour as live. The app runs the installed 1.18.34 binary until that CLI is upgraded. Detectors have to work for both.

## Suggested order

1. Turn-ending classifier and the one continuation table. Folds in the two detectors that just landed, and gives Codex and Copilot a place to plug in.
2. Child-progress lease refresh, so the 4-hour task ceiling becomes a backstop instead of the timer.
3. Stop sending `doom_loop: allow` for mutating tools. Auto-deny with a tool result the model can read.
4. MiMo reasoning budget, plus collapse detection on single-line runs.
5. Claude max-output escalate-once, and dangling-tool-result recovery on clean process exit.
6. Codex thread-goal versus Harness-continue ownership across compaction.
7. Copilot pipe-backpressure lease refresh, and the same child-liveness rule once its subagent tool shape is known.
8. Upgrade the installed OpenCode CLI so `refusal` is real, and send upstream the `length` to `MessageOutputLengthError` wiring.

Items 1–3 are the ones that would have changed the three sessions: `iaki24ipc` and `iuxohtji2` via the classifier (the detectors already written are the first two rows), `ipbrmlyp0` via child liveness. Item 3 is the next death we have not had yet, and it is a one-line permission change with a sharp edge, so it should land with the auto-deny result text and a test that a repeated bash is blocked and a repeated grep is not.
