# AIO October to-do: spend fewer tokens, make loops finish, calm the screen, tooltips everywhere

**Date:** 10 October 2026 · **Author:** Claude (research pass across every sibling project in `/Users/suas/work/orchestrat0r/`) · **Status:** backlog, not a plan; **approved by James on 10 October 2026** through the review page (overall APPROVED). Every item was approved except A20, which was left unmarked and stays at low priority. All seven decisions were confirmed as answered. · **Version:** v3 (James's decisions applied, 10 October)

**James's brief:** "token wastage reduced in AIO, looping better, the UX cleaner and easier to understand, tooltips everywhere."

**Lifecycle:** this file is deliberately **untracked**. Before building anything, turn sections of it into dated `*_plan.md` files. Rename this file to `claude_oct-todo_completed.md` only when every item is built, verified, or explicitly closed, and never add scope to it after that.

**Plans made from this backlog** (written 10 and 11 October; none started; all untracked):
- Phase 0, confirmed bugs and true numbers: [`docs/plans/2026-10-10-oct-phase0-confirmed-fixes_plan.md`](docs/plans/2026-10-10-oct-phase0-confirmed-fixes_plan.md). Fact-checked by two fresh reviewers.
- Phase 1, the biggest token savings: [`docs/plans/2026-10-10-oct-phase1-token-levers_plan.md`](docs/plans/2026-10-10-oct-phase1-token-levers_plan.md).
- Phase 2, loops that finish and the plan queue: [`docs/plans/2026-10-10-oct-phase2-loops-converge_plan.md`](docs/plans/2026-10-10-oct-phase2-loops-converge_plan.md).
- Phase 3, a calmer, clearer screen: [`docs/plans/2026-10-10-oct-phase3-calm-screen_plan.md`](docs/plans/2026-10-10-oct-phase3-calm-screen_plan.md).
- Phase 4, tooltips everywhere, in three parts that each close on their own:
  - part 1, the tools: [`docs/plans/2026-10-10-oct-phase4-tooltips_plan.md`](docs/plans/2026-10-10-oct-phase4-tooltips_plan.md);
  - part 2, the main screens: [`docs/plans/2026-10-10-oct-phase4b-tooltips-migration_plan.md`](docs/plans/2026-10-10-oct-phase4b-tooltips-migration_plan.md);
  - part 3, the remaining screens, then lint: [`docs/plans/2026-10-10-oct-phase4c-tooltips-finish_plan.md`](docs/plans/2026-10-10-oct-phase4c-tooltips-finish_plan.md).
- Phase 5, later items: [`docs/plans/2026-10-10-oct-phase5-later_plan.md`](docs/plans/2026-10-10-oct-phase5-later_plan.md).
- Housekeeping, alongside the phases: [`docs/plans/2026-10-10-oct-housekeeping_plan.md`](docs/plans/2026-10-10-oct-housekeeping_plan.md).
- Follow-ups (written 11 October, at James's request: "definitely need to retire old docs. We have FAR too many docs" and "add one more doc for that list of other things"): retiring old docs, then every piece the plans above leave to nobody, with a one-line list for the small or conditional ones: [`docs/plans/2026-10-11-oct-followups_plan.md`](docs/plans/2026-10-11-oct-followups_plan.md).

Every item was re-checked against the code before its plan was written, and each plan's "Corrections to the backlog" section lists what changed. On 10 October each plan then had a fresh, independent review, and every must-fix and should-fix finding was either fixed in the plan or rejected with evidence (the review notes are in `_scratch/oct-phases/_review2-*.md`). Phase 4 was split into three parts at the reviewer's suggestion.

---

## In plain English

1. **The biggest token sinks today are helper agents and long conversations that nobody trims.**
   - **Helper agents.** Codex starts its own helper agents, and they used about half of all AIO's Codex input over 1-10 October (7.2 billion tokens across 695 helpers). Your Codex "helper agents off" setting only covers the old kind; Codex now switches the new kind on by default. Claude's built-in helpers (subagents) cost more than the Claude conversations themselves: about 53% of Claude spend over the last month.
   - **Untrimmed conversations.** In ordinary Claude sessions, requests that carry more than 200,000 tokens of history take 78% of the spend. AIO's context safety setting is off by default, and Claude only summarises itself at about 970,000 tokens.
2. **Every Claude session AIO starts also carries roughly 30,000-35,000 tokens of your personal setup.** That is your global instructions file, this project's memory notes, every skill, and the names of about 490 tools, most of them from your personal connectors. Even tiny helper jobs such as reviewers and title-writers carry it. AIO's own part is only about 5,000-6,000 tokens.
3. **Hidden spenders:**
   - An automatic "second opinion" review fires on almost every coding reply. It is on by default, waits only 10 seconds between reviews, and its spend is never recorded: 66 reviews in about four days.
   - Scheduled check jobs spent about $330 of $479 in a month on runs that found nothing to do.
   - Failed automation runs are retried even when a retry cannot help: 48 of 59 retries failed again, and one used about 109 million tokens.
4. **The cost numbers on screen are wrong, so fix them first.**
   - AIO stores Claude's running session total as if it were each turn's cost, so Claude dollar totals are inflated about 9 to 19 times.
   - Copilot tokens are counted about 2.5 times over.
   - Several features never record what they spend.
5. **Loops waste most of what they spend, and they have stopped finishing.** You haven't run a loop since 23 September (the last real loop work was on 6 September). Before that:
   - none of the 44 loop runs since 1 July finished cleanly;
   - 88% of loop tokens, and all $1,366 the providers reported since 12 July, went to runs that did not finish cleanly;
   - runs kept polishing after the work was done, with 124 rounds (28 hours) run against an empty task list;
   - each run's conversation grew until the same work cost about 3.5 times more just before each refresh.
6. **Bugs, all confirmed by tracing the code:**
   - The /goal command cannot start.
   - "Compact now" usually hands the fresh session a one-line placeholder instead of a summary.
   - AIO's own instructions are silently dropped for OpenCode and Copilot sessions; they reached only 13 of 2,951 Copilot sessions.
   - The loop's notes file often never shrinks.
   - Every Claude loop round re-sends the full loop instructions.
   - AIO's built-in guide, which teaches new sessions to use AIO's own tools, reaches only about 2 in 122 new sessions.
   - After you switch model in a Claude session, AIO tells you and the model that the conversation was "preserved". In fact only the last 24 messages were carried over, shortened and without tool results.
7. **The screen shows too much at once.**
   - Context use appears three times on the session screen.
   - About 13 different places say "something needs you".
   - Internal words leak into what you read.
   - "Close all" ends every session without asking.
   - On a denied permission, "Allow" defaults to "always": a lasting rule in your Claude settings, plus a restart. The choice sits in a small dropdown, and the button itself doesn't say so.
8. **Tooltips:**
   - Only 48 of 167 icon-only buttons have both a tooltip and a screen-reader label.
   - 358 old-style browser hover texts remain.
   - 192 controls stay greyed out with no reason given.
   - There is no glossary of AIO's own terms.
   - Keyboard-shortcut hints are typed in by hand, so they are wrong on Windows and after you change a shortcut.
9. **Loops and long jobs can stall overnight.** AIO never keeps your Mac awake while it works, and its logs show eight sleeps in under three days.
10. **Storage.** About 80 GB sits in AIO's data folder, mostly a 29 GB raw event log that only two developer scripts read, and 25 GB of old backups.
11. **What you need to do.** Nothing. You answered the seven choices on 10 October, and the backlog now follows your answers (see "Decisions for James").

---

## How this was produced, and how to trust it

- **Coverage.** Six audits of AIO itself and scouts for all 24 sibling projects. The AIO audits were:
  - loops in practice;
  - screen clutter and wording;
  - tooltip coverage;
  - how prompts are built;
  - AIO's own usage databases;
  - the providers' own transcripts.

  The sibling projects were Actual Claude, claude-code, codex-plugin-cc, codex, opencode, t3code, pi, rtk, hermes-agent, openclaw, agent-orchestrator, jean, CodePilot, CodexDesktop-Rebuild, oh-my-codex, oh-my-opencode-slim, storybloq, tura, claw-code, nanoclaw, mempalace-reference, OB1, copilot-sdk and online-orchestrator.

  Full reports are in `_scratch/oct-audit/*.md` (gitignored, disposable); "Research coverage" below lists them.
- **Freshness.** The siblings were pulled on 10 October and have moved a long way since the July rounds (for example about 34,000 new commits in openclaw and 32,500 in hermes). The scouts mined that new history.
- **Interruption.** The first research wave was cut off when the first account hit its usage limit. Unfinished work was restarted from the partial reports with tighter budgets. Some lower-priority scouts ran on a cheaper model; every code claim behind a top item was re-traced here, and report numbers were checked against the reports.
- **Evidence labels:**
  - **VERIFIED** means the code path was read end to end.
  - **PRESENT-BUT-UNWIRED** means the code exists but has no production caller.
  - **ABSENT** means it was searched for and not found; the source report lists the searches.
  - **UNVERIFIED** means it is a lead only.
  - **[checked by Claude, 10 Oct]** means the author re-traced the claim independently of the scout that found it; "Verification log" at the end lists these.
  - Nothing was executed against the running app.
- **Data.** Usage numbers come from read-only queries of AIO's own databases on this Mac (`~/Library/Application Support/harness/`) and of the providers' transcripts. They are aggregate only: no message content was read out.
- **Lesson from earlier rounds.** The July rounds produced false "AIO lacks X" claims. This round caught three errors of its own before v2: the orchestration-guide claim, an "already done" item that is actually unwired, and some counts. They are recorded in the Verification log.

---

## Already done (do not rebuild)

| Area | What already exists | Where |
|---|---|---|
| Prompt-cache safety | Stable-prefix injection contract with tripwire tests (round 2, WS-B4) | `src/main/context/prompt-injection-contract.ts` |
| MCP tool tax (AIO's own tools) | Runtime tool context capped at 6 tools, description-only, rest behind ranked search | `src/main/mcp/mcp-tool-search.ts`, `mcp-runtime-tool-context.ts` |
| Compaction | Coordinator, compactor, micro-compaction, epochs, manual preview with "keep latest N" (WS-B7) | `src/main/context/compaction-*.ts`, `context-compactor.ts`, `microcompact.ts` |
| Context visibility | Attribution panel, cache analytics, context manifest | `context-attribution-service.ts`, `cache-analytics-service.ts`, `context-manifest-store.ts` |
| September token work | Token-efficiency remediation; fresh-session token cuts. The Claude/Codex cache hit rate is now 97-98.5% (usage audit) | `docs/plans/2026-09-05-token-efficiency-remediation_*`, `2026-09-12-fresh-session-token-cuts_*` |
| Helper models | The 12 auxiliary slots (titles, compaction, classifiers) run local-first. **But** when the Windows PC's local model is down, about a third of compaction calls escalate to a fallback chain that records nothing (see A0); the cost log holds only 40 recorded Anthropic calls since 10 July | `src/main/` aux-LLM routing |
| Loop prompt cuts | Stable prefix + volatile board; goal skipped on proven same-thread (this never fires for Claude loops, see A3); replay only on round 0 or after a recycle | `loop-continuation-prompt.ts`, `loop-iteration-prompt.ts` |
| Loop safety | Per-run state folders, terminal-intent CLI, stuck signals A to I, auto-unstick, idle nudge, announce-then-halt, 50-hour resilience, turn timeout, cwd discipline, failed-attempt charging, verify replay on unchanged workspace | `src/main/orchestration/loop-*.ts` |
| Plan queue | Worker plus a different-provider verifier per document, squash landing, stranded-run rescue | `src/main/plan-queue/*` |
| Tooltip system | One `appTooltip` directive with timing/suppression policy, a copy registry with house rules, a guard spec (UX1) | `src/renderer/app/shared/tooltip/*` |
| Operator UX | Workboard with shared attention scale (WS-C2), run-readiness banner (WS-C3), inline diff comments (WS-C4), keyboard registry and `shortcutHint` pipe (WS-C9), progressive Council (WS-B6), approval digest, notification centre, loop "while you were away" recap, settings tidy-up (2026-08-28), loop wording pass (2026-09-02) | `features/workboard`, `shared/attention/attention-level.ts`, `core/keybindings/*` |

**Built but unused or barely used.** These are quick wins: the code exists, but little or nothing uses it.
- Output persistence (head/tail capping with pointers, 20K/50K/100K). The adapter path `flushOutputBuffer` has no caller (`base-cli-adapter.ts:881`) **[checked by Claude, 10 Oct]**, so it caps nothing a CLI session's model sees. Its one live use is an opt-in loop-output path (`loop-output-externalize.ts:50`).
- `resolveIconButtonAria` (the tooltip/name contract) has no caller. The settings `dependsOn` / `requiresRestart` fields are read by the setting badges, but no setting declares them, so those badges never show.
- `ShortcutHintPipe`: its only consumer is the Settings Keyboard tab.
- `generateActivityStatus(…, thinking)`: its one caller passes only a tool name, never thinking text.
- `setLiveSteeringSupported` in the loop.
- `describePermissionPolicy`: only used by side chats.
- The RTK `getCompliance()` filtered-vs-passed-through figure.
- The per-purpose cost log: no screen reads it.

**Previously rejected, not to be reopened:**
- a fresh session for every loop round by default;
- per-turn micro-compaction of loops (hermes's September results agree);
- a default $30 loop spend cap (removed 2 September at James's request);
- copying RTK's filters into AIO;
- browser automation of logged-in AI tabs;
- any remote telemetry;
- a second policy engine or shadow task ledger.

---

## Headline numbers

| Measure | Value | Source |
|---|---|---|
| Input tokens processed, last 30 days | ~44 billion: Codex 23.5B, Claude 19.6B (19.3B of it cache reads), Copilot ~1.1B after correcting a 2.5x over-count | `aio-tokens-empirical.md` |
| Cache hit rate | Claude 98.5%, Codex 97-98%. The waste is volume, not cache misses | `aio-tokens-empirical.md` |
| Codex input used by Codex's own helper agents (1-10 Oct) | **49%** (7.24B tokens; 695 helper threads; 53 helpers spawning helpers; 633 at "high" effort) | `ref-codex-core.md` CXC-01 (mechanism **[checked by Claude, 10 Oct]**) |
| First turn of a session, average processed tokens (a first reply makes 50-150 model calls) | Claude 8.0M, Codex 21.1M; turns 1-5 carry about 60% of all input | `aio-tokens-empirical.md` AE-5 |
| Claude, last 31 days, at list-price equivalent (subscriptions make this notional; tokens are the real unit) | AIO main sessions about $14.7K; **Claude's own subagents about $16.7K (53%)**. Re-reading cached context is 61-70% of the cost; the first request is only 2.5% | `aio-tokens-transcripts.md` |
| Where Claude main-session spend goes | Requests above 200K tokens of context take **78%** of it, and above 400K take 48%. 34% of sessions passed 200K. There were only 30 compactions, all Claude's own at about 970K | `aio-tokens-transcripts.md` TR-1 |
| First request of an AIO Claude session | About 60K tokens. James's setup is about 20K of instruction files, 8K skills list and 7K of names for about 487 deferred tools; built-in tools are about 10K. **AIO's own share is about 5-6K** | `aio-tokens-transcripts.md` TR-4 |
| Claude turns after more than an hour idle | 188 turns, each re-writing about 380K cached tokens: 25% of all Claude cache writes | `aio-tokens-empirical.md` AE-4 |
| AIO's recorded Claude Opus cost, 30 days | **$409,452 recorded vs about $21,333** once Claude's running totals are turned back into per-turn amounts. Pricing AIO's *stored* tokens gives only about $5.2K, because they miss subagent spend | `aio-tokens-empirical.md` AE-1, AE-6 (storage path **[checked by Claude, 10 Oct]**) |
| "Second opinion" reviews | On by default; 66 reviews (about 132 reviewer sessions) over 6-10 Oct, 41 of them using Copilot premium requests; spend never recorded | `aio-tokens-static.md` AT-2 (trigger **[checked by Claude, 10 Oct]**) |
| Scheduled monitoring jobs, 30 days | $478.79, of which at least $330.42 (241 of 279 runs) found nothing to do | `ref-openclaw-runtime.md` OCR-04 |
| All automations, 30 days | 573 runs, 3.05B tokens (about 7% of all); two one-time Codex jobs burned about 400M tokens with no successful run | `aio-tokens-empirical.md` AE-7 |
| Helper calls handed to the fallback chain with nothing recorded | 5,456 (compaction and titles, mostly while the Windows PC's local model was unhealthy). Where they ran and what they cost is unknown; with no API keys configured, many may have ended as a free basic summary | `aio-tokens-empirical.md` AE-8a |
| Loop runs / rounds since 8 May | 141 runs, 2,874 rounds; the last loop round ran on 22 September (the plan queue replaced loops) | `aio-loop.md` |
| Clean loop finishes since 1 July | **0 of 44** (May 14/32, June 8/65) | **[re-queried by Claude, 10 Oct]** |
| Loop tokens on runs that did not finish cleanly | **88%** (clean finishes 11.6%) | **[re-queried by Claude, 10 Oct]** |
| Provider-reported loop spend since 12 July | $1,366.16, of which $0 went to clean finishes ($964 "completed - needs review", $266 capped, $102 no progress, $34 cancelled or stranded) | **[re-queried by Claude, 10 Oct]** |
| Rounds run after the task list was already empty | 124 rounds, 28 hours, across 12 runs | `aio-loop.md` Q20 |
| Average Claude Sonnet loop round | $6.87, 14.7M cache-read tokens, 9.8 min | `aio-loop.md` Q6 |
| Cache re-read growth inside one long run | 2.9M → 27M tokens per round before refresh; same work about 3.5x dearer at the end | `aio-loop.md` Q7 |
| Claude loop rounds cut off by the 30-step cap | 61% | `aio-loop.md` Q8 |
| Loop runs whose tests were already failing or too slow before round 1 | 17 of 18 checked | `aio-loop.md` Q10 |
| "Needs you" loop questions ever answered | 2 of 303 (293 still open) | **[re-queried by Claude, 10 Oct]** |
| Plan-queue items that land, of genuine attempts | about 32% (36 of 111) | `aio-loop.md` |
| Personal setup in every AIO-started Claude session | **About 30-35K tokens** in the measured first request: instruction files about 20K (global `CLAUDE.md` about 8.2K, memory index about 6K), skills list about 8K, tool names about 7K. An earlier character-count estimate gave 19-21K. File sizes **[checked by Claude, 10 Oct]**: `~/.claude/CLAUDE.md` 25,218 B; repo `AGENTS.md` 10,505 B plus conventions 2,085 B; this repo's auto-memory index 18,710 B (179 notes); 5 enabled plugins (of 11 installed). Also 15 skills, 13 agents, and 9 personal MCP servers plus claude.ai connectors | `aio-tokens-transcripts.md` TR-4; `aio-tokens-static.md` AT-1 |
| AIO's orchestration guide | 14,157 bytes (about 3.5K tokens), but it reaches only about **2 of 122** new sessions, because the usual start path skips it | **[checked by Claude, 10 Oct]**; `ref-omx-slim.md` OMX-1 |
| RTK (command-output shrinker) | In RTK's own test, input fell 2-4% but the bill didn't fall (−0.2%); an outside study found it 7.6% dearer at low effort and no different at high effort. 88% of Codex shell commands bypass it; the Savings tab overstates by about 1,000x; the bundled copy is 0.39.0, the copy in use is James's Homebrew 0.42.4, and the current release is 0.51 | `ref-rtk.md`; `ref-storybloq-tura.md` |
| Icon-only buttons with both tooltip and name | 48 of 167 (29%) | `aio-tooltips.md` |
| Old-style `title` hovers remaining | 358 in 119 files | `aio-tooltips.md` |
| Greyed-out controls that never say why | 493 of 578 can be greyed out without a reason; 192 of those are lasting states (the rest are brief "busy" states) | `aio-tooltips.md` |
| Storage under the app's data folder | About 80 GB: conversation ledger 28.9 GB, RLM backups 25 GB, session states 4.2 GB | `aio-tokens-empirical.md` AE-9 |

---

## If you only read one list: top 15

| # | Item | Goal | Size | Why first |
|---|---|---|---|---|
| 1 | **A0** Fix the spend numbers before judging any saving | Tokens | S-M | Claude totals are inflated about 9-19x; several spenders are unrecorded |
| 2 | **B1** Loop quick-fix bundle ("/goal" start, notes trimming, iteration log, checkpoints) | Looping | S each | Confirmed bugs; cheap |
| 3 | **A1** Make "Compact now" actually write a summary | Tokens | S | Confirmed bug; every non-Codex provider |
| 4 | **A2** Deliver AIO's instructions to OpenCode/ACP sessions; stop duplicating them for Codex | Tokens / correctness | S | Confirmed bug |
| 5 | **A16 + A18** Rein in helper agents: Codex's (about half of Codex input) and Claude's own subagents (53% of Claude spend) | Tokens | S-M | About half of each main provider's volume; for Claude, context growth (#11) is a lever of similar size |
| 6 | **A14** "Second opinion" reviews only on real changes, and recorded | Tokens | S-M | Fires on almost every coding reply today |
| 7 | **A15** Scheduled jobs check before they wake a model | Tokens | M | About $330 a month on "nothing to do" runs |
| 8 | **A5** Machine-started sessions: read-only reviewers, cache-stable resumes, no security-plugin review (your setup stays) | Tokens / safety | S | Every resume after an edit currently re-writes the whole cache |
| 9 | **B2** A "finish phase" when the task list is closed | Looping | M | 28 hours of polishing after done |
| 10 | **B3** Verification that knows what was already broken | Looping | M-L | 17 of 18 runs started red |
| 11 | **A4 + A3** A context ceiling for long Claude sessions and loops; no repeated loop instructions | Tokens | S-M | Requests above 200K carry 78% of Claude main-session spend |
| 12 | **C1 + C3a** "Close all" asks first; "Allow" says its scope | UX / safety | XS-S | Both confirmed |
| 13 | **C2 + C4** One of everything on screen; one "Needs you" place | UX | M-L | About 20 items above the first message; 13 attention signals |
| 14 | **D1-D4** Tooltip foundation: fix, measure, ratchet, building blocks | Tooltips | S-M | Makes "tooltips everywhere" enforceable |
| 15 | **A19, then A13** Cap tool output (Claude's Bash cap, AIO's own tools), then RTK after a side-by-side trial | Tokens | S | Bash output is about 69% of tool-result text |

---

## A. Spend fewer tokens

### A0. Fix the spend numbers before judging any saving · P0 · S-M
- **What's wrong.**
  1. **Claude dollars are inflated.** The adapter takes `total_cost_usd` from each turn's result message and stores it as that turn's cost (`src/main/cli/adapters/claude-cli-adapter.ts:961-962`, `:991-992`) **[checked by Claude, 10 Oct]**. Claude Code reports this figure as a *running session* total. AIO's own code says so ("result has the session cost", `claude-result-usage.ts:74-75`), and since CLI 2.1.277 a headless resume carries the session's totals forward rather than starting at zero (`claude-code/CHANGELOG.md:1686`) **[both checked by Claude, 10 Oct]**. Every turn of a long-lived or resumed session is therefore booked at the session total so far.
     - The usage audit found Opus recorded at $409,452 over 30 days, against about $21,333 once those running totals are turned back into per-turn amounts.
     - Every in-app cost total inherits this, and a loop on a resumed Claude session could stop early on its cost cap.
  2. **Copilot tokens are about 2.5x too high.** The ACP prompt result is a running total with cached tokens inside "input", and it is stored as-is (`acp-usage-estimator.ts:79-89`). Copilot is also deliberately left unpriced, although the exact bill (111,887 AI credits across AIO's saved sessions) sits unread in the session files (CPS-5).
  3. **Spend that is never recorded.**
     - Cross-model review, consensus, multi-verify, Council, magic prompts and the fresh-eyes reviewer all start CLI sessions directly, outside the recorded paths (AT-11). The fresh-eyes reviewer drops `response.usage` (`review-execution-host.ts:147-208`) **[checked by Claude, 10 Oct]**.
     - 5,456 helper calls (compaction, titles) were handed to the fallback chain with no provider, model or cost recorded, mostly while the Windows PC's local model was unhealthy. Nothing records where they ran: with no API keys configured, many may have ended as a free basic summary. The $2/day helper cap cannot see them either way (AE-8a).
     - Pricing AIO's stored Claude tokens gives only about $5.2K for Opus in the same 30 days, 2-4x below Claude's own (de-duplicated) cost. That suggests subagent and side-model calls are missing from the stored tokens (AE-6, inferred).
     - **Claude already reports each subagent's final context size, tool count and run time, and AIO drops them** (`claude-cli-async-work.ts:307-314`; `ref-jean.md` JN-1; jean shows them on each subagent row). Record them for visibility and for A18's trial. They are **not** a spend figure: the token number is the size of the subagent's last request, not what it processed. Subagent spend still comes from the per-turn deltas above.
     - Background helper calls can keep failing over: a failed local model is only deprioritised for 10 minutes, and when no local endpoint is healthy every call escalates again with no back-off. Add back-off, a visible "paused until…" state, and an "unknown cost" footnote on the Costs page wherever a call's cost wasn't recorded (CP-2).
- **Fix.**
  - Record per-turn *deltas* (the difference between successive session totals).
  - Normalise Copilot usage.
  - Route every AIO-started CLI call through one usage recorder with a `purpose`.
  - Record the fallback provider, model and cost, and alert when the local helper model is down.
  - Add `--max-budget-usd` as a per-call backstop for helper calls.
  - Show spend by purpose and by provider, with cache read / cache write / uncached separated. The per-purpose cost log already exists; no screen reads it.
- **Done when:** a day's Claude total in AIO matches the same day's spend priced from Claude's own transcripts (subagents included) within a few per cent; AIO's token view includes subagent usage; and every AIO-started model call shows up under a purpose.
- **Sources:** `aio-tokens-empirical.md` AE-1, AE-2, AE-6, AE-8a; `aio-tokens-static.md` AT-11; `ref-claude-code.md` CC-9.

### A1. Make "Compact now" actually write a summary · P0 · S · **[checked by Claude, 10 Oct]**
- **What's wrong.**
  - For every provider except Codex, manual compaction (the "Compact now" button, the preview's Confirm, and `/compact`) goes through `restartCompact` (`src/main/app/compaction-runtime.ts:352-407`). That clears the shared `ContextCompactor`, re-adds only user/assistant text, and calls `compact()`.
  - `compact()` returns early with no summary unless the fill ratio reaches 0.85 of `maxContextTokens`, which is 200,000 by default (`context-compactor.ts:118-126`, `:252-254`, `:384-397`; `src/shared/constants/limits.ts:20`). Nothing in production reconfigures it: `updateConfig` has no caller.
  - So a summary is written only when the visible text is about 170K estimated tokens. Otherwise the fresh session is seeded with the literal `Previous conversation context was compacted.` (`compaction-runtime.ts:405-407`). The tests force small limits, so they never notice.
- **Fix.**
  1. Bypass the fill gate when compaction is explicitly requested, and add a test that a normal-sized transcript produces model-written summary text.
  2. Replace "last 8 messages cut to 400 characters" with a token-budgeted verbatim tail. opencode keeps 25% of the usable window, clamped to 2K-15K tokens (`opencode/packages/opencode/src/session/compaction.ts:32-33,115-120`).
  3. Rebuild the summary prompt so the transcript comes first and the instructions last, with explicit carry-forward and conflict rules and every section kept with "(none)". opencode did this on 12 August for small models (`opencode/packages/core/src/session/compaction.ts:16-55,160-174`), and AIO's summaries run on small local models first.
  4. Add two sections that don't depend on the summary model: an index of exact identifiers pulled out by pattern (commit hashes, paths, error strings, issue numbers), and every real user message word for word. On hermes's own tests, recall went from 43% to 79% at the same retained size (`ref-hermes-runtime.md` HR-1).
  5. End with a pointer to the full pre-compaction transcript, as Claude Code does (`Actual Claude/services/compact/prompt.ts:337-374`). The same "read another session" tool can serve it (A11).
  6. The compression helper accepts at most 96K tokens (`settings-defaults.ts:431`). Above that it silently keeps at most the first 20% and last 40%, scaled down to fit, with a bare `[...truncated...]` marker (`auxiliary-llm-utils.ts:196-216`). Chunk-summarise instead, and say what was dropped.
  7. **Don't make it re-run the last job.** The continuity package uses the last user message as the "Objective" and says "Continue from this state" (`compaction-runtime.ts:409-475`). Use hermes's rule instead: if there is no new request after the summary, wait.
  8. **Test Claude's own `/compact`.** Claude Code's source and changelog say `/compact`, `/context` and `/cost` are handled as local commands in this headless mode rather than sent to the model as a prompt (compaction still makes its own summary call). AIO assumes they don't work. One live test settles it; if it works, use it for Claude instead of restart-with-summary (CC-4).
  9. Give the compaction divider plain words ("Started a fresh session from a summary. New size shows after the next reply."), with a tooltip saying what was kept. Today it reads `Context compacted [restart-with-summary] (82% → 82%)`.
- **Also check.** The overflow-recovery "compaction" for Gemini, Copilot, Cursor, Antigravity and local models trims AIO's own buffers, not the provider's session (`instance-manager.ts:375-391`). Route it through the fixed path. (UNVERIFIED in practice; OCC-N-05.)
- **Sources:** `ref-opencode-core.md` OCC-T1-01, T1-04, T3-01, T4-01; `ref-hermes-runtime.md` HR-1, HR-2; `ref-actual-claude.md` AC5; `ref-claude-code.md` CC-4.

### A2. Deliver AIO's instructions to OpenCode/ACP sessions, and stop duplicating them for Codex · P0 · S · **[checked by Claude, 10 Oct]**
- **What's wrong.**
  - The ACP adapter sends AIO's system prompt **only if it is 4,000 characters or less**. Otherwise it sends nothing, marks it "sent", and logs nothing (`acp-cli-adapter.ts:362`, `:2194-2203`).
  - AIO has no OpenCode rule in `nativeOwnedInstructionPaths` (`native-instruction-ownership.ts:103-123`), so it prepends the whole instruction stack, starting with James's 25 KB global file. That guarantees the drop.
  - Root OpenCode sessions, and most likely Copilot root sessions, therefore get none of AIO's agent-mode prompt, memory brief, lessons or permission notes.
  - **Measured for Copilot:** AIO's system prompt reached only **13 of 2,951** Copilot sessions. Meanwhile the repo's `AGENTS.md` was loaded **twice** in all 684 sessions run inside this repo (CPS-3, from AIO's saved Copilot session logs).
  - Separately, Codex receives all 25K characters of the global file, of which 13.7K duplicates its own `~/.codex/AGENTS.md`. That wastes about 3.4K tokens per fresh Codex session (AT-6).
- **Fix.**
  - Add an `opencode` ownership rule that mirrors OpenCode's own loader (`opencode/packages/opencode/src/session/instruction.ts:59-68`).
  - Replace the all-or-nothing drop with the existing budgeted composer (`budgeted-system-prompt.ts`), sized for ACP.
  - Log any cut, name the sections that were dropped (hermes HR-6), and record it in the context manifest.
  - Remove line-level duplicates between the global file and Codex's own `AGENTS.md`.
  - **Careful with Copilot:** applying the budgeted composer naively would load `AGENTS.md` a *third* time. Prefer delivering AIO's instructions as native instruction files, through the CLI's custom-instructions directory setting (unconfirmed over ACP; the Copilot report ends with a one-session probe plan), and add a Copilot ownership rule (CPS-3).
- **Done when:** a root OpenCode session's first prompt carries AIO's governing instructions, and the manifest shows anything omitted.
- **Sources:** `ref-opencode-core.md` OCC-T1-07; `aio-tokens-static.md` AT-6; `ref-hermes-runtime.md` HR-6; `ref-copilot-sdk-plans.md` CPS-3.

### A3. Stop re-sending the full loop instructions every round · P0 · S-M · **[checked by Claude, 10 Oct]**
- **What's wrong.** The loop sends a short continuation card only on a "proven same-thread" (`loop-goal-reanchor.ts:16-33`). For Claude, that proof needs a *resident* adapter (`claude-cli-adapter.ts:316-341`), but the loop's persistent adapter is created without `residentClaude` (`default-loop-invoker-helpers.ts:31-69`). So every isolated Claude loop round re-sends the 7-12.5 KB re-anchor prompt into a session that already holds it, and each copy is re-read on every later step.
- **Fix.**
  - Treat "resumed the same session with the same model" as same-thread, or make the loop adapter resident.
  - Re-anchor fully only when the provider actually summarised its history. Claude's stream reports this as a `compact_boundary` event, which AIO's parser currently drops (`claude-cli-adapter.ts:1600-1636`; `ref-omx-slim.md` OMX-3).
  - Otherwise send a one-line "sparse anchor" (goal, stage, "done when"), as Claude Code does for plan mode (`Actual Claude/utils/attachments.ts:254-267,1196-1240`). Keep a long fixed cadence only as a backstop.
- **Sources:** `aio-loop.md` LP-4; `ref-actual-claude.md` AC9; `ref-omx-slim.md` OMX-3.

### A4. A context ceiling for long Claude sessions, loops, automations and helpers · P0 · S-M
- **What's wrong.**
  - **This is not only a loop problem.** In ordinary Claude sessions, requests above 200K tokens of context take 78% of main-session spend, and above 400K take 48% (31 days of transcripts). There were only 30 compactions in that time, all Claude's own at about 970K.
  - AIO's context-safety mode defaults to off for every provider (`src/shared/types/settings-defaults.ts:21-29`), and its warnings start at 75% of a 1M window. The transcript audit estimates that holding requests over 400K to about 250K would have saved about $3.2K a month at list price, with a tighter policy saving $5.6K on main sessions plus about $3.5K on subagents.
  - Same-session loops recycle only when *known* occupancy reaches 85% of the window (`loop-context-discipline.ts:79-220`). On 1M-window models that is about 850K tokens re-read on every API call.
  - Measured: cache reads per round climb from 2.9M to 27M, and the same work costs about 3.5x more at the end of a run.
  - Claude and OpenCode both compact themselves only near 1M (Claude at about 970K).
  - Returning to a big session after more than an hour re-writes the whole conversation to cache. The usage databases count 188 such turns, each re-writing about 380K tokens, a quarter of all Claude cache writes (AE-4). The transcripts, over a slightly different window, count 244 such returns averaging about 395K tokens each (TR-3). Both measure the same effect.
- **Fix.**
  - Add a **per-model absolute ceiling** next to the 85% rule. pi's documented example compacts a 1M-window model above 600K (`pi/packages/coding-agent/docs/compaction.md:439-463`); 200-400K suits loop children, helpers and plan-queue workers.
  - **Choose the number by replaying logged usage, not by weeks of shadow mode.** hermes replayed a real run at a 200K cap and estimated about a 49% cut before shipping (HR-3). AIO already has the per-call data in the providers' transcripts.
  - **Pass each provider's own lever:**
    - Claude: the environment variable `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. It is present in CLI 2.1.296; a `--settings` key is unconfirmed. Clear any inherited value; use `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` for runs meant to stay at 200K.
    - OpenCode: `limit.context` in `OPENCODE_CONFIG_CONTENT`. AIO already writes it, but defaults it to 1,000,000 when no limit is known (`opencode-generation-budget.ts:69-74`).
    - Codex: see A16.4.
    - Copilot: it already compacts itself at about 160K tokens (69 times in the logs), apparently tunable by environment variable, and `/compact` may be sendable natively. Sessions of 50+ turns (64 of them) used 55.7% of Copilot's AI credits, at about 2.5x the cost per turn. Copilot also reports its real context fill-up, but AIO's Copilot profile is fixed to "spend only" and throws it away, which blinds the context ring, the warnings and the memory-injection scaler (CPS-1, CPS-2; both unconfirmed over ACP).
  - **Price the cold-cache case.** A resume after the cache expired re-bills the whole prompt at the write price: 1.25x for the 5-minute cache, 2x for the 1-hour cache, against 0.1x for a cache read. So recycle when the idle gap exceeds the cache lifetime and the context is large (pi `cache-warmer.ts:15-32,378-400`). Make the loop's stale-cache tier act; today it is a logged no-op (`loop-context-survival.ts:296-335`).
  - Say it on screen: "Claude will summarise in about 40K tokens", instead of hiding context warnings for self-compacting Claude sessions (`context-warning-level.ts`).
- **Sources:** `aio-loop.md` LP-3; `ref-actual-claude.md` AC6, AC12; `ref-pi.md` PI-1, PI-2; `ref-hermes-runtime.md` HR-3; `ref-openclaw-runtime.md` OCR-02; `ref-claude-code.md` CC-3; `ref-opencode-core.md` OCC-T1-05; `ref-t3code.md` T3-01; `aio-tokens-empirical.md` AE-4; `aio-tokens-transcripts.md` TR-1.

### A5. Machine-started Claude sessions: read-only reviewers, cache-stable resumes (James's setup stays) · P1 · S · Decision 2: keep the setup
- **What's wrong.** Loop rounds, reviewers, fresh-eyes checks, consensus, title fallbacks and magic prompts all spawn ordinary Claude sessions with James's full personal setup. That is about 30-35K tokens in the measured first request (an earlier character-count estimate gave 19-21K):
  - the global `CLAUDE.md`;
  - this repo's 18.7 KB auto-memory index;
  - 15 skills, 13 agents and 5 enabled plugins;
  - 9 personal MCP servers plus claude.ai connectors (about 490 deferred tool names in all). In the research session, two servers failed to connect (codex-cli, fal-ai) and one needed sign-in (webflow). chrome-devtools also loads into every session, though James's rules bar using it on the Mac without asking.

  More detail:
  - James's settings set `ENABLE_TOOL_SEARCH=auto:0` **[checked by Claude, 10 Oct]**. That matches Claude Code's default (always defer tool schemas), so the schemas stay deferred either way, but each deferred tool's *name* is still listed in every request.
  - Loop rounds start a fresh process each time, so up to 9 servers spin up per round.
  - Reviewers also inherit `--permission-mode acceptEdits` and write-capable tools.
  - James's security-guidance plugin is set to run an Opus security review when a session stops with code changes: 30 of 74 stops in about 12 hours inside AIO's sessions. At 2.1 seconds each they may not be full reviews, so the cost is unknown (AT-4; Decision 4: James approved turning it off for machine-started sessions).
- **Fix**, narrowed by Decision 2: James keeps his full setup in machine-started sessions.
  - Reviewers and verifiers get read-only built-in tools (`--tools "Read,Grep,Glob"`) and a turn cap, instead of inheriting `--permission-mode acceptEdits` and write-capable tools. This is a safety fix, not a setup change.
  - One-shots (titles, consensus, magic prompts) add `--no-session-persistence` and a per-purpose `--max-budget-usd` backstop.
  - Keep per-run details in the user message, so repeated helpers share a cached prefix.
  - Turn James's security-guidance plugin off for machine-started sessions only (Decision 4).
  - Optionally block the two built-in tools nobody uses (`Workflow`, used 0 times; `ReportFindings`, used 6 times) in machine sessions.
  - **Not doing** (declined in Decision 2): stripping connectors (`--strict-mcp-config`, `ENABLE_CLAUDEAI_MCP_SERVERS=false`), skills, auto-memory, plugins or the global `CLAUDE.md` from machine-started sessions, and the Copilot equivalent. Revisit only if James asks.
  - Interactive chats can still get the small per-session menu to switch skills, MCP servers and web search off **for this session only**, marked "session" with an "N changes, reset" row (openclaw, OCX-3). It is user-controlled and changes no default. Check whether Claude's live MCP toggle is saved globally before relying on it.
- **Also for every resumed Claude session:** set `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1`. Claude rebuilds a git-status snapshot ahead of the conversation when a process resumes, so any edit or commit breaks the whole cache. openclaw added this switch on 6 September with a test requiring at least 90% of the conversation to come from cache after an edit and resume (`openclaw/extensions/anthropic/cli-backend.ts:272-276`; OCR-01). AIO resumes often (30-minute hibernation, respawns, restarts).
- **Two smaller items:**
  - Move memory blocks that change with the first prompt out of Claude's system prompt into the first user message, as Codex already does, so sessions started close together can share a cached prefix (AT-8, medium confidence).
  - Prune the 18.7 KB auto-memory index to one-line pointers (AT-5), only if James wants; it is his and his agents' memory.
  - Separately, James could run Claude's `/doctor prompt-audit` and `/skill-doctor` once (CC-19).
- **Done when:** no reviewer can edit files; a resumed Claude session after an edit or commit still reads at least 90% of its conversation from cache (openclaw's test); and machine-started sessions run no security-plugin reviews.
- **Measured** (31 days of transcripts):
  - The first request of an AIO Claude session is about 60K tokens. Of that:
    - about 20K is instruction files (the global `CLAUDE.md` about 8.2K, the auto-memory index about 6K);
    - about 8K is the skills list;
    - about 7K is the names of about 487 deferred tools (Comtech/EBRD Jira and Confluence 198, claude.ai connectors about 150);
    - built-in tool schemas are about 10K.

    AIO's own share is only about 5-6K.
  - Even sessions started minutes apart reused only about 12K of it from cache.
  - Two tools nobody uses (`Workflow`, used 0 times; `ReportFindings`, used 6 times) are re-read on every request; block them for machine sessions.
  - Loading the Jira/Confluence servers only in workspaces that need them would save more, but it is part of James's setup (Decision 2), so it is not planned.
- **Sources:** `aio-tokens-static.md` AT-1, AT-4, AT-5, AT-8; `aio-tokens-transcripts.md` TR-4; `ref-claude-code.md` CC-1, CC-2, CC-19; `ref-actual-claude.md` AC1; `ref-openclaw-runtime.md` OCR-01, OCR-03.

### A6. Use OpenCode's own levers, which AIO already has a channel for · P1 · S each
1. Turn off OpenCode's hidden title call. It sends the whole first prompt to a model, and AIO then throws the result away. Set `agent.title.disable`.
2. Turn on tool-output pruning (`compaction.prune`, off by default; keeps the newest 40K tokens of tool output).
3. Set `agent.<name>.steps` from the loop's turn cap. Today only Claude gets `--max-turns`.
4. Give the adapter a native `compactContext()` (`/compact` between turns) instead of killing the session.
5. Read OpenCode's `session.status` retry frames and `session.compacted` events off the SSE stream AIO already opens. Today retry storms look like stalls.
6. Check whether OpenCode's 5-minute stream timeouts silently retry long MiMo turns (UNVERIFIED).
7. Optionally, a cheaper model for OpenCode's read-only `explore` subagent.

- **Where:** `opencode-adapter-factory.ts` (config overlay), `opencode-child-progress-source.ts:166-243`, `acp-cli-adapter.ts`.
- **Source:** `ref-opencode-core.md` OCC-T1-02, T1-03, T1-06, T2-01, T2-04, T2-05.

### A7. Exact context accounting for Claude, plus a "context doctor" with actions · P1 · M
- **What's wrong.** AIO's attribution panel can't see Claude's own system prompt and tools, so it shows them as "other" (`context-attribution-service.ts:1-15`), and it gives no advice. The cache-break detector knows only three causes: no idle/TTL cause, no baseline reset after compaction, and no dollar figure (`cache-analytics-service.ts`).
- **Fix.**
  - Call Claude's `get_context_usage` control request on demand. It returns categories, per-tool call/result tokens, memory files, MCP tools loaded vs deferred, and the auto-compact threshold.
  - Add `context-advice.ts` with Claude's own thresholds (tool results at least 15% and at least 10K; memory files at least 5%; MCP tools above 25K) plus AIO's levers ("this session loads 9 personal connectors", "global CLAUDE.md is 25 KB").
  - Price each cache miss as pi does: `missed = min(previous prompt, this prompt) − cache read`, ignoring misses of 1,024 tokens or fewer (`pi/packages/coding-agent/src/core/cache-stats.ts:8-80`). Name the cause: "idle 9 min", "after compaction", "model switch", "provider-side, nothing to fix".
  - Add a per-session "cache waste" total. Copilot reports its own cache lifetime (300 s for Claude models, 1,800 s for GPT models), which gives the right idle threshold for each (CPS-8).
- **Sources:** `ref-actual-claude.md` AC3, AC15; `ref-pi.md` PI-4.

### A8. Use the live Claude session for side jobs instead of new sessions · P1 · S-M
1. **"Quick ask" without interrupting:** the `side_question` control request runs one tool-less turn from the cached prefix and is not written to the transcript. Today a side chat pays a full cold start plus up to 12K uncached tokens of parent snapshot (`src/main/chats/side-chat-context.ts:8`).
2. **Titles:** try `generate_session_title` (one Haiku call) before spawning a fresh CLI. In 31 days, 119 title fallbacks each sent about 35.8K tokens to make a title of 80 characters or fewer; 99.3% of that was fixed overhead (`auto-title-service.ts:78,400-427`; TR-6). Alternatively, drop the escalation and keep the instant title.
3. **Model or effort switch without a restart:** `set_model` / `apply_flag_settings`, checked with `get_settings`. Today every Claude model change forces a "replay" that loses tool results and file contents (`runtime-reconciler-plan.ts:107-119`). The replay keeps only the last 24 turns, each cut to 800 characters (4,000 for the newest), with no tool results (`replay-continuity.ts:3-10,82-97`). Yet both James and the model are told "Conversation context has been preserved." (`runtime-change-notices.ts:79`) **[checked by Claude, 10 Oct]**. Until the live switch exists:
   - make the notice truthful;
   - say in the picker, before the click, what will carry over;
   - also say what changes in price and context size (CP-1, HU-1).

- AIO currently sends only `interrupt` as a control request. `sendEndSession` sends a message shape the CLI ignores and has no caller (`claude-cli-adapter.ts:409-421`).
- **Sources:** `ref-actual-claude.md` AC2, AC4, AC7, AC16; `ref-codepilot-codexdesktop.md` CP-1.

### A9. Cheaper defaults at the composer · P1 · S each
1. **Big pastes become a file attachment.** At 32 KiB or more, measured in bytes, the paste becomes `pasted-text.txt`; Cmd+Shift+V pastes inline anyway (`t3code/packages/client-runtime/src/textPaste.ts:1-52`). Carry over the conditions round 2 attached when it deferred this: a screen-reader label for the chip, and a secret scan before the file is written.
2. **Refuse duplicate attachments.** Today `addPendingFiles` just appends, so the same screenshot can ride on every turn (OCU-2).
3. **Offer "Compact first"** when returning to a big Claude thread whose cache has gone cold (100K+ tokens, idle 70+ minutes), as a chip beside Send with a one-click "send with full history" escape (T3-01). In 31 days, 244 such returns each re-wrote about 395K tokens: about a third of all mid-session cache writes, from about 0.35% of requests (TR-3).
4. **Show cost tier, price and context window in the model picker.** The catalogue has them, and Copilot's model list sends more such facts, but the picker row drops them all (OCU-1, CPS-10). Also warn that switching model or effort mid-session re-sends the whole conversation at full price (CC-14).

### A10. Show James what a session is costing, where he works · P1 · S
- **Quick fix:** the session header mounts the context bar with `[showCost]="false"` hard-coded (`instance-header.component.html:283`) **[checked by Claude, 10 Oct]**, so per-session cost never shows there. Let the setting decide; it came in a bulk commit with no recorded reason. Do this after A0, or it will show inflated numbers.
- **Quota warning beside the composer, before the wall.** Main already emits 50/75/90% `quota-warning` events, but only the Settings tab shows them. Codex shows "5h limit: 23% left · resets 14:05" in the composer hint row (CXU-1).
- **A one-screen "session status" card** (a `/status` command and a header popover):
  - model and effort;
  - permissions in words;
  - account;
  - context;
  - quota;
  - this session's spend by model;
  - a "cache warm, cools in N min" line (CC-14).

  Name sessions on the Costs page instead of showing truncated ids (CXU-9, CXU-15).
- **For subscription (plan-billed) sessions, lead with plan usage, not dollars.** openclaw's context-ring popover shows the 5-hour and weekly plan usage with reset times, and hides dollar figures for plan-billed sessions. James's Claude and Codex use is on subscriptions, so a dollar figure there is notional; plan headroom is what actually limits him. Confirm the plan type per account (OCX-4).

### A11. Read another session by pointer, not by pasting it · P2 · M
- Add an AIO MCP tool `read_session(sessionId, view, after, limit)`: messages-only by default, paged, with a truncation flag. Pair it with an `@session` composer chip. The same tool lets a compacted session read its own pre-compaction history (A1.5).
- **Sources:** `ref-t3code.md` T3-06; `ref-hermes-runtime.md` HR-1.

### A12. Make AIO's orchestration guidance short, consistent and actually delivered · P1 · S-M · **[checked by Claude, 10 Oct]**
- **What's wrong.**
  - The full "You Are an Orchestrator" guide is 14,157 bytes, about 3.5K tokens (`orchestration-protocol.prompts.ts:66-256`). It is added only in `InstanceManager.sendInput`, on the first message of a session that started *empty* (`instance-manager.ts:1809-1816`).
  - The usual path, typing into a new session, sends the first message through `instance-lifecycle.ts:1009-1060` with only the indexed-context block (`instance-system-prompt.ts`), so it **never gets the guide**. A log sample found 120 of 122 new top-level sessions started that way, so the guide reached about 2 of 122. Its "use `create_automation`, never the host `/schedule`" steering almost never lands.
  - Meanwhile two short reminders, scheduling (about 900 characters) and consensus (about 1.1K), are re-added on *every* message whose raw text matches, including pasted logs and words like "tomorrow" (`orchestration-handler.ts:334-344`). Nothing is logged when they fire.
- **Fix.**
  - Put a short pointer of a few lines on **every** entry path.
  - Add the full Automations, Consensus or Code-Navigation sections only when intent matches, once per provider session, then a one-line marker. oh-my-opencode-slim cut its equivalent block from 861 to 565 characters, at most once per conversation.
  - Strip code before matching, and log when reminders fire.
  - Add a block only when the model can actually use it and something will show its result. For example, no automation section in sessions where the automation tools are hidden (openclaw, OCX-6).
  - Keep a fixed set of example prompts as a test, plus a with/without comparison (pi's "documentation lift" eval).
  - Bundle a small `docs/llm/harness-help/` set the agent reads on demand. The same pages feed the tooltips' "Learn more" (D6).
- **Sources:** `ref-omx-slim.md` OMX-1; `ref-pi.md` PI-3, PI-12; `aio-tokens-static.md` AT-7.

### A13. Get RTK (the command-output shrinker) working where the tokens are · P1 · S-M
In RTK's own study, input fell 2-4%, but the bill did not fall (net cost −0.2%), because sessions ran about 3.4 extra commands (`rtk/FIX_PERF.md:14-27`). That is far from the 60-90% its marketing and AIO's setting text claim. An independent JetBrains study (80 paired runs, quoted by tura and fetched by the storybloq/tura scout) found RTK cost a median **7.6% more** at low effort, with more turns and cache reads, and made no difference at high effort. So **measure with a side-by-side trial before widening its use**; A0's numbers make that possible. Several of the newer RTK fixes target exactly those extra commands (item 3). Today AIO doesn't even get RTK's own figure, for these reasons:
1. **Loops and every auto-approve Claude session get no RTK** **[checked by Claude, 10 Oct]**. The Claude hook that carries RTK attaches only when *not* in auto-approve mode (`claude-cli-argv-builder.ts:162`). Loops always auto-approve, and a spec asserts no RTK is attached (`default-invokers.loop.spec.ts:533`). It was removed by accident in May. Review, consensus, multi-verify and Council calls have the same gap. **Fix:** a rewrite-only `rtk hook claude` for auto-approve sessions, which never denies or asks.
2. **Codex mostly bypasses it.** About 88% of shell commands in AIO's Codex sessions are `rtk proxy …` (unfiltered), and AIO's own instruction text invites that ("…would lose required evidence", `rtk-awareness.ts:23-25`). **Fix:**
   - Use the native `rtk hook codex` (RTK 0.50+), written as a *merged* `hooks.json` into AIO's private `CODEX_HOME` that keeps James's own hooks.
   - Use RTK's own short "awareness" text: none for hooked agents, the full version only for hookless ones.
   - Antigravity and Gemini currently get the 1.1 KB block on every turn.
3. **The bundled copy is old** **[checked by Claude, 10 Oct]**: `RTK_BUNDLED_VERSION = '0.39.0'` (`rtk-runtime.ts:29`), against the current 0.51. The copy actually in use is James's newer Homebrew 0.42.4, which AIO prefers when present. The fixes since include exit-code pass-through and safe pipelines. Bump the bundled copy and require 0.49+ for rewriting. The "bundled only" setting would currently lock in the old copy.
4. **The Savings tab overstates savings about 1,000-fold.**
   - It shows "26,155M tokens saved"; 99.3% of that comes from 64 giant outputs. A realistic figure is about 25M over 90 days.
   - 92.8% of recent "compressed" commands compressed nothing.
   - `getCompliance()` is never called.
   - **Fix:** cap per row; split "filtered" from "ran unfiltered"; add a time window; fix the copy ("restart the app", not "restart the session"; RTK is "Rust Token Killer"; drop "60-90%"); add tooltips.
5. Where the project's test runner has an RTK filter, pass loop verify-failure text through `rtk pipe --filter`, and keep the full log in AIO. This doesn't help AIO's own `npm run verify`.
6. **Investigation:** RTK's history shows `rtk proxy git cat-file` running about **2,877 times an hour** on 8-9 October in `communitytech/work-finding`, including its `.worktrees/queue/*` plan-queue folders. That is 31,566 calls on the 9th alone **[re-queried by Claude, 10 Oct]**. The pace suggests a scheduled script, so the output probably didn't all reach a model. Find it and check its real cost; per-run cost visibility (A0, B6) should surface this kind of thing automatically.
7. **Copilot:** only 7.1% of Copilot bash commands use RTK. The two reports disagree on the fix. The Copilot report suggests a native hook (CPS-11); the RTK report found that Copilot's RTK hook blocks the command and makes the model re-send it, so it advises staying instruction-only (RTK-14). Settle this with one live probe before choosing.
- **Source:** `ref-rtk.md` RTK-1, -2, -3, -4, -7, -8, -10, -11, -16; `aio-tokens-static.md` AT-3.

### A14. Make "second opinion" reviews deliberate · P0 · S-M · **[trigger checked by Claude, 10 Oct]**
- **What's wrong.**
  - Cross-model review is **on by default** (`src/shared/types/settings-defaults.ts:264`).
  - When a session goes idle, it fires if the output contains *any* fenced code, a file-touch phrase, or plan/architecture words (`output-classifier.ts:39-90`), with a **10-second cooldown** (`cross-model-review-service.constants.ts:6`) and no exclusion for child sessions (`cross-model-review-service.ts:252-300`).
  - Each review starts up to two full reviewer sessions with no tool or turn limits, carrying up to 32K characters.
  - Logs show 66 reviews (about 132 reviewer sessions) over roughly 6-10 October, 41 of them on Copilot seats (premium requests), with an estimated 1-3M tokens a day. None of it is recorded (A0).
- **Fix.**
  - Trigger on real file changes, using the workspace diff AIO already tracks, not on text patterns.
  - Skip child and loop sessions unless asked.
  - Use the lean, read-only reviewer profile (A5) with a turn cap.
  - Record usage, and set a daily budget.
  - Show "Second opinion: ✓ / 2 concerns" on the session (UX-11).
- **Sources:** `aio-tokens-static.md` AT-2, AT-11.

### A15. Scheduled jobs check before they wake a model · P0 · M
- **What's wrong.**
  - Five recurring monitoring automations cost $478.79 in 30 days (provider-reported; slightly inflated by the A0 bug, about 12% on the biggest one). At least 241 of their 279 runs (86%) ended "nothing to do", costing $330.42. That count is a lower bound from a keyword match. Examples: "The leads panel is up, so James gets no message", "nothing to copy".
  - Across all automations: 573 runs used 3.05B tokens, about 7% of everything.
    - Three jobs account for 59%.
    - Two one-time Codex jobs burned about 400M tokens without a successful run.
    - 64 successful near-empty runs used 120M.
    - The one Sonnet job costs about 40x less per run than the Opus ones.
  - AIO has no pre-run check and no quiet outcome (searched); the only pre-run skip is "provider excluded".
- **Fix**, from openclaw and hermes:
  - An optional pre-check per automation: a command or small script, at most 30 seconds, at most 5 tool calls, at most 16 KB of saved state.
    - If nothing changed, no model runs and the run is recorded as "no change".
    - If something changed, the difference goes into the prompt.
    - If the check itself fails, treat it as an error rather than a "change" (hermes). openclaw instead lets the job run anyway ("fail open"). Pick one rule per job; either way, James is alerted.
  - A structured `notify: yes/no` result instead of free text; a `[SILENT]` / `NO_REPLY` reply suppresses delivery.
  - Default "check" jobs to a cheaper model.
  - **Retry only what a retry can fix.**
    - AIO retries most failed automation runs, up to three attempts in all (provider limits, approvals and some refusals are exempt). Over 30 days 59 retries ran, 11 worked and 48 failed again; one failed retry alone spent about 109M tokens.
    - Three failure kinds failed on *every* attempt: busy conversation, AIO's own session-count limit (the resource governor) and a deleted target conversation.
    - Treat "busy" and "paused" as *waiting*, not failing, and never retry deterministic refusals. AIO already has a "don't retry" switch that these cases don't use. Nanoclaw never reruns a turn that errored (CN-3).
    - Example **[checked by Claude, 10 Oct]**: two one-time "Resume session after codex quota reset" wake-ups from mid-September were switched off by the five-failure safety stop. Each failed with "Codex app-server runtime already has an active turn", meaning the session they were meant to wake had already resumed. They need no action, but they show "busy" being counted as failure.
  - **Limit how often an agent can schedule work.** Nothing stops an agent creating an "every 15 minutes" automation, and AIO's instructions give that as an example request. Copy nanoclaw's teaching refusal for **agent-created** automations only. Nanoclaw allows 4 runs a day without a pre-check; for AIO, start above 24 a day so existing jobs still pass (James's busiest runs every 15 minutes in a weekday window: 126 runs in 30 days). James's own form stays warn-only and shows "starts the AI about N times a day" (CN-2).
  - On screen: quiet runs greyed out, with "skipped by pre-check: nothing changed". Today every finished run, quiet or not, adds to the unread count (CP-3).
- **Sources:** `ref-openclaw-runtime.md` OCR-04 (`openclaw/docs/automation/cron-jobs/schedules.md:93-139`, `src/cron/trigger-script.ts:104`); `ref-hermes-runtime.md` HR-5; `aio-tokens-empirical.md` AE-7; `ref-claw-nanoclaw.md` CN-1, CN-2, CN-3. Earlier rounds recommended a pre-check twice; it was never built.

### A16. Put Codex's helper agents, tool output and compaction under AIO's control · P0 · S-M
1. **Helper agents** (mechanism **[checked by Claude, 10 Oct]**).
   - Over 1-10 October, Codex-spawned helper threads used 49% of AIO's Codex input (7.24B tokens; 695 threads; 53 helpers spawning helpers; most at "high" effort, inherited from the parent). The usage audit independently found that turns including helper or other estimated usage carry 80% of `gpt-6.1-sol` input.
   - James's `[features] multi_agent = false` turns off only the old version. Codex picks the version from the feature flags, then `[agents] enabled` (default true), then the **model catalogue**, which marks `gpt-6.1-sol`, `gpt-6-sol` and others as `v2` (`codex-rs/core/src/config/mod.rs:1628-1655`, `:3926-3932`; `~/.codex/models_cache.json`).
   - **Fix:** send per-thread settings through `thread/start.config`, which is already in AIO's protocol snapshot. Use Off (`[agents] enabled = false`) for loop and plan-queue workers, a lighter setting for chats (`default_subagent_reasoning_effort` / `default_subagent_model`), and Full on request (Decision 3: James approved, 10 Oct).
   - Trial it side by side: some work moves back to the main agent, so the real saving is less than 49%.
2. **Tool-output cap on every path.**
   - Codex "code mode" cells are cut at a fixed 10K tokens whatever AIO sets.
   - AIO's 6K cap applies late, and is lost on the shared-process and retry paths.
   - A simulation estimates that about 975M characters of tool output were kept in 10 days under the current cap, roughly 60% of uncached input. A 4K cap would cut that by about 15%, a 3K cap by about 28%.
   - **Fix:** send the cap per thread on every path, and use 4K for loop workers.
3. **Re-send AIO's live instructions after Codex compacts.** 60 of 63 AIO notes sent as developer messages (plan-queue follow-ups, child results, LSP feedback, continuation prompts) disappeared at the next compaction, because the retain setting is off.
4. **Compact between steps, not mid-task.** 93% of Codex compactions (1,034 of 1,107) happen mid-task. The opt-in `model_post_turn_compact_threshold_percent` compacts after a step finishes, without the interrupt that made AIO stop doing its own Codex compaction.
5. **First, regenerate AIO's Codex protocol snapshot** with the existing generator; it is 18 versions behind the installed 0.162.1.
6. **Experiments:**
   - `thread/revert` / `thread/fork` to drop a failed loop attempt from history (CXC-06).
   - The hypothesis that cache misses follow helper messages (CXC-05), which disappears wherever helpers are off.
- **Sources:** `ref-codex-core.md` CXC-01 to CXC-07; `aio-tokens-empirical.md` AE-6.

### A17. Fan-out and plumbing leaks · P1 · S each
1. **Wake a parent once per batch of child results.** Today each finished child is its own message, so an idle parent takes a full turn per child, followed by a final "all done, summarise" prompt. Each child summary reaches the parent four times. Measured: 43 parents, 622 child results; 16 parents had 6 or more children; median gap 158 seconds. (OCR-05)
2. **Stagger multi-verify siblings** by a second or two, with the shared text first, so later ones reuse the first one's cache. (CC-7)
3. **Don't hide AIO's own tools twice.** With Claude's tool search active, AIO's second layer of deferral adds about two extra model turns before a tool can be used. (CC-5)
4. **Align browser snapshot caps.** The extension path is capped only by the generic 51,200 bytes (about 12.8K tokens); the managed path uses 12K characters. (AT-9)
5. **Remove duplicate tools:** `imap` is added twice, and code navigation is offered three ways (native LSP, the `lsp` server, codemem). Keep exactly one IMAP server reachable for the automations that use it: 27 of 47 enabled automations mention email or the inbox. (AT-10)
6. **Trim "[Retrieved Context]".** It searches the session's own history on every message of 50+ characters (`instance-context.ts:404-516`). Skip sections still in the live window, or already sent. The gain is small (65 injections, about 166 tokens each). (OMX-2)
7. **Stop the loop's wrap-up step from changing the tool list on a resumed Claude session.** That forces a full cache rewrite, about $2.50-4 per capped run; use a blocking hook instead. (CC-6)
8. **Wire the adapter path of output persistence (`flushOutputBuffer`), or delete it.** Keep the opt-in loop-output path that does use it (`loop-output-externalize.ts:50`). (AT-12)

### A18. Rein in Claude's own subagents · P0 · S-M
- **What's wrong.**
  - In AIO's Claude sessions, Claude's built-in subagents cost more than the main conversations: about $16.7K against $14.7K at list price over 31 days.
  - 1,900 general-purpose subagents each started at about 44.8K tokens and grew to 169K (median) or 303K (top 10%). They are 90% of subagent spend.
  - Main sessions cache for an hour, but subagents cache for only 5 minutes. As a result, 978 subagent pauses of 5-60 minutes (735 of them right after a Bash command) threw the cache away and re-wrote 285M tokens.
  - AIO sets none of the controls (searched).
- **Fix.**
  - A subagent model setting (`CLAUDE_CODE_SUBAGENT_MODEL`, e.g. Sonnet for general-purpose subagents). In the Claude Code source it overrides **every** subagent's model, including agents that name their own (`Actual Claude/utils/model/agent.ts:43-44`), and CLI 2.1.296 adds a `_FORCE` variant. So check the precedence first: reviewers and the fresh-eyes gate should stay on the parent model. The audit estimates about $5-6K a month at list price, if quality holds. Trial it first.
  - Apply A4's context ceiling to subagents too.
  - Add one instruction line: "run long commands in the background and check back at least every 4.5 minutes", so the 5-minute cache stays warm.
  - Switching subagents to a 1-hour cache roughly breaks even, so it is not the fix.
- **Pairs with:** A16 (Codex's helper agents). Helper and subagent fan-out is about half of each main provider's volume (CXC-01, TR-2, TR-7). For Claude, context growth (A4) is a lever of similar or larger size: the transcript audit ranks it first.
- **Source:** `aio-tokens-transcripts.md` TR-2.

### A19. Cap tool output for the CLIs and for AIO's own tools · P1 · S
- **What's wrong.** In Claude sessions, Bash produces 68-69% of tool-result text and Read 14-28%. Those results are re-read on every later request: about 6.5B tokens in main sessions and 10B in subagents over 31 days. AIO's own browser and orchestrator tools return up to about 50K and 39K characters.
- **Fix.**
  - Set Claude Code's `bashOutputMaxChars` (default 30,000 characters) through AIO's existing settings overlay. A 12K cap saves an estimated $410 a month and 8K about $840; both are upper bounds.
  - Cap AIO's own tool outputs at the source, and align the browser snapshot paths (A17.4).
  - For Codex, see A16.2. Copilot's report has the equivalent output-cap data (CPS-12).
- **Source:** `aio-tokens-transcripts.md` TR-5; `aio-tokens-static.md` AT-9.

### A20. Memory notes added to every message: make them earn their place · P2 · S-M
- **What's wrong.**
  - On every message, AIO searches its memory and the code index and prepends the hits to what the model sees. That includes machine-written messages such as plan-queue prompts. It adds up to about 1,400 tokens on a short message and about 3,700 on a long one, and the notes then stay in the conversation.
  - There is no "is this worth searching for" check ("continue" still triggers a code search), no repeat-protection, and no running total. OB1 and MemPalace inject once, on a topic change, with a per-session cap.
  - The measured volume is small: the usage audit counted about 0.38M injected memory tokens in 30 days, and the oh-my-codex scout found 65 "[Retrieved Context]" injections averaging 166 tokens. So this is mainly about clean context, not money.
- **Fix.**
  - Skip machine-written messages first.
  - Then inject only on a topic change, with a per-session cap and repeat-protection.
- **Small bugs found on the way:**
  1. **Observation memory is called with the wrong arguments.** The search text is the instruction files, and the session's first message is used as a task label, so every note is filtered out whenever a first message exists (MEM-4, S).
  2. **The long-query clean-up covers only 1 of 5 search paths.** One path reads the first 12 words of a pasted message instead of the question at the end (MEM-3, S).
  3. **"Used 12x" on the Wake page counts how often a note was *shown*,** and every injection counts as a success. Real use detection exists only for loop lessons; extend it. Retire notes that are never used or whose source changed (MEM-2).
  4. **Loop lessons are global,** so lessons from one repo can steer loops on another (MEM-5).
- **Sources:** `ref-mempalace-ob1.md` MEM-1 to MEM-5; `ref-omx-slim.md` OMX-2; `aio-tokens-empirical.md`.

### A21. Approve a plan into a fresh session that carries only the plan · P1 · M
- In AIO, going from Plan to Build keeps the whole planning conversation, so every build step re-reads it. AIO's own data puts a Claude instance's first turn at 50-150 calls over 100-200K tokens of context.
- Jean's "approve plan" can start a fresh session (optionally on a cheaper model) that is handed only the approved plan.
- AIO's Plan Mode page also asks James to *type an instance id*; fix that too.
- **Source:** `ref-jean.md` JN-2.

---

## B. Make loops finish (and cost less when they don't)

### B1. Loop quick-fix bundle · P0 · S each
1. **"/goal" cannot start** **[checked by Claude, 10 Oct]**.
   - `buildGoalLoopStartConfig` sets `allowOperatorReviewedCompletion: true` with the default cost cap, which has been `null` since 2 September (`goal-command-loop.ts:51-71`; `loop.types.ts:74`).
   - `goal-loop-command.ts:49-54` then calls `prepareLoopStartConfig`, which throws for exactly that combination (`loop-start-config.ts:94-103`).
   - **Fix:** give `/goal` the workspace's detected verify command, or relax the guard for goal loops. Don't reintroduce a default spend cap: James removed the $30 default on 2 September. A cap should be an option he chooses. Add a builder-to-prepare test.
2. **NOTES.md never shrinks to 12K** **[checked by Claude, 10 Oct]**. Curation reads a 24,000-*byte* tail, adds a 95-byte header, then compares *characters* against 24,000 (`loop-stage-machine.ts:324-354`; `loop-stage-markdown.ts:181-182,213-217`). Text containing dashes or arrows therefore never trips the trim, and the file is rewritten at exactly 24,095 bytes every time.
3. **The iteration log is uncapped** (up to 296 KB, 45% repeated lines), yet the prompt invites the agent to open it (`loop-stage-machine.ts:566,695-726`). Cap it.
4. **Checkpoints keep only the last round** (`loop-handlers.ts:84,104,165`), so stuck detection restarts cold after an app restart.
5. **The stale-cache reset decides on the run's lifetime token total** (`loop-context-survival.ts:321-325`), against the loop's own rule.
6. **Housekeeping:**
   - Close the five stranded "paused" runs.
   - Delete the committed `src/main/orchestration/loop-audit-runtime.ts.bak`.
   - Fix the loop-config hint that promises "up to 50KB" of rehydrated files when the cap is 2,800 bytes (`loop-recycle-handoff.ts:19-20`).
- **Source:** `aio-loop.md` LP-7.

### B2. A "finish phase" when the task list is closed · P0 · M
- **What's wrong.**
  - In the default review-driven mode, a clean pass needs `reviewVerdict.clean && noProductionChanges && verifyOk` (`loop-coordinator-completion-gates.ts:177`) **[checked by Claude, 10 Oct]**, and two in a row.
  - The change check diffs the whole checkout (`loop-invocation-attempt.ts:150-160` says so in its own comment), so other sessions' edits reset the streak.
  - Agents keep polishing: 12 runs ran 124 more rounds (28 hours) after their task list was empty, still editing 1-50 files a round.
- **Fix.**
  - Once the ledger is closed and checks pass, switch to a bounded finish phase (about 3 rounds) with a narrow "wrap up, no new work" instruction.
  - Judge "no changes" by the loop's own edits.
  - Make the second confirmation round cheap, or skip it when a second model already reviewed. The two confirmation rounds took 17% of tokens and 24% of the time in runs that did finish.
  - Add Copilot's own long-task rule to AIO's loop prompts: "if no acceptance criterion remains, return the final answer". Copilot's instructions also cap how many fresh context windows a run gets and tell the agent to finish on the last one (CPS-6).
  - When the finish phase runs out, end with a per-check list ("finished; these checks were skipped, and why") instead of yet another round. oh-my-codex turned blocking checks into recorded, visible ones the same way. James approved this for ordinary loops (Decision 6); strict stays the default for plan-queue and lifecycle loops.
- **Sources:** `aio-loop.md` LP-1, LP-9; `ref-omx-slim.md` OMX-4; `ref-copilot-sdk-plans.md` CPS-6.

### B3. Verification that knows what was already broken · P0 · M-L
- **What's wrong.**
  - In 17 of 18 recorded runs, `npm run verify` was failing or timing out *before* round 1.
  - A failing verify still resets the streak and injects up to 8 KB of failure output telling the agent to fix it (`loop-coordinator-utils.ts:17-48`), including failures the loop never caused.
  - The start-of-run check that would record the baseline has been **off by default** since 4 September (`loop-start-config.ts:263-270` **[checked by Claude, 10 Oct]**).
- **Fix.**
  - Record the failing set at the start, cheaply.
  - Block only on new failures.
  - Have reviewers mark each finding "caused by this change" or "already there". The second kind becomes a follow-up item that can't keep the run alive, and agents are told to file unrelated failures, not fix them (storybloq, SBT-4).
  - Run a fast targeted check each round and the full suite once at the end.
  - Make the verify timeout a setting; it is hard-coded in `loop-config-panel.component.ts:598`.
  - Show "Started with 3 failing tests (not the loop's fault)".
- **Source:** `aio-loop.md` LP-2.

### B4. Honest end states · P0 · S
- A degraded attempt with unprovable workspace state (typically a 30-minute timeout) ends the run as `completed-needs-review` (`loop-attempt-review-pause.ts:21-45`). In September, 9 of the 11 runs with that label were failed attempts that ended the run, 5 of them at the very first step. Six were a variant fixed on 5 September; the three 30-minute-timeout cases are the path that still does this (re-queried by the fact-checker).
- **Fix:** add a separate "stopped: attempt failed" state, and split "needs your sign-off" from "finished with notes".
- **Source:** `aio-loop.md` LP-6.

### B5. Questions from a running loop that you can answer without stopping it · P1 · M
- **What's wrong.** `OUTSTANDING.md` is read only when the run ends (`loop-coordinator.ts:3889-3892`). A question asked in round 3 of an overnight run is therefore invisible until morning. 293 of 303 "needs you" items are still open.
- **Fix.**
  - Re-parse the file at each round boundary.
  - Show new questions as a chip, with an answer box pre-filled with the agent's recommendation.
  - Send the answers as a Hint for the next round.
  - One click answers or clears an item.
  - One stable-prefix line tells agents they may ask this way and keep working. Codex's rule applies: arrival never steals focus.
  - **Split "needs you" into three kinds,** as storybloq does: *blocks this task*, *decision already applied (tell me if wrong)*, and *for information*. Only the first waits for an answer. About three-quarters of the open loop questions (139 of 179) already carry a recommended answer. James approved agents going ahead with their own recommendation on non-blocking questions, cautiously (Decision 7, "yes±"): start with low-risk questions only, mark each "decision applied, tell me if wrong", make it one click to reverse, and keep waiting on anything that changes scope, spends money, deletes data or touches shared resources.
- **Sources:** `ref-codex-ux.md` CXU-10; `aio-loop.md` LP-12; `ref-storybloq-tura.md` SBT-5.

### B6. Count every loop dollar, read every stop reason · P1 · M
- **What's wrong.**
  - Fresh-eyes reviewer spend is never recorded (`review-execution-host.ts:147-208` drops `response.usage`) **[checked by Claude, 10 Oct]**.
  - Ping-pong reviewer cost is an 85/15 guess with no cache discount.
  - The "provider-reported vs estimated" label comes from the last round only.
  - Plan-queue spend is not in the loop database.
  - Prompt sizes are not stored.
  - Claude's end-of-turn result now carries a stop reason (19 values, including "hit the turn limit") and a turn count, and nothing reads them, although 61% of Claude rounds stop at the 30-step cap.
- **Fix.**
  - Record purpose, stop reason, prompt bytes and cache read/write per round.
  - Treat max-turn stops as unfinished work and continue cheaply.
  - Add one line near the cap: "You are near the step limit: save progress, then continue; don't stop because of this" (hermes).
  - Add a per-run scorecard: tokens per accepted change, rounds after the ledger closed, reviewer share. Show the denominator beside every rate, print "-" when it is empty, and use one shared rate helper (storybloq, SBT-6).
- **Sources:** `aio-loop.md` LP-5, LP-14; `ref-claude-code.md` CC-8; `ref-hermes-runtime.md` HR-4; `ref-storybloq-tura.md` SBT-6.

### B7. Cheaper reviewer rounds · P1 · M
- A ping-pong round costs about $6-11. In two runs it pushed spend over the cost cap.
- **Fixes:**
  - Show the reviewer what changed since its last round, **plus a short record of its earlier findings and how each was resolved**. A diff alone is still a cold read: storybloq traced 27 of 44 empty "revise" rounds to reviewers re-reading cold (SBT-1).
  - Scale review depth to the size and risk of the change: light means one reviewer and about a third of the round cap (SBT-2).
  - Stop after two identical findings.
  - Don't pay a full fresh-instance start-up every round unless asked.
  - Use A5's helper profile.
  - **Don't pay to re-review unchanged code.** Skip the reviewer when nothing changed since its last rejection and the builder didn't argue back (agent-orchestrator never reviews the same revision twice).
  - **Only blocking findings become builder work** **[checked by Claude, 10 Oct]**.
    - The ping-pong verdict honours a "changes requested" even with nothing blocking (`agentic-pingpong-reviewer.ts:640-649`).
    - The builder is handed optional suggestions with "Fix the valid ones" even when `blocking.length === 0` (`loop-pingpong-completion.ts:175-184,649-667`).
    - The fresh-eyes path already sends only blocking findings. Measured impact is small: ping-pong is rarely used, and no run has ended on the nits-only path. But it is a cheap rule fix.
- **Sources:** `aio-loop.md` LP-13; `ref-agent-orchestrator.md` AO-1, AO-2; `ref-storybloq-tura.md` SBT-1, SBT-2.

### B8. Plan-queue reliability · P1 · M-L
1. **Auto-merge document-only landing conflicts.** 24 finished items could not land because one shared doc was being edited in the main checkout.
2. **Survive app restarts.** 90 items in 4 runs were cancelled because "the session that started the run no longer exists" (`plan-queue-control-authority.ts:54-63`).
3. **Retry the first classification step.** 23 items failed there.
4. **Finish the incomplete quit fix (LT-701).**
5. **Plan-queue workers get A16's Codex settings** (helpers off, 4K tool-output cap) and A4's context ceiling.

- **Source:** `aio-loop.md` LP-10.

### B9. Loop screen: one story, plain reasons, a button for every next step · P1 · M
- **What's wrong.**
  - Up to seven status renderings can disagree.
  - Raw reasons are printed verbatim ("signal=done-promise", "cap=iterations; after 50 iteration(s); no completion was attempted").
  - Suggested next steps have no buttons.
  - Stop needs no confirmation.
  - The pre-start summary never says there is **no spending limit** (`loop-preflight-summary.ts:25-36`).
  - The end of a loop is reported twice, with contradictory counts.
  - The start panel has about 42 inputs, including about 10 overlapping "when is it done" settings.
- **Fix.**
  - One status line, and one end card in plain words with the finish time.
  - A button for every recovery suggestion.
  - Confirm on Stop.
  - "No spending limit set" shown before start.
  - Live reviewer spend.
  - Later, presets with an "Advanced" fold.
- **A ready template:** jean's "Mr. Robot" panel gives every state a one-line headline, one plain sentence and one button. Use that shape for the loop and plan-queue panels (JN-6).
- **Sources:** `aio-loop.md` LP-8, LP-11, LP-16; `aio-ux-clarity.md` UX-12; `ref-claude-code.md` CC-13; `ref-jean.md` JN-6.

### B10. Fewer false "stuck" alarms, and explain real stalls with process facts · P1 · S-M
- **Codex "slow but alive".** The stuck-session detector warned 225 times in 2.7 days, and 221 of those were Codex: about 40 times Claude's rate per busy turn. The only forced restart was a Codex one.
  - ACP-driven sessions already get a liveness "lease" that prevents this. Codex lacks one method to provide it.
  - Judge liveness from the provider's own event stream, as nanoclaw does, and some of these warnings may disappear (CN-4).
- When a stall check fires, sample the CLI process and its children: CPU, state (D/T/Z), memory and the hung child's command. Then say, for example, "Waiting on `npm test` (child, 14 min, 0% CPU)".
- Never auto-kill on these signals. (AC8, from Claude's internal `/stuck` heuristics.)

### B11. OpenCode loop parity and live steering · P2 · M
- Make the cap "wrap-up turn" enforceable on OpenCode with a restricted agent mode; today only Claude can enforce it.
- OpenCode v1 accepts a mid-turn message (`prompt_async`), so it could be AIO's first live-steer loop provider. (OCC-T2-02, T2-03)

### B12. Show the provider's own goal state · P2 · S-M
- AIO already tracks Codex's native goal status. Show it as one row above the composer, with Resume and Clear, so a provider-run goal is never a silent continuation. (T3-02)

### B13. Let the loop agent ask for a fresh start at a natural seam · P2 · S-M
- Today the agent can signal only complete, block, fail or wakeup (`loop-state.types.ts:343`). Add a rate-limited `handoff` intent with a capped note, so it can start fresh when a stage is committed and the tests are green (pi `durable/README.md:402-411`; PI-7).

### B14. Keep the Mac awake while work is running · P1 · S **[checked by Claude, 10 Oct]**
- AIO listens for sleep and wake events (`powerMonitor`, in 4 production files) but never prevents sleep: there are 0 references to `powerSaveBlocker` or `caffeinate` in `src/`.
- AIO's own logs show eight sleeps in 2.7 days, four of them 34-223 minutes long (about 8.4 hours in total). It wasn't proven that a loop was running during them. A sleeping Mac stalls loops, automations and remote-node work, and wakes into cold caches (A4).
- **Fix:** a setting with three values, Off / While working / Always, using Electron's `powerSaveBlocker('prevent-app-suspension')` while any turn, loop, automation or plan-queue run is active. Recommended default: **While working**. Show a small "keeping your Mac awake: loop running" hint, with a tooltip.
- **Source:** `ref-hermes-ux.md` HU-2.

### B15. Recognise Copilot's usage-limit messages · P1 · S
- AIO's two limit detectors recognise 0 and 1 of Copilot's 7 current limit messages. A Copilot run that hits a weekly, session or credit limit is therefore not parked until the limit resets; it fails or retries instead.
- **Fix:** add the current message set, with fixture tests built from real logs. Park on rate, weekly and credit limits; recycle on "session spending limit" (CPS-7).
- Separately, if James has set a loop cost cap, offer "add more" at the cap, with amounts suggested from past runs (CPS-9; never a default cap).
- **Source:** `ref-copilot-sdk-plans.md` CPS-7, CPS-9.

---

## C. A calmer, clearer screen

### C1. "Close all" must ask first · P0 · XS · **[checked by Claude, 10 Oct]**
- The always-visible footer button ends every session with no confirmation anywhere on the path. The click (`features/dashboard/sidebar-footer.component.ts:61`) goes to `dashboard.component.ts:608-610`, then `terminateAllInstances`, then the IPC handler (`instance-handlers.ts:652-658`). What happens to a running loop is not traced: nothing on that path cancels one (`instance-event-forwarding.ts:161-186`), so loops may keep running unseen or be left stranded. Check that before choosing the wording.
- **Fix:** reuse the terminate-confirm dialog ("Close all 9 sessions?"), say truthfully what happens to running loops (or stop them too), or move the button into a menu. (UX-3)

### C2. One of everything on the session screen · P0 · M
- **What's wrong.** The header and composer show:
  - the model picker, account chip and pending switch twice each;
  - context use three times (a bar, a pill and a ring);
  - Stop twice;
  - app-wide facts ("12 hooks") on every session;
  - a full-width desktop-control box even when that feature is off.

  James's screenshots show about 20 items above the first message.
- **Fix.**
  - One status area above the composer instead of about 18 separate blocks around the transcript. AIO already has counted toggle chips for five groups (tasks, review, children, checkpoints, outstanding); extend that pattern. Approvals and questions stay outside it, so collapsing it can never hide a decision (HU-5, JN-5).
  - Model, account, pending switch and the context ring live in the composer toolbar only.
  - The ring opens one "Context details" popover.
  - Non-default modes show as chips only when they differ from the default.
  - The header becomes one row.
- **Source:** `aio-ux-clarity.md` UX-1 (file list there).

### C3. Approval buttons that name their scope · C3a P0 · S; C3b P1 · M · **[checked by Claude, 10 Oct]**
- **What's wrong.** For a permission denial, the default "remember" scope is **Always** (`user-action-request.rules.ts:40-44`), while the button just says "Allow" (`user-action-request.component.ts:344-358`). A "Remember this decision" dropdown pre-set to Always, and a one-line hint naming `~/.claude/settings.json`, sit beside the button. But the button label never changes, and the hint doesn't mention the restart (`user-action-request.component.html:244-262`). Always writes a lasting rule into the user-level Claude settings and restarts the session (`instance-handlers.ts:1138-1180`).
- **Fix.**
  - Buttons say "Allow once" / "Allow for this session" / "Always allow (adds a rule to ~/.claude/settings.json and restarts)".
  - **C3b: "Allow once" doesn't work for most tools today.** Only shell (Bash) asks can be answered at all: the call is held, then the session resumes with your answer. For every other tool, "Allow once" cannot take effect, and "Always" writes a rule, restarts the session and tells the user to retry (`ref-jean.md` JN-3). Jean answers every tool's permission ask inside the turn. **Fix:** do the same, so "Allow once" really works, then make it the default. Until then, don't offer an option that can't work. Size M; how often non-Bash denials happen is not yet measured.
  - Add "Don't allow, and tell it what to do instead". Today every denial sends a fixed sentence (`user-action-request.component.ts:926`).
  - Every question card offers "Type your own answer".
  - **When a request ends without James, say why.** Today the card just vanishes, although the reason (timed out, auto-approved, cancelled, answered elsewhere, session closed) has already reached the screen and is ignored. This is verified for ACP-driven sessions; other providers are not checked. Show one quiet line per case, and give agent questions a visible deadline (OCX-2).
- **Sources:** `ref-codex-ux.md` CXU-7; `ref-opencode-ux.md` OCU-5, OCU-9; `ref-jean.md` JN-3; `ref-openclaw-ux.md` OCX-2.

### C4. One "Needs you" place, a dock badge, and list tabs · P0 · M-L
- **What's wrong.**
  - About 13 separate attention signals.
  - The Workboard has no rail button and covers only 4 sources.
  - Notification and away-recap items can't be clicked through.
  - The sidebar has just "All / Active".
  - Nothing persistent shows, while James is in another app, that 2 of 8 sessions are waiting on him.
- **Fix.**
  1. A "Needs you (N)" rail button opening the Workboard, fed by the shared attention scale plus approvals, plan-queue questions, doc and memory reviews, fallback decisions and loop questions (B5).
  2. One slim strip replacing the separate banners; time-limited approvals keep their countdown.
  3. Count-bearing tabs on the session list: "Needs you N · Working N · Idle N · All".
  4. A dock or taskbar badge (`app.setBadgeCount`), zero while AIO is focused.
  5. Collapsed groups show their most urgent child.
- **Check first (UNVERIFIED):** Claude's own tool-permission prompts may not reach the approvals store that the "blocked on you" digest reads.
- **Sources:** `aio-ux-clarity.md` UX-2; `ref-codex-ux.md` CXU-2, CXU-3; `ref-t3code.md` T3-15; `ref-opencode-ux.md` OCU-4.

### C5. Calm the top of the window and the notices · P1 · S-M
1. **A banner budget:** at most one banner row; extra ones collapse to "N more".
   - No startup chip and banner shown together.
   - No "Local AI: Not configured" shown forever.
   - Provider names instead of two-letter codes ("CU" means two different things today).
   - In the 4 October captures, banners took 30-45% of the window height.
2. **A placement rule:** a banner only if it changes what Send does; otherwise one quiet line in the transcript with one action (t3code).
3. **Toasts with a key, priority, fold and invalidation.** Errors stay until dismissed and offer the fix as a button. Today every toast vanishes after 2.2 seconds, including errors such as "model swap degraded" (HU-6).
4. **Notifications that name the session and open it.**
   - The approval toast doesn't say which session is asking.
   - Identical text from two different sessions is dropped as a duplicate.
   - Clicking any toast only focuses the window, instead of opening the session (CP-5).
5. **Separate "seen" from "still a problem".** The badge counts every record, including suppressed ones that were never shown. Records go away only when dismissed, so the "Needs you" count would fill with stale items (agent-orchestrator).
- **Sources:** `aio-ux-clarity.md` UX-4; `ref-t3code.md` T3-11; `ref-actual-claude.md` AC11; `ref-agent-orchestrator.md` AO-3; `ref-codepilot-codexdesktop.md` CP-5.

### C6. Plain-English messages and one status vocabulary · P1 · M
- **What's wrong.**
  - About 80 system-message sites. The worst: two stuck checks giving opposite advice in a row; "cleared the optimistic busy state"; "shared context-policy boundary". In one screenshot James replied "??? CONTINUE?".
  - The interrupt divider prints raw codes ("interrupt completed · respawn-fallback").
  - Tool groups say "44 calls · 900,532 characters · 25 results externalized".
  - Errors interpolate raw statuses ("instance is respawning").
  - Three separate label maps describe one state differently, and have already drifted ("respawning" is purple in one, teal in another).
- **Fix.**
  - A shared user-facing messages module: what happened, what it means, what to do, with raw detail behind "Details".
  - One sentence per interrupt case.
  - Tool groups summarised in words ("Read 6 files, ran 3 commands, 1 failed"), always with a failure count on the collapsed line, and each command one click away. Codex reverted a roll-up that hid failures, and AIO's collapsed groups hide failed calls today.
  - One shared `presentInstanceStatus()` with about 8 plain labels, computed in shared code so mobile pushes and notifications match, plus a spec that fails on new local label maps.
  - The honesty rule: never say an automatic fix is happening unless one is running.
  - Rewrite the top 20 messages first.
  - **Automations too:** the Automations page shows raw text such as "Instance entered error". Nine messages cover 94% of failures, and the claw/nanoclaw report drafts plain wording for each (CN-5).
- **Sources:** `aio-ux-clarity.md` UX-5; `ref-t3code.md` T3-09, T3-10, T3-16; `ref-codex-ux.md` CXU-5, CXU-6; `ref-agent-orchestrator.md` AO-4; `ref-claw-nanoclaw.md` CN-5.

### C7. One name for each thing · P1 · M
- A conversation is called session, instance, thread, chat or conversation; the app is called Harness, AIO, Orchestrator or AI Orchestrator. 25 of 52 secondary pages are titled differently from their menu label.
- **Fix:** a short word list enforced through one copy registry ("session" everywhere; page title = menu label). The product name is **Harness** everywhere (Decision 1, James, 10 Oct). (UX-6)

### C8. Say what the session is allowed to do, in one sentence · P1 · S
- `describePermissionPolicy` exists but only side chats use it (`side-chat-permissions.ts:14-30`). The main session shows jargon toggles instead ("YOLO ON", "FAST ON", "Hardened N/A").
- **Fix:**
  - Show the summary line ("Acts without asking · edits limited to this folder · web allowed").
  - Leave a transcript receipt when the posture changes.
  - Label "YOLO" visibly as "Auto-approve", with its consequence in visible text.
  - Say plainly when a setting is "saved as X but running as Y" until the session restarts, and use one set of words for capability states: checking, unavailable, degraded (CodePilot).
- **Sources:** `ref-codex-ux.md` CXU-8; `aio-tooltips.md` TT-9; `ref-codepilot-codexdesktop.md` CP-6.

### C9. Show what the agent is thinking about in the busy row · P1 · S
- The helper exists, but its only caller passes the tool name alone (`instance.store.ts:189-192`), so long reasoning shows "Processing...". Feed the reasoning text in ("Thinking · migration plan for auth"), and use it on the session-list row too. (T3-07, CXU-16)
- **A hover card on each session row:** the pending question or approval text, and the current to-do step ("3/7") where the provider publishes one (Codex today; Claude only if C13.7 turns its task tools back on). AIO already has this data and the list doesn't use it, and it is a steadier source than streamed reasoning (OCX-5).

### C10. A shorter menu and a command palette that goes anywhere · P1 · M
- **What's wrong.** There is a 52-link page menu and a 46-link "Tools & Views" panel. 15 places review or verify work, and there are six ways to find an old session. Cmd+K works only with a session selected and opens only four pages.
- **Fix:** about 20 everyday destinations, with the rest under "More tools"; "Needs you" replaces Plugins on the rail; the palette works anywhere and lists "Go to <page / settings tab>". (UX-7, UX-8)
- **Better still, an "Everyday / Full" view switch.** hermes uses one switch that quietly hides the instrumentation (status bar, terminal and file panes, raw tool payloads, diffs, the live reasoning stream). It never overwrites your own settings, and ⌘K is always the way back. Everyday view would show the ~20 destinations and a calm session screen; Full shows everything. Unlike hermes, AIO must **never** hide the auto-approve indicator in the simple view (HU-4).

### C11. Settings with one menu column and fewer tabs · P1 · S then M
- Hide the shell menu column on Settings, which today shows three columns plus Help. Fold the 30 tabs to about 12, add missing search keywords ("discord"), and wire `dependsOn` into "why is this disabled". (UX-9, TT-5)
- Give the custom settings tabs a typed list of searchable sections, with a guard test, so the next "search can't find X" can't happen silently (openclaw, OCX-7).

### C12. Undo instead of "Are you sure?" for reversible actions · P2 · M
- Archive, pin, snooze, cancel a queued message and discard a draft act at once, with a 5-second Undo (Cmd+Z when no text field is focused).
- Keep confirmations for the irreversible, and replace the 23 native `confirm()` dialogs with the app's own. (T3-08, UX-15)

### C13. Other clarity items · P2
1. **Honest search wording.** Chat Search claims to search messages but only matches titles and prompts. Then add one "Find session" overlay. (UX-10)
2. **"Review" means one thing.** Add "Ask another model about this reply" on answers. (UX-11)
3. **Developer details behind "Details".** UUIDs and "$0.7302072" become names and cents. (UX-13)
4. **Hide scaffolding pages** (Training Data; possibly Instance Messaging). (UX-14)
5. **Child-session orientation:** "Child 2 of 5 of ‹parent›", with Parent / Previous / Next. (OCU-6)
6. **Small fixes:** merge "New chat" and "New session"; show the task list once; one composer hint line. (UX-15)
7. **The task panel is dead for Claude.** Current Claude models no longer offer the task-list tool, so the panel never appears. Offer Claude's task tools as an opt-in for chats (`CLAUDE_CODE_ENABLE_TODO_TOOLS=1`, a small cost per message), or say where the panel would be that Claude doesn't publish one on this model; never for loops. (CC-12)
8. **Per-connector "costs about N tokens per message" tooltips** in MCP settings. (CC-15)
9. **A placeholder when a provider hides its reasoning**, so a long silent think doesn't look stuck. (OCC-T3-02, UNVERIFIED per provider)
10. **The memory (Wake) page speaks MemPalace's own language** ("Wing", "Room", "L0", "L1") and has no tooltips. There is also no view of what memory the AI was actually given in this session. The proposed tooltip copy is in the report. (MEM-6, MEM-7)
11. **Answer a findings table by clicking.** When an agent replies with a numbered findings or options table, let James tick rows and send "do 1, 3 and 5" into the next reply. This matches how he already answers, by number. (JN-4)
12. **One slot for optional chips on the composer's top edge.** Jean put its goal indicator in four places in four days before settling on a single strip, then moved other chips into it. This supports C2. (JN-5)

---

## D. Tooltips everywhere (and make them stay that way)

The order matters: fix the directive, measure honestly, ratchet, then migrate. A mass swap of `title=` attributes was tried once and lost a destructive-action warning (house rules in `tooltip-copy.ts`).

### D1. Fix the tooltip directive first · P0 · S
1. Template tooltips (`appTooltipTpl`) point `aria-describedby` at an element that is never rendered.
2. The redundancy check reads `textContent`, which includes labels hidden with `display:none`. Migrating the collapsed Settings rail would lose its tooltips.
3. There is no test for disabled hosts.
4. Long paths and commands overflow the box: add `overflow-wrap: anywhere` and a monospace "code" variant. (TT-6, T3-04)

### D1b. A quick, safe interim: upgrade every remaining `title=` at once · P1 · M
- openclaw installs one app-wide listener that shows any element's plain `title` text in its styled tooltip, with proper timing and keyboard-focus behaviour. It also gives unlabelled buttons a name while they are hovered or focused.
- For AIO this would improve all ~358 remaining hovers in one change **without moving any wording**. Moving wording is what lost a destructive-action warning in the last mass migration.
- Treat it as a bridge, not the end state: the ratchet (D3) and the building blocks (D4) still replace native titles over time, and the listener must respect the existing suppression rules (redundant label, open menu, recently clicked).
- **Source:** `ref-openclaw-ux.md` OCX-1.

### D2. Measure honestly · P0 · M
- The `verify` gate reports "0 blocking", but it treats `@if (…)` and `&times;` as readable text, and it only looks at elements that already have a `title`. **Fix:** rebuild `scripts/audit-native-titles.js` on Angular's own `parseTemplate`, which `@angular/compiler` already provides, so no new package is needed. (TT-1)

### D3. A ratchet that can only go down · P0 · M
- Generalise `icon-control-tooltip.spec.ts` from 2 templates to all 307, with a per-file baseline (like `check:ts-max-loc`). The rules:
  1. An icon-only control needs a tooltip **and** a name.
  2. No native `title` on controls.
  3. No nested tooltips.
  4. Hover-only explanations only with a listed reason.
  5. No hard-coded shortcut text.
  6. Every `TOOLTIP_COPY` key is used.
  7. A lasting disabled state needs a reason (report-only at first).
  8. The first use of a glossary term is marked.

  (TT-2; t3code reached zero native titles under a hard lint rule, T3-03)

### D4. Building blocks that make the right thing the easy thing · P1 · S-M
1. **`[appIconButton]="'Close panel'"`**: one string sets both the tooltip and the accessible name. This finally wires `resolveIconButtonAria`.
2. **`appTooltipShortcut="<action-id>"`**: renders the *live* key binding as a chip, omits it when unbound, and sets `aria-keyshortcuts`. At least 12 hover texts hard-code Mac glyphs, which are wrong on Windows and Linux and wrong after a rebind; the `shortcutHint` pipe has one consumer.
3. **`appTooltipDisabledReason`**: lasting conditions use `aria-disabled`, so keyboard users get the reason. Put a `xDisabledReason` next to every `xDisabled`.

- **Sources:** TT-3/4/5; OCU-11 (opencode's `TooltipKeybind`, 17 uses); T3-13, T3-14; CXU-14; AC13.

### D5. Migrate the always-visible surfaces first · P1 · M-L
- **Tier A:**
  - Composer: name the message box, which has no accessible name today.
  - Session header: 16 native titles; put YOLO's consequence inline.
  - Session list: 20 titles.
  - Left rail: 8/8 native, with hard-coded shortcuts.
  - Title bar: 12 native titles, 0 `appTooltip`.
  - Context ring: make it focusable.
  - Queue: show the "not saved" risk inline.
- **Tier B:** loop and plan-queue controls. 32 of 138 have tooltips, 0 of 24 in the plan queue; Pause and Resume don't say when they take effect.
- **Tier C:** settings, side chat, source control.
- **Tier D:** the rest under the ratchet, shared components first.
- One surface per change. (TT-8/9/10; LP-15)

### D6. A glossary for the jargon · P1 · M
- `shared/glossary/glossary.ts` plus an `appTerm` marker: dotted underline, focusable, plain definition, with "Learn more" opening Help or the A12 help pages.
- Seed about 25 terms (drafts in `aio-tooltips.md`): YOLO, FAST, RTK, RLM, codemem, MCP, ACP, worktree, compaction, recycle, ping-pong, fresh-eyes, steer, sidechat, and so on. Pick one name where two exist.
- Expand `TOOLTIP_COPY` beyond the loop, delete its 3 dead keys, and add `learnMore`. (TT-7, TT-12)

### D7. Help where the work is · P1-P2 · S-M
- A "?" on the loop panel and the session header opens the Help pane as a drawer. Loop help is only reachable from Settings today.
- Add tooltips to transcript links and buttons built from raw HTML, using one delegated listener.
- Update `docs/shell-component-standards.md`, which still prescribes native `title`, and the visual QA checklist. (TT-13/14/15)

### D8. A one-page screen-and-wording guide that agents are pointed at · P1 · S
- `docs/DESIGN.md` is an architecture document, and no instruction file points agents at a UI or wording standard.
- **Fix:** write a short guide (tooltip and copy rules, C6's status words, C5's banner rule, C7's word list) and add **one pointer line** to `AGENTS.md` ("before UI work read …"). Agent-orchestrator does this and treats existing screens as "debt, not precedent". (AO-5)
- Include CodePilot's standing rules for what may sit in the session header and composer: "healthy is invisible" (no chip unless something needs attention), and "status panels explain, they don't configure". These stop C2's clean-up from creeping back (CP-4).

### D9. A "UI consistency" review angle on renderer changes · P2 · S
- When a diff touches `src/renderer/**`, reviewers check changed lines only for:
  - an icon control without a tooltip;
  - a native `title`;
  - raw status text or jargon;
  - a local status map;
  - a destructive action without an inline consequence.

  They answer "All clear" otherwise. (T3-12)

### D10. Lint, once the ratchet hits zero · P2 · M
- Move the strict rules into a local ESLint template rule. angular-eslint's `elements-content` can't do it, because it counts any child and `title` as content. (TT-11, T3-03)

### D11. Teach in waiting time · P2 · M · approved (Decision 5)
- Codex and Claude Code show one quiet tip after the agent has worked 30+ seconds: no repeats, at most 2 per session, live shortcuts, never while typing, retired once the feature has been used.
- AIO deliberately rejects rotating tips (`hint-policy.ts:4-8`). A middle path keeps its "earned, dismissible" rule and adds usage counters plus a single "while you wait" slot. (CXU-13, AC14, OCU-12)

---

## E. Housekeeping that wastes disk, money or trust

### E1. Storage: about 80 GB under the app's data folder · P1 · M
- **What's there:**
  - The conversation ledger is 28.9 GB. It holds about 30 days of raw provider events, each stored twice, with no runtime reader (only two developer scripts) and no vacuum. It grew about 0.9 GB in under two hours.
  - RLM backups take 25 GB: two pre-shrink copies from 12 July, pruned only when another maintenance run happens.
  - Session-continuity states take 4.2 GB, and 73% of the files are older than 30 days.
- **Fix:**
  - The ledger already deletes events older than 30 days; what is missing is vacuuming (`auto_vacuum = 0`), so the file never shrinks. Add incremental vacuum after the sweep, and store one copy of each event.
  - Run this backlog's planned ledger counts (E3.10's `ScheduleWakeup` check, C3's non-Bash denial count, A20's measure-first step) **before** making capture opt-in.
  - RLM backups already keep only the newest 2, which are the two July copies, so a count limit deletes nothing. Prune by age instead, and **ask James before the two July copies go**.
  - Add retention for session-continuity states.
  - A "Storage" line in Settings showing each store's size, whose clean-up always asks first.
- **Source:** `aio-tokens-empirical.md` AE-9 (`projects/` 7.3 GB and `conversation-evidence/` 3.2 GB were not examined).

### E2. Leftover worktrees · P2 · XS
- `git worktree list` shows two Claude Code agent worktrees from 19 July under `.claude/worktrees/` and 10 AIO worktrees under `.worktrees/` (9 task worktrees and one rescue branch). None were created by this research. James decides; the stranded-worktree rescue could list the stale ones.

### E3. Stale versions and comments that will mislead the next change · P2 · S each
1. Regenerate the Codex protocol snapshot, which is 18 versions behind (CXC-07).
2. Bump RTK from 0.39.0 to 0.51 (A13.3).
3. The prompt-cache flag was cache-harmful before CLI 2.1.268, and AIO checks that the flag exists, not the version; this matters on older worker CLIs (CC-16). Below CLI 2.1.267, resuming without the overlay drops AIO's prompt (AC18).
4. Fallback prices for the 5.5 models are out of date (CC-17).
5. `claude-env-pack.ts` says the CLI has no stream watchdog; 2.1.296 has one on by default (AC17).
6. `codex-app-server-turn-adapter.ts:319-320` says Codex has no PreToolUse hook; it now has one (RTK 0.50+ uses it).
7. `sendEndSession` is malformed and unused (AC16).
8. The stray `.bak` file (B1).
9. **Quota refresh hygiene.** AIO refreshes the quota endpoint after every turn and ignores `Retry-After` on a 429. Back off and honour it. (JN-7)
10. **Lead to check.** Claude's built-in `ScheduleWakeup` tool, which lets a session schedule its own later wake-ups, is neither intercepted nor blocked by AIO (zero hits in `src/`). AIO already blocks the CLI's `CronCreate` in favour of its own automations. Query the ledger for `ScheduleWakeup` use. If sessions are waking themselves, route that through AIO's wakeups so it shows up and is counted. (JN-8)

---

## Suggested order

| Phase | What | Why this order |
|---|---|---|
| 0: confirmed bugs and true numbers (days) | A0, B1, A1, A2, A3, B4, C1, C3a, D1, A14 (trigger fix and recording), A20's MEM-4 bug, A10 quick fix after A0 | Small, verified, and each one either wastes tokens or misleads James today. A0 makes every later saving measurable |
| 1: biggest token levers (1-2 weeks) | A16 + A18 (helper agents: side-by-side trials), A4 (replay first), A5, A15, A19, A12, A6, A9, A17, A8, A21, then A13 after its trial | Largest measured effects. Each one is checked against A0's numbers |
| 2: loops converge (2-3 weeks) | B14 and B15 (small, do first), B6, then B2, B3, B5, B7, B8, B9, B10 | B6's telemetry lets B2 and B3 be judged on real runs |
| 3: calm screen (2-3 weeks) | C2, C4, C5, C6+C7 as one wording pass, C10, C11, C3b, C8, C9, A7, the rest of A10, A20 | C10's palette makes the shorter menu safe; C3b after counting non-shell permission denials |
| 4: tooltips everywhere (rolling) | D1b (after D1), D2 → D3 → D4 → D5 tiers → D6 → D8 → D7 → D9 → D10 | Measure, ratchet, building blocks, then migrate one surface per change |
| later (P2) | A11, B11, B12, B13, C12, C13, D11 | Useful, but not before the items above |
| alongside | E1, E2, E3 | Low risk; E3.1 must come before A16; E1's ledger counts come before any change to what the ledger captures |

Each phase becomes its own dated plan, with the normal gates and the fresh-eyes completion gate. Screen checks for phases 3 and 4 run on the Windows PC, or on the Mac only with James's OK; headless test runners are fine.

---

## Decisions for James

James answered all seven on 10 October 2026. The items above now follow these answers.

1. **Product name on screen: "Harness".** The UI currently uses Harness, AIO, Orchestrator and AI Orchestrator; C7's wording pass uses **Harness** everywhere.
2. **Your personal setup in machine-started Claude sessions: keep it as it is.** James: "No, I think it's fine." Loop rounds, reviewers, title-writers and scheduled jobs keep the full global instructions, memory notes, skills, plugins and connectors (about 30-35K tokens per session, mostly cached).
   - A5 is narrowed to changes that don't remove anything from that setup: reviewers can't edit files, resumed sessions keep their cache, and the security plugin is off for machine sessions (Decision 4).
   - Claude's view: not worth pushing back on. The measured saving from trimming connectors and listings is modest (about $0.6-1K a month at list price, mostly cached), much smaller than A4, A14, A15, A16 or A18.
   - One small thing is still worth doing in your own setup whenever convenient: two personal connectors (codex-cli, fal-ai) were failing to connect at every session start.
3. **Codex's helper agents: yes.** Off for loops and the plan queue; a cheaper setting for your own chats; full on request. Try it side by side first (A16).
4. **Security-guidance plugin: yes.** Off for machine-started sessions, kept for your own chats (A5).
5. **Tips while you wait: yes.** One quiet, relevant tip after 30 seconds of waiting, retired once you've used the feature (D11).
6. **Loops that finish "with skipped checks": yes** for ordinary loops you start. The strict rule stays for the plan queue and lifecycle loops (B2).
7. **Agents act on their own recommendation for questions that don't block their task: yes, cautiously** (James: "yes±"). Start with low-risk questions only. Each one shows in the Needs-you list as "decision applied, tell me if wrong" and is one click to reverse. Agents still wait on anything that changes the scope, spends money, deletes data or touches shared resources (B5).

---

## Research coverage

| Report (`_scratch/oct-audit/`) | Scope | Status |
|---|---|---|
| `aio-loop.md` | AIO loop mode, loop database, plan queue | complete |
| `aio-ux-clarity.md` | AIO information architecture, clutter, jargon, screenshots | complete |
| `aio-tooltips.md` | AIO tooltip/help coverage and enforcement | complete |
| `aio-tokens-static.md` | Every prompt AIO builds and every helper call it makes | complete |
| `aio-tokens-empirical.md` | AIO's usage databases, automations, storage | complete |
| `aio-tokens-transcripts.md` | Provider transcripts (first-request size, cache misses, subagents) | complete |
| `ref-actual-claude.md` | Claude Code CLI source snapshot | complete |
| `ref-claude-code.md` | Claude Code changelog since July, plugins, codex-plugin-cc | complete |
| `ref-codex-core.md`, `ref-codex-ux.md` | Codex engine and terminal UI | complete |
| `ref-opencode-core.md`, `ref-opencode-ux.md` | opencode engine and app | complete |
| `ref-t3code.md` | T3 Code | complete |
| `ref-pi.md` | pi | complete |
| `ref-rtk.md` | rtk | complete |
| `ref-hermes-runtime.md` | hermes engine | complete |
| `ref-openclaw-runtime.md` | openclaw engine | complete |
| `ref-agent-orchestrator.md` | agent-orchestrator | complete |
| `ref-omx-slim.md` | oh-my-codex, oh-my-opencode-slim | complete |
| `ref-storybloq-tura.md` | storybloq, tura | complete |
| `ref-mempalace-ob1.md` | mempalace, OB1 (memory) | complete |
| `ref-codepilot-codexdesktop.md` | CodePilot, CodexDesktop-Rebuild (the latter holds no interface source, only version bumps) | complete |
| `ref-jean.md` | jean | complete |
| `ref-openclaw-ux.md` | openclaw interface | complete |
| `ref-claw-nanoclaw.md` | claw-code, nanoclaw | complete |
| `ref-hermes-ux.md` | hermes interface | complete |
| `ref-copilot-sdk-plans.md` | copilot-sdk, superseded Codex context plan (nothing worth reviving), workspace subagents plan (duplicates A5/A18) | complete |
| online-orchestrator | Browser extension; unchanged since January; its approach was already rejected | checked directly, nothing new |

---

## Considered and rejected (this round)

- **Copying Claude Code's in-loop context tricks into AIO** (tool-result budgets, file-read "unchanged" stubs, micro-compaction). The CLIs already run these, and AIO can't edit a CLI's tool results.
- **Hiding the fixed overhead in "context left"**, as Codex's baseline subtraction does. It would hide the instruction and tool tax AIO deliberately shows.
- **LLM-written follow-up suggestions.** Codex removed them within three days: each was a hidden extra model call over the whole conversation.
- **"Ran N commands" roll-ups.** Codex reverted them because they hid failures. Keep each command visible inside the plain-words summary.
- **Wrapping the whole verify run in `rtk err`.** It drops file names and failing test names.
- **Auto-installing RTK hooks globally**, which would edit James's own agent configs. Scope hooks to AIO-started sessions.
- **Time-based "you've been idle" nudges** (agent-orchestrator built them twice and removed both) and first-run onboarding (reverted there too).
- **Codex goal budgets, `thread/queue`, `historyMode` as a token saver, Codex's experimental token-budget mode** (CXC rejected list).
- **opencode's tooltip component** (AIO's is better), and a `?` keyboard overlay (AIO's palette already shows live bindings).
- **Pre-compaction memory-save turns.** Only as an extra section in A1's summary prompt, never as a separate model turn.
- **A "definition of done" card for loops** (hermes HU-3): low value, because the loop leak is the stop rule (B2), not a vague goal.
- **A bare "?" shortcut list** (HU-7): the command palette already shows live bindings.

---

## Verification log

Re-traced by Claude on 10 October, independently of the scout that found each one:
1. **"/goal" start failure.** Builder, then prepare, then the throw (B1.1).
2. **NOTES curation pinned at 24,095 bytes.** The 95-byte header was measured (B1.2).
3. **Loop re-anchor every round.** The loop adapter has no `residentClaude` (A3).
4. **"Compact now" placeholder summary.** The fill gate, a default of 200,000, and no `updateConfig` caller (A1).
5. **ACP system prompt dropped over 4,000 characters, and no OpenCode ownership rule** (A2).
6. **"Close all" with no confirmation**, traced from button to IPC handler (C1).
7. **Session header hides cost** (`[showCost]="false"`) (A10).
8. **Permission denial defaults to "always" behind "Allow"** (C3).
9. **Start-of-run verify off by default** (B3).
10. **Clean-pass rule, and whole-tree change detection** (B2).
11. **Fresh-eyes reviewer usage dropped** (B6).
12. **Orchestration guide size, and it is skipped on the usual start path** (A12).
13. **RTK pinned at 0.39.0, and RTK off in auto-approve sessions** (A13).
14. **RTK `git cat-file` burst**, by project and by hour (A13.6).
15. **Ping-pong nits rule**, plus a database check that no run ended on that path (B7).
16. **Output persistence unwired** (`flushOutputBuffer` has no caller).
17. **"Second opinion" review on by default**, with its trigger rules and cooldown (A14).
18. **Codex helper-agent version resolution, and the model catalogue marks** (A16.1).
19. **Claude cost stored from `total_cost_usd` per turn** (A0.1).
20. **Loop database headline numbers**: clean finishes by month; dollars by outcome; outstanding items.
21. **Sizes of instruction files, the memory index and plugins**, and `ENABLE_TOOL_SEARCH=auto:0` in James's settings.
22. **Context-evidence safety mode defaults to off for every provider** (`settings-defaults.ts:21-29`) (A4).
23. **The model-switch notice says "Conversation context has been preserved"** (`runtime-change-notices.ts:79`), while a Claude replay keeps only the last 24 turns (`replay-continuity.ts:3`) (A8.3).
24. **The two automations switched off by the five-failure stop** are stale one-time "resume after Codex quota reset" wake-ups that failed because their session was already busy (read-only query of the automations table) (A15).
25. **No sleep prevention anywhere** (0 references to `powerSaveBlocker` or `caffeinate` in `src/`; `powerMonitor` used in 4 production files) (B14).

Corrections made before v2:
- **A12.** v1 said every fresh session pays the 14 KB guide. In fact the usual start path skips it entirely (found by the oh-my-codex scout, then confirmed here).
- **"Already done" table.** It listed output persistence; that code is unwired, so it moved to "Built but never connected".
- **Counts.** v1 said 11 enabled plugins and 16 skills; the correct figures are 5 enabled and 15. `~/AGENTS.md` is not counted in the Claude overhead (it loaded in one session but not another).
- **A4's Claude lever.** It is the environment variable `CLAUDE_CODE_AUTO_COMPACT_WINDOW`; a settings key is unconfirmed.
- **RTK `cat-file` burst.** Reframed as a probable scheduled script whose output may not have reached a model.

Corrections from the independent fact-check of the summary, headline numbers and sections A-B (`_scratch/oct-audit/_verify-A-B.md`: 5 must-fix, 14 should-fix, 19 nits, all addressed):
- **Summary.** "Loops are the biggest leak" was wrong for today: loops haven't run since 22 September. Helper agents and untrimmed conversations are now the biggest sinks, and the summary leads with them.
- **Claude cost comparison.** "$409,452 vs $21,333 when the tokens are priced" was mislabelled. $21,333 is Claude's own running total turned back into per-turn amounts; pricing AIO's stored tokens gives about $5.2K.
- **Helper models.** "Only 40 Anthropic fallback calls" counted only the recorded calls; 5,456 escalations recorded nothing.
- **`ENABLE_TOOL_SEARCH=auto:0`.** It matches Claude Code's default, so removing it would change nothing.
- **September end states.** Only 5 of the 9 September "paused for review" endings were at the first step, and only 3 are the path that still exists.
- **Smaller fixes:**
  - personal setup measured at about 30-35K tokens, not 20K;
  - the cache-write share for idle returns is about a third, not 51%;
  - RTK's own study saved input but not money;
  - the security-plugin claim was softened;
  - the `/goal` fix no longer suggests a default spend cap;
  - "every loop round" corrected to "every Claude loop round";
  - the broken MCP servers are codex-cli and fal-ai, not chrome-devtools;
  - the summary was rewritten in plainer words.

Corrections from the second independent fact-check of sections C-E, the late additions and the rewritten summary (`_scratch/oct-audit/_verify-C-E.md`: 2 must-fix, 11 should-fix, 25 nits, all addressed):
- **Per-subagent totals.** Claude's per-subagent totals are the size of the subagent's last request, not what it processed. Recording them gives visibility, not spend (A0).
- **Decision 2.** It now keeps each scheduled job's own connectors (27 of 47 enabled automations use email), and A17.5 keeps one IMAP server reachable.
- **"Allow".** The dropdown and hint beside it are now described. C3 is split into a small labels-and-default fix (C3a) and a separate in-turn answering item (C3b, M).
- **Model-switch notice.** It is a Claude-only problem, and what carries over is the last 24 messages, not "a summary".
- **"Close all".** It is traced to end sessions without confirmation, but whether running loops stop is untested, so the dialog wording waits on that check.
- **CodePilot references.** The swapped IDs are fixed (CP-2 is the helper back-off, CP-5 the notifications).
- **E1.** It now respects the existing 30-day sweep and 2-backup limit, and asks before deleting backups.
- **A15's schedule limit.** It now carries nanoclaw's caveats (agent-created automations only; start above 24 a day).
- **A18.** It now warns that the subagent-model setting may override reviewers.
- **Suggested order.** It now places every item, including a P2 row.
- **Smaller fixes:**
  - mid-September, not late;
  - 4 production `powerMonitor` files, not 15;
  - 10 worktrees, not 11;
  - 17 opencode tooltip uses, not 46;
  - about three-quarters of open questions;
  - item order.
