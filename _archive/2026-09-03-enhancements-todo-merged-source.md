# Enhancements TODO — AI Orchestrator

Merged 2026-09-03 from four untracked root-level backlog files, newest first:
`grok.md`, `codex_aug_todo.md`, `fable_aug-todo.md`, `fable_todo2.md`. Those files
were deleted after the merge. Each part below is the original document verbatim; the
only mechanical change is that every heading was demoted one level so this file has a
single title. When a part refers to one of the old filenames, read that as the matching
part of this file.

| Part | Former file | Generated | What it owns |
|---|---|---|---|
| [Part A](#part-a-grok) | `grok.md` | 2026-08-31, deepened through 2026-09-03 | Current forward plan and wave order: T1–T45, L1–L14, UX1–UX18, discovery gates 1–39, sibling constants |
| [Part B](#part-b-codex) | `codex_aug_todo.md` | August 2026 | Resource attribution, convergence benchmark, Loop-intervention receipts, intent presets, causal timeline, tooltip primitive (Waves 0–3) |
| [Part C](#part-c-fable-aug) | `fable_aug-todo.md` | 2026-08-20 | T1–T5 token bugs, L-A–L-F loop robustness, E-A–E-I token-economy architecture, UX1–UX9 tooltip plan |
| [Part D](#part-d-fable-todo2) | `fable_todo2.md` | 2026-07-30 | Settings overhaul S1–S5, proposed defaults, loop L1–L12, general UX U1–U17, reference defaults appendix |

**Reading order.** Part A is the current plan and index: it re-verified the earlier
sweeps against the 2026-09-02/03 tree, records corrections to their counts and line
numbers, and holds the delivery order (Waves 0–6) plus a mapping table from Part C's
item IDs to its own. Parts B–D still own unimplemented work that Part A deliberately does
not re-list. Start at Part A's "Delivery order" if you just want what to build first.

**Item IDs are per part.** T1–T5, L1–L12, and UX1–UX9 are reused with different meanings
across parts (for example Part D's L1 is loop terminal-state notifications; Part A's L1 is
the same-session idle nudge). A bare ID means the numbering of the part it appears in.
Part A's "Mapping from fable_aug-todo.md" table reconciles Part C's IDs.

**Lifecycle.** This is an active, untracked plan seed. Where Part A says to rename the
file to `grok_completed.md` before committing, read that as
`enhancements_todo_completed.md`. Do not commit this file until the documented work is
implemented and verified.


---

<a id="part-a-grok"></a>

## Part A · `grok.md` — AIO forward plan: token economy, loop quality, UX clarity

> Source: `grok.md` (2026-08-31, deepened through 2026-09-03). Verbatim; headings demoted one level.

**Status:** active plan seed. Untracked (`git status` shows `?? grok.md`). Do not
commit until implementation is complete and this file is renamed `grok_completed.md`.

**Generated:** 2026-08-31. **Re-verified + deepened:** 2026-09-02–03 (five passes +
replay Iteration 0 + replay Iteration 3 + **this-loop Iterations 0–2**).
Method: re-read AIO's current loop/token/UX source, then fan out sibling audits
(token economy, loop robustness, tooltip/UX) across every project in
`/Users/suas/work/orchestrat0r` except AIO itself. Every "AIO lacks X" claim below
was re-checked against today's tree, not against the July/August todo files.
See **§ 2026-09-02 deltas** (morning pass), **§ 2026-09-02 late pass**
(capability-aware T1/T2, intra-iteration waste, sibling constants grok.md
missed the first time), **§ 2026-09-02 evening pass** (dead `reviewStyle`,
unbounded cost-cap revert, third compaction stack, Hermes 24h cache, oh-my-codex
ultragoal steering), **§ 2026-09-02 night pass** (sibling constant
re-read, ACP/Cursor resume trap, uncapped-vs-60k fresh-eyes diff, UX recount),
**§ 2026-09-02 fresh-eyes pass** (1M "keep working" nudge vs null token
cap; cheap-classify aux tax; **T28** ledger-complete vs review-driven;
**T29** ping-pong verify excerpt is head-only oxlint noise;
**T30** `runVerifyTwice` is gated-only;
**T31** default continuation prompt auto-enables cross-model review;
**T32** review-driven never sends `iterationPrompt` to the child;
**T33** closed LOOP_TASKS.md re-opens a ping-pong reviewer every later iter;
**T34** T2 skip has no coordinator seam — `justRecycled` is not a symbol;
**T35** adapter caps are chosen after `buildPrompt` and live in a private invoker map;
**T1a occupancy lock** recycle uses `currentTokens/tokenLimit`, not conversation-only;
**T36** last-iter Claude snapshot + invoker model-switch recycle must reanchor the goal),
and **§ 2026-09-02 replay Iteration 0** (**T37** isolation `skipInstall`;
**T38** user-started audit defaults contradict engine; **T39** 50k rehydrate vs
OpenClaw 2.8k; **UX11** ping-pong silently forces review-driven; **UX12** recipe
row dead on default mode; sibling deep-pins from CodePilot/claw-code/rtk/OB1/
nanoclaw/mempalace/oh-my-codex/openclaw/t3code/Actual Claude),
and **§ 2026-09-02 replay Iteration 3** (**UX13** clean-reviews control unused
under default ping-pong; **UX14** rename-gate auto-enabled but only gated
enforces; **T37 addendum** missing-deps verify classified as test failure;
Hermes `.worktreeinclude` as cheaper dep strategy),
and **§ 2026-09-02 this-loop Iteration 0** (**T40** `maxToolCallsPerIteration`
never stops a loop; **T41** Loop model ship-defaults + "Session default" lie;
**T42** shared verify artifacts + Vitest cache false-red; **UX15** Settings
search cannot find the Loop model picker; **UX16** review-driven HUD still
advertises PLAN/REVIEW/IMPLEMENT),
and **§ 2026-09-03 this-loop Iteration 1** (**T41 correction** Grok has no
balanced catalog row; **T43** balanced routing pass-through sends Claude
`sonnet`/`haiku` to Grok, adapter repairs to flagship `grok-4.6`; Antigravity
missing from `CLI_TO_PROVIDER_TYPE`; **T44** shared-checkout verify races
concurrent writers of untracked loop files),
and **§ 2026-09-03 this-loop Iteration 2** (**T45** default-on cap wrap-up is a
silent +1 paid iteration, tools-disable Claude-only and Edit/Write stay on;
**L14** review-driven never pauses after auto-unstick's 2-strike cap;
**UX17** issue card promises a pause review-driven will not do;
**UX18** auto-unstick and wrap-up have no HUD chip, tooltip, setting, or help).

**This is not a rewrite of the earlier sweeps.** Those still exist and still have
unimplemented work. Read them when the matching wave starts; do not re-propose their
items here.

| Existing doc | What it still owns | How this file relates |
|---|---|---|
| `fable_todo2.md` (2026-07-30) | Settings overhaul S1–S4, general UX U1–U17, loop UX L1–L12 | Still the settings bible. This file only adds the pieces that block token/loop/tooltip work. |
| `fable_aug-todo.md` (2026-08-20) | T1–T5 token bugs, L-A–L-F loop ideas, E-A–E-I architecture, UX1–UX9 | T1/T2/T3 and the "no tooltip primitive" claim are **still true**. Counts and a few sibling facts are stale (see corrections). |
| `codex_aug_todo.md` | Attribution / intervention-receipt backlog | Keep for Wave 0 resource-view work. Do not revive completed loop machinery. |
| `docs/plans/2026-08-28-settings-ux-remediation_plan.md` | Settings shell IA (Remote Nodes, Permissions, Aux, Ecosystem, Advanced) | Complementary. Does **not** add a tooltip primitive or settings-row search. |
| `docs/plans/2026-02-22-token-memory-optimization-plan.md` | Older ContextCompactor / smart-compaction work | Six months old, not `_completed`. Reconcile before touching `src/main/context/`. |

---

### Executive direction

AIO already has a serious Loop Mode. Completion is evidence-gated, not a promise-string
match. Same-session reuse is the default. Occupancy-truthful recycle exists. NOTES.md is
curated. PLAN-stage prior context is budgeted. RTK is bundled and on by default. Cheap
aux routing exists. The HUD already has a status pill, completion-gate chips, ping-pong
strip, and always-visible config hints.

The remaining waste is not "we need another agent loop." It is four specific gaps:

1. **Same-session context never recycles for resume-capable providers** (Copilot exec,
   Claude non-resident, ACP, most Codex), so long loops rot and re-bill an unbounded
   transcript (T1 / T1a). Gemini/Antigravity are exec-per-message — recycle cannot
   help; their waste is the per-spawn scaffold (T11).
2. **The loop prompt re-sends the full goal (and prior-observations) every iteration**
   even when a *proven* persistent session already has them (T2). Blind-gating on
   `contextStrategy` alone is unsafe after recycle and for `supportsResume: false`.
   The constitution (T12) and a moving system reminder (T13) re-pay even more.
3. **The loop is excellent at not stopping early and weak at not spending the next
   iteration** when the child is idle-without-done, waiting on a process, or re-claiming
   done on an unchanged tree (and it currently pays verify **twice** by default).
4. **The UI explains pages, not controls — and Help does not explain Loop Mode at
   all.** There is a Help pane and inline hints, but no shared tooltip primitive and
   no Loop article. Icon buttons, status dots, and the loop HUD still speak in native
   `title=` or in color alone.

Build in that order. A tooltip system on top of a loop that silently never recycles is
polish on a leak.

---

### Sibling coverage (every project in the folder)

Excluded from adoption: `userdata`, `worktrees`, `_scratch`, `ai-orchestrator-plans`
(planning corpus only), `CodexDesktop-Rebuild` (patch harness, no product UX).

| Sibling | Examined for | Transfer |
|---|---|---|
| `rtk` | Command-output compression, gain ledger, awareness prompt | Keep using. Measure **rounds + uncached input**, not `rtk gain` %. `rtk/src/analytics/README.md` is explicit: stored % = output **bytes**; token counts are `bytes/4` estimates, **not billed tokens**. Make Codex/Gemini actually prefix `rtk`. Surface bypass count as a loop diagnostic, never a savings trophy. |
| `hermes-agent` | Micro-compaction, cache boundary, native compaction, WAIT/park, composer queue, anti-thrash, `.worktreeinclude` | Steal: reclaim+rearm prune, stable-prefix registration, WAIT-on-pid, **2-strike/300s compact anti-thrash**, lineage-stable cache key, **`.worktreeinclude` symlink of `node_modules/`** (T37 Wave 1). **Do not** copy per-turn micro-compaction (breaks cache every turn). |
| `opencode` | Cache policy, tool-output prune, truncate-to-disk, tooltip, small_model, session status | Steal: mid-history prune constants (AIO already has them on the *instance* buffer — apply to loop CLI), truncate-to-spill, tooltip delay + keybind chip + structured model tooltip. |
| `openclaw` | Mid-turn tool-result guard, continuation-skip, steering leases, bounded queues, Labs, tooltip policy, form tiers | Steal: pre-submit overflow check, lease/ack interventions, bounded pending-hint queue, Labs honesty, `aria-describedby` tooltip, common/advanced tiers. |
| `storybloq` | Health model, session diagnostics, park-item, artifact freshness | Steal: alive≠progressing≠waiting-on-build, named non-convergence diagnostics, fail-open freshness, park a defective ledger leaf. |
| `copilot-sdk` | `session.idle` vs `task_complete`, autopilot nudge, live steer | Steal: same-session idle-nudge. Live steer is L and provider-gated. |
| `agent-orchestrator` | Reaper mass-death breaker, Radix tooltip, FieldDefaultHint, collapsed-rail tooltips | Steal: fail-open probe policy, tooltip primitive shape, "inherited default" caption. |
| `codex` (`codex-rs`) | `compact_remote`, token-budget compact, context-window metadata | Already partially wired. Steal token-budget compact as the loop recycle analogue (no summarizer turn). |
| `codex-plugin-cc` | Job phase inference, stop-review gate | Steal: cheap intra-iteration phase from tool/command lines. Stop-gate is optional later. |
| `t3code` | Settings row + reserved reset, settings search catalog, status-dot contract, no-native-title lint | Steal: the settings row/search/lint. Strongest settings UX in the folder. |
| `jean` | Preferences Fuse search, per-task model routing, feature tour, MCP status hints | Steal: search-to-row + keywords. **Do not** copy defaulting context-summary to Opus. Tour is last. |
| `Actual Claude` | Tip registry (behavior-gated), status notices with a named fix | Steal: relevance + cooldown + "run X to fix". |
| `CodePilot` | Aux-model cross-provider fallback, honest context badge, getting-started bar | Steal: borrow a cheap model from another connected provider; never show `∞%`. Delay=0 tooltips are the wrong policy. |
| `tura` | Structured checkpoint (no summarizer), stable tool-result cache ids | Steal: structured handoff on recycle. GUI is native `title=` — same gap AIO has. Negative: RTK % ≠ bill (their blog). |
| `pi` | Compaction hooks, retain-user-asks, reserve/keep-recent budgets | Steal: reject a summary that drops identifiers; keep the goal verbatim across recycle. |
| `nanoclaw` | Bounded always-on memory files | Already copied into `wake-context-builder.ts`. Tighten caps; don't dump more memory. |
| `mempalace-reference` | L0/L1 wake budgets | Already copied. Optional: pre-compact mine, only if re-injection stays capped. |
| `oh-my-opencode-slim` | Cache-safe injection (volatile tail only), background-job context eviction | Steal: property-test the loop prompt prefix; evict a bloated reused CLI session. |
| `oh-my-codex` | External goal-snapshot reconciliation, HUD objective strip | Steal: HUD language. External `get_goal` snapshot is M and provider-inconsistent. |
| `oh-my-opencode-slim` | See above | — |
| `claw-code` | Compact thresholds, never-split tool pairs, 1200-char summary budget | Steal: cap the summary so it cannot become a second transcript. |
| `claude-code` | Ralph Wiggum plugin | **Negative lesson.** Same-prompt Stop-hook loop with only a raw iteration cap. AIO already inverted this. Do not copy. |
| `online-orchestrator` | Parallel multi-provider then merge | Optional: one third-model break of ping-pong deadlock. Not a loop engine. |
| `OB1` | Skills vs recipes, provenance memory | Adopt only bounded, source-attributed memory proposals. No loop engine. |
| `hermes-agent/apps/desktop` | `Tip`, `OverflowTip`, skip-delay 0, keyboard-only focus-open | Best desktop tooltip policy in the folder. Copy the *policy*, not React. |
| `storybloq` | See above | Operator language is CLI diagnostics, not a GUI. |

---

### Current AIO baseline (re-verified 2026-08-31)

#### Already shipped — do not re-implement

| Mechanism | Where |
|---|---|
| Occupancy-truthful recycle (known samples only) | `src/main/orchestration/loop-context-discipline.ts:75-137` |
| Same-session default | `loop-config-panel.component.spec.ts` ("defaults each loop iteration to same-session") |
| Existing-session context gated after iter 0 | `loop-stage-machine.ts:483-486` |
| PLAN-stage prior context, 1,500 tokens, once | `loop-prior-context.ts`, injected only when `iterationSeq === 0` |
| NOTES.md curation cap 24k | `loop-stage-markdown.ts` |
| Hard token/cost/iteration/wall caps | `loop-coordinator.ts`, `loop.types.ts` — **cost default is `null` (unbounded) as of 2026-09-02**, not 3000¢. Iteration default 50, wall default 50h. UI `maxDollars` also starts null. |
| Work-hash + A–I progress + doom-loop + review-stall | `loop-progress-detector.ts`, `loop-work-hash.ts`, `doom-loop-detector.ts`, `loop-review-stall-policy.ts` |
| Review-driven + gated completion, ledger authority, `MORE_WORK_REMAINING` | `loop-completion-detector.ts` |
| Ping-pong review + issue ledger | `loop-pingpong-completion.ts` |
| Cheap-model classification for loop chores | `invocation-model-resolver.ts` |
| RTK rewrite hook + bundled binary + awareness prompt | `cli/hooks/rtk-defer-hook.mjs`, `cli/rtk/rtk-runtime.ts`, `rtk-awareness.ts` (`rtkEnabled: true`) |
| Instance-buffer prune (OpenCode constants) | `src/main/context/context-compactor.ts` — **not** the loop CLI transcript |
| Prompt-injection contract + day-stable ages | `prompt-injection-contract.ts`, `format-age.ts` |
| Cache-TTL idle trigger | `loop-context-survival.ts:14-20, 285-298` |
| Mempalace-style wake budget | `wake-context-builder.ts` |
| Codex native compact + Anthropic `context_management` | `compaction-coordinator.ts`, `memory/context-editing-fallback.ts` (API path) |
| Help pane + inline help + settings tab help | `shared/help/help-pane.component.ts`, `inline-help.component.ts`, `settings/help/settings-help.ts` |
| Loop config always-visible `<span class="hint">` | `loop-config-panel.component.html` — **keep these; do not convert to hover** |
| `shortcutHint` pipe (live keybind registry) | `shortcut-hint.pipe.ts` |
| `SettingsStore.resetOne()` + IPC | `settings.store.ts:327` — **zero UI callers** |
| Stream-idle as advisory only | `loop-invocation-activity.ts` |
| Steer downgraded to next-iteration, honestly | `loop-coordinator.ts:1430-1444` |

#### Verified gaps that are still open

These were claimed in `fable_aug-todo.md` on 2026-08-20. Re-read today. Still true.

---

## Part 1 — Token waste (highest leverage)

Ranked by tokens saved on a real same-session loop, not by architectural elegance.

### T1. Recycle never fires for resume-capable aggregate-only adapters [CONFIRMED]

`shouldRecycleLoopContext()` returns `recycle: false` for any `unknown` observation
(`loop-context-discipline.ts:100-107`). That is correct after the old "3500% utilization"
bug. The leftover hole:

| Adapter | Occupancy | Recycle in same-session? |
|---|---|---|
| Claude CLI, resident session | `known` via `getLastContextUsage()` | Yes, when used/total ≥ `resetAtUtilization` (default 0.6) |
| Claude CLI, non-resident | `aggregate-only` | Never |
| Gemini | always `aggregate-only`; **also `supportsResume: false`** (`gemini-cli-adapter.ts:149-169`) | Recycle is a no-op — there is no transcript. Waste is per-spawn scaffold (T11) |
| Antigravity | `supportsResume: false` (`antigravity-cli-adapter.ts:145`) | Same as Gemini |
| Copilot exec mode | `aggregate-only` (`copilot-cli-adapter.ts:268`) | Never |
| Copilot **server mode (WS14)** | HUD gets real `session.usage_info` → `emit('context')`, but **`getLastContextUsage()` is still the base `not-reported`** | **Never** (see T1a) |
| ACP (Cursor/Grok path) | always `aggregate-only` (`acp-cli-adapter.ts:372`) | Never |
| Cursor CLI (direct) | HUD gets **estimated** cumulative (`isEstimated: true`, `cursor-cli-adapter.ts:836-857`) | Never — do not promote estimates to `known` |
| Codex app-server with `lastTurnTokens > 0` | `known` via override | Sometimes |
| Codex otherwise | `unknown` / `aggregate-only` | Never |

`contextStrategy` defaults to `'same-session'`. Net: a **Copilot exec** (`supportsResume:
true`) or Claude/Codex persistent loop can run 50 iterations in one growing CLI
transcript with **no orchestrator recycle**. The UI toggle "Recycle context on long
runs" (`loop-config-panel.component.html:338-340`) is then a lie for those providers.

**Gemini / Antigravity are a different bug.** Both advertise `supportsResume: false`
and `sameThreadContinuation: false` (Gemini `gemini-cli-adapter.ts:149-169`). Each
iteration is a fresh CLI process. Recycle cannot help because there is no provider
transcript to recycle. Their waste is the **full loop scaffold + RTK awareness +
CLI-loaded GEMINI.md/AGENTS.md on every spawn** (see T11), not an unbounded
same-session window. Do not plumb Gemini last-turn tokens into `getLastContextUsage()`
— that would invent occupancy (the 3500% class).

**Fix (do all three, in this order):**

1. **T1a — Plumb occupancy that already exists** (see dedicated section below). Smallest
   real win: Copilot WS14 already maps `currentTokens`/`tokenLimit` for the HUD and
   never feeds recycle.
2. **Ceiling recycle** when occupancy is unknown: recycle every N iterations or every
   M aggregate tokens, conservative, logged as `occupancyUnavailable + ceiling`. OpenClaw's
   `maxActiveTranscriptBytes` is the same idea with a byte cap.
3. **Plumb cheaper occupancy** where the CLI already has it (Codex app-server usage
   events; Claude `/compact` / status). Do not invent a fake `known` sample from
   cumulative tokens — that is the bug WS4 removed.

**Size:** M. **Risk:** medium (premature recycle loses cache; too-late recycle is today's
bug). Pair with Tura-style structured handoff (T6) so recycle is cheap.

**UI:** the recycle toggle must say which providers can honour it. If the selected
provider is aggregate-only, show the ceiling ("fresh session every 8 iterations") and
why.

### T1a. Copilot WS14 occupancy reaches the HUD but not recycle [NEW 2026-09-02]

Confirmed in today's tree:

- `copilot-server-event-mapper.ts` maps `session.usage_info` → `{ kind: 'context', used, total }`
  and comments call it "REAL context occupancy — a major upgrade over exec mode."
- `copilot-server-turn-bridge.ts` calls `host.emitContext({ used, total, source: 'provider-usage' })`.
- `copilot-cli-adapter.ts` wires that to `this.emit('context', usage)` for the renderer.
- `getContextCapabilities()` still advertises `occupancyReporting: 'aggregate-only'` even
  when server mode is active (unlike Codex app-server, which flips to `'current'`).
- There is **no** `override getLastContextUsage()` on the Copilot adapter. Base returns
  `{ status: 'unknown', reason: 'not-reported' }`.
- Loop recycle exclusively reads `adapter.getLastContextUsage()` via
  `evaluateLoopContextDiscipline` (`loop-context-discipline-runtime.ts:40-42`).

So the provider already tells AIO the window; the recycle path never looks. Mirror the
Codex app-server pattern: store last `{ used, total }` on context effects, override
`getLastContextUsage()` when server mode is live, and advertise `occupancyReporting:
'current'` only in that mode. Keep exec mode aggregate-only. Do **not** invent occupancy
from cumulative token sums.

**Locked occupancy contract (do not implement the late-pass "conversation-only" line).**
copilot-sdk `SessionUsageInfoData` (`zsession_events.go:491-506`) and the public
docs (`usage-and-billing.md:249-260`) define:

| Field | Meaning |
|---|---|
| `currentTokens` | Tokens **currently in the context window** (the overflow number) |
| `tokenLimit` | Max window |
| `conversationTokens` | Non-system messages only (user / assistant / tool) |
| `systemTokens` / `toolDefinitionsTokens` | Static-ish overhead that recycle **re-injects** |

`shouldRecycleLoopContext` keys off `used/total` (`loop-context-discipline.ts`).
The mapper already feeds `{ used: currentTokens, total: tokenLimit }`
(`copilot-server-event-mapper.ts:112-119`). Recycle **must** keep that
numerator. `conversationTokens / tokenLimit` undercounts system + tools; a
40k schema plus a growing transcript can sit at the real window limit
while conversation-only % stays below `resetAtUtilization`.

The late-pass fear (recycle because of a static 40k tool blob) is an
**anti-thrash** rule, not a different occupancy fraction:

- Recycle when `currentTokens / tokenLimit ≥ resetAtUtilization`.
- **Skip** recycle when a new session cannot drop occupancy: conversation
  is small **and** `(systemTokens + toolDefinitionsTokens) / tokenLimit`
  is already ≥ the threshold (Hermes 2-strike / 300s). Log
  `static-overhead` and fall through to T1.2 ceiling-by-iteration.
- HUD may show the split. The recycle chip uses full-window %.
- Still ignore `session.usage_checkpoint` (billing/resume, not a window).

**Size:** S. **Risk:** low if gated on server-mode + positive total. Highest-leverage
T1 sub-item because the data path already exists.

### T2. Goal + prior-observations re-injected every iteration in same-session [CONFIRMED]

`loop-stage-machine.ts:487` builds `goalBlock` unconditionally. `:463-465` and `:584-586`
build `priorObservationsBlock` the same way. Two blocks below, `existingSessionContextBlock`
already uses the correct gate:

```
isFirstIteration || config.contextStrategy !== 'same-session'
```

The team knows the pattern and applied it once. Same-session loops therefore re-pay the
full `initialPrompt` (and any prior-run observations) on every iteration of a persistent
conversation that already contains them. That also moves a volatile block *before* the
stable instruction tail and hurts cache hit rate (see E-B).

**Fix (do not ship the naive gate).** Applying the same
`isFirstIteration || contextStrategy !== 'same-session'` test that
`existingSessionContextBlock` uses is **unsafe**:

- After recycle / `forceContextReset` / `justCompacted`, the persistent adapter is a
  new window that never saw iter 0 (`loop-coordinator.ts:2708-2715`,
  `default-invokers.ts:1267`).
- Gemini / Antigravity "same-session" is an adapter-object reuse, not a provider
  conversation (`supportsResume: false`). Dropping the goal on iter 1+ leaves them
  with only NOTES.md.
- Copilot advertises `supportsResume: true` **and** `sameThreadContinuation: false`
  (`copilot-cli-adapter.ts:251-272`). `--resume` reattaches a session id; it is
  not a proven iter-0 window. Cursor CLI and ACP `loadSession` are the same
  trap (T23). Dropping the goal there is a regression — the stage machine
  keeps it today for that reason (`loop-stage-machine.ts:478-481`).

**Locked skip gate (T23).** Skip `goalBlock` + `priorObservationsBlock` only
when all of these are true:

`supportsResume && sameThreadContinuation && !pendingContextReset && !justCompacted && iterationSeq > 0`

Those last two names are the real flags (`loop-completion-context-store.ts`,
`state.justCompacted`). There is no `justRecycled`. The stage machine cannot
evaluate this today — see **T34**.

Apply the same predicate to `buildReviewDrivenPrompt` (goal is unconditional
at `:634-635`; that is the default user-started mode).

| Adapter | Skip goal on iter 1+? |
|---|---|
| Claude resident / Codex app-server (`sameThreadContinuation: true`) | Yes, unless just recycled |
| Copilot exec (`--resume`), Cursor CLI, ACP `loadSession` | **No** — resume ≠ same thread |
| Gemini / Antigravity / Codex exec / Claude non-resident | **No** — `supportsResume` or `sameThreadContinuation` is false |

Do **not** implement from the morning gate (`supportsResume && !forceContextReset`
alone) or from the "Copilot exec skips after iter 0" first-PR line. Those
contradict this table and the adapter contract. T8 prefix-split, T12
continuation-card, and T19 OUTSTANDING-schema skip use **this same gate** —
not `contextStrategy === 'same-session'` and not `supportsResume` alone.

**Size:** S (the gate) / M (capability plumbing + tests).

### T3. Interactive cost-cap settings do not apply to loop mode [CONFIRMED]

`cumulativeTokenCompactionTrigger` / `contextWarningThreshold` feed
`getCompactionCoordinator()`, which tracks `InstanceManager` instances.
Loop persistent adapters live in `persistentLoopAdapters` (`default-invokers.ts`) and
are never registered there. Loop uses its own `resetAtUtilization` (default 0.6).

Not a logic bug — two strategies. It is an invisible one. A user who sets a global
cost-cap thinks loops are bounded by it.

**Fix now:** surface it. Loop-config recycle row + Settings compaction rows need a
structured tooltip / inline note: "Loop Mode uses its own recycle threshold, not this
setting." Ties to Part 3.

**Fix later:** one resource view (see `codex_aug_todo.md` Wave 0) that attributes
adapter / review / verify / recycle separately and never treats `caps.maxTokens` as a
context window (`loop-context-survival.ts` still falls back that way in places).

**Size:** S (copy) / L (unify).

### T4. `action:'micro'` on loop transcripts is a documented no-op [CONFIRMED]

`loop-context-survival.ts:256-278` is explicit: there is no coordinator-owned turn list
for any `contextStrategy`, so `Microcompact.compact()` cannot run on the child CLI
transcript. `action:'micro'` writes a log line. Instance-scoped `ContextCompactor`
prune (`context-compactor.ts`) does not touch loop same-session history.

Do not celebrate "micro" in loop telemetry. Either drive prune inside the adapter /
child CLI, or stop calling it a compact.

**Size:** M to make it real; S to stop lying in the log.

### T5. RTK is on, but Codex/Gemini/Copilot compliance is advisory [CONFIRMED]

Claude gets a PreToolUse hook that rewrites `git status` → `rtk git status`
(`rtk-defer-hook.mjs`). Everyone else gets `RTK_AWARENESS_PROMPT` prepended every turn
(`rtk-awareness.ts:12-23`) and is trusted to prefix `rtk`.

Tura's own write-up (`tura/docs/blog/token-saving-plugins-the-denominator-matters.md`):
compressing a shell fragment does not cut the bill if the agent takes more rounds.
JetBrains + RTK in their numbers: **+7.6% cost, +13.8% turns** at low effort.

**Fix:**

1. Keep the Claude hook. For Codex/Gemini/Copilot, prefer a provider-native hook or a
   shell wrapper in the spawn environment over hoping the model cooperates.
2. Feed `rtk gain` into the loop inspector as a "commands that bypassed RTK" signal,
   not as a savings trophy.
3. Never treat `rtk gain` % as loop-cost reduction.

**Size:** M.

### T6. Structured handoff on recycle, not a summarizer turn [from tura / claw-code]

Tura rebuilds provider messages from a compact `context_cache` (stable `cache_id`,
reporting fields stripped) — no standalone summarizer LLM call
(`tura/crates/runtime/src/context/tool_results.rs`, `docs/core/context-management.md`).
Claw-code caps the summary at 1200 chars / 24 lines / 160 chars per line
(`claw-code/rust/crates/runtime/src/summary_compression.rs`).

AIO recycle today is a **fresh window + bounded rehydrate**. That is the right cheap
shape (Codex `compact_token_budget.rs` agrees: skip the summarizer). What is missing is
a **structured checkpoint** the next session must read: goal, open ledger leaves,
last verify result, files touched, decisions. Rehydrate already caps files; the content
is still prose NOTES.md.

**Fix:** on recycle, write a machine-readable `HANDOFF.json` (or a tight markdown
schema with required headings) and tell the next iteration to treat that as the
re-anchor, not a literary summary. Pi/OpenClaw quality-guard: reject a handoff that
drops the goal text or ledger ids.

**Size:** M.

### T7. Mid-turn overflow precheck + old-tool prune + truncate-to-disk [from openclaw / opencode / hermes]

Three stacked, non-LLM levers, in order:

1. **At tool return:** cap result size, spill full text to disk, return a preview
   (opencode `packages/opencode/src/tool/truncate.ts` — 2000 lines / 50 KiB).
2. **After tools, before the next model call:** if the prompt no longer fits, truncate
   or compact+retry instead of submitting overflow (openclaw
   `tool-result-context-guard.ts`). AIO currently compact-on-failure
   (`instance-communication.ts`), which still pays the doomed request.
3. **Episodic prune of old tool bodies** once reclaim ≥ a floor, then rearm so you
   do not bust the cache prefix every tool (hermes `proactive_prune_min_reclaim_tokens`
   + growth interval; opencode `PRUNE_MINIMUM=20k` / `PRUNE_PROTECT=40k`). AIO already
   has those constants on the instance buffer. They must run against the **child
   session**, or they do not exist for loop mode.

**Size:** L (adapter-internal). Do after T1/T2.

### T8. Stable-prefix / volatile-tail for the loop prompt [from hermes / oh-my-opencode-slim / opencode]

Providers cache exact byte prefixes. T2 is the first violation. The loop prompt also
embeds iteration number, stage, remaining caps, and pending interventions in the
*head* (`renderSystemReminder` is injected inside Step 1 at
`loop-stage-machine.ts:516`, not at the tail). **There is no wall-clock timestamp**
in that reminder (`loop-stage-prompt-helpers.ts:35-51`); `formatAge` on learnings is
already day-stable. The earlier "timestamps in the head" claim was stale. The live
cache-busters are `# Loop Mode — Iteration ${n}`, stage, `Caps remaining` (cumulative
loop spend, not window occupancy), and every-10th-iter open-ledger dump (T13).

Hermes registers a stable scaffold and places `cache_control` at the volatile tail
(`agent/prompt_cache_boundary.ts`). Slim strips tagged volatile parts and re-appends
them last (`cache-safe-injection.ts`). OpenCode puts Anthropic breakpoints at last
tool def + last system + latest user message (`packages/llm/src/cache-policy.ts`).

**Fix:** split loop prompts into (1) immutable rules + goal and (2) a trailing
board: stage, iteration, interventions, occupancy note. The goal leaves the
stable prefix only when the T23/T34 skip is true (`supportsResume &&
sameThreadContinuation && !pendingContextReset && !justCompacted &&
iterationSeq > 0`). Copilot exec, Cursor CLI, and ACP `loadSession` keep the
goal in the prefix. Property-test that the prefix bytes are identical across
two **same-thread** iterations with only the tail changed — not across every
same-session pair.

**Size:** M.

### T9. Cheap-model routing is present; defaults and fallbacks are not done

Jean has per-task model slots — and defaults `context_summary_model` to Opus. That is
the anti-pattern. AIO already classifies cheap-eligible loop work
(`invocation-model-resolver.ts`). Remaining:

- Force compaction / title / lesson-capture / clean-review classification onto aux.
  Never frontier.
- CodePilot `resolveAuxiliaryModel`: if the active provider has no cheap slot, borrow
  one from another **connected** provider, and if none exist, log and run at main-model
  cost rather than fail silent.

**Size:** S–M.

### T10. `fresh-child` / post-recycle bootstrap is uncapped

OpenClaw `contextInjection: "continuation-skip"` + `bootstrapMaxChars` +
`postCompactionMaxChars`. AIO same-session already skips existing-session context after
iter 0. Recycle and `fresh-child` re-pay AGENTS.md / MCP schemas / wake context.

**Fix:** cap AGENTS.md / instruction excerpts on the fresh window the same way wake
context is already capped (~600–900 tokens). Skip re-injection on safe continuations.

**Size:** S–M.

---

## Part 2 — Looping better

AIO is already better than Ralph Wiggum, CodePilot's stub doom-loop, and jean's
"never mark complete without proof" prompt text. The gap is **intra-iteration and
between-claim** waste, not another completion detector.

### L1. Idle ≠ complete: nudge the same session [from copilot-sdk]

Copilot keeps `session.idle` (mechanical) distinct from `session.task_complete`
(semantic). Autopilot idle without complete injects one synthetic nudge and restarts
the **same** tool loop (`copilot-sdk/docs/features/agent-loop.md:108-153`).

AIO treats iteration end as "this turn finished," then spends a **new iteration**
(new prompt, new context tax) if completion was insufficient. Stream-idle is
advisory only. There **is** one narrow same-session nudge:
`maybeQueueAnnounceThenHaltContinuation` (`loop-announce-then-halt.ts`) injects up
to **2** IMPLEMENT-stage hints when the child announced a next action with no tools
and no files. L1 is still right for idle-without-done; it is wrong if read as
"zero same-session nudges."

**Fix:** when a same-session turn goes quiet without a sufficient completion signal
and the ledger is still open, inject one nudge ("you are not done; do not declare
complete while ledger items are open") into the persistent adapter. Cap at one
nudge per iteration. Stay off for interactive / operator-reviewed loops.

**Size:** M. **Highest loop-quality win after T1/T2.**

### L2. Skip identical-fingerprint verify [from hermes goals]

Hermes: if a gate failed and HEAD + working-tree fingerprint is unchanged, replay the
recorded failure. AIO re-runs verify on every sufficient completion claim
(`loop-completion-detector.ts`). `lastVerifiedWorkHash` / `isVerifyEvidenceStale`
(`evidence-resolver.ts:239-245`) **invalidate** a passing verify after edits; they
never skip an identical tree. Work hash is `sha256(stage ‖ files ‖ tools)`, not a
git tree fingerprint. Default `runVerifyTwice: true`
(`loop-config-defaults.ts:108`), so a claim storm pays `verifyTimeoutMs` **twice**
(`loop-coordinator.ts:2476-2478`). `hasMatchingVerificationExecution` only accepts
a verify that already ran **this iteration**.

**Fix:** persist `{ treeHash, command, exit, outputExcerpt }`. If the next claim's
treeHash matches a recorded red, do not re-spawn. Re-run if the command or env
changed. Fail-open if hash cannot be computed.

**Size:** S. **Cheapest waste to cut.**

### L3. Health: alive ≠ advancing ≠ waiting-on-build ≠ stalled ≠ zombie [from storybloq]

`storybloq/src/autonomous/health-model.ts:11-114` reduces independent probes
(heartbeat, MCP age, guide age, subprocess PID, dialog). A long `npm test` is
`waiting-on-build`, not `stalled`. Failed probes stay `null`, never guessed.

AIO's A–I signals fire **after** an iteration. A long verify looks like a stall and
increments `loop-review-stall-policy.ts`.

**Fix:** add a live reducer fed by PID liveness + last tool/command line + stream-idle.
Hold stall counters while `waiting-on-build`. Pair with L4.

**Size:** M. Fail-open like agent-orchestrator's reaper.

### L4. Intra-iteration phase from the command stream [from codex-plugin-cc]

`inferLegacyJobPhase` (`codex-plugin-cc/plugins/codex/scripts/lib/job-control.mjs:103-158`)
classifies investigating / editing / verifying / reviewing from the latest progress
line. Zero model calls.

**Fix:** derive a phase for the HUD and for L3. `looksLikeVerificationCommand` regexes
already exist in spirit in AIO's verify path. Advisory first; then hold stall.

**Size:** S.

### L5. WAIT / park on a real process [from hermes]

Hermes judge can return `wait` with `wait_on_pid` / `wait_on_session` /
`wait_for_seconds` and **skips turns** until the barrier clears. Stale barriers
cannot wedge (dead PID releases).

AIO parks on quota, rate-limit, pause, maintenance. It does not park on "CI is still
running." The common wasted iteration is "is it done yet?"

**Fix:** when the child (or the verify spawn) has a live PID, the coordinator waits on
that PID instead of starting the next iteration. Fail-open if the PID is unknown.

**Size:** M.

### L6. Named non-convergence + park a defective leaf [from storybloq]

Storybloq splits `code_review_non_converging`, `landable_uncommitted`, `scope_expanded`.
After 3 plan-review rounds without approval it **parks the ticket** and advances
(`stages/park.ts`) — stage-gated so IMPLEMENT park is not misread as done.

AIO has `no-progress`, ping-pong `MAX_LOW_ONLY_ROUNDS` / `MAX_CONTRADICTORY_ROUNDS`,
and ledger `[-] deferred`. It will not auto-defer one unworkable leaf and finish the
rest. One bad checkbox blocks `ledger-complete` forever.

**Fix:**

1. Emit named diagnostics onto `OUTSTANDING.md` and the HUD (not just `no-progress`).
2. After N critical-no-progress iterations on the **same leaf** with a contradiction
   reason, auto-defer that leaf and continue. Never auto-defer without a reason.

**Size:** S (diagnostics) / M (auto-defer).

### L7. Artifact-freshness, fail-open [from storybloq]

Compare newest source mtime vs newest build-output mtime. Only **positively
established** staleness blocks (`MAX_FRESHNESS_RETRIES = 2`). Unestablished
(interpreted project, no outputs) never hard-blocks.

AIO verify is "exit code of the command." Green-on-stale-`dist/` is a false complete.

**Size:** S.

### L8. Lease interventions; bound the hint queue [from openclaw]

OpenClaw leases child results before inject (`steeringLeaseId`), stale leases
re-queue, ack drops payload, overflow can **seal** (`bounded-serial-queue.ts`,
`MAX_MERGED_STEERING_CHARS = 24_000`).

AIO `pendingInterventions` is an unbounded array. Crash mid-inject can double-apply a
reviewer finding and trip `builder-unreliable`. Live steer is honestly downgraded
(`loop-coordinator.ts:1430-1444`) — keep that honesty; add lease/ack on the
next-iteration path first.

**Size:** S.

### L9. Mass-death / probe-failed ≠ dead [from agent-orchestrator]

If you add L3 probes: a flaky `IsAlive` must not kill a healthy loop. agent-orchestrator
`observe/reaper/reaper.go` trips when `dead >= massDeadMinSessions` (5) **and**
`dead > massDeadFraction * N` (0.5): the whole pass is rewritten to `ProbeFailed`
(inconclusive), never mass-archived. Small boards stay exact. AIO already has a
per-provider invocation breaker. Add the mass-failure rule before probes go live.

**Size:** S (policy).

### L10. Later / optional

| Idea | Source | Why later |
|---|---|---|
| Live mid-turn steer | copilot-sdk, openclaw, hermes | L. No loop adapter exposes in-flight input. Keep the downgrade until one does. |
| Per-turn ALLOW/BLOCK stop-gate | codex-plugin-cc | Overlaps ping-pong. Only if reviewer spend is the problem. |
| External `get_goal` snapshot | oh-my-codex | Provider APIs inconsistent; fail-closed wedges. |
| Evict bloated reused CLI session | oh-my-opencode-slim | After T1 ceiling recycle exists. |
| Parallel third-model deadlock break | online-orchestrator | Costly; ping-pong already sequential. |
| Claim/ownership epoch | storybloq | Only if concurrent loops share one repo. |
| Ralph Wiggum same-prompt Stop hook | claude-code | **Do not copy.** |

---

## Part 3 — UX cleaner, tooltips everywhere

### House rules (set these before writing a directive)

1. **Three hint channels, not one.**
   - Hover tooltip = space-constrained chrome (icon buttons, dots, chips, collapsed rail).
   - Always-visible hint = dense forms (loop-config `span.hint`, setting descriptions).
   - Help pane = "what is this page."
2. **Never hide a destructive consequence in a tooltip.**
   `allow-destructive` (`loop-config-panel.component.html:445-448`) stays inline.
3. **Copy shape:** `{ label, meaning, consequence?, learnMore? }`. If the user needs
   `consequence` to decide, use inline help.
4. **Do not mass-replace `title=`.** Migrate high-confusion controls first.
5. **Do not convert loop-config hints to hover.** They are the right pattern.

### What is actually true today (counts from 2026-09-02 re-count)

`fable_aug-todo.md` said 143 `title=` across 29 of 55 templates, and 12 unlabeled
button files. The 2026-08-31 seed said 219 / 35 / 9. Re-counted today:

| Surface | Status now |
|---|---|
| Shared tooltip (`aioTooltip`, CDK tooltip, `matTooltip`) | **ABSENT** — zero matches in `src/renderer` |
| Native `title=` / `[title]` | **219** in **35** `.html` files; more in inline-template `.ts` files |
| Coachmark / tour | **ABSENT** |
| Help pane + inline callouts + `SETTINGS_TAB_HELP` | **PRESENT** |
| Settings search | **PARTIAL** — filters `NAV_ITEMS` only (`settings.component.ts:328-339`) |
| Settings row reset slot | **ABSENT** (`resetOne()` exists, no button) |
| `loopStatusTone()` | **ABSENT** (`loopStatusLabel` exists at `loop-formatters.util.ts:201-219`) |
| `LoopStatus` members | **15** (not "16"): includes ping-pong terminals `cost-exceeded`, `needs-human-arbitration`, `reviewer-unreliable`, `reviewer-unavailable`, `builder-unreliable`; `idle`/`verify-failed` removed (LF-8) |
| Hybrid context strategy | Still selectable; option text admits it falls back to fresh-child (`loop-config-panel.component.html:267`) |
| `@angular/cdk` | Already a dependency |

**HTML files with `<button>` and no `aria-label` and no `title` anywhere in the file
(11 today; the Aug-31 claim that `ask-council-page` / `codebase-panel` were fixed is
stale — they are unlabeled again, or the labels never landed in these templates):**

- `orchestration-hud.component.html`
- `node-service-panel.component.html`
- `browser-approval-request.component.html`
- `browser-campaign-list.component.html`
- `browser-credential-authorization-panel.component.html`
- `browser-escalation-queue.component.html`
- `browser-unattended-panel.component.html`
- `browser-vault-control.component.html`
- `grpo-dashboard.component.html`
- `ask-council-page.component.html`
- `codebase-panel.component.html`

OpenClaw is no longer SwiftUI-only. Current UI is Lit (`openclaw/ui/src/components/tooltip.ts`)
with `aria-describedby`, touch long-press (`TOUCH_DELAY=450`), redundant-title suppression
(`isTooltipTextRedundant`), hover delay 150ms, skip delay 300ms. Steal that policy.

### UX1. One `AioTooltipDirective` on CDK Overlay [foundation]

Copy **policy**, not React/Solid:

| Rule | Steal from |
|---|---|
| openDelay 200ms on icon rails, 400ms on overflow titles; skipDelay 0 (no trail on cursor sweep) | hermes `apps/desktop/src/components/ui/tooltip.tsx` |
| Suppress while `aria-expanded="true"`; click closes | opencode `packages/ui/src/components/tooltip.tsx` |
| Keyboard-only focus-open; Escape closes | hermes `suppressNonKeyboardFocusOpen` |
| `aria-describedby` injection | openclaw `tooltip.ts` `syncDescription` |
| Suppress if tooltip text equals visible untruncated label | openclaw `isTooltipTextRedundant` |
| `prefers-reduced-motion`: no scale | house |
| Overflow-only open when `scrollWidth - clientWidth > 2` | hermes `OverflowTip` |

API: `[aioTooltip]="string"` and `[aioTooltipTpl]="TemplateRef"`. Companion
`TooltipIconButton` contract: icon buttons **require** a tooltip; `aria-label` is the
same string (hermes `tooltip-icon-button.tsx`).

Central `TOOLTIP_COPY` registry (plain TS, no i18n). Later lint: forbid `title=` on
`button` / `a` / `[role=button]` once migrated (t3code `no-native-title-tooltip`).

**Size:** M (~2–3 days) + tests.

### UX2. Status language before "tooltips everywhere" [highest UX ROI]

A violet ring with no words is the most confusing thing in the rail.

1. Add `loopStatusTone(status): 'success' | 'warning' | 'danger' | 'neutral'` next to
   `loopStatusLabel` in `loop-formatters.util.ts`. Map all **15** statuses. Drive
   past-runs + outstanding from `data-tone`. **`failed` must not stay gray**
   (`loop-past-runs-panel.component.ts` colors 5 statuses including `error` but not
   `failed`; `loop-outstanding-panel.component.ts` is thinner still).
2. `app-status-indicator` is a `<div title>`. Make it a button (or `role="img"` +
   `aria-label`) using `STATUS_LABELS`.
3. Instance-row leading indicator (`instance-row.component.html:23-96`) becomes a
   structured tooltip: provider, activity, hibernated, looping, needs-attention.
4. **Remove Hybrid** from the context-strategy `<select>` until it exists
   (`loop-config-panel.component.html:267`). Shipping a third option that says "not
   yet implemented" is how the UI got hard to understand.
5. Group loop Advanced into **Safety / scope**, **Stall & cost**, **Review & quality**
   instead of one toggle pile (`loop-config-panel.component.html:305-448`). Keep the
   inline hints.

t3code `ConnectionStatusDot` + jean `McpStatusDot` are the pattern: pure
`label(state)` + `tone(state)`, trigger is a real button, copy is actionable
("Needs authentication — run X").

**Size:** S–M. No tooltip dependency. Do this week.

### UX3. First rich-tooltip rollout (after UX1)

Starter list. Each line is a control that is currently a native `title=` or has no
accessible name. Copy must answer "what is this" and "what happens if I click."

#### Loop HUD / config

| Control | Path | Needed |
|---|---|---|
| Pause / Resume / Stop / Hint / Follow-up / Inspect | `loop-control.component.ts:136-147` | Resume vs Resume anyway; Hint = next iteration; Follow-up queues before finish |
| Banner actions | `loop-control.component.ts:81-106` | Visible text only today. What "Resume anyway" ignores. |
| Status pill | `loop-control.component.ts:121-123` | Meaning of NEEDS REVIEW vs PAUSED · NO PROGRESS vs PROVIDER LIMIT |
| Token/cost/time dump | `loop-control.component.ts:127-134` | Structured: iter used/cap, wall, tokens, cost, estimated vs observed |
| Completion gate chips | `loop-control.component.ts:170-177` | Per-step why skipped / pending / passed |
| Ping-pong / audit chips | `loop-control.component.ts:151-187` | Round, open issues, preflight vs final |
| Loop toggle | `loop-toggle.component.ts` | Off / Armed / Running; click opens vs stops |
| Recycle toggle | `loop-config-panel.component.html:338-340` | T1 honesty: which providers honour it |

#### Instance rail / composer

| Control | Path | Needed |
|---|---|---|
| Leading provider / activity | `instance-row.component.html:23-96` | Structured rows, not one overloaded title |
| Restart `↻` / Terminate `×` | `instance-row.component.html:162-176` | Title only, no `aria-label`. Terminate is destructive. |
| Expand children | `instance-row.component.html:151-158` | Add `aria-label` |
| Context ring | `composer-toolbar.component.ts:59-95` | Already honest (`–` when unknown). Make structured: used / window / aggregate-only. |
| Send `↑` | `input-panel.component.html:502-511` | Title, no `aria-label`. Live keybind. |
| Steer / Stop | `input-panel.component.html:476-494` | Steer is next-iteration in loop (match coordinator honesty). Stop: live `shortcutHint`, not hardcoded Esc. |
| Workspace rail | `workspace-rail.component.ts:22-130` | Live `shortcutHint`; stop hardcoding `⌘H` / `⌘,` |

#### Settings / chrome

| Control | Path | Needed |
|---|---|---|
| Settings nav items | `settings.component.html:42-70` | title = visible label. Overflow-only. Tooltip only when rail collapsed (agent-orchestrator `sidebar.tsx:546-550`). |
| `app-setting-row` risk pills | `setting-row.component.ts:20-31` | Risk tooltip on yolo / MCP overrides; reserved reset slot (UX4). |
| Provider quota chip | `provider-quota-chip.component.ts` | Structured windows |
| Compaction / cost-cap rows | Settings | T3: "does not apply to Loop Mode" |

Then the 11 unlabeled clusters: orchestration HUD, node-service-panel, five browser
templates, GRPO, ask-council, codebase-panel. Names first, rich tooltips second.

### UX4. Settings discoverability (after UX1, aligns with `fable_todo2.md` S2/S3)

Do not wait for the full settings overhaul. These three unlock "easier to understand":

1. **Reserved reset slot** on `app-setting-row` (t3code `settingsLayout.tsx:157-238`).
   `resetOne()` already works. Always reserve 20×20 so the row does not reflow.
2. **Search-to-row** (t3code `settingsSearch.ts` + jean Fuse keywords). Today's search
   only filters tab names. Typing "recycle" or "yolo" should land on the control,
   scroll, pulse, focus.
3. **Origin caption** ("inherited default, not chosen") — agent-orchestrator
   `FieldDefaultHint`. `ResolvedConfig.sources` is populated and unused
   (`fable_todo2.md` S2.3).

The 2026-08-28 settings IA plan (section tabs, compact rail, Help drawer) is
compatible. Do not block tooltips on it.

**Size:** M (reset) / L (search catalog).

### UX5. Behavior-gated tips, then maybe a tour

Actual Claude `tipRegistry.ts`: show a tip only when usage proves the need, with a
cooldown. AIO analogues that are already measurable:

- Loops hitting provider limit while resume-on-limit is off.
- Loop used but recycle can never fire for the selected provider (T1).
- N instances running with cost display off.
- `toolLoopAutoInterrupt` off after repeated tool-loop toasts.

CodePilot getting-started bar (pending-first, N/M, unmounts when done) is a better
first-run surface than jean's paged tour. Tour last, after the HUD is readable.

**Size:** M. After UX1 + UX2.

---

## Delivery order

Do not start a later wave while an earlier one is still leaking tokens.

#### Wave 0 — honesty (this week, no architecture)

- **T2** skip goal + prior-obs only when `supportsResume && sameThreadContinuation && !pendingContextReset && !justCompacted && iterationSeq > 0`. Resume-alone (Copilot exec, Cursor CLI, ACP `loadSession`) still sends the goal. **T34** is the coordinator seam.
- **T3** copy: loop recycle ≠ global compaction.
- **T4** stop calling loop `micro` a compact in telemetry.
- **UX2.4–2.5** remove Hybrid; group loop Advanced.
- **UX2.1** `loopStatusTone` so `failed` is not gray.
- **T1a** Copilot WS14 `getLastContextUsage` plumbing. Recycle on `currentTokens/tokenLimit`. Skip recycle only when static system+tools already fill the window (anti-thrash), not by using conversation-only % as the threshold.
- **T24** never inject keep-working on sufficient complete, or when `caps.maxTokens` is null.
- **T25** cache cheap-classify per goal hash.
- **T26** skip review-driven `loopScoring` unless sentinel / phrase / sufficient signal.
- **T27** do not document `TokenBudgetTracker.STOP` as a live governor.
- **T28** do not treat gated-mode `ledger-complete` as a spend-more trigger on review-driven / ping-pong.
- **T29** ping-pong verify-fail intervention must send the **tail** (or `excerpt` head+tail), not `slice(0, 8192)`.
- **T30** `runVerifyTwice` / quick-verify only run on the gated completion path. Review-driven and ping-pong ignore the checkbox.
- **T31** `DEFAULT_LOOP_PROMPT` contains "fresh eyes"; that phrase auto-enables `crossModelReview` even when the panel checkbox is off.
- **T32** review-driven never injects `iterationPrompt`. The panel's "later iterations use the directive below" is a lie on the default mode.
- **T33** ping-pong treats every post-close `ledger-complete` as builder-done and re-spawns the reviewer.
- **T34** compute T2 in the coordinator (peek `pendingContextReset` + `justCompacted` + **recorded** last-iter caps **including model**) *before* `buildPrompt`; rebuild the prompt if a retry sets `forceContextReset` **or** this attempt's resolved model ≠ `lastThreadCaps.model` (T36).
- **T35** do not peek `persistentLoopAdapters` or guess caps from a factory adapter; persist last-iter `supportsResume` / `sameThreadContinuation` / **resolved model** on `LoopState`; fail closed (keep the goal) when missing or when the model changed.
- Label the remaining **9** unlabeled button files (names only; night-pass recount, not 11).
- **T37** isolation + `skipInstall: true`: honesty now; stop skipping install on loop worktrees.
- **T38** user-started audit defaults (`gate`/`record`/`prompted`) contradict engine `observe`/`off`/`off` — align or label cost.
- **T39** Wave 0: do not call 50k rehydrate cheap (cut bounds in Wave 1).
- **UX11** ping-pong default-on silently forces review-driven over the mode select.
- **UX12** recipe row is dead on review-driven (default mode).
- **UX13** "Clean reviews to finish" unused while default ping-pong runs; child still taught N-consecutive.
- **UX14** rename-gate auto-enabled + HUD chip on modes that never call `passesBeltAndBraces`.
- **T37 diagnosis** missing-deps verify = `command` failure, not infra; Hermes `.worktreeinclude` preferred over cold install.
- **CodePilot trusted-window** / **OB1 evidence-only learnings** (see replay Iteration 0 sibling pins).
- **T45** cap wrap-up is default-on and silent: a 50-iter / token / cost cap
  still pays one more full scaffold. HUD and the cap row do not say `+1`.
  `buildCapWrapUpDirective` still claims tools are not API-disabled; the
  coordinator already passes `disableTools`.
- **L14** after auto-unstick's 2 attempts, review-driven keeps paying
  iterations until the cap (then T45). Hermes parks; AIO does not.
- **UX17** "it will pause on its own" is false on the default
  (review-driven / ping-pong) path.
- **UX18** auto-unstick and wrap-up have no chip, tooltip, setting, or Help.

#### Wave 1 — stop the unbounded transcript (P0)

- **T1** ceiling recycle for remaining aggregate-only adapters + UI honesty.
- **T6** structured handoff on recycle (+ claw-code preserve-4 / no-recap resume).
- **T39** cut recycle rehydrate from 50k/20k to OpenClaw-scale 2.8k/1.2k (paths+hashes first).
- **T8** property-test loop prompt prefix stability.
- **L2** skip identical-fingerprint verify.
- **L4** phase inference (HUD + stall hold).
- **L8** lease + bounded intervention queue.
- **T45** skip or cheap-aux the wrap-up turn after a token/cost cap.

#### Wave 2 — stop spending the next iteration (P0)

- **L1** same-session idle-nudge.
- **L3** health reducer (waiting-on-build vs stalled).
- **L5** WAIT on PID.
- **L6** named diagnostics + park one defective leaf.
- **L14** after two auto-unstick misses, park review-driven (do not run to 51).
- **T45** non-Claude wrap-up must not stay tool-capable.
- **L7** freshness fail-open.
- **L9** mass-probe fail-open (before L3 goes live).

#### Wave 3 — tooltip primitive + first rollout (P1)

- **UX1** `AioTooltipDirective` + `TOOLTIP_COPY` + icon-button contract.
- **UX3** loop HUD → instance-row dots → composer ring/send → workspace rail →
  setting-row risk pills → recycle/T3 honesty.

#### Wave 4 — cheaper tokens inside a turn (P1)

- **T5** RTK compliance for Codex/Gemini/Copilot + gain-as-diagnostic.
- **T7** truncate-to-disk → mid-turn precheck → reclaim+rearm prune on the child session.
- **T9** aux-only housekeeping + cross-provider cheap fallback.
- **T10** post-recycle AGENTS.md cap.

#### Wave 5 — settings understandability (P2)

- **UX4** reset slot + search-to-row + origin caption.
- Continue `fable_todo2.md` S1 broken-bits and the 2026-08-28 IA plan.
- **UX5** one behavior-gated tip on Settings Overview / first loop-config open.

#### Wave 6 — only if evidence says so

Live steer, stop-review gate, external goal snapshot, Labs page, feature tour,
native gpt-5.6 Responses compaction (Hermes: wrong model → HTTP 500 / 90s stall).

---

### Negative lessons (do not copy)

1. **Ralph Wiggum** — re-feed the same growing transcript, complete on a promise
   string, safety net is only `--max-iterations`. AIO already inverted this.
2. **Hermes per-turn micro-compaction** — opt-in because it breaks the cache prefix
   every turn. First pass often *costs* tokens. AIO `action:'micro'` is already a
   no-op; do not make it a real per-turn rewrite.
3. **Jean defaulting summaries to Opus** — per-task routing is useless if
   housekeeping uses the most expensive model.
4. **RTK local % ≠ bill** — tura measured more rounds after compression; RTK's own
   analytics README says stored % is **byte** reduction and tokens are `bytes/4`
   estimates. Measure uncached input and iteration count, never trophy the %.
5. **Native compaction on the wrong model** — Hermes live-verified 500s / stalls.
   Gate hard.
6. **Server compaction drops pre-checkpoint plaintext** — retain the goal / user
   asks or the next iteration re-explores.
7. **CodePilot tooltip `delayDuration = 0`** — flashes a trail across the icon rail.
8. **Shipping Hybrid** as a selectable no-op.

---

### Discovery gates (do not skip)

1. Before T1 occupancy plumbing: which CLIs actually emit a current-window sample
   AIO is not reading? Read Codex app-server usage events and Claude status, do not
   guess.
2. Before T7: can the child CLI be told to prune, or must AIO own a parallel
   transcript? If the latter, that is a design spec, not a drive-by.
3. Before unifying loop recycle with `CompactionCoordinator`: they are different
   strategies (fresh window vs summarize-and-continue). Unifying without a spec
   will reintroduce the 3500% bug class.
4. Before live steer: one adapter must expose in-flight input. Until then the
   downgrade is correct.
5. Re-read `docs/plans/2026-02-22-token-memory-optimization-plan.md` before editing
   `src/main/context/`.

---

### Suggested first PR (smallest proof)

One PR, prefer the smallest real token win plus visible honesty:

1. **T1a** — Copilot server-mode: store last context sample from bridge effects;
   override `getLastContextUsage()`; advertise `occupancyReporting: 'current'` only
   when server mode is live. Spec + unit tests mirroring Codex app-server. Recycle
   Recycle keys off `currentTokens / tokenLimit` (full window). Do **not**
   use `conversationTokens / tokenLimit` as the threshold. Skip recycle
   only when static `systemTokens + toolDefinitionsTokens` already sit at
   the threshold (anti-thrash — a new session re-injects them).
2. **T2** — `loop-stage-machine.ts`: skip `goalBlock` + `priorObservationsBlock`
   only when `supportsResume && sameThreadContinuation && !pendingContextReset &&
   !justCompacted && iterationSeq > 0` (T23/T34). Same gate on `buildReviewDrivenPrompt`. Tests:
   Gemini same-session still gets the goal every iter; post-recycle Claude
   resident still gets the goal once; Copilot exec with `--resume`, Cursor
   CLI, and ACP `loadSession` **still get the goal** after iter 0. Claude
   resident / Codex app-server skip after iter 0 only when the thread still
   holds iter 0.
3. **UX2.4** — `loop-config-panel.component.html`: delete the Hybrid `<option>`; add
   three `<h4>` groups in Advanced. Hybrid is fresh-child at the invoker
   (`default-invokers.ts:1239-1240`); the `loop-context-survival.ts:263` comment
   that "`hybrid` mixes both" is wrong.

That is real token savings (T1a + gated T2) plus a visibly cleaner loop panel, and
it does not wait on a tooltip system. Do **not** ship blind T2.

---

### 2026-09-02 deltas (this loop pass)

Re-read AIO + siblings. Claims that moved, constants pinned, and new stealables.

#### AIO claims re-confirmed today

| Claim | Verdict |
|---|---|
| T2 goal/prior-obs re-injected every same-session iter | **Still true** (`loop-stage-machine.ts` goalBlock unconditional; existingSession gated) |
| Shared tooltip primitive absent | **Still true** (0 `aioTooltip` / `matTooltip` / CDK tooltip matches) |
| Hybrid selectable no-op | **Still true** (option text says not implemented) |
| `loopStatusTone` absent | **Still true** |
| `title=` count 219 / 35 HTML | **Still true** |
| Recycle needs known occupancy | **Still true** (`shouldRecycleLoopContext` + WS4 regression tests) |

#### AIO claims corrected today

| Old claim | Correction |
|---|---|
| Copilot always aggregate-only with nothing better available | WS14 server mode already emits real occupancy to the **HUD**; recycle path ignores it (**T1a**) |
| 9 unlabeled button templates; ask-council/codebase labeled | **11** unlabeled; ask-council + codebase are back on the list |
| "Map all 16 statuses" | **15** `LoopStatus` members; LF-8 removed dead `idle` / `verify-failed` |
| RTK gain ≈ savings | RTK analytics README: % is **byte** reduction; tokens = bytes/4 estimate |

#### Sibling constants pinned (for implementers)

| Source | Constant / policy | Use in AIO |
|---|---|---|
| opencode `truncate.ts` | `MAX_LINES=2000`, `MAX_BYTES=50*1024`, 7-day spill retention, hint to Grep/Read spilled file | T7 truncate-to-disk |
| opencode `compaction.ts` | `PRUNE_MINIMUM=20_000`, `PRUNE_PROTECT=40_000`, protect `skill` tool | T7 reclaim+rearm on child session |
| hermes micro-compaction.md | `proactive_prune_min_reclaim_tokens` default **4096**; growth-interval rearm | T7; do **not** adopt per-turn micro rewrite |
| hermes desktop `tooltip.tsx` | `TIP_DELAY_MS=200`, `skipDelayDuration=0`, `disableHoverableContent=true`, `suppressNonKeyboardFocusOpen` (modality + `:focus-visible`) | UX1 policy |
| openclaw `tooltip.ts` | `HOVER_DELAY=150`, `TOUCH_DELAY=450`, `SKIP_DELAY=300`, redundant-text suppress, overflow-aware | UX1 policy |
| openclaw steering | `MAX_MERGED_STEERING_CHARS=24_000`, stale lease re-queue | L8 |
| openclaw agent defaults | `contextInjection: always \| continuation-skip \| never`, `bootstrapMaxChars`, `maxActiveTranscriptBytes` | T10 + T1 ceiling |
| openclaw Labs | `ui/src/pages/labs/labs-registry.ts` — Labs writes the **shipped recommended variant** (e.g. `"auto"` tier), never raw `true`; docs link per lab; honesty about inherited defaults | Wave 6 optional; steal honesty, not a Labs page yet |
| jean `preferences.ts` | default `context_summary_model: 'claude-opus-4-8[1m]'` | **Negative** for T9 |
| CodePilot `tooltip.tsx` | component default `delayDuration=0`; AppShell provider often sets 300 | Prefer hermes policy; do not copy the 0 default |
| CodePilot `ContextUsageIndicator.tsx` | hide until `hasData`; if capacity unknown show used-only + popover, **never ∞%/NaN%** | Composer ring honesty (already partially done; keep) |
| CodePilot `OverviewGettingStartedBar.tsx` | pending-first sort, N/M counter, unmount when none pending | UX5 first-run (better than a paged tour) |
| CodePilot `resolveAuxiliaryModel` | 5-tier chain incl. cross-provider cheap borrow | T9 |
| t3code | `no-native-title-tooltip` oxlint rule; `settingsSearch` + reserved reset; `ConnectionStatusDot` | UX1 lint later; UX4; UX2 |
| oh-my-opencode-slim `cache-safe-injection.ts` | strip tagged volatile → re-append **tail only**; property-tested; never timestamps in prefix | T8 |
| tura `tool_results.rs` | stable `cache_id` from content hash; strip reporting fields | T6 |
| claw-code `summary_compression.rs` | `DEFAULT_MAX_CHARS=1200`, `MAX_LINES=24`, `MAX_LINE_CHARS=160`; dedupe + omission notice | T6 handoff / summary cap |
| pi `compaction.ts` | `reserveTokens: 16384`, `keepRecentTokens: 20000`; summarizer prompts say **PRESERVE exact file paths, function names, and error messages** | T6 quality guard; T1 recycle threshold pairing |
| Actual Claude `tipRegistry.ts` | relevance predicate + `cooldownSessions` 3–30 | UX5 |
| storybloq `health-model.ts` | `waiting-on-build` when subprocess alive && guide not advancing; failed probes stay `null` | L3 |
| storybloq `artifact-freshness.ts` | `MAX_FRESHNESS_RETRIES = 2`; unestablished never hard-blocks | L7 |
| storybloq `stages/park.ts` | `PARK_ACTION = park_item`; `PARK_STAGES = {PLAN, PLAN_REVIEW}` only — refuse park from IMPLEMENT | L6 |
| hermes `goals.py` | WAIT + `wait_on_pid` parks without burning a turn; dead PID releases | L5 |
| agent-orchestrator `reaper.go` | `massDeadMinSessions = 5`, `massDeadFraction = 0.5`; trip → report pass inconclusive (`ProbeFailed`), do not mass-archive | L9 |
| mempalace CLI | `mempalace wake-up` documents L0+L1 ≈ **600–900 tokens** (already mirrored in AIO `wake-context-builder.ts`) | Keep caps; do not grow wake dumps |

#### Sibling dead-ends / thin for this goal

| Sibling | Why thin |
|---|---|
| `online-orchestrator` | Parallel multi-provider merge only; optional deadlock breaker later |
| `OB1` | Skills/recipes/provenance; no loop engine to steal |
| `CodexDesktop-Rebuild` | Patch harness, no product UX |
| `claude-code` Ralph plugin | Negative lesson only |
| `getideasprompt` | Single-file prior copy of this same research goal (`fable_aug-todo.md`); no product | 
| `discordapi` | Two-line credential scratch, not a product. Do not mine. Treat as secrets to rotate off this disk. |
| `userdata` / `_scratch` | Not product code |

#### Mapping from `fable_aug-todo.md` (do not duplicate work)

| fable_aug item | grok.md owner | Notes |
|---|---|---|
| T1 recycle unknown occupancy | T1 + **T1a** | T1a is new (Copilot HUD≠recycle) |
| T2 goal re-inject | T2 | Still open |
| T3 cost-cap vs loop | T3 | Copy now; unify later |
| T4 "already engineered" | Baseline table | Do not re-open |
| T5 minor | folded into T5 RTK / discovery | — |
| L-A alive≠progressing | L3 | storybloq health-model |
| L-B named non-convergence | L6 | + park leaf |
| L-C mechanical vs semantic + nudge | L1 | copilot-sdk |
| L-D mass-death breaker | L9 | AO reaper 5 / 0.5 |
| L-E phase inference | L4 | codex-plugin-cc |
| L-F stop-gate review | L10 later | — |
| E-A–E-I architecture | T6–T10 / T8 | Prefer Wave order; E-I not a live bug |
| UX1–UX9 | UX1–UX5 + Wave 0 Hybrid | Counts in fable_aug are stale; use § UX today |

`fable_todo2.md` still owns settings S1–S4 and general U1–U17 — not re-listed here.

#### Discovery gates added today

6. Before declaring Copilot "cannot recycle": confirm whether the loop's persistent
   adapter actually entered WS14 server mode for that run (account routing skips it).
   T1a only helps when server mode is live; otherwise ceiling recycle (T1.2) still
   applies.
7. Before T1a ships: add a regression that a synthetic `session.usage_info` sample
   with `currentTokens/tokenLimit ≥ reset` makes `shouldRecycleLoopContext` flip,
   that a high-tools / low-conversation sample still recycles unless static
   overhead alone is already ≥ threshold, and that exec mode still refuses
   aggregate totals. Do not write the converse (conversation-only %) as the
   recycle trigger.
8. Before T2 ships: the skip must be `supportsResume && sameThreadContinuation
   && !pendingContextReset && !justCompacted && iterationSeq > 0`. Peek those
   flags *before* `buildPrompt` (T34). A Gemini/Antigravity same-session
   loop that drops the goal is a regression. A post-recycle Claude turn that
   drops the goal is a regression. Copilot exec `--resume`, Cursor CLI, and
   ACP `loadSession` dropping the goal are also regressions (T23). The morning
   formula without `sameThreadContinuation` is withdrawn.
9. Before plumbing Gemini/Antigravity HUD occupancy into recycle: last-turn
   tokens vs a hardcoded 1M window is **not** current occupancy. Leave
   `getLastContextUsage()` unknown.
10. Before injecting occupancy / "almost out of iterations" into the **child
    prompt**: Hermes `#7915` — models told they are running out of iterations
    give up. HUD can show pressure; the model should not see it until the cap
    is real. `renderSystemReminder` cap lines are cumulative loop spend, not
    window headroom — rename them if they stay in the prompt.

---

## 2026-09-02 late pass — capability-aware waste, intra-iteration leaks, sibling constants the morning pass missed

Re-read AIO adapters + coordinator + HUD, then re-audited every sibling for
mechanisms grok.md did not pin. Do not implement from the morning T2 wording;
use this section.

### Corrections to this morning's claims

| Claim this morning | Verdict now |
|---|---|
| Gemini same-session grows an unbounded CLI transcript (T1) | **Wrong.** `supportsResume: false`. Waste is per-spawn scaffold (T11). Recycle cannot help. |
| T2 = copy the existingSession gate | **Unsafe.** Must be T23/T34: `supportsResume && sameThreadContinuation && !pendingContextReset && !justCompacted`. Resume-alone (Copilot) is not enough. `justRecycled` is not a symbol. |
| T8 timestamps in the prompt head | **Stale.** No wall-clock in `renderSystemReminder`. Live busts: iteration, stage, caps remaining, ledger dump. |
| L1: zero same-session nudges | **Incomplete.** Announce-then-halt exists (cap 2, IMPLEMENT, no tools/files). Idle-without-done still missing. |
| L2: pay verify once per claim | **Incomplete.** Default `runVerifyTwice: true` — pay twice. Hash invalidates, never skips. |
| Hybrid "mixes both" (`loop-context-survival.ts:263`) | **Wrong comment.** Invoker treats only `same-session` as persistent (`default-invokers.ts:1239-1240`). Hybrid is fresh-child. |
| Copilot occupancy is `{used, total}` | **Partial, then over-corrected.** The split is real. Recycle **must** use `currentTokens/tokenLimit` (full window). A 40k schema is anti-thrash (`static-overhead`), not a reason to switch the numerator to `conversationTokens`. |
| UX1 overflow delay 400ms | **Wrong number.** hermes `OVERFLOW_TIP_DELAY_MS = 600`. 400 is opencode's default `openDelay`. |
| jean `McpStatusDot` is a button | **Wrong.** It is a `<span>`. Only t3code's `ConnectionStatusDot` is a button. |
| t3code settings search has keywords | **Wrong.** Title substring only. Keywords live in jean Fuse. |
| Help pane exists so Loop is explained | **Wrong.** No Loop Mode article under `src/renderer/app/shared/help/content/` (only passing mentions in monitoring/automation). |
| `title=` 219 / 35 HTML | **~215 matching lines** in the same 35 HTML files; inline-template `.ts` adds many more (`loop-control` 17, `loop-outstanding-panel` 16, …). |
| Settings search haystack | Still tab-only, but it does match `keywords` (`settings.component.ts:328-339`). `recycle` / `same-session` / `hybrid` are **not** keywords (`settings-navigation.ts`). Loop recycle lives on the loop panel, not Settings. |

### New AIO token items

#### T11. Exec-per-message providers are not a recycle problem [NEW]

Gemini and Antigravity spawn a fresh process every iteration. Same-session still
keeps a persistent **adapter object** (`default-invokers.ts:1239-1240`) but that
does not persist a provider conversation. `systemPrompt` is `undefined` on the
loop child (`default-invokers.ts:1359`), so T10's "wake context on recycle" is
overstated for this path. The CLI still re-loads AGENTS.md / GEMINI.md / MCP
schemas on each spawn.

Same-session skip of `existingSessionContext` is **strategy-based**, not
capability-based (`loop-stage-machine.ts:483-486`). After iter 0, Gemini drops
parent-chat replay **and** has no provider memory of it.

**Fix:** split the HUD and the recycle path by `supportsResume`. For
exec-per-message: cap the scaffold (T12/T13), do not promise recycle, do not
skip the goal. For resume-without-`sameThreadContinuation` (Copilot exec,
Cursor CLI, ACP `loadSession`): same — keep the goal; T1/T1a only. For
true same-thread (Claude resident, Codex app-server): T1 ceiling + gated T2.

**Size:** S (honesty + gate) / M (scaffold cap).

#### T12. Entire instruction scaffold + loop-control CLI re-sent every same-session iter [NEW]

Not just goal/prior-obs. Every staged iter re-pays Steps 0–5, recipe stage work,
completion steps, and `summarizeLoopControlPrompt` (~8 extra lines) —
**staged only** (`loop-coordinator.ts:1940` vs review-driven `:1932`).
Review-driven loops never get the control CLI even though `complete` / `block`
/ `wakeup` / `fail` exist in the control dir (L13).

Same-session **staged** prompt still tells the model "the next iteration is a
fresh process" (`loop-stage-machine.ts:505`, Autonomous Mode Rules — always,
even when `contextModeLine` says persistent). Review-driven does **not** say
that: `:598-599` is honest, and `:609` only says the next iteration will not
see clarifying questions. The agent is still trained to re-dump state to
NOTES/ledger every turn even when the CLI session already has it.

**Fix:** when the T23/T34 skip is true (Claude resident / Codex app-server,
thread still holds iter 0), iter 1+ may send a short continuation card
(stage, ledger counts, interventions, caps) and point at disk state. Keep
the full scaffold — including the goal — for `fresh-child`, recycle,
`supportsResume: false`, **and** resume-without-continuation (Copilot exec,
Cursor CLI, ACP `loadSession`). Same-session + `supportsResume` is not
enough. Fix the contradictory "fresh process" sentence.

**Size:** M. Highest same-session token win after gated T2.

#### T13. System reminder is mid-prompt and changes every iter [NEW]

`renderSystemReminder` is injected inside Step 1, not at the tail
(`loop-stage-machine.ts:395, 516`). `capUsage` is **cumulative loop spend**
(`loop-coordinator.ts:1944`: `state.totalTokens` / `state.totalCostCents`), not
window occupancy. The "N tokens remaining" line moves every iter, busts prefix
cache, and is easy to misread as context-window headroom (T3-adjacent).

Every 10th iter it also dumps up to 8 open ledger leaves into the prompt
(`loop-stage-prompt-helpers.ts:74-77`).

**Fix:** hoist volatile reminder/caps/iteration/interventions to the tail (T8).
Rename "Caps remaining" to "Loop budget remaining (this run, not the model
window)". Do not tell the model it is almost out of iterations until the cap
is real (Hermes `#7915`).

**Size:** S–M.

#### T14. Iter 0 can inject the same learnings twice [NEW]

`priorObservations` = `loopMemoryStore.surfaceLearnings(..., 3)`
(`loop-coordinator.ts:1066`). `planStageContext.surfaceLearnings` calls the
**same** store again, plus `getLessonStore().digest` (`:1105-1119`). On iter 0
both blocks render (`loop-stage-machine.ts:463-468`). Duplicate lesson text.
`priorObservations` then keep going every later iter (T2).

**Fix:** one injection site. Prefer `planStageContext` on iter 0; keep
`priorObservations` only when plan-stage context is empty.

**Size:** S.

#### T15. Fresh-child / hybrid re-inject parent chat replay every iter [NEW]

`buildExistingSessionContext` can be 24 turns × 1000 chars, last turn 4000
(`loop-existing-session-context.ts:23-26`, `replay-continuity.ts:3-10`). The
gate re-sends that block on **every** non-same-session iter. T10 talks
AGENTS/MCP/wake. This is parent **conversation history**, and it is larger.

**Fix:** send parent-chat replay on iter 0 and post-recycle only. Cap the last
turn; do not re-pay 24 turns on a fresh-child loop that already wrote NOTES.md.

**Size:** S.

### New AIO loop items

#### L11. Heartbeats defeat the iteration timeout [NEW]

Coordinator timeout ignores only `stream-idle` and `error`
(`loop-child-invoker.ts:75-80`). Any other `loop:activity` updates
`lastActivityAt`; if it is recent, the checkpoint **extends** (`:98-112`).
Invoker treats `heartbeat` as meaningful (`default-invokers.ts:1181-1188`) and
emits `loop:activity`. A wedged child that still heartbeats can run past
`iterationTimeoutMs` (default 30 min) until a wall/cost cap. Distinct from L3
(post-iter stall during verify).

**Fix:** do not treat `heartbeat` as progress for the **iteration deadline**.
Keep using it to nudge the adapter idle watchdog. Cap total extension
(Hermes: notify only at actual exhaustion).

**Size:** S.

#### L12. HUD `current idle` while the loop is RUNNING [NEW]

While status is `running`, the meter prints `current idle` whenever
`runningIteration()` is null (between iters, or mid-handoff)
(`loop-control.component.ts:127-130`). That is not Copilot's `session.idle` vs
`task_complete`. It reads as "the loop is idle" while the pill says RUNNING.

**Fix:** `between iterations` / `handing off` / `waiting on verify`. Never the
word `idle` on a running loop. Pair with UX2 tone.

**Size:** S.

#### L13. Review-driven loops never see the loop-control CLI [NEW]

`appendLoopControlPrompt` is only on staged `buildPrompt`. Review-driven has
the binaries but the child is never told the commands. Staged children are
told every iter (T12). Either teach review-driven once (iter 0 / post-recycle)
or stop shipping a CLI the child cannot discover.

**Size:** S.

#### L2 addendum — skip identical-fingerprint verify **and** the second run

L2's skip must also short-circuit `runVerifyTwice` when the tree hash matches a
recorded result. Fail-open if hash cannot be computed. Pair with
codex-plugin-cc: skip reviewer spend on non-edit turns (ALLOW immediately if
the last turn made no edits).

### New AIO UX items

#### UX6. Help pane has no Loop Mode article [NEW]

No loop article under `src/renderer/app/shared/help/content/`. Operators get
page-level help for agents/monitoring/automation, then a HUD full of `title=`
and color. Worse than "no control tooltips": the Help channel also skips the
product's most expensive mode.

**Fix:** one Loop article covering same-session vs fresh-child, recycle honesty
(T1/T11), completion gate, ping-pong (review vs tool — UX8), and where
OUTSTANDING.md lives. Do this in Wave 0; it does not wait on UX1.

**Size:** S.

#### UX7. Unlabeled-button heuristic undercounts [NEW]

The 11 file-level unlabeled templates still have unlabeled buttons. Also
unlabeled (file has *some* `aria-label`, so they missed the heuristic):

- `automation-webhooks-panel.component.html` Refresh / Create
- `checkpoint-timeline.component.html` Retry / Cancel / Restore
- `child-diagnostic-bundle.modal.component.html` Copy
- `context-evidence-panel.component.html` Load next chunk / Close

Names first (Wave 0), rich tooltips second (UX3).

#### UX8. Two different "ping-pong"s, one badge [NEW]

HUD `PING-PONG` is conversational review (`loop-control.component.ts:152-153`).
Doom-loop also has a `ping-pong` tool-pair signal (`doom-loop-detector.ts:16, 71`).
Config hint says "until both agree" (`loop-config-panel.component.html:116`).
Operators cannot tell review ping-pong from tool ping-pong.

**Fix:** `REVIEW PING-PONG` vs `TOOL LOOP`. Structured tooltip after UX1; label
fix can ship in Wave 0.

**Size:** S.

#### UX1 policy corrections (do not copy the morning numbers)

| Rule | Steal from | Use |
|---|---|---|
| Overflow delay **600ms**, pointer-only; keyboard stays off because the full string is already the accessible name | hermes `OVERFLOW_TIP_DELAY_MS` | Replace "400ms on overflow titles" |
| One root tooltip provider; per-icon providers cost tens of thousands of renders | hermes `RootTooltipProvider` | CDK overlay at app-root |
| `disableHoverableContent` on Electron drag-region chrome | hermes | Tips stick otherwise |
| Trailing hotkey chip from the live action registry | hermes `TipKeybindLabel` | AIO already has `shortcutHint` |
| `aria-describedby` on the **inner** focusable, description node in the **trigger** document (not the overlay portal) | openclaw `resolveDescribedElement` | CDK would otherwise describe the portal |
| Native-title guard that blanks redundant `title=` without removing the attribute | openclaw `installNativeTitleGuard` | Migration bridge while 215+ `title=` remain |
| `open-on-click` for status dots / touch | openclaw | |
| Dense chrome `openDelay={2000}` | opencode session-review | HUD chips you glance past constantly |
| Hide quota until ≥ 75% / context warn 0.7 critical 0.9; `role="progressbar"`; consequence sentence | agent-orchestrator `ContextMeter` | Composer ring |
| Status: tone + short label + reason-bearing long copy + ping only on transitional + button iff there is copy | t3code `ConnectionStatusDot` | UX2 `loopStatusTone` |
| Cause ≠ remedy; never truncate the safety sentence (`MAX_PROSE_LENGTH = 4000`) | storybloq `corruptRemedy` | Loop HUD / OUTSTANDING.md |
| Settings search: catalog SSOT + `desktopOnly` + hash jump + pulse XOR focus + `/` hotkey | t3code | UX4 |
| Settings search matching: Fuse keywords + `fallbackAnchorId` + RAF jump that **yields to user scroll** | jean | UX4 |
| Settings search: schema+hint catalog, `tag:`, auto-open Advanced, curated visible keys (never land on a row the page cannot edit) | openclaw `SETTINGS_SEARCH_TARGETS` | UX4 — AIO `ResolvedConfig` is closer to this than to jean's hand-authored arrays |
| Info-icon PolicyTooltip next to the row title (4th hint channel) | t3code `PolicyTooltip` | T3 recycle-vs-compaction |
| HoverCard ≠ Tooltip for token breakdowns | CodePilot | Do not dump 4-row occupancy into `aioTooltip` |

**Do not steal:** jean 500ms + per-instance provider; delay=0 as a default
(CodePilot / AO sidebar / hermes statusbar — local exception for icon-rail
sweep only, with Tip-level 200 override); tura native `title=`.

### New sibling constants (morning pass did not pin)

| Source | Constant / policy | Use in AIO |
|---|---|---|
| hermes compressor | Gateway hygiene **85%** vs in-loop **50%**; unifying both at 50% caused every-turn compact | T1.2 ceiling ≠ `resetAtUtilization` 0.6 |
| hermes lean tail | 2.5% of window, 10K floor, 25K cap + regex-extracted identifier index + `session_search` pointer | T6: recoverable archive, do not grow HANDOFF |
| hermes anti-thrash | 2 ineffective/fallback-only compacts → block; **300s** then one probe; strike count durable on the session row | Recycle/compact-on-failure without this is a new doom loop |
| hermes | `max_compression_attempts = 3`; lock-skip refunds the attempt | T7 compact+retry cap |
| hermes | Rearm only on **provider-proven** `prompt_tokens` below threshold; char estimates forbidden | T1a rearm |
| hermes | Overflow size = messages **+ tool schemas + system** | T7 precheck |
| hermes | Windows **< 512K**: trigger ≥ **75%**; tiny windows **85%** (`_MIN_CTX_TRIGGER_RATIO`) | `resetAtUtilization = 0.6` is too early on small Copilot windows |
| hermes | In-place compact keeps the same session id; `resolve_prompt_cache_scope()` maps to compression-lineage **root** (not conversation-root) | T1 recycle that mints a new CLI session busts Anthropic cache unless `prompt_cache_key` is lineage-stable |
| hermes | Prompt-cache TTL is only `"5m"` or `"1h"`; model/account are part of the key | Align cache-TTL idle recycle; T9 fallback = new cache scope |
| hermes | `#7915` no intermediate iteration-budget warnings in the **prompt** | T13 / discovery gate 10 |
| hermes | Post-compact: do not re-deliver the previous answer (`_HANDOFF_SKIP_FINAL_RESPONSE`) | Recycle that replays the last assistant bubble wastes tokens and confuses completion |
| hermes | `min_tail_user_messages` ≥ 1 real user (synthetics don't count); `protect_first_n=3` | T2/T6 |
| hermes composer | Stop/Esc **parks** the queue (does not drain); `busy_input_mode: queue \| steer \| interrupt` | L8 + HUD Hint/Follow-up |
| hermes | Async token accounting; writer failures never raise into a turn | Loop HUD cost must not stall the next iter |
| opencode compaction | `MIN_PRESERVE_RECENT_TOKENS=2_000`, `MAX=15_000`, default `floor(usable * 0.25)`; `usable` subtracts reserved; overflow counts **cache.read + cache.write** | Recycle math that ignores cache tokens fires late |
| opencode | Summarizer tool bodies capped at **2_000 chars** (separate from truncate.ts 2000 **lines**) | T6 HANDOFF must not become a second transcript |
| opencode retry | Context overflow is **not** retryable (`RETRY_MAX_RETRIES=5` excludes it) | T7 must not hammer the provider |
| opencode truncate | Spill hint: **do not Read the full file**; delegate Grep/Read offset | Truncate without this undoes T7 |
| opencode | `small_model` family walk: gemini-flash → gpt-nano → claude-haiku (Copilot prepends gpt-mini); Azure returns undefined | T9 family order, not "any cheaper model" |
| opencode cache | Anthropic 5m write **1.25×**, read **0.1×** — one reuse inside 5 minutes already wins | Recycle that busts a 5m prefix is a **cost** |
| opencode | MCP blob cap **10 MiB** | Independent of text truncate |
| openclaw | Live tool-result cap **16k / 32k@100k / 64k@200k**, then `min(0.3 × window × 4 chars, cap)` | T7's 50 KiB is the whole window on a 32k child |
| openclaw | `bootstrapMaxChars` **20000** per file, `bootstrapTotalMaxChars` **60000** | T10 needs a **sum** cap |
| openclaw startup prelude | First-turn only: `maxFileChars: 1200`, `maxTotalChars: 2800` | Recycle rehydrate |
| openclaw heartbeat | `isolatedSession: true` (~100K → ~2–5K per beat), `lightContext`, silent `HEARTBEAT_OK` | Cheaper than L5 WAIT *or* another full iteration for "is it done yet?" |
| openclaw | `compaction_loop_persisted`: after overflow→compact, same `(tool, argsHash, resultHash)` aborts | T7 without this is unbounded spend |
| openclaw | Session `reset: none` default — compaction bounds context, not a daily wipe; heartbeat/cron do **not** refresh idle | T1 ceiling "every 8 iters" is crude |
| openclaw | `maxSkillsPromptChars: 18000` | Loop skill catalog cap |
| copilot-sdk | `session.usage_info` splits `conversationTokens` / `systemTokens` / `toolDefinitionsTokens`; `currentTokens` is the full window; `session.usage_checkpoint` is the durable resume event | T1a HUD split; recycle off `currentTokens/tokenLimit`; skip when static overhead already fills the window |
| copilot-sdk autopilot | Idle-without-complete copy: stop planning, start implementing; don't mark complete with open questions, errors, or remaining steps | L1 copy |
| storybloq | Hop-cap default **8** (min 2 max 32); park never drop; successor thread with refused artifact; duplicate-fingerprint park has **no** redeliver | L6 ping-pong hop-cap |
| storybloq health | `alive` is epoch-ms, not a boolean; stale-read guard | L3 |
| tura | Default context limit **260000** (not the model card); `waiting_first_token` ≠ stalled; strip `compact_context` out of stored tool results | L3 / T6 double-bill |
| pi | Summarizer `cacheRetention: "none"` + fresh routing id + `toolChoice: "none"` | T6 aux write at 1.25× for a one-off is pure waste |
| pi | Never split a tool pair; split-turn dual summary with heading **Original Request** | T6 schema |
| claw-code | Auto-compact at **100_000** cumulative input (`CLAUDE_CODE_AUTO_COMPACT_INPUT_TOKENS`) | T1.2 concrete M for aggregate-only adapters |
| claw-code | Lane agents `DEFAULT_AGENT_MAX_ITERATIONS = 32` (not the parent's 500-class budget) | Review/verify/aux children |
| oh-my-opencode-slim | Reused session illegal above **50_000** context lines; `DEFAULT_MAX_SESSIONS_PER_AGENT=2` | L10 tripwire |
| oh-my-opencode-slim | 5s stop-confirmation grace (idle ≠ stopped) | L1/L3: don't recycle on a 500ms quiet |
| oh-my-opencode-slim | `compaction_continue` is an internal initiator, not a user turn | T2/T8 must not treat it as "user asked again" |
| oh-my-codex / Codex | `goals.max_goal_token_budget`; setting `tokenBudget` to **`null` resets to the limit**, it does not mean unlimited | T3 cost-cap UI "clear" ≠ infinite |
| rtk | `CAP_ERRORS=20`, `CAP_WARNINGS=10`, `CAP_LIST=20`, `CAP_INVENTORY=50`; success tee `tail -n +{offset}` | T5/T7 recovery path is a **command**, not "read the file" |
| nanoclaw | Resume injects **nothing**; fresh window injects two files, **16k chars** each | T2/T10 file cap |
| jean | `think=4K` / `megathink=10K` / `ultrathink=32K` (default — anti-pattern); `adaptive` omits the budget | T9 loop chores must force adaptive/low, not just a cheap model |
| jean | `compact_chat_view_enabled` tool-call ticker | Loop HUD density (not a tooltip) |
| t3code | `doom_loop` permission = **ask**, not silent kill (interactive loops) | Doom-loop auto-stop is wrong for operator-reviewed loops |
| Actual Claude | Compact close **4001** retried 3× / 2s (`MAX_SESSION_NOT_FOUND_RETRIES`); `compact_boundary` is first-class | L3/L9: drop mid-compact is probe-failed, not dead |
| CodePilot | Context accounting by **kind** (`system_prompt`, `tools`, `rules`, `skills`, `mcp`, `memory`, `files_attachments`); `context_summary_boundary_rowid` | Composer ring next step; T6 incremental compact |
| codex-plugin-cc | Stop-gate ALLOW if the last turn made **no edits** | Cheap slice of L10 worth stealing now (pairs with L2) |

### Highest-leverage additions this pass (rank for implementers)

| ID | Why it outranks polish |
|---|---|
| T2 correction | Blind T2 is a Gemini/post-recycle regression |
| T11 | Stop treating Gemini as T1 |
| T12 + T13 | Same-session still re-pays the constitution + a moving reminder |
| T1a + copilot split | Data is on the wire; recycle on full-window `%`; skip when only static schemas fill it |
| L11 | Heartbeat-extended 30 min iterations are free token burn |
| L2 + runVerifyTwice | Cheapest waste: don't pay verify twice on an unchanged tree |
| H-anti-thrash | Recycle/compact without a 2-strike/300s probe is a new doom loop |
| OC-overflow-retry | Never retry overflow |
| Claw-toolcap | 16k/32k/64k × 0.3 window — T7's 50 KiB is too big for small windows |
| Hermes-cache-scope | Recycle that changes session id busts T8 |
| Pi-no-cache-write | Summarizer `cacheRetention: none` |
| UX6 + L12 + UX8 | Loop Help article, never say `idle` on a running loop, name the two ping-pongs |
| Overflow 600 + root provider | Morning UX1 numbers were wrong |

### Wave 0 additions (still this week, no architecture)

- **T11 honesty** in the recycle row: Gemini/Antigravity cannot recycle; show the per-spawn cost instead.
- **T14** dedupe iter-0 learnings.
- **L11** heartbeat ≠ iteration-progress.
- **L12** replace HUD `current idle`.
- **UX6** Loop help article.
- **UX8** `REVIEW PING-PONG` vs `TOOL LOOP`.
- **T13 copy**: rename "Caps remaining" so it cannot be read as window headroom.
- Label the extra unlabeled clusters in UX7 (names only).
- **T17** hide or label `reviewStyle` as unused (default `debate` is a lie).
- **T20** inline hint on "Run verify twice": doubles wall/cost; default on.
- **Cost-cap honesty**: HUD / help must say the default governor is 50 iters / 50h, not a dollar cap.
- **T24** never inject "keep working — do not summarize" on sufficient complete, or when `caps.maxTokens` is null.
- **T25** cache cheap-classify; do not aux-call every loop spawn.
- **T26** do not `loopScoring`-classify every review-driven iter; skip unless sentinel / phrase / sufficient signal.
- **T27** HUD/help must not claim a token-budget STOP that the coordinator swallows.
- **T28** do not treat gated-mode `ledger-complete` as a spend-more trigger on review-driven / ping-pong.
- **T29** ping-pong verify-fail dump: tail (or `excerpt()`), not the first 8k of oxlint warns.
- **T30** label or wire `runVerifyTwice`: it does not run on review-driven or ping-pong converge.
- **T31** stop feeding `DEFAULT_LOOP_PROMPT` into `detectConvergeUntilCleanIntent` (or strip "fresh eyes" from the boilerplate).
- **T32** review-driven: inject custom continuations, or stop collecting / advertising `iterationPrompt`.
- **T33** ping-pong: `ledger-complete` opens a reviewer only on the close-transition, not every later seal.
- **T34** T2 skip is not evaluable inside `buildPrompt` today; pass `reanchorGoal` from the coordinator.
- **T35** record last-iter adapter caps on loop state; fail closed when unknown. Same PR as T2/T34.

Do not start Wave 1 recycle/compact work until Hermes anti-thrash + overflow-not-retryable are in the spec for that work. Do **not** call `getSmartCompactionManager()` from the loop path (T16).

---

## 2026-09-02 evening pass — dead controls, third compaction stack, sibling cache/steer

Re-read AIO loop config + coordinator + RLM bootstrap, then sampled siblings
the late pass treated as "already pinned." New leaks and constant corrections.
Do not implement from a morning baseline that still says `$30` / `3000¢`.

### Corrections to earlier claims in this file

| Claim earlier today | Verdict now |
|---|---|
| `DEFAULT_LOOP_MAX_COST_CENTS = 3000` (baseline table) | **Stale.** `loop.types.ts:71` is `null`. Comment: $30 ended real multi-hour runs (`cap=cost` after ~$34); reverted 2026-09-02. Renderer `maxDollars` starts `null` (`loop-config-panel.component.ts:159-160`). Governors are 50 iters + 50h wall. |
| Help has "passing mentions" of Loop Mode | **Thinner.** `monitoring.help.ts` says "loop runs"; `automation.help.ts` says "AI loops". Zero "Loop Mode" / recycle / same-session vocabulary. UX6 still right. |
| Hermes prompt-cache TTL is only `"5m"` or `"1h"` (late-pass pin) | **Incomplete.** Codex Responses + Meta Muse Spark (`api.meta.ai`) send `prompt_cache_retention: "24h"` (`hermes-agent/tests/agent/transports/test_meta_codex_cache.ts`). AIO adapters have **zero** `prompt_cache_key` / `prompt_cache_retention` matches. |
| openclaw `isolatedSession: true` as the heartbeat default | **Wrong default.** Docs default `isolatedSession: false` / `lightContext: false` (`openclaw/docs/gateway/config-agents.md:554-571`). The 100K→2–5K drop is the *enabled* pattern, not shipped-on. |
| ask-council lives under an unlabeled `features/ask-council` cluster | **Moved.** `features/compare/ask-council-page.component.html`. Recount before UX7 checkboxes. |
| `child-diagnostic-bundle` Close unlabeled | **Partial drift.** Close now has `aria-label`. Re-check Copy. |
| Dedicated Grok CLI adapter owns occupancy | **No runtime adapter.** `grok-cli-adapter.models.ts` only. Grok rides ACP. T1 ACP row is the Grok row. |

### New AIO token / honesty items

#### T16. Third compaction stack: RLM SmartCompaction never sees loop transcripts [NEW]

AIO already has three separate compact/recycle machines:

| Stack | Owner | Trigger | Loop child? |
|---|---|---|---|
| `CompactionCoordinator` + instance `ContextCompactor` | InstanceManager | occupancy / cumulative | **No** — loop adapters live in `persistentLoopAdapters` (T3/T4) |
| `SessionCompactor` / `SmartCompactionManager` | RLM sessions | 80% warn / 95% emergency, summarizer LLM, `maxTokens: 50000` (`smart-compaction.ts:55-70`) | **No** — booted in `memory-bootstrap.ts:69-73`, never registered for loop CLI |
| `shouldRecycleLoopContext` | Loop coordinator | known occupancy ≥ `resetAtUtilization` | **Yes**, and only when occupancy is `known` (T1) |

T3/T4 named stack 1 vs 3. Stack 2 was invisible. `getSmartCompactionManager()` is the wrong T1 fix: it is a summarizer-turn at 80% on a different session object, fights Hermes anti-thrash, and would reintroduce the "compact because we guessed" class.

**Fix:** document the third stack in the Wave 1 spec so nobody "reuses" it. Loop stays T1 ceiling + T6 handoff. Optional later: *read* RLM archive as a capped pointer after recycle, never as the recycle engine.

**Size:** S (docs / discovery gate) / XL (if anyone tries to unify).

#### T17. `reviewStyle` defaults to `debate` and the coordinator never reads it [NEW]

`LoopReviewStyle` comment (`loop.types.ts:73-77`):

- `single` — single agent at REVIEW
- `debate` — 3-agent in-process debate (Claude only)
- `star-chamber` — Claude + Codex (Gemini excluded)

Defaults: `loop-config-defaults.ts:38` and the panel signal (`loop-config-panel.component.ts:179`) are **`debate`**. The Advanced `<select>` has **no hint** (`loop-config-panel.component.html:244-249`).

`loop-coordinator.ts` has **zero** `reviewStyle` references. Stage machine neither. Ping-pong types are explicit (`loop-pingpong.types.ts:100-104`): the behavioural switch is `completion.crossModelReview.pingPong.enabled`, **NOT** `reviewStyle`. The only runtime consumer is a chat handoff string (`loop-chat-summary.ts:191`): `A background "${state.config.reviewStyle}" loop` — so a review-driven same-session run is narrated as a "debate" loop.

This is Hybrid-class honesty, worse because the default is the most expensive-sounding option. Operators are trained to believe loops run 3-agent debates.

**Fix (Wave 0):** hide the `<select>` (or label "unused — ping-pong is the review switch") and stop interpolating the enum into the handoff. Do **not** wire debate as the T17 "fix" — that is a token bomb and a new architecture.

**Size:** S.

#### T18. RTK awareness comment invites a cache-busting "fix" [NEW]

`rtk-awareness.ts:10` says the block is "safe to prepend on every turn." Code:

| Adapter | When injected |
|---|---|
| Codex exec | once per session (`rtkAwarenessSent`, `codex-exec-adapter.ts:173-176`) |
| ACP (Cursor/Grok) | once unless `resume` (`acp-cli-adapter.ts:2056-2058`) |
| Gemini / Antigravity | **every spawn** (correct: `supportsResume: false`, `gemini-cli-adapter.ts:554-560`) |

**Fix:** change the comment to "once per persistent session; every spawn only when `supportsResume === false`." Do not make Codex match the comment.

**Size:** S (comment + a spec note). T5 still owns real Codex/Gemini hooks.

#### T19. Review-driven constitution still re-sends the OUTSTANDING schema every iter [NEW]

T12 covers staged Steps 0–5. Review-driven is shorter and still dumps the full OUTSTANDING.md template + stop protocol + goal on every iter (`loop-stage-machine.ts:606-648`). When the T23/T34 skip is true, iter 1+ may send a continuation card (open ledger counts, interventions, "schema unchanged — read the file"). Keep the full schema — and the goal — for iter 0, recycle, `supportsResume: false`, and resume-without-continuation (Copilot / Cursor CLI / ACP). Same gate as T2/T12; do not key this off `contextStrategy` or `supportsResume` alone.

**Size:** S–M. Same gate as T2/T12.

#### T20. `runVerifyTwice` default on, no cost hint [NEW]

Default `true` (`loop-config-defaults.ts:108`, panel signal `true`). The Advanced row is a bare checkbox (`loop-config-panel.component.html:325-326`) — no `span.hint` that it **doubles** verify wall/cost. HUD already prints `verify×2` (`loop-control.component.ts:675`) with no explanation.

L2's skip must also short-circuit the second run. Wave 0 is copy: "runs the command twice; turn off unless flake is the problem."

**T30:** that copy is still a lie on the default user-started modes. Only the gated `hasSufficientSignal` branch runs v2. See T30.

**Size:** S (copy) / already in L2 for the skip.

### New AIO UX items

#### UX9. Dead expensive-looking controls are the clarity bug [NEW]

Hybrid (selectable no-op) and `reviewStyle` (selectable unused, default `debate`) plus recycle (toggle that cannot fire for aggregate-only / exec-per-message) are one class: the panel offers a knob whose label describes a machine that is not running. Tooltips on those knobs without removing/hiding them make the lie accessible.

Wave 0: hide Hybrid + `reviewStyle`; recycle row must name which providers honour it (T1/T11). Do this before UX1.

#### UX10. Settings search still cannot find loop words

Confirmed: `settings-navigation.ts` keywords include `rtk token cost` but not `loop` / `recycle` / `same-session` / `hybrid`. Loop recycle lives on the loop panel. Typing "recycle" in Settings still misses. UX4 search-to-row must include loop-panel rows or the Loop help article must be the landing.

### New sibling constants / stealables

| Source | Constant / policy | Use in AIO |
|---|---|---|
| hermes `idle_compact_after_seconds` default **0** | Opt-in: on resume after N seconds idle, compact *before* the first reply; skip if already ≤ `threshold × target_ratio`; honors anti-thrash / lock / cooldown | Distinct from AIO cache-TTL idle recycle (`loop-context-survival.ts`). Do not enable by default. Pair with T1 only after anti-thrash exists. |
| hermes Codex/Meta `prompt_cache_retention: "24h"` | Mantle / `api.meta.ai` / selected Codex Responses models | Correct the "5m or 1h only" pin. Recycle that mints a new session still busts the key; a 24h prefix makes busts *more* expensive. |
| hermes xAI | `prompt_cache_key` via `extra_body` (not top-level kwargs) | AIO Grok/ACP path sets neither. T8/T1 lineage-stable key has no adapter wire today. |
| oh-my-codex ultragoal | Per-goal `tokenBudget`; steering mutations require `evidenceBackedNecessity` (non-empty evidence + rationale) **and** `noEasierCompletion` (refuse wording that weakens the stop) (`ultragoal/artifacts.ts:1300-1354`) | L6 park-leaf / ledger steer. **Do not** copy external `get_goal` snapshot (still L10). Copy the invariant: do not expand scope without evidence, do not "finish" by shrinking the goal. |
| CodePilot `resolveAuxiliaryModel` | Beyond the 5-tier walk: `AUXILIARY_{TASK}_PROVIDER` / `_MODEL` env override; skip `interactive_only` providers; `sdkProxyOnly` awareness; `computeEffectiveRoleModels` merges preset defaults so empty `role_models_json` still exposes haiku (`provider-resolver.ts:1671-1758`) | T9 contract. AIO aux fallback that only looks at user-persisted cheap slots will miss catalog defaults. |
| openclaw heartbeat | `isolatedSession` / `lightContext` **default false**; enabled isolated drops ~100K → ~2–5K; UI suppresses `HEARTBEAT_OK` so it does not pollute history | L5/L11: a cheap isolated "is it done?" beat, not a full iteration, and do not persist `HEARTBEAT_OK` into NOTES.md |
| tura `waiting_first_token` | Provider accepted, no first token yet ≠ stalled | L3 confirm (already pinned; still true) |
| jean | `context_summary_model: 'claude-opus-4-8[1m]'` still the default (`preferences.ts:819`) | T9 negative — still true |
| t3code | `PolicyTooltip` next to the row title; `no-native-title-tooltip` is an oxlint **error** in `vite.config.ts` | UX1 lint later; T3/T17 honesty as an info-icon, not a hover-only |

### Highest-leverage additions this pass

| ID | Why it outranks polish |
|---|---|
| T17 | Default control teaches the wrong cost model; one-line hide |
| Cost-cap baseline | Implementers still citing 3000¢ will re-introduce the $30 mid-run kill |
| T16 | Prevents a false "reuse SmartCompaction" Wave 1 |
| Hermes 24h cache | Recycle-bust cost is higher than the late pass assumed |
| OMX ultragoal invariants | L6 without "weaken the goal to finish" |
| CodePilot aux merge | T9 that only reads persisted slots is a silent frontier fallback |
| T18 | Stops a well-meaning every-turn RTK prepend on Codex |

### Wave 0 additions (still this week)

- **T17** hide `reviewStyle` or stamp "unused".
- **T20** verify×2 cost hint.
- **T18** fix the RTK comment; do not change Codex to every-turn.
- **T16** discovery gate: no SmartCompaction on loop transcripts.
- **Cost-cap copy**: default is unbounded $; 50 iters / 50h govern.
- **UX9** treat Hybrid + reviewStyle + recycle-as-lie as one honesty sweep.

### Discovery gates added this pass

11. Before anyone calls `getSmartCompactionManager()` from loop code: it is the RLM session stack, not the child CLI. Write the Wave 1 spec first (gate 3 still applies).
12. Before wiring `reviewStyle: debate`: measure current ping-pong reviewer cost on a real run. Adding a 3-agent in-process debate on top is a new product, not a bugfix.
13. Before setting a global `prompt_cache_retention: 24h`: confirm the provider/model pair actually accepts it (Hermes omits it for non-mantle endpoints). Wrong field → ignored or 400.
14. Before T9 cross-provider borrow: replicate CodePilot's `interactive_only` skip and preset role-model merge, or the borrow will pick a floor model the user cannot actually call.

---

## 2026-09-02 night pass — sibling drift re-read, ACP/Cursor resume trap, reviewer payload

Re-read every leftover sibling constant from the evening ledger, then AIO
adapters + fresh-eyes/ping-pong payload + a title=/unlabeled recount. Most
pins did **not** drift. The new leaks are on AIO's own review path and on
`supportsResume` without `sameThreadContinuation`.

### Sibling constants — still true (do not re-pin)

| Source | Still |
|---|---|
| opencode `truncate.ts` | `MAX_LINES=2000`, `MAX_BYTES=50*1024` (also duplicated in `packages/core/src/tool-output-store.ts`) |
| opencode `compaction.ts` | `PRUNE_MINIMUM=20_000`, `PRUNE_PROTECT=40_000`, `TOOL_OUTPUT_MAX_CHARS=2_000`, `MIN_PRESERVE=2_000`, `MAX_PRESERVE=15_000`, protect `skill` |
| opencode `retry.ts` | overflow is **not** retryable (`ContextOverflowError.isInstance` → undefined). `RETRY_MAX_RETRIES=5`, initial delay 2000, backoff 2, jitter 0.25 |
| t3code `settingsSearch.ts` | catalog SSOT, `desktopOnly`, title **substring** only (no keywords). `PolicyTooltip` delay **200** on an info-icon button (`settingsLayout.tsx:95-110`) |
| t3code lint | `no-native-title-tooltip` is still an oxlint **error** |
| AO reaper | `massDeadMinSessions=5`, `massDeadFraction=0.5` |
| AO `ContextMeter` | hide quota until `QUOTA_WARN=75`; context warn 0.7 / critical 0.9; `role="progressbar"`; used-only (no bar) when window unknown; tooltip `delayDuration={200}` |
| AO `FieldDefaultHint` | still a caption, not a tooltip |
| storybloq | `DEFAULT_BUS_MAX_HOPS=8` (min 2 max 32); `PARK_ACTION=park_item`; `PARK_STAGES={PLAN,PLAN_REVIEW}`; `MAX_FRESHNESS_RETRIES=2`; `waiting-on-build` still a health state |
| pi | `reserveTokens=16384`, `keepRecentTokens=20000`; summarizer `cacheRetention:"none"`; PRESERVE paths/names/errors |
| claw-code | summary 1200 / 24 / 160; `DEFAULT_AUTO_COMPACTION_INPUT_TOKENS_THRESHOLD=100_000`; lane `DEFAULT_AGENT_MAX_ITERATIONS=32` |
| nanoclaw | resume injects **nothing**; fresh window two files × **16k** chars (`docs/memory.md`) |
| mempalace | `wake-up` L0+L1 ≈ 600–900; AIO `wake-context.types.ts:9` still mirrors this |
| copilot-sdk | `session.usage_info` still splits `conversationTokens` / `systemTokens` / `toolDefinitionsTokens`; `usage_checkpoint` is **billing/resume aggregate**, not occupancy |
| hermes desktop tooltip | `TIP_DELAY_MS=200`, `OVERFLOW_TIP_DELAY_MS=600`, `skipDelayDuration=0`, `disableHoverableContent=true`, `RootTooltipProvider`, `suppressNonKeyboardFocusOpen` |
| openclaw tooltip | `HOVER_DELAY=150`, `TOUCH_DELAY=450`, `SKIP_DELAY=300`, `isTooltipTextRedundant`, `aria-describedby` |

### Corrections to this file

| Claim | Verdict now |
|---|---|
| Unlabeled-button templates = **11** (ask-council + codebase on the list) | **9** file-level hits. Dropped: `codebase-panel` (now has `[title]` on the auto-status badge), `ask-council` (moved to `features/compare/`; Cancel/Clear have visible text; remaining action buttons still lack `aria-label` — UX7 style, not the file heuristic). Current 9: five browser templates + `browser-approval-request` + `orchestration-hud` + `node-service-panel` + `grpo-dashboard`. |
| `title=` **219 / 35 HTML** | **Still 219 / 35.** Late-pass "~215 matching lines" was a sloppy recount. |
| `loop-control` **17** `title=` | **12** today. |
| ACP always `aggregate-only` / resume-incapable | **Split.** `supportsResume` is `agentCapabilities.loadSession === true` (`acp-cli-adapter.ts:368`). `copilot-acp` profile is aggregate-only + `sameThreadContinuation: false`. Default ACP uses `CONSERVATIVE_PROVIDER_CONTEXT_CAPABILITIES` (`occupancyReporting: 'none'`). Recycle still never. T2 skip on `supportsResume` alone is a Cursor-ACP / Grok-ACP regression. |
| Cursor CLI occupancy | `supportsResume: true`, hardcoded `contextWindow: 200_000`, HUD cumulative with `isEstimated: true` (`cursor-cli-adapter.ts:83-90, 830-844`). **No** `getLastContextUsage` / `getContextCapabilities` override → conservative `none`. Recycle never. Do not promote the estimate (T1). T2 skip on resume-alone is also a Cursor-CLI regression. |
| Copilot T1a mapper uses conversation occupancy | **Must stay false.** Mapper `currentTokens`/`tokenLimit` is the correct recycle sample. Store the split for HUD + anti-thrash; do not make conversation-only the `used/total` pair. Still ignore `session.usage_checkpoint`. |

### New AIO token items

#### T22. Fresh-eyes review payload is looser than ping-pong [NEW]

`collectWorkspaceDiff` defaults to **64_000** chars (`loop-diff.ts:48`). Ping-pong then re-caps at **60_000** and tells the reviewer to read the rest (`agentic-pingpong-reviewer.ts:157, 307-310`). Fresh-eyes (`loop-fresh-eyes-reviewer.ts:167-172`) dumps `diffText` as-is. Collection already truncated, so this is not unbounded, but:

1. Fresh-eyes can send **4k more** than ping-pong considers reviewable.
2. Fresh-eyes does not emit ping-pong's "read the remaining files directly" instruction (only collect's `… (diff truncated for review)`).
3. `verifyOutputExcerpt` is capped at **4096** at the gate (`loop-coordinator-completion-gates.ts:408`) — good — but the builder itself does not re-cap.
4. Debate/other scaffolding uses `maxChars: 4000` (`default-invokers.ts:829`). Three different diff budgets for "show the reviewer the change."

**Fix:** one `MAX_REVIEW_DIFF_CHARS` (60k) + one truncation sentence, used by fresh-eyes and ping-pong. When truncated, prefer stat + file list + "Read these paths" over stuffing 64k into a frontier reviewer. Pair with L2 (skip identical tree).

**Size:** S.

#### T23. `supportsResume` without `sameThreadContinuation` is now three providers [NEW]

T2's evening correction named Copilot. Same trap, two more:

| Adapter | `supportsResume` | `sameThreadContinuation` | Occupancy | Recycle |
|---|---|---|---|---|
| Copilot exec | true | false | aggregate-only | never |
| Cursor CLI | true | conservative false | `none` (estimated HUD only) | never |
| ACP (Cursor/Grok) when `loadSession` | true | false (copilot-acp) / conservative | aggregate-only or `none` | never |
| Gemini / Antigravity | false | false | aggregate-only | n/a (T11) |

**Fix:** T2 skip = `supportsResume && sameThreadContinuation && !pendingContextReset && !justCompacted && iterationSeq > 0`. `loadSession` / Copilot `--resume` alone is not a proven iter-0 window. The T2 body, first-PR test list, and discovery gate 8 must use this formula — not resume-alone. Evaluate it in the coordinator (T34); do not invent `justRecycled`.

**Size:** S (same gate as T2). Add Cursor + ACP cases to the T2 test list.

### New UX / tooltip pins

- t3code `PolicyTooltip` is the 4th hint channel with **200ms** delay (not the overflow 600). Use for T3 / T17 / T20 honesty icons.
- AO ContextMeter: do not show quota chrome below 75%; never draw a fullness bar without a window (CodePilot `never ∞%` + this). Composer ring already honest; keep it.
- Actual Claude tip ids worth copying as **predicates** (not copy): `prompt-queue` (cooldown 5, relevant when the user queued while busy), `continue` (always-on, resume-after-gap). AIO analogues: queue-while-looping, recycle-just-happened. `enter-to-steer-in-relatime` is always-relevant — do **not** copy (AIO steer is next-iteration; a tip that implies live steer is a lie).
- storybloq hop-cap park writes a refused artifact and offers `redeliver_on_hop_cap_successor` — L6 "park a leaf" must **not drop** the work. Successor thread, same artifact.

### Wave 0 / Wave 1 additions

- **T23** fold into the T2 gate tests (Cursor CLI + ACP `loadSession`).
- **T22** share the 60k review-diff cap (Wave 1, with L2).
- **UX recount:** label the remaining **9** file-level unlabeled templates; ask-council action buttons still need names; do not chase the old 11-file list.
- T1a recycle stays on **`currentTokens / tokenLimit`**. Conversation / system / tools are HUD + anti-thrash inputs, not the recycle fraction. The withdrawn "conversation-only" line was a planning defect (Codex review 2026-09-02).

### Discovery gates added this pass

15. Before T2 ships: a Cursor-CLI same-session loop that drops the goal is a regression. An ACP `loadSession` loop that drops the goal is a regression. Gemini already in gate 8.
16. Before raising `collectWorkspaceDiff` above 64k: ping-pong and fresh-eyes must share one cap; `loop-repo-state.ts` 96k is a **baseline hash** budget, not a reviewer prompt budget.
17. Before treating `session.usage_checkpoint` as occupancy: it is durable billing for resume (`copilot-sdk` docs). Recycle on it is the 3500% class.

---

## 2026-09-02 fresh-eyes pass — the 1M "keep working" nudge, cheap-classify tax

The night-pass ledger was closed. Fresh-eyes on AIO survival + routing (not
another sibling constant walk) found a leak this file never named — and that
this loop itself just ate.

### T24. Sufficient complete under a phantom 1M budget injects "keep working" [NEW]

`caps.maxTokens` default is **`null`** (evening pass). Context-survival does
not treat that as "no token target." `resolveBudgetTokens` falls back to
`DEFAULT_CONTEXT_BUDGET_TOKENS = 1_000_000` (`loop-context-survival.ts:11, 114-116`).
`TokenBudgetTracker.checkBudget` (`token-budget-tracker.ts:68-71`) **always**
attaches this nudge on `CONTINUE`:

`Stopped at ${fillPercentage}% of token target (${turnTokens} / ${effectiveBudget}). Keep working — do not summarize.`

`turnTokens` is **this iteration's** tokens, not loop cumulative. Any iter that
spent < 900k (90% of the fallback) and fired a **sufficient** completion
signal gets `reason: 'completion signal fired under token target'`
(`loop-context-survival.ts:301-307`). `applyLoopContextSurvivalDecision` then
pushes it onto `pendingInterventions` as `source: 'context-survival'` unless
the queue is already non-empty (`loop-coordinator.ts:2883-2885`).

A spec locks the behaviour in (`loop-context-survival.spec.ts:127-143`).

This is the inverse of Hermes `#7915` (don't tell the model it is out of
iterations). Here the orchestrator tells a finished child it has not spent
enough of a **compaction fallback** that is not even a user-visible cap.
Review-driven clean-review cannot survive it: the next iter is binding
"keep working," so two consecutive no-change cleans never happen on a cheap
finish. Gated loops that emit a sufficient complete get the same extra turn.

Evidence: this run's own queued intervention was exactly that string at
`2989 / 1000000`.

**Fix (Wave 0):**

1. If `caps.maxTokens === null`, **never** emit the keep-working nudge.
   Compaction may still use 1M as an internal ceiling; that is not a
   "you must spend this" target.
2. If a sufficient completion signal fired, **never** inject keep-working.
   Completion and "do not summarize" are opposites.
3. If the nudge stays for under-budget *continuations* (no complete signal),
   say "loop token cap" only when the user set one. Do not print 1000000.
4. Update the spec that currently requires the nudge on complete-under-budget.

**Size:** S. Highest-leverage token win left that is not T1/T2.

**UI:** Loop help (UX6) + HUD: "no token cap" must not be narrated as a 1M
target.

### T25. Cheap-eligible classification is an extra aux call on loop spawn [NEW]

When `routingIntent === 'loop'` and model routing is on and
`auxiliaryLlmRoutingClassificationEnabled` (default **true**,
`settings-defaults.ts:375`), every child spawn calls
`classifyCheapModelEligible` (`invocation-model-resolver.ts:161-185`,
`default-invokers.ts:236-243`). That is a separate aux `generate()` over the
**goal** slice (first 4k after `## Goal`). The goal does not change after
iter 0, so the answer is stable and the call is repeated.

Fail-closed to `false` (stay on the expensive tier) on any parse/aux error —
so a down setting still pays the aux round-trip and then runs frontier.

**Fix:** cache `{ goalHash → eligible }` for the run. Skip the aux call on
iter 1+ same-session. Force `eligible: true` for known housekeeping
(title / lesson / clean-review classify) without a generate. T9 still owns
cross-provider borrow.

**Size:** S.

### T26. Review-driven pays `loopScoring` every iteration for a classifier that cannot say clean [NEW]

User-started loops default to `review-driven` (`prepareLoopStartConfig`). Every
sealed iteration hits `evaluateReviewDrivenCompletionGate`
(`loop-coordinator.ts:2437-2445` → `loop-coordinator-completion-gates.ts:182-187`)
and **unconditionally** calls `classifyCleanReview` on the full child output.

`defaultCleanReviewClassifier` (`loop-clean-review-classifier.ts:36-43`):

1. Deterministic short-circuit only when `[[LOOP:CLEAN_REVIEW]]` is on its own
   line (`confidence: 1`).
2. The required human sentence `"There are no outstanding issues"` is treated
   as **UNCLEAR** (`confidence: 0`), not clean — then the aux path still runs.
3. Unresolved-work regexes score `clean: false` at **0.85**, which is below
   the 0.9 skip, so they still pay aux.
4. Aux `loopScoring` (and, if local is down, a frontier fallback) can only
   *confirm not-clean*. A model `clean: true` is discarded
   (`:40-43`: if the model is clean or low-confidence, return deterministic).

Ping-pong already documented this asymmetry and **skips** the classifier when
a sufficient completion signal exists (`loop-pingpong-builder-done.ts:15-34, 73-82`).
Review-driven never copied that skip. Mid-IMPLEMENT iterations with no sentinel
and no done-claim still pay a `loopScoring` round-trip whose useful answers
are a subset of the regex.

**Fix (Wave 0):**

1. Do not call `classifyCleanReview` on a review-driven iter unless the output
   contains the sentinel, the required phrase, or a sufficient completion
   signal. Otherwise the gate is already "not clean."
2. Inside the classifier: skip aux when deterministic already decided
   (sentinel / unresolved regex / phrase-without-sentinel). Keep aux only for
   truly ambiguous prose, and never escalate that slot to frontier (T9).
3. Steal ping-pong's sufficient-signal short-circuit so a ledger-complete
   iter does not also pay `loopScoring`.

**Size:** S. Same class as T25 — default-on aux tax on the default loop mode.

**Do not** let the model path return `clean: true`. That guard is load-bearing
anti-self-grading (`loop-pingpong-builder-done.ts:30-34`).

### T27. `TokenBudgetTracker.STOP` is not a loop stop [NEW — corrects gate 18]

`onIterationSealed` maps `BudgetAction.STOP` to `noDecision(...)`
(`loop-context-survival.ts:252-254`). `applyLoopContextSurvivalDecision` only
honours `nudge`, `forceContextReset`, and `rehydrate`. Diminishing-returns
(`< 500` tokens after 3 recorded continuations) and the 90%-of-budget STOP
therefore do **not** pause, recycle, or terminate the loop.

Gate 18 in this pass said "keep STOP for runaway continuations." That assumed
STOP was live. It is not. Do not cite the tracker as a governor in HUD/help.

**Fix:** Wave 0 honesty — stop documenting it as protection. Wave 1 (if ever):
define "continuation" as same-iteration tool-loop continuation, not "every
sealed loop iter," then wire STOP to a real pause. Do not flip STOP on after
3 cheap review-driven iters; that would kill clean-review.

### T28. Review-driven + a closed LOOP_TASKS.md re-triggers T24 every later iter [NEW]

`LoopCompletionDetector` still runs on review-driven iters
(`loop-coordinator.ts` observe → `completionSignalsFired`). When
`LOOP_TASKS.md` has items and every leaf is `[x]`/`[-]`, it emits
`ledger-complete` with `sufficient: true` in IMPLEMENT
(`loop-completion-detector.ts:563-584`). That is the **gated** stop
signal (verify-before-stop). Review-driven does not use it: the
`else if (reviewDriven)` branch owns the terminal, so a closed ledger
does not stop the loop.

Context-survival does not know that. `hasSufficientCompletionSignal`
is a raw `some(sufficient)` (`loop-context-survival.ts:110-112`). A
closed ledger therefore takes the T24 branch:
`reason: 'completion signal fired under token target'` + the 1M
keep-working nudge.

The review-driven prompt *requires* a LOOP_TASKS ledger. Once the
agent finishes the leaves (this loop's `LOOP_TASKS.md` is all `[x]`
after iter 2), every later seal looks "sufficient" to survival even
when the child emits more-work or is mid-fresh-eyes. Evidence: this
run's iter-3 queued hint is again
`Stopped at 0% of token target (3569 / 1000000). Keep working`.

Staleness guard (`loopTasksLedgerResolvedAtStart`) only skips a
ledger that was already complete at boot. A ledger that closes
*during* the run keeps firing.

**Fix (Wave 0, fold into the T24 PR):**

1. Apply the keep-working nudge only when the coordinator's
   **terminal decision** this iter is actually "about to complete"
   (gated `stopWithSignal`, or review-driven/ping-pong accepted
   clean). Raw detector `sufficient` is the wrong namespace.
2. On `completion.mode === 'review-driven'` or ping-pong, ignore
   `ledger-complete` / `done-sentinel` / `completed-rename` for
   survival nudges. Those are gated-mode stops.
3. Spec: review-driven + all-`[x]` ledger + null `maxTokens` must
   **not** queue `source: 'context-survival'`.

**Size:** S. T24 without this still leaks on every review-driven run
that uses a ledger (the default prompt). See **T33** for the ping-pong
reviewer spawn on the same stale `ledger-complete`.

### T29. Ping-pong verify-fail injects the *head* of `npm run verify` [NEW]

On APPROVED + red verify, ping-pong queues
(`loop-pingpong-completion.ts:575-581`):

```
The ping-pong reviewer APPROVED, but the configured verify command FAILED.
… + verify.output.slice(0, 8192)
```

That is **head-only**. AIO's configured verify is
`lint && lint:fast && typecheck && … && test && verify:architecture && …`.
`lint:fast` is oxlint with `eqeqeq` / `no-explicit-any` / `prefer-const` as
**warn** (`.oxlintrc.json`). Warnings do not fail the script. They do eat
the first 8k. The real failure (last iter: stale
`architecture-inventory.json` after 20k green tests) is at the **tail**.

The in-tree summarizer already knows this
(`verify-output-summarizer.ts:24-26`: "failures cluster at the tail";
sends last 16k to the *operator* UX slot only). Gated
`verifyFailureIntervention` uses `excerpt(output, 8192)` (head+tail).
Ping-pong did not share either helper.

Evidence: this iter's binding intervention is that exact string plus a
page of oxlint `⚠` on `debug-commands.ts` / `lsp-manager.ts` — pre-existing
warns this plan loop must not "fix." A child that obeys the intervention
burns a turn on warn-level lint and never sees the failing step.

Sibling: rtk recovery is `tail -n +{offset}`, not "read the file from
byte 0."

**Fix (Wave 0):**

1. Replace `slice(0, 8192)` with `excerpt(output, 8192)` at minimum.
   Prefer the summarizer's tail (last 16k) plus a one-line
   `last failing script / exit code` header.
2. Share one helper between ping-pong, gated `verifyFailureIntervention`,
   and the 4096-char fresh-eyes excerpt (`loop-coordinator-completion-gates.ts:408`).
3. Do **not** promote oxlint warns to errors as the T29 "fix." Do **not**
   spend a loop iter mass-editing `catch (e: any)`.

**Size:** S. Highest-leverage "this run just wasted a turn" leak after T24/T28.

### T30. `runVerifyTwice` is a gated-only switch; the default modes ignore it [NEW]

User-started loops are `review-driven` (`prepareLoopStartConfig`). Ping-pong
is an overlay on that. Neither path uses the twice/quick-verify runner.

| Path | Verify call | Twice? | Quick-verify? | Ledger? |
|---|---|---|---|---|
| Gated `hasSufficientSignal` | `runRecordedVerify` v1 then v2 (`loop-coordinator.ts:2462-2478`) | yes (default on) | yes | yes |
| Review-driven clean pass | `completionDetector.runVerify` (`loop-coordinator-completion-gates.ts:190-191`) | **no** | **no** | **no** |
| Ping-pong APPROVED | one `runRecordedVerify(..., 'verify')` (`loop-coordinator.ts:3458-3464`) | **no** | **no** | yes, then can fail `ok` on ledger miss |

The Advanced checkbox and HUD `verify×2` chip describe a machine that only
exists on the legacy gated branch. T20's "add a cost hint" still implies
the knob works. It does not, on the loops this product actually starts.

Review-driven also skips the verification run ledger. A later ping-pong
round can then fail with `Verification ledger has no matching current
full verify execution` after a green `runVerify` — extra iter, T29 head
dump, no real test failure.

**Fix (Wave 0 honesty):** the checkbox/chip must say "gated mode only"
or be hidden unless `completion.mode === 'gated'`.

**Fix (Wave 0 wiring, still no architecture):** one `runLoopVerify`
helper used by gated / review-driven / ping-pong. Honour
`runVerifyTwice`, quick-verify, and the ledger. Feed T29's tail excerpt
from that helper. Do **not** "fix" this by turning twice on for
review-driven without the T20 cost hint — that would double this
loop's 8-minute verify on every clean pass.

**Size:** S.

**T13 pin:** `Caps remaining` lives only on the gated `buildPrompt`
(`loop-stage-prompt-helpers.ts:48`). Review-driven does not print it.
Rename it there; do not add it to review-driven (T8/T12).

### T31. Default continuation prompt auto-enables a second-model review [NEW]

`detectConvergeUntilCleanIntent` (`src/shared/utils/loop-intent.ts:22-61`)
treats `\bfresh[\s-]?eyes\b` as a **standalone** match. It scans
`initialPrompt + iterationPrompt`.

The renderer default continuation directive (`DEFAULT_LOOP_PROMPT` in
`loop-prompt-history.service.ts:16-34`) ends with:

`Before stopping, review your own work with fresh eyes.`

The default start path (`input-panel-loop-start.ts:35-41`) does this:

- composer text → `initialPrompt`
- panel textarea → `iterationPrompt` (when the composer is non-empty)
- empty composer → panel textarea becomes `initialPrompt`, no
  `iterationPrompt`

The panel textarea is prefilled with `DEFAULT_LOOP_PROMPT` (or the last
recalled prompt, which history migrates onto the same "fresh eyes"
string). Both start paths therefore feed that phrase into the detector:
as `iterationPrompt` (typed goal) or as `initialPrompt` (empty composer).

The panel's "Ask another model to review" checkbox defaults **off**
(`freshEyesReview = false`) and **omits** `crossModelReview` when off
(`loop-config-panel.component.spec.ts`: "sends fresh-eyes review config
only when explicitly enabled"). The coordinator then sees
`!userExplicitlySetCrossModelReview && !config.completion.crossModelReview`
and runs the detector (`loop-coordinator.ts:1007-1015`). The boilerplate
matches. It writes `defaultCrossModelReviewConfig()` (`enabled: true`).

`detectLoopGoalIntent` already **refuses** to fold `iterationPrompt`
because `DEFAULT_LOOP_PROMPT` is full of implementation verbs
(`loop-intent.ts:124-129`). Converge-until-clean was not given the same
guard. The comment says the detector "favours false negatives." As wired,
every user-started loop that leaves the default directive in place
auto-pays a finish-line cross-model review (T22 64k payload) the Advanced
row says is off.

`loop-intent.spec.ts` locks the trap in: "matches the cue in the
iterationPrompt even when the goal is plain."

See T32: on review-driven (the default mode) the child never even
receives that continuation. The tax is paid for text the model does not
see.

**Fix (Wave 0):**

1. Detect on `initialPrompt` only (same as goal-intent). Boilerplate
   continuation must not enable a second CLI.
2. When the checkbox is off, send `{ enabled: false }` so auto-enable
   cannot win.
3. Change DEFAULT_LOOP_PROMPT to "re-read the diff" / "self-review" —
   keep the child's instruction, drop the detector tripwire.
4. HUD: if the detector auto-enabled, say so. Do not show a quiet
   `fresh-eyes` chip that looks operator-chosen.

**Size:** S. Default-on token tax the panel claims is opt-in.

### T32. Review-driven never sends the continuation directive to the child [NEW]

Gated `buildPrompt` injects `iterationPrompt` on iter 1+ as
`## Loop Continuation Directive` (`loop-stage-machine.ts:488-491`).
Review-driven `buildReviewDrivenPrompt` (`:554-655`) does not mention
`iterationPrompt` at all. The coordinator comment at
`loop-coordinator.ts:1921-1924` is explicit: review-driven uses its own
prompt and does not append the loop-control CLI.

Default user-started mode is review-driven
(`prepareLoopStartConfig` / `prepareLoopStartConfig` mode default).
The panel still labels the textarea "Loop continuation directive (later
iterations)" and the hint says "then later iterations use the directive
below" (`loop-config-panel.component.html:42-51`). Past-runs / HUD still
surface `iterationPrompt` as if the child saw it.

So the default path stores a ~250-token canned constitution, trips T31
on it, shows it in the run summary, and never puts it in the child
prompt. A user who *replaces* the default with a real continuation
("skip tests, only fix types") is also ignored.

**Fix (Wave 0):**

1. Same PR as T31: if the panel text is `DEFAULT_LOOP_PROMPT` or a
   legacy default, do not send it as `iterationPrompt` on review-driven.
   The constitution already covers inventory / rename / self-review.
2. If the user typed a custom continuation, inject it into
   `buildReviewDrivenPrompt` (iter 0+ or iter 1+ — pick one and test
   both). Otherwise hide the textarea when mode is review-driven.
3. HUD / past-runs: do not show a continuation the child never received.

**Size:** S. UX honesty + removes the T31 tripwire on the default path.

### T33. Closed LOOP_TASKS.md re-opens a ping-pong reviewer every later iter [NEW]

Same root as T28, different consumer, much more expensive.

`resolvePingPongBuilderDone` (`loop-pingpong-builder-done.ts:68-82`)
treats **any** `sufficient` detector signal as "builder declared done."
That includes `ledger-complete` once every `LOOP_TASKS.md` leaf is
`[x]`/`[-]` (`loop-completion-detector.ts:574-584`). Ping-pong is
review-driven-only (`loop-coordinator.ts:1737-1738`). After the ledger
closes mid-run, `loopTasksLedgerResolvedAtStart` is still false, so
**every later seal** is sufficient. `evaluatePingPongCompletion` then
spawns a full cross-model reviewer (T22 64k), and on APPROVED runs
verify again (`loop-pingpong-completion.ts:567-595`).

This was intentional: without route (a), a finished ledger that never
emitted `[[LOOP:CLEAN_REVIEW]]` left `pp.roundCount` at 0 and ran to
the iteration cap (comment in `loop-pingpong-builder-done.ts:26-38`).
The transition fix is right. Re-firing on a *stale* all-`[x]` ledger
is not. This planning loop closed the ledger in iter 2 and has paid a
reviewer+verify round on every iter since. The queued "reviewer
APPROVED, verify FAILED" + oxlint head this iter is T33 opening the
round, then T29 showing the wrong 8k of a verify that
`lint:fast` already treats as warn-level.

**Fix (Wave 0, same PR as T28):**

1. Treat `ledger-complete` as builder-done only on the **close
   transition** (first sufficient this run, or ledger text/workHash
   changed since the last ping-pong round). A stale all-`[x]` ledger
   plus no sentinel must not spawn a reviewer.
2. Keep the sentinel / required phrase / `declared-complete` as the
   steady-state "I am actually claiming done" route.
3. Spec: review-driven + ping-pong + ledger already complete + no
   sentinel + unchanged workHash ⇒ `evaluatePingPongCompletion`
   returns null and `classifyCleanReview` is not called.
4. Do not mass-fix oxlint warns to "satisfy" the T29 dump.

**Size:** S. One predicate. This loop is the live repro.

### T34. T2 skip has no coordinator seam; `justRecycled` is not a symbol [NEW]

The locked T2/T23 formula named `justRecycled`. That identifier does not
exist. The stage machine cannot evaluate the gate:

- `buildPrompt` / `buildReviewDrivenPrompt` take no adapter capabilities
  and no recycle flags (`loop-stage-machine.ts:337-368`, `:554-562`).
- Loop orchestration never reads `getContextCapabilities()` /
  `sameThreadContinuation`.
- The prompt is built at `loop-coordinator.ts:1931-1950`.
  `consumeContextReset` runs *after* that (`:1973`). Survival queues
  `pendingContextReset` at the *end* of the previous iter (`:2885` →
  `loop-context-survival.ts:333`).
- `state.justCompacted` is set when the child recycles (`:2710`) and is
  still set at the *start* of the next iter, but `buildPrompt` never
  sees `state`. The canary clears it later (`:2211-2212`).
- Overflow / breaker / degraded retries set `forceContextReset = true`
  and `continue` the same `for (;;)` with the **already-built** prompt
  (`:2049-2055`, `:2097-2098`, `:2136`). A T2 skip computed on attempt 1
  would ship a no-goal prompt into a fresh window on attempt 2.

**Fix (same PR as T2):**

1. Coordinator, *before* `buildPrompt`: peek
   `pendingContextResets.has(id)` (do not consume yet), peek
   `state.justCompacted`, read **last-iter recorded** caps including
   **model** (T35) — not a live adapter (selection has not happened
   yet). Resolve this attempt's model with the same
   `resolveModelForInvocation({ routingPolicyKey: 'loop', ... })` the
   invoker uses (`default-invokers.ts:1287-1296`). Compute
   `reanchorGoal = !(T23 formula) || missing caps || model mismatch`.
   Missing caps or a different model ⇒ `reanchorGoal: true`.
2. Pass `reanchorGoal` into both prompt builders. They only skip
   goal/prior-obs when it is false.
3. If a retry sets `forceContextReset`, rebuild the prompt with
   `reanchorGoal: true` before `invokeChild`.
4. **T36:** also reanchor when this attempt's resolved loop model ≠
   `lastThreadCaps.model`. The invoker recycles the persistent adapter
   on that mismatch (`default-invokers.ts:1298-1308`) *after* the
   prompt exists. A prior Claude-resident snapshot must not authorize
   a no-goal prompt into that fresh session.
5. Spec: post-recycle Claude resident + pending reset ⇒ goal present.
   Same-thread Claude resident, **same model**, no reset, iter > 0 ⇒
   goal absent. Copilot `--resume` ⇒ goal present. Degraded retry that
   flips `forceContextReset` ⇒ goal present on the retry prompt.
   Same-thread snapshot + model switch on the first attempt ⇒ goal
   present (T36).

**Size:** S–M. Without this, T2 cannot be implemented without inventing
a flag or regressing gate 8. See **T35** for where the capability bits
actually live.

### T35. Adapter caps are not visible at `buildPrompt` time [NEW]

T34 said "read the live adapter" in the coordinator before `buildPrompt`.
That adapter does not exist yet.

- Selection order is borrow → persistent → fresh, inside
  `decideAdapterBorrow` + `default-invokers.ts` *after* the prompt is
  already built (`loop-adapter-borrow.ts:10-21`,
  `default-invokers.ts:1256-1338`).
- `persistentLoopAdapters` is a **private** `Map` in
  `default-invokers.ts:886`. The coordinator cannot peek it.
- A throwaway `new ClaudeCliAdapter()` / Codex factory reports
  `sameThreadContinuation: false` unless `residentClaude` /
  `useAppServer` is already on. Guessing from a factory instance would
  either always keep the goal (no T2 savings) or skip incorrectly if
  someone sets those flags on a dummy.
- Parent-chat borrow (priority 1) can be Claude resident while the
  persistent map is empty. Caps for *this* iter are the borrowed
  adapter's, known only after `decideAdapterBorrow`.

**Fix (same PR as T2/T34):**

1. After each successful `invokeChild`, copy
   `supportsResume` + `sameThreadContinuation` + **the resolved model
   that actually ran** from the adapter/result onto `LoopState`
   (e.g. `lastThreadCaps`). Clear it on recycle / `forceContextReset` /
   provider failover / model switch.
2. T34 reads only that snapshot + `pendingContextReset` +
   `justCompacted`. If the snapshot is missing **or the model differs**,
   **fail closed**: send the goal. Clearing caps *after* invoke is too
   late for this attempt's already-built prompt — compare models
   *before* `buildPrompt` (T36).
3. Do not import `persistentLoopAdapters` or `persistentLoopAdapterModels`.
   Do not construct a factory adapter to guess resident/app-server.
4. Spec: iter 0 always has the goal (no snapshot yet). Iter 1 after a
   Claude-resident invoke, **same model**, no reset ⇒ snapshot allows
   skip. Iter 1 after Copilot, after recycle, or after a model change ⇒
   goal present.
5. `LoopChildResult` (`loop-coordinator.types.ts:47-81`) has no
   capability fields. The invoker listener that holds the adapter
   (`default-invokers.ts`) must put the two bits **and the resolved
   model** on the result. The coordinator copies
   `result → state.lastThreadCaps`. That is the only legal path — the
   coordinator never sees the adapter object.

**Size:** S. One field on loop state. Without it T34 is fiction.

### T36. Last-iter snapshot + invoker model switch drops the goal [NEW]

T34/T35 as first written only rebuilt the prompt when a *retry* set
`forceContextReset`. That misses the first attempt of an iteration.

The live order is:

1. Coordinator builds the prompt (`loop-coordinator.ts:1931-1950`) using
   last-iter `lastThreadCaps`. A Claude-resident snapshot can set
   `reanchorGoal: false`.
2. Invoker then calls `resolveModelForInvocation` and, if the persistent
   adapter's recorded model differs, **recycles it before invoke**
   (`default-invokers.ts:1287-1308`, status
   `Context reset for model switch`). `oneShotContextReset = true`.
3. The child runs against a **new** session with the already-built
   no-goal prompt.

Clearing `lastThreadCaps` after invoke / on recycle is too late for this
attempt. `pendingContextReset` and `justCompacted` are also false here —
this is not the previous iter's survival queue and not a compact canary.

**Fix (same PR as T2/T34/T35):**

1. `lastThreadCaps` stores `model` (the resolved id that actually ran).
2. Before `buildPrompt`, coordinator resolves this attempt with the
   **same** `resolveModelForInvocation({ routingPolicyKey: 'loop', ... })`
   the invoker uses. Do not peek `persistentLoopAdapterModels`.
3. If snapshot.model is missing or `!==` this attempt's model →
   `reanchorGoal: true` even when T23 flags would skip.
4. If those two `resolveModelForInvocation` calls can diverge, fail
   closed (always keep the goal). Share one helper / same args.
5. Spec: iter 0 Claude-resident opus, iter 1 routing picks sonnet ⇒
   goal present. Same model both iters, no reset ⇒ goal absent.
   Provider failover already covered; this is same-provider model
   change on the first attempt.

**Size:** S. Without it T2 ships a silent goal-drop on cheap-tier
routing (T25/T9) — the exact loop that wants to skip the goal.

### Smaller pins this pass

| Item | Use |
|---|---|
| `replay-continuity.ts` last turn **4000**, default per-message **800**; `buildExistingSessionContext` overrides per-message to **1000** | T15 already; pin the 800 vs 1000 split so a "unify the cap" PR does not silently grow replay |
| `oh-my-opencode-slim` `cache-safety-tripwire.test.ts` + `cache-safety.property.test.ts` | T8 implementation method: ban volatile prefix writes in CI, don't just document T8 |
| `degradedIterationRetry` default **on**, `maxRetries: 2` | Extra full child turns on a degraded iter. Right for spawn flakes; wrong if "degraded" includes idle-without-done (L1). Keep on; do not classify announce-then-halt as degraded |
| Branch-select still default **off** and cost-cap gated | No change. Honesty already on the row |
| Failover row already has an inline hint | Leave it. Not a dead control |
| OB1 / online-orchestrator | Re-confirmed thin for this goal (no loop engine / no token policy to steal) |

| Loop panel subtitle "caps and review style apply" | T17 copy. `reviewStyle` is unused; the subtitle still advertises it |
| `nextObjectivePlanning` default **off**, already has a cheap-planner hint | Leave it. Not a default tax |
| Semantic progress default **off**, cadence 5 | Leave it. Same shape as next-objective: opt-in aux |

### Wave 0 additions

- **T24** stop the 1M keep-working nudge (null cap + sufficient complete).
- **T25** cache cheap-classify per goal hash.
- **T26** skip review-driven `loopScoring` unless the iter actually claims done.
- **T27** do not document `TokenBudgetTracker.STOP` as a live governor.
- **T28** survival nudge keys off the coordinator terminal, not raw `ledger-complete`.
- **T29** verify-fail interventions: tail / `excerpt()`, not head-only oxlint.
- **T30** `runVerifyTwice` is gated-only; label or share `runLoopVerify`.
- **T31** do not let `DEFAULT_LOOP_PROMPT` auto-enable `crossModelReview`.
- **T32** review-driven must render custom `iterationPrompt` or stop advertising it.
- **T33** ping-pong must not re-open on a stale `ledger-complete`.
- **T34** T2 skip: coordinator peeks real flags and passes `reanchorGoal`; rebuild on retry reset **or** model mismatch (T36).
- **T35** persist last-iter thread caps **including model** on `LoopState`; fail closed when unknown or the model changed.
- **T36** first-attempt invoker model-switch recycle must reanchor the goal; do not wait for a retry `forceContextReset`.
- **T1a occupancy lock** recycle = `currentTokens/tokenLimit`; conversation split is HUD + `static-overhead` anti-thrash only.

### Discovery gates added this pass

18. Before wiring `TokenBudgetTracker.STOP` to the loop: it is currently
    `noDecision`. "Continuation" in the tracker is every sealed iter, not a
    mid-iteration tool-loop. Wiring it as-is would halt cheap review-driven
    finishes. Delete the complete-signal nudge (T24) without pretending STOP
    already protects runaway spend.
19. Before treating 1M as "the old token cap we reverted": it is still live as
    `DEFAULT_CONTEXT_BUDGET_TOKENS`. A UI that says "unbounded" while survival
    prints `/ 1000000` is T3-class honesty.
20. Before letting `classifyCleanReview` return model `clean: true`: ping-pong
    and the classifier both treat that as a self-grade hole. Skip the aux call
    instead of "fixing" the asymmetry.
21. Before T1a ships: recycle `%` is `currentTokens/tokenLimit`. A test that
    `conversationTokens/tokenLimit` trips recycle while `currentTokens` is
    still low is the **wrong** polarity. The required miss-case is the
    inverse: high `currentTokens`, low conversation, large tools — must
    recycle unless static overhead alone is already ≥ threshold.
22. Before T2 ships: a same-thread Claude-resident loop whose iter-1
    `resolveModelForInvocation` differs from iter-0's recorded model must
    still include the goal on that first attempt (T36). Clearing caps after
    invoke does not count.

---

## 2026-09-02 replay Iteration 0 — isolation tax, audit defaults, rehydrate bloat, dead mode controls

Prior passes stopped at T36. This pass re-read loop start/config/survival +
worktree provision, then deep-mined siblings that were marked thin or only
partially pinned. Header already advertised these IDs; the bodies live here.

### New AIO token / honesty items

#### T37. Default isolation skips the dep clone the worktree manager already has [NEW]

**Evidence:** `loop-config-panel.component.ts:234` (`managedIsolation = true`);
isolation checkbox copy says "recommended"
(`loop-config-panel.component.html:301-307`); coordinator always passes
`skipInstall: true` (`loop-coordinator.ts:846-851`); worktree manager only
provisions deps when `installDeps && !skipInstall`
(`worktree-manager.ts:176-178`); APFS clone path already exists
(`worktree-deps.ts`).

**Waste:** User-started loops isolate by default. The child cwd is a git
worktree with `node_modules` excluded and install skipped. Auto-inferred
`npm run verify` then fails on a tree that never got deps. That burns
verify-fail iterations (and multiplies T29 head dumps / T33 reviewer
re-opens) on infrastructure, not the goal. Same `skipInstall: true` pattern
in `default-invokers.ts:788` and `campaign-coordinator.ts:172`.

**Fix:** Stop passing `skipInstall: true` on loop (and branch-select)
worktrees, or call `provisionWorktreeDependencies` after add. Wave 0: the
isolation checkbox must say verify runs without `node_modules` until that
lands.

**Wave:** Wave 0 honesty; Wave 1 one-line call-site change (clone already
implemented).

#### T38. User-started audit defaults contradict the engine and tax every default loop [NEW]

**Evidence:** Engine `defaultLoopAuditConfig()` is `observe` / `off` / `off`
(`loop-audit.types.ts:12-18`). User-started `prepareUserStartedAuditConfig`
overrides to `gate` / `record` / `prompted`
(`loop-start-config.ts:245-262`). `defaultPlanPacketMode` is `prompted` when
`maxIterations >= 5` (default cap is 50). Renderer `DEFAULT_AUDIT` matches the
override (`loop-config-panel.component.ts:84-88`); Advanced audit row has
**no** cost hints (`loop-config-panel.component.html:208-231`).

What that does on a default review-driven loop:
- Plan packet instructions are injected every iter
  (`loop-stage-machine.ts:601-603` — a one-liner that does not teach the
  schema).
- Missing packet → `plan-criteria-unproven` / `needs-review`.
- `finalAuditMode: 'gate'` on review-driven / ping-pong **rejects completion
  and continues** (`loop-coordinator.ts` final-audit branch; locked by
  `loop-coordinator-review-driven.spec.ts`).
- `no-deliverable-change` is blocking when implementation + git +
  `changedFiles.length === 0`. Loop-state-only finishes (ledger / NOTES /
  already-complete) fail the gate after a quiet finish.
- Preflight `record` runs the full verify command before iter 0 (wall-clock,
  not tokens).

**Fix:** User-started defaults should match `defaultLoopAuditConfig()`, **or**
the Advanced row must say "gate = extra paid iters; prompted = write
ROADMAP/phases every iter." Do not treat `no-deliverable-change` or a missing
packet as blocking on review-driven quiet finish. Leave preflight `record`
opt-in.

**Wave:** Wave 0 default + copy (same class as T20/T31).

#### T39. Recycle rehydrate is 50k / 20k; sibling pin is 2.8k / 1.2k [NEW]

**Evidence:** `loop-context-survival.ts:29-31` —
`MAX_REHYDRATE_FILES = 5`, `MAX_REHYDRATE_BYTES_PER_FILE = 20_000`,
`MAX_REHYDRATE_TOTAL_BYTES = 50_000`. Applied as a pending intervention after
any `contextCompacted` (`:343-355`). This file already pinned OpenClaw's
startup prelude (`maxFileChars: 1200`, `maxTotalChars: 2800`) as "Recycle
rehydrate" and never gave AIO an ID.

**Waste:** A recycle (or T36 model-switch reset) can dump ~12k tokens of plan
+ ledger + recent files into the next prompt, on top of T2's re-anchored
goal. T6 called this "bounded"; the bound is ~18× the sibling constant this
file already endorsed.

**Fix:** Cap rehydrate at OpenClaw's 1200 / 2800 (or 2k / 6k). Prefer paths +
hashes, not file bodies. Keep plan/ledger as "read these," not inline dumps.

**Wave:** Wave 1 (constant + prompt shape). Wave 0: HUD/help must not call
50k "cheap."

### New AIO UX items

#### UX11. Default-on ping-pong silently forces review-driven [NEW]

**Evidence:** `pingPongEnabled = signal(true)`
(`loop-config-panel.component.ts:208`). `buildConfig` does
`mode: this.pingPongEnabled() ? 'review-driven' : this.completionMode()`
(`:560`) and, when ping-pong is on, forces `crossModelReview.enabled: true` +
`pingPong.enabled: true` (`:576-589`). The "When is it done?" select still
offers Gated (`loop-config-panel.component.html:62-66`) while ping-pong sits
above the fold (`:112-117`). Spec locks the default on
(`loop-config-panel.component.spec.ts:139`).

**UX / tokens:** Gated is a lie whenever the default checkbox stays on. That
also forces a T22-class reviewer on every builder-done (T33 multiplies it).
T31 is a different tripwire (`DEFAULT_LOOP_PROMPT` / Advanced fresh-eyes).
This one is the visible checkbox overriding the visible mode.

**Fix:** Selecting Gated turns ping-pong off (or disables the checkbox with a
reason). Hint must say "second full agent turn every done claim," not only
"until both agree." Default ping-pong **off** unless the operator opts in
(product call; the mode override is a bug either way).

**Wave:** Wave 0 honesty.

#### UX12. Loop recipe is main-panel and unused on the default mode [NEW]

**Evidence:** Recipe select is always rendered
(`loop-config-panel.component.html:69-77`). `resolveLoopRecipe` runs only in
`buildPrompt` (`loop-stage-machine.ts:419-425`). `buildReviewDrivenPrompt`
(`:554-656`) never reads `loopRecipe`. User-started default is review-driven
(`loop-start-config.ts:154-162`); ping-pong forces that again (UX11).

**UX:** Same class as T32 (continuation directive collected, never sent).
Operator picks `coding` / a user recipe and nothing changes.

**Fix:** Hide or disable the recipe row unless mode is gated and ping-pong is
off. Or inject a one-line recipe hint into the review-driven prompt if a
non-default recipe is selected.

**Wave:** Wave 0 honesty.

### Areas re-checked this pass — nothing new

Notes curation (24k), output-externalize (50k HUD-only), anti-self-grading
(opt-in), commit-ratchet (default off), scope-assessment (no LLM), iteration
cost (pricing only), quota-throttle (fail-open by design), wake/loop-memory
(T14 already), pre-iteration guard (intentional wrap-up), child-invoker
scaffold beyond T2/T12/T13 (none).

### Sibling deep-pins this pass (previously thin / partial)

| Sibling | Constant / policy | Use |
|---|---|---|
| CodePilot `useContextUsage.ts` | `SNAPSHOT_FRESHNESS_MS = 60_000`; `%` only when `contextWindowTrusted` (SDK/upstream window, never catalog fallback); warn ≥0.8 / critical ≥0.95 | Wave 0 honesty + T1a: catalog 200k must not become a recycle % |
| claw-code `compact.rs` | `preserve_recent_messages: 4`, `max_estimated_tokens: 10_000` (compactable *slice* floor; 100k remains auto-trigger); `COMPACT_DIRECT_RESUME_INSTRUCTION` forbids recap/ack | Wave 1 / T6: keep last 4 turns; never-split tool pairs; no recap turn |
| rtk `gain.rs` | Warn when `RTK_DISABLED=1` > **10%** of bash over **7 days** (scan ≤200 sessions, fail-open); `rtk gain --failures` | Wave 4 / T5: bypass tripwire, never a green "saved %" chip |
| OB1 `safe-agent-memory-provenance.md` | `can_use_as_instruction=false`, evidence-only; skip auto-inject for superseded/disputed/generated/inferred | Wave 0: `surfaceLearnings` default evidence-only until confirmed |
| nanoclaw `context.ts` | Truncation notice `[truncated: slim this file…]`; host never overwrites existing memory files | Wave 1 / T10: append slim-and-link notice when wake is capped |
| mempalace `hooks_cli.py` | Mine synchronously on **precompact**; session-start/end must stay under **1.5s** hook budget | Wave 1: mine on recycle path only, never on spawn/wake |
| oh-my-codex `artifacts.ts` | `hasProtectedSteeringPayload` refuses rewrites of goal/gates/completed plan; aggregate objective cap **4,000** chars | Wave 2 / L6/L8: steer may split pending work, not shrink the goal |
| openclaw labs + `tooltip.ts` | Labs `activeValues` can be broader than `onValue`; `aria-describedby` **merge+restore**; `title=""` (not remove) blocks inherited native titles; `TOUCH_VISIBLE=900` | Wave 0 Labs honesty / Wave 3 UX1 |
| t3code `no-native-title-tooltip` | Flag `title=` only on intrinsic lowercase JSX; exempt iframe/embed accessible-name; allow custom-component `title` props and SVG `<title>` | Wave 3: Angular lint must not ban settings-row titles |
| Actual Claude `tipHistory.ts` | Cooldown keyed on **startup count** (`numStartups - lastShown`); `isRelevant` catch → false | Wave 5 / UX5 |
| jean | No new product policy — Fuse `threshold=0.38`, weights title3/keywords2, `limit=30` are implementer numbers only | — |
| online-orchestrator | Still thin — merge needs ≥2 responses, always `newChat: true`; **no deadlock-breaker code exists** | — |
| getideasprompt | Not product code | — |

### Wave 0 additions (this pass)

- **T37** isolation honesty: say verify may run without `node_modules` while
  `skipInstall: true` remains; then stop skipping install on loop worktrees.
- **T38** align user-started audit defaults with `defaultLoopAuditConfig()`,
  or label gate/prompted cost; do not block quiet review-driven finish on
  `no-deliverable-change` / missing packet alone.
- **T39** (Wave 0 copy) do not call 50k rehydrate "cheap"; Wave 1 cut to
  OpenClaw-scale bounds.
- **UX11** ping-pong must not silently override the mode select; default
  ping-pong off (or couple Gated ↔ ping-pong off).
- **UX12** hide/disable recipe on review-driven, or inject a one-line hint.
- **CodePilot trusted-window** gate any recycle % on a fresh SDK/upstream
  window (pairs T1a).
- **OB1 evidence-only learnings** — stop promoting generated lessons to the
  prompt until confirmed.

### Discovery gates added this pass

23. Before flipping isolation `skipInstall` off: confirm APFS clone / npm
    install path is safe on remote worker nodes and non-APFS volumes; fail
    open with a HUD warning rather than hanging iter 0.
24. Before aligning audit defaults to `observe/off/off`: decide whether
    plan-packet prompting stays for ≥5-iter loops as an *opt-in* Advanced
    default, not a silent tax. Do not keep `gate` as the user-started
    default while review-driven is the completion mode.
25. Before cutting rehydrate to 2.8k: keep plan + `LOOP_TASKS.md` as path
    pointers (always), and only inline bodies for files under the new total
    cap. A test that inlines 50k and still "passes" is the wrong polarity.
26. Before defaulting ping-pong off: the mode-override bug (UX11) lands
    regardless of the product default. Fix the override first.

---

## 2026-09-02 replay Iteration 3 — dead stop controls, rename-gate lie, missing-deps diagnosis

Fresh-eyes pass after Iteration 0 bodies landed. Sought controls collected but
unread (beyond recipe / iterationPrompt / reviewStyle), default taxes, and
sibling constants that beat T37's "flip skipInstall" recommendation.

### New AIO UX / honesty items

#### UX13. "Clean reviews to finish" is unused on the default (ping-pong) path [NEW]

**Evidence:** Panel sends `requiredCleanReviewPasses` (default 2)
(`loop-config-panel.component.ts:225-227, :561`; HTML `:102-109`). Default
ping-pong takes the completion branch first (`loop-coordinator.ts:2429-2436`).
Ping-pong stop reads `maxRounds` only (`loop-pingpong-completion.ts:253,
:301-307`) — zero reads of `requiredCleanReviewPasses`. The review-driven
prompt still teaches "The loop ends after **N consecutive** iterations…"
every iter (`loop-stage-machine.ts:577, :637-638`).

When ping-pong is off, review-driven *does* honour the counter
(`loop-coordinator-completion-gates.ts:178, :207-217`). The bug is the
default stack: ping-pong on → child is taught a stop rule the machine
ignores. Stop is actually mutual APPROVED + 15-round cap.

**Fix:** When ping-pong is on, hide/disable the clean-reviews control and
surface `maxRounds` as the real stop. Or teach the child the ping-pong stop
rule instead of `requiredCleanReviewPasses`.

**Wave:** Wave 0 honesty (same class as UX11/UX12/T32).

#### UX14. Rename-gate auto-enabled and HUD-advertised; review-driven / ping-pong never check it [NEW]

**Evidence:** Start auto-sets `requireCompletedFileRename` when uncompleted
plan files exist and the caller did not pin it (`loop-coordinator.ts:980-997`),
including default review-driven + ping-pong. HUD shows `rename-gate`
(`loop-control.component.ts:704, :758`). `passesBeltAndBraces` is the only
reader (`loop-completion-detector.ts`) and runs only on the gated
`hasSufficientSignal` branch (`loop-coordinator.ts:2446-2487`).
`evaluateReviewDrivenCompletion` / `evaluatePingPongCompletion` never call it.
Gated `buildPrompt` injects the rename contract (`loop-stage-machine.ts:405`);
`buildReviewDrivenPrompt` does not.

**UX:** Operator sees a rename contract the default completion path cannot
enforce. Auto-enable still mutates config and the HUD flag for modes that
ignore it.

**Fix:** Do not auto-enable rename on review-driven / ping-pong, or hide the
HUD chip unless mode is gated. Optionally inject a one-line rename hint into
review-driven when the operator explicitly opts in.

**Wave:** Wave 0 honesty.

#### T37 addendum — missing-deps verify looks like a red test suite

T37 covered skipInstall + checkbox copy. After spawn, a verify that exits
nonzero because `node_modules` is absent is `failureKind: 'command'`
(`loop-completion-detector.ts:724-736`). Only spawn ENOENT is `'infra'`
(`:739-746`). HUD says "Verify ran and failed" / `(command)`
(`loop-issue-diagnosis.util.ts:384-387`; `loop-control.component.ts:429`).
Child intervention: "Fix these errors before re-declaring completion"
(`loop-coordinator-utils.ts:35-37`) — no isolation / skipInstall /
`node_modules` mention. The loop keeps paying verify-fail iters on
infrastructure.

**Fix:** When isolation is on and verify output matches missing-module /
`Cannot find module` / `npm ERR!` patterns, classify as `infra` (or a new
`environment` kind) and intervene with "worktree has no node_modules;
re-run with dep provision or disable isolation."

**Wave:** Wave 0 diagnosis; pairs T37.

#### Sibling beat for T37 — Hermes `.worktreeinclude`

Hermes copies/symlinks gitignored paths listed in repo-root
`.worktreeinclude` after worktree add (`hermes-agent/cli.py:1904-1952`;
docs example includes `node_modules/` at
`hermes-agent/website/docs/user-guide/configuration.md:787-793`).
Directories are symlinked (copy fallback on Windows).

AIO still `copyExclude: ['node_modules/**']` (`worktree.types.ts:178`) while
loop start forces `skipInstall: true`. Prefer Hermes include-list (symlink
existing deps) over a cold `npm install` as the Wave 1 default strategy;
keep provision as fallback when the include list is absent.

**Wave:** Wave 1 (T37 implementation choice). Update gate 23 accordingly.

### Surfaces confirmed clean this pass

Branch-select / semantic progress / next-objective / anti-self-grading all
default OFF. `initialStage` is read by ping-pong subject classification.
Failover is read when enabled. ROADMAP schema dump beyond T38's one-liner
only exists on gated `buildPrompt` (intentional). Help still UX6; settings
search still UX10. No new sibling constant beat OpenClaw 1200/2800 or
claw-code 16k beyond `.worktreeinclude`.

### Wave 0 additions (this pass)

- **UX13** couple clean-reviews UI to the machine that is actually running
  (hide under ping-pong; show `maxRounds`).
- **UX14** do not auto-enable / HUD-advertise rename-gate on review-driven
  or ping-pong.
- **T37 diagnosis** classify missing-deps verify as infra/environment, not
  a red test suite.
- **T37 strategy** prefer Hermes `.worktreeinclude` symlink over cold
  install when implementing Wave 1.

### Discovery gates added this pass

27. Before teaching the child `requiredCleanReviewPasses` under ping-pong:
    either disable ping-pong's override of the stop rule, or stop injecting
    the unused N-consecutive sentence. A test that only asserts the panel
    default is 2 does not prove the default stack honours it.
28. Before auto-enabling rename on every mode: gated-only enforcement is
    the contract today. Auto-enable + HUD chip on review-driven is a lie;
    do not "fix" it by also blocking ping-pong completion on rename
    without an operator opt-in.
29. Before Wave 1 isolation deps: prefer `.worktreeinclude` symlink of
    existing `node_modules` (Hermes) over unconditional `npm install`;
    measure remote-worker + non-APFS fallback separately (extends gate 23).

---

## 2026-09-02 this-loop Iteration 0 — unenforced tool cap, loop-model defaults, stage chrome

Fresh-eyes pass after replay Iteration 3. Sought caps that are stored but never
checked, the highest-volume cost control's real default, and HUD chrome for a
machine review-driven does not run. Sibling coverage table still complete;
new pins below are additive.

### New AIO token / honesty items

#### T40. `maxToolCallsPerIteration` is stored, merged, and never enforced [NEW]

**Evidence:** Panel always sends `maxToolCallsPerIteration: 200` with no UI
(`loop-config-panel.component.ts:23-26, :555`). Merge clamps it
(`loop-coordinator-state-helpers.ts:36`). `checkLoopHardCaps`
(`:83-89`) only returns `'iterations' | 'wall-time' | 'tokens' | 'cost'`.
Zero reads of `caps.maxToolCallsPerIteration` exist in
`src/main/orchestration` outside that merge and fixture objects.

The nearby number that *does* fire is doom-loop `runawayCap: 200`
(`doom-loop-detector.ts:73-86, :302-307`) — a **warn/critical event** on
tool calls in one *turn*, not a loop stop. `toolLoopAutoInterrupt`
defaults **false** (`settings-defaults.ts:352`). File comment is explicit:
AIO cannot veto a CLI tool call; callers *may* auto-interrupt, gated off
(`doom-loop-detector.ts:4-11`).

**Waste / honesty:** Types, IPC, and the cap object advertise a per-iteration
tool budget. A 400-call iteration does not hit a hard cap. Doom-loop may
emit a HUD warning at 200 and keep going. Same class as T17 (`reviewStyle`)
and T30 (`runVerifyTwice` on the default path): a collected number the
machine does not honour.

**Fix:** Either drop the field from the shipped config (Wave 0 honesty) or
put it in `checkLoopHardCaps` / the child invoker and surface it on the
HUD. Do not add a second stop next to doom-loop runaway — one cap, one
interrupt policy, visible in Run configuration.

**Wave:** Wave 0 hide-or-label; Wave 1 enforce if the product wants a real
tool budget.

#### T41. Loop model ship-default only pins Codex; "Session default" is three different models [NEW]

**Evidence:** `DEFAULT_LOOP_MODEL_BY_PROVIDER` is `{ codex: GPT56_TERRA }`
only (`settings-defaults.ts:63-65`). Comment: other providers stay on the
interactive default so the change stays scoped to measured Codex burn.

`resolveAutomationDefaultModel` treats `''` / `'auto'` as
`getDefaultModelForCli` (`automation-model-defaults.ts:54-58`). House
fallbacks (`provider.types.ts:344-372`):

| CLI | House default (`getDefaultModelForCli`) | Routed `balanced` (loop policy, router ON) |
|---|---|---|
| claude | `opus` | `sonnet` (`PROVIDER_MODEL_LIST` first balanced) |
| gemini | `gemini-3-pro-preview` | `gemini-3-flash-preview` |
| copilot | `gemini-3.1-pro-preview` | first balanced = `Claude Sonnet 4.6` |
| grok | `grok-4.6` | whatever the grok catalog marks balanced |
| codex | Terra (also the loop pin) | Terra |

Loop spawn *does* pass `routingIntent: 'loop'` + `routingPolicyKey: 'loop'`
(`default-invokers.ts:1287-1295, :1363-1368`). Router default `enabled:
true` (`model-router.ts:48`). Policy default `loop: 'balanced'`
(`settings-defaults.ts:82`). So a factory Claude/Gemini loop usually
lands on Sonnet / Flash — **unless** the router is off, ChatGPT-auth
skips routing (Codex only), or an explicit `payloadModel` is set.

The Settings copy is still wrong in every case:

> **Session default** means "use whatever a new chat would use"
> (`orchestration-settings-tab.component.ts:54`).

New chats default to **Opus-1M** via `PROVIDER_MODEL_LIST[0]`
(`provider.types.ts:348-349`). House fallback is **plain Opus**. Actual
default-on Claude loops are **routed Sonnet**. The picker showing
"Session default" names none of those three.

**Waste:** Router-off / routing-skip Claude and Gemini loops ride flagship
rates on the highest-volume path — the exact 2026-07-10 Codex incident
this module exists to prevent (`automation-model-defaults.ts:8-11`).
Copilot house default is still Gemini 3.1 Pro. Operators cannot find the
picker by searching "loop" (UX15).

**Fix:** Pin Claude → Sonnet and Gemini → Flash in
`DEFAULT_LOOP_MODEL_BY_PROVIDER` (same rationale as Terra). Change the
picker caption to "Automation default (routed balanced unless pinned)".
Show the resolved model id, not "Session default". Pair with UX15 so
search reaches this row.

**Wave:** Wave 0 copy + search keywords; Wave 1 pin the remaining
providers after gate 31.

### New AIO UX items

#### UX15. Settings search cannot find the Loop model picker [NEW]

UX10 said Settings keywords omit `loop` / `recycle` / `same-session`. The
money control is more specific: Orchestration tab hosts the Loop model
list (`orchestration-settings-tab.component.ts:46-80`) while nav keywords
are `'children instances nesting limits idle'`
(`settings-navigation.ts:107-111`). Auxiliary-models keywords include
`cheap` but not `loop`. Typing "loop", "terra", "recycle", or "same-session"
does not land on the page that sets the per-iteration model.

t3code's search catalog is title-substring only (already corrected); jean
Fuse `threshold=0.38` / title3 / keywords2 is the steal. Add `loop model
terra sonnet recycle same-session iteration` to Orchestration (and
`loop classify` to Auxiliary).

**Wave:** Wave 0 (one keyword string). Wave 5 still owns full search-to-row.

#### UX16. Review-driven HUD still advertises PLAN / REVIEW / IMPLEMENT [NEW]

Default user-started mode is review-driven; ping-pong forces it again
(UX11). `buildReviewDrivenPrompt` comment: "no PLAN/REVIEW/IMPLEMENT
machinery" (`loop-stage-machine.ts:548-552`). The prompt body never
mentions `STAGE.md`.

The HUD still prints `stage {{ runningIteration()?.stage ?? a.currentStage }}`
(`loop-control.component.ts:141`). Run configuration always shows
`Start stage` (`:769`). Bootstrap still writes `STAGE.md` from
`config.initialStage` (default `IMPLEMENT`, `:93-100`). Ping-pong subject
classification is the only remaining reader of `initialStage` (replay
Iteration 3 "surfaces confirmed clean").

**UX:** Operator sees a stage machine the default path does not run. Same
class as UX12 (recipe), UX13 (clean reviews), UX14 (rename-gate).

**Fix:** Hide stage chrome unless mode is gated and ping-pong is off. Keep
writing `STAGE.md` only for gated. Do not teach review-driven to honour
stages.

**Wave:** Wave 0 honesty.

### New AIO token item (verify tax)

#### T42. Shared verify artifacts + Vitest cache turn a green suite into a red loop [NEW]

**Evidence:** `scripts/run-tests-quiet.js:60-71` writes `_scratch/test-run.log`
and `_scratch/test-results.json` unless `AIO_TEST_OUT_SUFFIX` is set. Comment
at `:60-65` already names the race: concurrent agents clobber the JSON and
the next reader sees "produced no JSON report" (or a *different* run's
failures). Vitest result cache is **on by default** (`:81-83, :127-129`).

This-loop `npm run verify` exited 1 after 1218s / 20703 tests with:

`TypeError: store.setAutoUnstickCount is not a function`
(`loop-completion-context-store.spec.ts:40, :70`).

Those methods exist and are used by the coordinator
(`loop-completion-context-store.ts:87-92`;
`loop-coordinator.ts:3307-3308`). Isolated re-run with
`AIO_TEST_NO_CACHE=1 AIO_TEST_OUT_SUFFIX=…` → **4/4 pass**. A concurrent
short run had already written the shared JSON at 23:55 (6 files / 105 tests)
while this verify was still in typecheck.

**Waste:** Default review-driven loops infer `npm run verify`. A false-red
from a clobbered report or a stale cache is a T29 head dump + another
paid iteration (T33 if ping-pong). Isolation worktrees (T37) do not help
when two loops share one checkout, or when the parent `_scratch` is the
report dir.

**Fix:** Default the quiet runner to a per-pid / per-loop suffix (the env
var already exists). Cold-cache on CI / loop verify (`AIO_TEST_NO_CACHE=1`
in the inferred command, or `--no-cache` when `ORCHESTRATOR_LOOP_CONTROL_FILE`
is set). Wave 0: HUD must not treat "setAutoUnstickCount is not a function"
as a product defect when the symbol exists.

**Wave:** Wave 0 suffix default (one-line); Wave 1 loop-inferred verify
sets the suffix + no-cache.

### Sibling pins this pass

| Sibling | Constant / policy | Use |
|---|---|---|
| t3code `ConnectionStatusDot.tsx:7-18, :51-57` | Color map is shared; ping halo **only** on `connecting`/`reconnecting`; color-only dots render a **bare `<span>` with no accessible name** when `tooltipText` is omitted | Wave 3: AIO `ls-pill` (`loop-control.component.ts:134`) is label-only with no `title` / tooltip. Do not ship color-only chips. Require tooltip text before a status dot is a button. |
| AIO `PROVIDER_MODEL_LIST` (this tree, not a sibling) | Gemini balanced = `gemini-3-flash-preview`; Copilot first balanced = Claude Sonnet 4.6; Codex balanced = Terra | T41 implementer table. Do not invent "Flash" ids. |

No new sibling beat OpenClaw 1200/2800, claw-code 16k, or Hermes
`.worktreeinclude`. jean / online-orchestrator remain thin.

### Surfaces confirmed this pass — nothing new

Help pane still has no Loop article (UX6). Tooltip primitive still absent
(UX1). `reviewStyle` still unread (T17). Recipe / iterationPrompt still
dead on review-driven (UX12 / T32). Isolation still `skipInstall: true`
(T37). User-started audit still `gate/record/prompted` (T38). Rehydrate
still 50k (T39).

### Wave 0 additions (this pass)

- **T40** drop or label `maxToolCallsPerIteration` until it is in
  `checkLoopHardCaps`; do not treat doom-loop runaway as the cap.
- **T41** fix "Session default" copy; show the resolved model id.
- **UX15** add `loop` / `terra` / `sonnet` keywords on Orchestration.
- **UX16** hide stage chrome on review-driven / ping-pong.
- **T42** per-run `AIO_TEST_OUT_SUFFIX` (pid or loop id) so concurrent
  verifies cannot clobber `_scratch/test-results.json`.

### Wave 1 additions (this pass)

- **T40** one real tool-call cap (hard stop *or* documented warn), HUD-visible.
- **T41** pin Claude Sonnet + Gemini Flash in `DEFAULT_LOOP_MODEL_BY_PROVIDER`.
- **T42** inferred loop verify sets suffix + `AIO_TEST_NO_CACHE=1`.

### Discovery gates added this pass

30. Before enforcing `maxToolCallsPerIteration`: pick one stop (hard cap vs
    doom-loop runaway + optional interrupt). A test that only asserts the
    merge clamps 200 does not prove the loop stops.
31. Before pinning Claude/Gemini loop defaults: confirm routed-balanced is
    what operators already get with the router on; the pin must match that
    (Sonnet / Flash), not house Opus / Pro. Copilot's first balanced id is
    Sonnet 4.6, not Gemini Flash — do not silently retarget Copilot.
32. Before hiding HUD stage: ping-pong `initialStage` subject classification
    stays. Do not delete `STAGE.md` bootstrap on gated runs.
33. Before treating a verify TypeError on a method that exists as a product
    bug: re-run that file with `AIO_TEST_NO_CACHE=1` and a unique
    `AIO_TEST_OUT_SUFFIX`. A red suite whose isolated file is green is T42,
    not a child defect.

---

## 2026-09-03 this-loop Iteration 1 — Grok balanced is a lie, routing pass-through

Fresh-eyes on T41's provider table and `resolveRoutedModel` pass-through.
T41's Grok row ("whatever the grok catalog marks balanced") is **wrong**.
No new sibling beat; jean / online-orchestrator still thin.

### T41 correction — Grok has no balanced row; Antigravity/Cursor were omitted

Static `PROVIDER_MODEL_LIST.grok` is one row: `grok-4.6` / **powerful**
(`provider.types.ts:594-596`). `resolveModelForTier('balanced', 'grok')`
returns `undefined`. Discovery can add `grok-4.6-mini` (classified **fast**
by `classifyGrokModelTier`, `grok-cli-adapter.models.ts:58-66`) but there
is still no balanced id unless a `*-build*` name appears.

Loop model picker also lists **antigravity** and **cursor**
(`orchestration-settings-tab.component.ts:14-22`). T41's table skipped both.

| CLI | House default | Routed `balanced` (router ON) |
|---|---|---|
| grok | `grok-4.6` (`DEFAULT_MODELS`) | **none** — see T43 |
| cursor | `auto` | `auto` (first balanced) |
| antigravity | **`undefined`** — `antigravity` is not in `CLI_TO_PROVIDER_TYPE` (`provider-model-utils.ts:298-305`) | `Gemini 3.5 Flash (Medium)` (first balanced label) |

Router-off Antigravity loops therefore have no house pin and no
`getDefaultModelForCli` fallback. The CLI picks its own default (agy
ignores unknown `--model` silently — comment at `provider.types.ts:554-560`).

### T43. Balanced Grok routing pass-through sends Claude ids; spawn repairs to flagship [NEW]

**Evidence:** Loop spawn uses `routingIntent: 'loop'` + policy `balanced`
(T41). `computeBaseDecision` with explicit tier `balanced` sets
`model: 'sonnet'` (`route-task.ts:116-123`). `applyProviderResolution`
for `provider === 'grok'` calls `resolveModelForTier('balanced', 'grok')`,
gets `undefined`, **warns and returns the Claude decision unchanged**
(`:85-90`). Spec locks the pass-through
(`route-task.spec.ts:49-54`).

`createCliAdapter('grok', { model: 'sonnet' })` then
`normalizeModelForProvider('grok', 'sonnet')`: `sonnet` is not in the
Grok catalog, so it falls back to `getPrimaryModelForProvider('grok')`
= catalog `[0]` = `grok-4.6` (`provider-model-utils.ts:158-160, :217-232`).
Comment: `grok agent -m <unknown id>` **exits 1** ("unknown model id");
repair exists so the session starts.

Cheap-classify (T25) prefers `explicitModel: 'fast'` → `haiku` → same
repair → still `grok-4.6`. There is no Grok fast/balanced pin on the
static list.

**Waste / honesty:** Default Grok loops cannot honour `loop: 'balanced'`.
Logs/HUD can show the routed Claude id (`sonnet` / `haiku`) while the
CLI runs flagship `grok-4.6`. Same class as T41's "Session default" lie,
provider-specific. A Grok loop that looks "routed cheap" is not.

**Fix:**

1. When `resolveModelForTier` is empty, fall back to that provider's
   house / primary id — never a Claude alias. Fail the spawn (or omit
   `-m`) rather than pass `sonnet` through.
2. Pin `DEFAULT_LOOP_MODEL_BY_PROVIDER.grok = 'grok-4.6'` (honest
   flagship) until a real balanced/fast Grok id exists in the live
   catalog. If discovery sees `grok-*-mini`, use that as fast.
3. Add `antigravity` to `CLI_TO_PROVIDER_TYPE` (or a dedicated default
   map) so router-off is not `undefined`.
4. HUD / Run configuration must show the **normalized spawn id**, not
   the pre-repair routed id.

**Wave:** Wave 0 honesty (do not claim Grok is balanced); Wave 1
pass-through + `CLI_TO_PROVIDER_TYPE` + pin.

### Surfaces confirmed this pass — nothing new beyond T43

T40/T42/UX15/UX16 still match the tree. Help still UX6. Tooltip primitive
still UX1. Isolation still `skipInstall: true` (T37). No new sibling
constant. `maxTurnsPerIteration` **is** wired (`default-invokers.ts:1245-1247,
:1328`) — not a T40-class dead cap.

### Wave 0 additions (this pass)

- **T41 correction** Grok row: "no balanced id", not "whatever balanced".
- **T43** do not advertise Grok loops as routed-balanced; show spawn id.
- **T43** add `antigravity` to `CLI_TO_PROVIDER_TYPE` (or document "CLI
  default") so router-off is defined.
- **T44** do not treat a red full suite as a child defect when the same
  files pass in isolation and are `??` mid-write.

### Wave 1 additions (this pass)

- **T43** pass-through must not leak Claude ids to Grok/Antigravity.
  Fallback = provider primary or omit `-m`.
- **T43** pin Grok in `DEFAULT_LOOP_MODEL_BY_PROVIDER` once the spawn id
  is honest.

### Discovery gates added this pass

34. Before pinning a Grok "balanced" id: confirm it exists on the live
    `grok models` list for this machine. Do not invent `grok-4.6-mini`
    as ship-default unless discovery classified it and the CLI accepts
    `-m`. A test that only asserts pass-through of `sonnet` is the
    wrong polarity — that is today's bug.
35. Before adding `antigravity` to `CLI_TO_PROVIDER_TYPE`: house default
    must be an **exact agy label** (e.g. `Gemini 3.5 Flash (Medium)`),
    not a `gemini-3-*` id. agy silently ignores unknown `--model`.

#### T44. Shared-checkout verify races concurrent writers [NEW]

T42 was artifact/cache clobber. This pass's isolated full verify
(`AIO_TEST_OUT_SUFFIX=loop-iter1 AIO_TEST_NO_CACHE=1`) still exited 1:
four tests in `loop-auto-unstick.spec.ts`,
`loop-coordinator-branch-select.spec.ts`,
`loop-coordinator-rpi.spec.ts` asserted auto-unstick **stole signal A**.

Current source does **not** include `A` in `ELIGIBLE`
(`loop-auto-unstick.ts:18-22`). Both files are **untracked** (`??`).
Re-run of those three files immediately after, same cold cache → **15/15
pass**. The suite compiled a mid-edit snapshot while another agent was
writing the new auto-unstick module.

**Waste:** A 580s / 20714-test run went red for a contract the tree no
longer violates. Next iteration pays another full verify (T29 head dump
if this were a child loop). Isolation (T37) does not apply when the loop
cwd **is** `ai-orchestrator` and other sessions write `??` files.

**Fix:** Wave 0: loop-inferred verify must isolate (T37 worktree **or**
refuse to start if `git status` shows foreign untracked orchestration
files). Wave 1: default `AIO_TEST_OUT_SUFFIX` (T42) does not fix source
races — only a private cwd does.

**Wave:** Wave 0 honesty (do not treat a red suite whose isolated re-run
is green as a child defect). Wave 1 isolate AIO self-verify.

### Discovery gate

36. Before blaming auto-unstick for stealing signal A: `git status` the
    spec + impl. If they are `??` and `ELIGIBLE` omits `A`, re-run those
    files before paying another full `npm run verify`.

---

## 2026-09-03 this-loop Iteration 2 — wrap-up +1, review-driven never parks

Fresh-eyes on the new untracked auto-unstick path, the cap-wrap-up guard,
the issue-card copy, Help, and the two folder entries still missing a
real sibling row. Targeted cold re-run of the six related specs:
**38/38 pass**. Isolated full verify this pass:
`AIO_TEST_OUT_SUFFIX=loop-iter2 AIO_TEST_NO_CACHE=1`.

### T45. Cap wrap-up is a silent extra paid iteration [NEW]

`capWrapUpIteration` defaults **true**
(`loop-config-defaults.ts:48-50`). When `checkLoopHardCaps` trips, the
pre-iteration guard injects `buildCapWrapUpDirective` and **continues**
(`loop-pre-iteration-guard.ts:68-82`). The next guard pass terminates.
A loop with `maxIterations: 50` therefore runs **51** paid iterations.
Token and cost caps already tripped still pay one more full scaffold
(T12 constitution + reminder + goal).

The Run configuration cap row does **not** expose this. Hint copy:
"blank = no cap" (`loop-config-panel.component.html:152-169`). Budget
note talks about the turn cap, not the wrap-up +1. No Advanced toggle.
HUD has no wrap-up chip (contrast ping-pong / gate / audit strips in
`loop-control.component.ts:173-209`).

Tools-disable is requested (`loop-coordinator.ts:3555`) but only Claude
honors it (`loop-tools-disable.ts:8-25`). Even on Claude, Read / Edit /
Write stay available so NOTES.md can be updated — "do NOT begin new
edits" is prompt-only. Codex / Gemini / Copilot / Cursor / Grok get a
full tool-capable turn after the cap. MCP tools stay on for everyone.

`buildCapWrapUpDirective` still documents the interim lie
(`loop-coordinator-state-helpers.ts:62-66`): "tools are NOT
API-disabled … deferred". That comment is stale. Implementers who
trust it will skip the Claude deny list.

**Waste:** one extra flagship turn (full T12) every time a loop hits a
cap, including token/cost caps that already overshot. Default wall is
50h so wrap-up also fires there.

**Fix:** Wave 0: HUD + cap-row hint must say "one wrap-up turn after
the cap"; delete or rewrite the stale comment. Wave 1: skip wrap-up
when the tripped cap is tokens or cost (already over budget), or run
it as a cheap aux with no T12 scaffold. Wave 2: prompt-only providers
should not get a tool-capable wrap-up — park and write the hand-off
from the last iteration's NOTES instead.

**Wave:** Wave 0 honesty; Wave 1 skip-or-cheap on token/cost; Wave 2
non-Claude park.

### L14. Review-driven never parks after auto-unstick's two strikes [NEW]

User-started loops are review-driven (UX11). They skip the no-progress
pause (`loop-coordinator.ts:3314`). Auto-unstick (`loop-auto-unstick.ts`,
still `??`) injects at most **2** next-iteration steers on fixable
CRITICAL (`G B E I D D-prime H`). Signal A is correctly excluded
(identical hash is the review-driven success signature).

After the cap, `runLoopAutoUnstick` returns `injected: false`. Gated
loops then pause. Review-driven keeps running. The next stop is T45
wrap-up at `maxIterations` (default 50+1) or wall/token/cost. Each of
those extra iters re-pays T12.

`pickAutoUnstickSignal` takes `reviewDriven` and prefixes it `_` —
eligibility is mode-blind. That is correct. The missing piece is the
**terminal policy after the 2-strike cap**, which is not mode-blind.

Hermes parks a goal on WAIT / 2-strike compact anti-thrash and does
not consume another turn (`hermes-agent` goals: park until the barrier
clears). AIO L5/L6 already asked for this. Auto-unstick implemented
the nudge and left the park out.

**Waste:** a 43× Edit thrash on review-driven now costs 2 steered
iters, then up to ~48 more full iters, then a wrap-up. The HUD asks
for a hint the whole time (UX17/UX18).

**Fix:** Wave 2: after `AUTO_UNSTICK_MAX_ATTEMPTS` on review-driven,
park (same as gated pause) or write a named OUTSTANDING leaf and
stop. Do not wait for the iteration cap.

**Wave:** Wave 2 (L6 park a defective leaf). Wave 0 is the HUD lie.

### UX17. "It will pause on its own" is a review-driven lie [NEW]

`implicationFor` when `running && CRITICAL && !autoUnstickInFlight`:

> The loop is still running. If this keeps happening it will pause on
> its own.

(`loop-issue-diagnosis.util.ts:256-257`)

That is true only for gated loops. Default user-started loops are
review-driven and **never** take that pause. After auto-unstick
attempt 2 is consumed, `autoUnstick.seq` is the previous iteration;
`autoUnstickInFlight` compares to `last.seq` (`loop-control.component.ts:663-664`)
and goes false. The lie returns for the remaining run.

While in flight the card is better ("already changing approach") but
it never says `1/2` or the signal id.

**Fix:** Wave 0: branch the sentence on `reviewDriven`. Review-driven:
"It will not pause. Hint or stop, or it keeps spending until a cap."
Show `attempt/max` + signal while unsticking.

**Wave:** Wave 0 honesty.

### UX18. Auto-unstick and wrap-up are invisible controls [NEW]

No Run-configuration toggle, no Settings keyword, no Help article
(UX6 still true — `control-surface-help.ts` has Automations/Campaigns,
not Loop Mode). HUD actions are still native `title=`
(`loop-control.component.ts:149-159`). `loop:auto-unstick` and
`loop:cap-wrap-up` fire; the status strip does not surface them.

Jean's worktree terminal indicator builds **structured tooltip lines**
(command, ports, crashed) on demand
(`jean/src/hooks/useWorktreeTerminalStatus.tsx:36-58`) — same contract
as t3code's status-dot pin, better than a single `title=`. First
auto-unstick / wrap-up chip should use that shape: `unstick 1/2 · G`
and `wrap-up · iterations cap`, not color alone.

**Fix:** Wave 0: one status chip + honest sentence (UX17). Wave 3:
real tooltip primitive (UX1) on the chip and the HUD icon buttons.

**Wave:** Wave 0 chip/copy; Wave 3 tooltips.

### Surfaces confirmed this pass — nothing new beyond T45 / L14 / UX17–18

T17 `reviewStyle` still unread. UX12 recipe still dead on review-driven.
UX14 rename-gate still gated-only. UX15 Orchestration keywords still
`children instances nesting limits idle`. UX16 still prints `stage
IMPLEMENT`. T40 `maxToolCallsPerIteration` still merged, still absent
from `checkLoopHardCaps`. T43 Grok pass-through unchanged. Help still
UX6. Isolation still `skipInstall: true` (T37). `maxTurnsPerIteration`
still wired.

`discordapi` is not a sibling product — two-line credential scratch.
`getideasprompt` is an older wording of this same research goal.

### Wave 0 additions (this pass)

- **T45** say the cap includes one wrap-up turn; fix the stale
  "tools are NOT API-disabled" comment.
- **UX17** stop promising a pause on review-driven.
- **UX18** chip for auto-unstick `attempt/max` + wrap-up reason.

### Wave 1 additions (this pass)

- **T45** do not pay a full-scaffold wrap-up after a token or cost cap.
  Cheap aux, or skip and keep the last NOTES.

### Wave 2 additions (this pass)

- **L14** park review-driven after two auto-unstick misses (Hermes
  park, not "keep going until 51").
- **T45** non-Claude wrap-up must not be tool-capable.

### Discovery gates added this pass

37. Before deleting cap wrap-up: confirm operators actually read
    LOOP_TASKS.md / NOTES.md after a cap-out. If they do not, the +1
    turn is pure waste — skip it.
38. Before parking review-driven after auto-unstick: signal A must
    stay ineligible (quiet convergence). Park only the ELIGIBLE
    CRITICAL set after 2 misses.
39. `discordapi` is credentials, not a product. Do not quote it into
    plans. Rotate the values off this disk; do not commit them.

---

### How to use this file

Turn each Wave item into a dated `_spec.md` / `_plan.md` pair when work starts.
Keep this file as the index. When a wave is implemented and verified, check it
off here. When every required item is done, rename to `grok_completed.md` and
only then commit it with the work.

Do not implement from `fable_aug-todo.md` line numbers without re-reading the
cited file; several of those lines have moved and two of its counts are wrong.


---

<a id="part-b-codex"></a>

## Part B · `codex_aug_todo.md` — AIO improvement backlog — August 2026

> Source: `codex_aug_todo.md` (August 2026). Verbatim; headings demoted one level.

> Scope: a fresh source audit of every sibling in `/Users/suas/work/orchestrat0r`
> except `ai-orchestrator`, checked against AIO’s current source. This is a
> prioritised implementation backlog, not a claim that the listed work exists.

### Executive direction

AIO already has a remarkably complete Loop Mode: per-run state, task-ledger
convergence, review-driven completion, context reset/rehydration, cost caps,
worktree isolation, final audit, cross-model review, and an Angular Loop HUD.
It also already records input/output/cache/reasoning usage where adapters
report it, calibrates a provider/model context window after overflow evidence,
anchors review findings to reviewed artifacts, caches clean reviewer angles,
durably queues ordinary session input, and enforces a byte-stable system-prompt
injection contract. The next gains are not another generic “agent loop.” They
are (1) closing the remaining semantics and attribution gaps without replacing
those shipped mechanisms, (2) making Loop-intervention delivery receipts
explicit, and (3) replacing a configuration-heavy experience and scattered
browser-title hints with an understandable control surface and an accessible
tooltip system.

Do not revive completed work merely because an older audit mentions it. In
particular, retain the current bounded artifacts, review-driven clean-pass
logic, ledger, context-survival manager, terminal completion handling, final
audit, managed isolation, and finite default spend cap unless a task below
explicitly changes their contract.

### Audit coverage

| Sibling | What was examined | Transfer decision |
|---|---|---|
| `Actual Claude` | CLI/TUI source layout, cost tracker, task and context modules | Reference only: mature CLI patterns, but no safe direct Electron reuse found in this pass. |
| `CodePilot` | Electron app structure and bridge documentation | Reference only: useful packaging comparison, no stronger Loop or context primitive. |
| `CodexDesktop-Rebuild` | Desktop shell structure | Reference only: no more capable orchestration mechanism than AIO. |
| `OB1` | skill/recipe catalog and provenance-oriented memory practices | Adopt bounded, source-attributed memory proposal workflow only; do not auto-promote memory. |
| `agent-orchestrator` | renderer UI primitives and Radix tooltip wrapper | Adopt a single accessible tooltip primitive, not the React implementation itself. |
| `ai-orchestrator-plans` | planning corpus | Evidence only; it is not a runtime source project. |
| `claude-code` | plugins, hooks, gateway/examples | Reference for hooks and policy boundaries; no direct source dependency. |
| `claw-code` | Rust runtime/session and explicit project operating docs | Reference for protocol/session discipline; no replacement of provider adapters. |
| `codex-plugin-cc` | handoff/review command flows | Reference for clear named review actions and handoff status. |
| `codex` | compaction lifecycle, context-window metadata, usage UI | Adopt provider-aware context-window/economic contracts. |
| `copilot-sdk` | session, hooks, permission, user-input and telemetry contracts | Adopt explicit admission/receipt semantics, preserving AIO’s adapters. |
| `hermes-agent` | persistent per-session composer queue | Adopt only the visible FIFO/park interaction language after durable AIO admission exists. |
| `jean` | local-first desktop/agent product structure | Reference only; no superior Loop mechanism established. |
| `mempalace-reference` | benchmark and memory-evaluation material | Use as evaluation inspiration; do not import experimental runtime architecture. |
| `nanoclaw` | bounded on-disk memory injection | Adopt explicit, independently capped memory inputs and visible truncation. |
| `oh-my-codex` | goal artifacts, reconciliation and status HUD concepts | Adopt explicit terminal-state reconciliation and status language where absent. |
| `oh-my-opencode-slim` | prompt-cache safety contracts and background-job budget gates | Reference: validates AIO's existing prefix-stability contract; retain cheap-observer ideas for future diagnostics only. |
| `online-orchestrator` | partial multi-provider responses and synthesis UX | Adopt progressive result/synthesis principles for AIO Council, separately scoped. |
| `openclaw` | bounded queues, steering leases, compaction, progress drafts, skill workshop | Adopt durable admission, bounded lease/ack delivery, and explicit authority patterns. |
| `opencode` | compaction, todo, question and session input contracts | Adopt append-only admitted input and task-visible state, not its framework. |
| `pi` | compaction hooks, branchable session model and mutation serialization | Adopt context-window identity and branch navigation research; do not duplicate AIO worktrees. |
| `rtk` | command-output compression | Continue using it in AIO operational paths; no app feature required. |
| `storybloq` | anchored review finding, coverage, cache and limit-ledger mechanisms | Reference: validates AIO's existing evidence anchors and per-angle review cache. |
| `t3code` | serialized async queues and typed ACP session boundaries | Reuse the small queue semantics as a design constraint, not a dependency. |
| `tura` | typed, bounded command-step execution | Candidate for a future read-only batched tool experiment only. |
| `userdata` | local data directory | Excluded from source adoption: not product code. |
| `worktrees` | checkout storage | Excluded from source adoption: not product code. |
| `_scratch` | disposable material | Excluded from source adoption. |

### Wave 0 — establish measurable baselines (P0)

#### 0.1 Close the remaining Loop budget-semantics and attribution gaps

**Problem.** AIO already persists input/output/cache/reasoning usage, resolves
per-model computed cost when provider cost is unavailable, and records a
provider/model context-window calibration after overflow evidence. But
`loop-context-survival.ts` still falls back from a missing calibration to
`caps.maxTokens`, even though that cap is whole-run spend. Review and
verification costs/actions also lack one explicit, purpose-attributed resource
view. The existing data therefore cannot always explain whether a reset,
reviewer call, or verify command was the cheapest safe next action.

**Implement.** Extend—not replace—the existing iteration usage/cost and
`contextWindowCalibration` contracts with a provider-neutral resource view.
Keep whole-run caps separate from calibrated/unknown context capacity; preserve
unknown rather than treating a cap as a context window. Attribute adapter usage
to input/output/cache/reasoning and record review, verification and context
actions with purpose, confidence, and before/after snapshots. Preserve the
current provider-reported versus computed/legacy-estimate distinction. Do not
alter completion/cap behaviour in this wave.

**AIO seams.** `src/shared/types/loop.types.ts`,
`packages/contracts/src/schemas/loop.schemas.ts`,
`src/main/orchestration/loop-iteration-cost.ts`,
`loop-context-survival.ts`, provider adapters, `loop.store.ts`, and the Loop
inspector.

**Acceptance.** Fixtures prove that a run total cap and a calibrated 128k
context window remain independent; absent calibration remains explicitly
unknown rather than borrowing the total cap; every compaction/reset/reviewer/
verification action has a purpose attribution; existing serialized loop state
and current cost-basis labels remain backward-compatible.

**Source evidence.** `codex/codex-rs/core/src/context/token_budget_context.rs`,
`codex/codex-rs/core/src/compact.rs`, and
`openclaw/src/infra/session-cost-usage.ts`.

#### 0.2 Add a reproducible “cost to convergence” benchmark

**Problem.** Unit tests show safety, not whether a change decreases calls or
tokens without reducing task success.

**Implement.** Create deterministic Loop fixtures for: clean no-change review,
one real blocker then clean review, stale/mislocated finding, context reset,
verify failure, and waiting-input recovery. Measure calls, tokens by purpose,
wall time, prompt bytes, and terminal status. Store versioned machine-readable
results and a human summary; make regressions fail only after a deliberately
chosen tolerance is exceeded.

**Acceptance.** CI can compare a baseline against a candidate without live
provider credentials. The report explains each delta by purpose rather than a
single total. No test records real prompts, repository code, or secrets.

### Wave 1 — make unattended execution reliable and intelligible (P0)

#### 1.1 Add explicit Loop-intervention receipts on the existing durable path

**Problem.** Ordinary session input is already durably persisted in
`SessionQueueService`/`SessionAdmissionStore` before its IPC acknowledgement,
with ordered queue positions, attachment recovery, promotion CAS and restart
reclaim. Loop `pendingInterventions` are also checkpointed immediately and
already have IDs, so they are not renderer-only. However the Loop IPC contract
returns only a boolean, its checkpoint entries do not expose receipt/delivery
state, and the text-only Loop path cannot distinguish accepted, injected,
cancelled, or failed delivery after a restart.

**Implement.** Extend the existing Loop checkpoint/intervention contract with
an explicit receipt and append-only delivery transitions: `received → admitted
→ injected/delivered → cancelled/failed`. Make `LOOP_INTERVENE` return that
receipt only after the checkpoint is durable, and make duplicate requests
idempotent by receipt/dedupe key. Keep the current discrete-turn safe boundary
(a requested `steer` remains visibly downgraded until an adapter genuinely
supports live input). Do not create a second SQLite inbox or duplicate the
ordinary `SessionQueueService`; define an explicit rejection/help path for
attachments until Loop delivery has a real provider-safe attachment contract.

**AIO seams.** `loop-coordinator.ts`, `LoopPendingInput`/checkpoint types,
Loop IPC/preload contracts, Loop control state/UI, recovery tests, and the
existing `SessionQueueService` only as the shared admission/receipt design
reference.

**Acceptance.** Kill/restart tests preserve an accepted intervention without
duplicate injection; repeated IPC delivery returns the same receipt; targeted
cancellation changes one receipt only; the UI shows durable state and the
steer downgrade; Loop attachment attempts are explicitly rejected rather than
silently discarded; provider-safe boundary tests prevent mid-tool injection.

**Source evidence.** OpenCode session-input design and OpenClaw’s bounded
lease/ack queue (`openclaw/src/agents/agent-steering-queue.ts`,
`src/shared/bounded-serial-queue.ts`).

#### 1.2 Replace the Loop configuration wall with intent-first presets

**Problem.** The current `loop-config-panel.component.ts` exposes many real
controls, but their consequences are hard to understand. The defaults are safe,
yet a user must reason about review style, compaction, strategy, audit, tokens,
spend, worktrees, and completion before simply asking for an outcome.

**Implement.** Start with four outcome presets—**Safe implementation**,
**Investigate**, **Plan only**, and **Review/fix until clean**—each rendering a
plain-language execution contract (authority, verify command, isolation,
budget, reviewer, completion rule). Keep an “advanced changes this preset”
drawer which marks overrides and can reset them. Use a compact preflight summary
and block ambiguous/dangerous combinations with an explanation, not an opaque
validation error. Do not remove existing advanced controls in the first release.

**Acceptance.** A new user can start a safe loop from one preset and accurately
state how it stops, what it may change, and its cost bound. Existing saved
configurations round-trip unchanged. Every control has a plain-language
explanation and keyboard-accessible help.

#### 1.3 Make Loop status a causal timeline rather than a dense metric strip

**Problem.** The Loop HUD already has a status pill, verdict, gate chips, trace
and actions, but the main strip compresses lifecycle, stage, iterations, time,
tokens, and cost into one sentence. It is difficult to answer “why is it still
running?” or “what will it do next?” at a glance.

**Implement.** Build a compact causal timeline with four stable steps:
**work**, **verify**, **independent review**, **terminal decision**. Surface the
currently blocking step, evidence and next automatic action. Keep total cost /
time/iteration in a secondary meter with provider-reported vs estimated label.
Show a specific recovery action for paused, budget-capped, provider-limited and
awaiting-review states. Preserve the existing detailed trace as the drill-down.

**Acceptance.** Seeded UI states make terminal reason, blocker, next action,
and estimated/observed spend available without opening the trace. Screen-reader
copy reports state changes once, without an alert storm. Visual tests cover
normal, paused, capped, review-blocked and provider-limit states.

### Wave 2 — tooltip and help system (P0)

#### 2.1 Establish one accessible, policy-tested tooltip primitive

**Problem.** AIO uses many native `title` attributes and ad-hoc labels. That is
helpful in places but not a coherent, touch-friendly, keyboard-accessible or
testable explanation system; “tooltips everywhere” must not become hundreds of
inconsistent hover strings.

**Implement.** Create a standalone Angular `AioTooltip` directive/component
with delayed hover, focus, Escape dismissal, `aria-describedby`, placement /
collision handling, reduced-motion support, long-text wrapping, and no reliance
on hover for destructive/safety-critical information. Define a `HelpCopy` map
whose entries contain label, short meaning, consequence, and optional “learn
more” route. Use an inline help disclosure where a tooltip would hide required
decision information. Add a template-lint/audit rule for icon-only buttons and
high-risk controls that lack an accessible name and help copy.

**Priority rollout.** First migrate Loop preset controls/HUD, provider and
context indicators, destructive source-control controls, capability/permission
prompts, and empty/error states. Then migrate shared icon buttons, panels and
settings by feature area. Do not mass-replace useful native titles without
testing focus and mobile behavior.

**Acceptance.** Keyboard and pointer tests prove open/close/association;
tooltip copy is visible to assistive technology without duplicate accessible
names; touch has an explicit tap/disclosure alternative; linter/audit reports
new violations; a migration inventory tracks every high-priority surface.

**Source evidence.** `agent-orchestrator/frontend/src/renderer/components/ui/tooltip.tsx`
for a shared portal primitive; AIO’s existing `aria-label`/`title` patterns as
the migration inventory, not the target architecture.

### Wave 3 — follow-on efficiency opportunities (P1)

#### 3.1 Add explicit session inbox policies after durable admission

Offer **steer now**, **run next**, **collect for a quiet window**, and
**interrupt/replace** with visible capacity, ordering and cancellation. This
depends on 1.1; do not promise durability before that transaction exists.

#### 3.2 Prototype a confined read-only batched tool behind benchmarks

Permit a small typed graph of already-authorized read operations to run in
parallel, with individual results/progress/cancellation. Mutations remain
serialized and permissioned. Advance beyond a benchmark flag only if it proves
better task completion and lower calls/tokens.

#### 3.3 Build a reviewable Skill Workshop, manual by default

Turn repeated, settled, redacted session evidence into proposals to create /
update/reject/quarantine a skill. Include source provenance, bounded budget,
validation, and an explicit human promotion step.

### Sequencing and guardrails

1. Land Wave 0 before claiming any token optimisation; it supplies the
   attribution and benchmark needed to avoid placebo savings.
2. Preserve the existing prompt-injection, evidence-anchor and per-angle-cache
   regression tests when their contracts change.
3. Land 1.1 before inbox policy UX. It is a correctness prerequisite.
4. Deliver 1.2, 1.3 and 2.1 as one coordinated user-facing release, sharing
   the same status language and HelpCopy registry.
5. Gate Waves 1–3 with the baseline benchmark, representative Electron UI
   tests, accessibility tests, migration tests and `npm run verify`.
6. Preserve provider neutrality, explicit user authority, existing worktree
   lifecycle rules, full audit traces, redaction boundaries, and ordinary
   non-Loop sessions. Never equate an estimate with provider-confirmed usage.

### Definition of success

The app can show, before and after a loop, exactly what it was allowed to do,
what is consuming tokens, whether a context action was justified, why each
review finding has authority, what input is durably queued, which gate blocks
completion, and what happens next. A user can start the safe common path
without decoding expert configuration, while advanced users retain explicit,
inspectable overrides.


---

<a id="part-c-fable-aug"></a>

## Part C · `fable_aug-todo.md` — Loop token economy, loop robustness, and tooltip/UX sweep

> Source: `fable_aug-todo.md` (2026-08-20). Verbatim; headings demoted one level.

**Contents:** [Part 1](#part-1--verified-aio-loop-mode-token-wastage-bugs-do-these-first)
(T1–T5, AIO's own verified bugs) · [Part 2](#part-2--loop-robustness-ideas-from-sibling-projects)
(L-A–L-F, loop-stall/health patterns) ·
[Part 3](#part-3--token-economy-ideas-from-sibling-projects-architectural-for-future-loop-mode-redesign)
(E-A–E-I, token-economy architecture ideas) ·
[Part 4](#part-4--tooltips-everywhere--general-ux-clarity-concrete-build-plan) (UX1–UX9, tooltip
build plan) · [Suggested delivery order](#suggested-delivery-order) ·
[Confirmed-empty corners](#confirmed-empty-corners-so-a-future-sweep-doesnt-re-check-these). Start
at the delivery order if you just want "what to build first."

Generated 2026-08-20 by an autonomous review-driven loop. Method: read AIO's own loop-mode source
first to find real, verified gaps (not guesses), then fanned out 6 read-only research agents —
3 over sibling projects not covered by the July sweep (`fable_todo.md`, `fable_todo2.md`), and 3
doing a *narrower, deeper* re-pass over already-reviewed projects specifically for token-economy,
loop-stall-detection, and tooltip/onboarding patterns that the July sweep didn't focus on.

**This file does not repeat `fable_todo2.md`.** That document is a large, still-unimplemented
idea catalog (settings overhaul, general UX, loop UX parts L1–L12, U1–U17) — read it too; nothing
in it is re-proposed here. This file adds three things that sweep missed or underweighted:

1. **Verified, file-and-line token-wastage bugs/gaps in AIO's own loop-mode code** (Part 1) — the
   highest-leverage section, because these are confirmed problems, not borrowed ideas.
2. **Loop-stall/health-detection and completion-signal patterns** (Part 2) — directly relevant
   because *this very loop run* previously dead-ended 3 weeks ago with "identical work hash
   repeated 5 times" (see `.aio-loop-state/*/OUTSTANDING.md` history) — a real instance of the
   token-wastage-via-stuck-loop failure mode this file is trying to prevent going forward.
3. **A concrete tooltip/UX plan**, because AIO has *no shared tooltip component* — but the gap is
   more specific than "no tooltips exist": 143 inline `title="..."` attributes are already scattered
   across 29 of 55 renderer component templates (confirmed by direct count, see Part 4), so hints
   exist, they're just inconsistent, unaudited, and stuck with the browser's plain/delayed/no-rich-
   content default. The sharper, more useful gap: 53 templates contain a `<button>`, and **12 of
   those have no `aria-label` or `title` anywhere in the file at all** — a real, listable set of
   completely unlabeled interactive controls (Part 4 names them). `@angular/cdk` is already a
   dependency, so a proper tooltip directive is a same-week build, not a redesign.

Also note two **existing, possibly-stale plans** worth checking before starting new token-economy
work, so effort isn't duplicated:
- `docs/plans/2026-02-22-token-memory-optimization-plan.md` (+ its design doc) — 7 token/memory
  optimizations targeting `src/main/rlm/smart-compaction.ts` and related. Not marked `_completed`.
  Six months old; status unknown. **Read and reconcile before implementing anything in Part 1** —
  it may already cover some of this, or may itself be dead/superseded.
- `docs/plans/2026-06-28-compaction-recovery-marker-spec_completed.md` — already shipped (marker
  persistence, recovery UI). Confirms the *interactive-session* compaction/recovery path is mature;
  Part 1's gap is specifically that **loop-mode's own separate context-discipline mechanism** is
  not the same system and has its own, narrower gaps.

**Addendum (same day, second pass):** closed a coverage gap — CodePilot, tura, and nanoclaw had
only been touched by the July sweep (general settings/UX), never examined specifically for
token-economy or tooltip patterns. That pass added E-H/E-I/UX7/UX8 below and produced the precise
tooltip/button-labeling counts used in item 3 above and in Part 4. It also corrected a risk this
doc almost introduced: tura's content-addressed tool-result cache pattern looked like a plausible
AIO gap on paper, but tracing AIO's actual Claude-CLI-adapter spawn path
(`adapter-factory.ts:203`, `excludeDynamicSystemPromptSections ?? true`) showed AIO already has a
working, enabled-by-default mechanism for the same cache-hit-rate goal via a different technique —
see T4 for the correction. Recorded so a future pass doesn't re-propose it as a live bug. A third
pass then independently re-verified 11 of this document's most load-bearing citations (T1–T3 plus
a diverse sample across Part 2/3/4 spanning 9 different sibling projects) directly against source —
all 11 confirmed accurate, several with verbatim comment/quote matches; one structural formatting
defect from this addendum's own edits (this paragraph having landed mid-list) was found and fixed
in the same pass.

---

## Part 1 — Verified AIO loop-mode token-wastage bugs (do these first)

All confirmed by direct source reading, not inference. Ranked most-impactful first.

### T1. Same-session loop context never recycles for 3 of 4 provider adapters [CONFIRMED — highest priority]

`src/main/orchestration/loop-context-discipline.ts:100-108` — `shouldRecycleLoopContext()` only
recycles when the occupancy observation has `status: 'known'`. Any `'unknown'` status
(`not-reported` / `aggregate-only` / `invalid-sample`) returns `recycle: false` unconditionally.
(This replaced an older aggregate-token heuristic that WS4 correctly removed — it recycled at a
"3500% utilization that never existed" per its own history comment. The fix was correct; it just
left a gap.)

Per-adapter occupancy reporting, checked directly:
- `src/main/cli/adapters/claude-cli-adapter.ts:207-212` — `known` only for a **resident** session
  with a per-call sample.
- `src/main/cli/adapters/acp-cli-adapter.ts:360`, `gemini-cli-adapter.ts:164`,
  `copilot-cli-adapter.ts:149` — **always** `aggregate-only` → always `unknown`.
- `src/main/cli/adapters/codex-app-server-adapter.ts:632,641,645` — `unknown` unless
  `useAppServer` AND `lastTurnTokens > 0`.

`contextStrategy` defaults to `'same-session'` (`default-invokers.ts:1215`). Net effect: for
Gemini and Copilot loops **always**, and Codex/some Claude configurations **often**, the
orchestrator-level recycle check is a permanent no-op for the entire IMPLEMENT stage of a loop
run. The persistent CLI conversation grows unbounded, with no orchestrator-forced compaction or
reset — the loop is entirely at the mercy of whatever (unverified) internal compaction that
provider's own CLI happens to do.

**Fix direction:** for adapters that only report `aggregate-only`, don't fall through to
permanent `false` — either (a) fall back to a conservative wall-clock/iteration-count recycle
ceiling (e.g. "recycle every N iterations regardless of occupancy, for adapters that can't report
occupancy"), or (b) extend those adapters to report a coarse-but-`known` estimate (turn count ×
median historical tokens/turn) rather than declaring defeat. Discovery gate: check whether any of
these CLIs expose a cheaper occupancy signal (e.g. Codex app-server's own usage events) not yet
plumbed through.

### T2. Goal text and prior-observations block re-sent in full every iteration, even in same-session mode [CONFIRMED]

`loop-stage-machine.ts:463-465` (`buildPrompt`) and `:584-586` (`buildReviewDrivenPrompt`) build
`priorObservationsBlock` with **no** `isFirstIteration` / `contextStrategy` gate. `goalBlock`
(`:487`, and inline at `:635` in the review-driven prompt) unconditionally re-embeds the full
`config.initialPrompt` every iteration, with a comment noting this is deliberate for fresh-process
loops — but the same unconditional code path fires when `contextStrategy === 'same-session'`,
where the goal is already present in the persistent conversation from iteration 0.

Contrast with `existingSessionContextBlock` two blocks below in the same function, which **does**
gate correctly:
```
existingSessionContext?.trim() && (isFirstIteration || config.contextStrategy !== 'same-session') ? ... : ''
```
The team already knows this pattern and applied it in one place but not the other two. This is a
small per-iteration cost individually, but it's paid on every iteration of every same-session loop
run for the run's entire lifetime, and it directly compounds T1 (never-recycled sessions keep
paying it forever) and accelerates hitting the 60% `resetAtUtilization` default (`loop.types.ts:405`)
sooner than necessary.

**Fix direction:** apply the exact same `isFirstIteration || contextStrategy !== 'same-session'`
gate to `goalBlock` and `priorObservationsBlock` that `existingSessionContextBlock` already uses.
Mechanical, low-risk, same file.

### T3. The interactive cost-cap settings (`cumulativeTokenCompactionTrigger`, `contextWarningThreshold`) have zero effect on loop mode [CONFIRMED — wiring/documentation gap]

`src/main/app/compaction-runtime.ts:178-191` wires `cumulativeTokenCompactionTrigger` into
`getCompactionCoordinator()`, which operates on `InstanceManager`-tracked `Instance` objects.
Loop mode's persistent adapters live in an entirely separate map,
`persistentLoopAdapters = new Map<string, unknown>()` (`default-invokers.ts:865`), never
registered with `instanceManager` (the one exception — a borrowed live chat adapter — explicitly
*skips* recycling: "the instance owns its compaction lifecycle and must never be recycled here",
`default-invokers.ts:1477-1479`). Loop mode instead runs its own independent
`config.context.compaction.resetAtUtilization` mechanism (default `0.6`), fully disconnected from
the Settings UI.

This isn't a bug in isolation — full-session-recycle vs. summarize-and-continue are legitimately
different strategies — but it means a user who sets a global cost-cap expecting it to bound loop
spend gets no protection there, and this gap is invisible: nothing in the UI says "this setting
doesn't apply to loop mode."

**Fix direction:** minimum viable fix is documentation/UI — surface in the loop-config panel that
loop mode uses its own `resetAtUtilization` threshold, independent of the global compaction
settings (ties into `fable_todo2.md` S2.1's exhaustive-metadata-registry work — this is exactly
the kind of surprising cross-setting relationship S3.4's "settings health notices" registry exists
to catch). A deeper fix would unify the two mechanisms, but that's a larger design change — not
recommended without a dedicated discovery pass first.

### T4. Already well-engineered — cite as the pattern to replicate, not a gap

- **PLAN-stage prior-context is correctly bounded**: `loop-prior-context.ts` `assemblePlanStageContext`
  runs once per run (`iterationSeq === 0` gate, `loop-stage-machine.ts:466,:588`), hard-capped at
  `PLAN_CONTEXT_TOKEN_BUDGET = 1_500` tokens, ≤5 codemem hits, ≤5 lessons
  (`loop-prior-context.ts:25,140-148`). Not re-computed or re-injected every iteration. Use this as
  the template when fixing T1/T2.
- **Token/cost accounting is a real hard stop, not cosmetic**: `loop-coordinator.ts:2315-2316`
  accumulates `totalTokens`/`totalCostCents`; `:2029-2035` and `:3245-3250` both call
  `terminate(state, 'cap-reached', ...)` when `maxTokens`/`maxCostCents` are exceeded.
- **NOTES.md is bounded**: `NOTES_CURATION_MAX_CHARS = 24_000` (`loop-stage-markdown.ts:181`),
  curated every iteration (`loop-coordinator.ts:2756-2777`, LF-3).
- **Cross-user cache-hit-rate optimization for the Claude CLI adapter already exists and defaults
  on** [added in the addendum pass, checked against a sibling-inspired hypothesis]:
  `excludeDynamicSystemPromptSections` (`claude-cli-adapter.types.ts:161-163`,
  `adapter-factory.types.ts:114-116`) moves per-machine dynamic system-prompt sections into the
  first user message specifically to improve prompt-cache hit rates, and
  `adapter-factory.ts:203` sets it `?? true` at the factory level — i.e. on by default for spawns
  through the normal adapter path, which includes loop mode's Claude CLI invocations. tura's
  `crates/runtime/src/context/tool_results.rs:134-157` stable content-addressed cache-id pattern
  (normalize-then-hash tool results so identical content always serializes identically) is a
  *different* technique aimed at the same goal and remains a legitimate, not-yet-adopted
  refinement if AIO ever wants tool-result-level cache stability specifically — but it is not a
  confirmed gap the way T1/T2/T3 are; AIO's system-prompt-level mechanism already covers the more
  common case. Low priority.

### T5. Minor / lower-confidence — worth a look, not urgent

- **`ITERATION_LOG.md` has no curation** (unlike `NOTES.md`) — grows append-only for the life of a
  run. The coordinator never reads it into a prompt itself (agents are told to open it only if
  needed, `loop-stage-machine.ts:515`), so this is agent-discretionary spend, not coordinator-forced.
  Plausible drain on very long runs; not confirmed as active.
- **Parallel git-worktree branches re-index near-identical trees independently** —
  `src/main/codemem/code-index-watcher.ts` has no worktree-awareness (no `worktree`/`dedupe`/
  `gitRoot`/`contentHash` hits); `parallel-worktree-coordinator.ts` spawns one `LoopCoordinator`
  per worktree, each independently searching its own index. Prompt cost stays capped by T4's
  1,500-token budget, so this is a compute-duplication finding (redundant background
  embedding/indexing), not directly an LLM-token one. Not confirmed whether the underlying
  vector-store/embedding cache is shared beneath the per-workspace index — worth a follow-up check
  before deciding this needs fixing.

---

## Part 2 — Loop robustness ideas from sibling projects

Directly relevant: this exact loop (`loop-1787241037235-b6fe2309`, and its predecessor run) has a
documented history of "identical work hash repeated 5 times" stalls. AIO's own stall/no-progress
detection (`computeWorkHash`, `loop:paused-no-progress` events, post-compaction health canary —
all in `loop-coordinator.ts`) is already more sophisticated than most of what the sibling sweep
found — but a few patterns are worth adding on top:

### L-A. Separate "alive" from "progressing" as independent probes, not one fuzzy signal
storybloq `src/autonomous/health-model.ts:11-114` — `reduceHealthState()` classifies a session as
`healthy | working | waiting-on-build | waiting-on-dialog | telemetry-stale | stalled | zombie |
ended | crashed | unknown` from independent boolean probes (process-alive, MCP-responsive,
guide-advancing, subprocess-alive, dialog-clear, binary-fresh) with explicit thresholds per probe
(alive=30s, MCP-responsive=5min, guide-advancing=15min, zombie=30min total silence). The key
insight: a session can be **alive but stalled** (responsive, not advancing) vs. **zombie**
(everything silent) — two different diagnoses needing different remedies. AIO's work-hash
detection is one axis of this; adding a liveness/responsiveness axis alongside it (not replacing
it) would let the loop distinguish "the agent is thinking slowly" from "the agent is stuck
repeating itself" from "the child process died."

### L-B. Named, actionable non-convergence diagnostics instead of a raw iteration count
storybloq `src/autonomous/session-diagnostics.ts:157-263` — three concrete diagnostics:
`code_review_non_converging` (review↔implement cycling with no blocking findings but still
looping), `landable_uncommitted` (agent believes it's done but never committed — a "claims success
but isn't" failure mode directly relevant to this loop's own completion-gate rules), and
`scope_expanded` (round/finding count blows past `cap + N`, meaning the task ballooned beyond
original scope). Also counts literal state-machine backtracks. AIO's `no-progress` status is a
single bucket; splitting it into named causes (like these three) would make `OUTSTANDING.md`'s
auto-generated recommendations sharper.

### L-C. Two-tier completion signal (mechanical stop vs. semantic done) + auto stall-nudge
copilot-sdk `docs/features/agent-loop.md:108-163` — `session.idle` (mechanical, always fires) is
kept distinct from `session.task_complete` (semantic, model-asserted). If autopilot goes idle
*without* `task_complete`, the CLI auto-injects a one-shot nudge ("you aren't done until fully
complete... don't call task_complete prematurely") and restarts the loop. More robust than a bare
promise-string match (see the negative example below) because it separates "nothing more is
happening right now" from "the model believes the goal is met."

**Negative lesson, worth citing explicitly:** claude-code's `ralph-wiggum` plugin
(`plugins/ralph-wiggum/hooks/stop-hook.sh:114-130`) re-feeds the *same, ever-growing* transcript
back into one continuous session every iteration via a Stop-hook `decision: block`, with **no**
context reset or compaction between iterations and no stall detection beyond a raw iteration cap.
This is a real illustration of exactly the failure mode T1/T2 above are trying to prevent — cited
here as a concrete "don't do this" reference, not a pattern to adopt.

### L-D. Mass-death circuit breaker for liveness probes
agent-orchestrator `backend/internal/observe/reaper/reaper.go:22-32,140-188` — if a single probe
pass concludes ≥5 sessions AND >50% of the pass are "dead" simultaneously, that's treated as one
infrastructure blip (probe/network issue), not N independent deaths, and all conclusions in that
pass are downgraded to "probe failed" rather than acted on. Relevant if AIO ever runs many
concurrent loops (parallel worktrees, multiple instances) — prevents one transient CLI hiccup or
rate-limit event from mass-terminating unrelated healthy loops.

### L-E. Cheap heuristic phase inference for the status display (no model call)
codex-plugin-cc `plugins/codex/scripts/lib/job-control.mjs`, `inferLegacyJobPhase` (lines 109-159)
— pattern-matches recent tool-call log lines to classify a job's current phase
(starting/investigating/reviewing/verifying/editing/finalizing/failed), e.g.
`looksLikeVerificationCommand` regexes for test/lint/build commands. Directly reusable for AIO's
loop-status chip/badge: turn raw tool-call noise into a small human phase label without spending a
model call on it.

### L-F. Isolated-subagent stop-gate review, verdict-only return
codex-plugin-cc `plugins/codex/scripts/stop-review-gate-hook.mjs` (`runStopReview` 98-140, `main`
142-176) — spawns a fully separate process to adversarially review the prior turn's work with a
15-min timeout; only a one-line `ALLOW:`/`BLOCK:` verdict crosses back into the main session. This
is the same shape as AIO's own **Completion Fresh-Eyes Gate** convention already in play for this
session (fresh subagent, independent verdict) — cited here as external confirmation the pattern is
sound, and as a reminder that the verdict-only return (not the full review transcript) is the part
that keeps it token-cheap.

---

## Part 3 — Token-economy ideas from sibling projects (architectural, for future loop-mode redesign)

These are heavier-weight ideas than Part 1's bug fixes — relevant mainly if/when loop mode's
process-per-iteration architecture is revisited. Recorded now so they aren't lost, not proposed as
immediate work.

### E-A. The core architectural insight
hermes-agent's own docs are blunt about this trade-off
(`docs/micro-compaction.md`; wiring at `agent_init.py:2109-2118,2664-2666`): rewriting transcript
history on every turn (their opt-in "micro-compaction") breaks the prompt-cache prefix on *every
single turn*, and their default is deliberately batch-only to keep the cache prefix stable between
compactions. **AIO's current loop-mode design — a brand-new child process every iteration — is
already the worst case this describes**: it forfeits prompt caching entirely by construction, for
every iteration, not just at compaction points. Before investing in a smarter summarizer, the
higher-leverage fix is architectural: reduce how much of the per-iteration prompt is forced to
change (Part 1's T2 is a first step) so that if the underlying CLI *does* reuse a session/cache-key
across iterations, some prefix has a chance to survive.

### E-B. Stable-prefix / volatile-tail cache boundary, set at construction time
hermes-agent `agent/prompt_cache_boundary.py:1-95` — builders register the exact static-scaffold
portion of a prompt via `register_stable_prefix()`; the cache planner finds the longest registered
prefix and places the `cache_control` breakpoint there, splitting static instructions from the
volatile tail (ticket payload / timestamp / run state) into two content blocks — explicitly
avoiding marker-string parsing because volatile payloads can legitimately quote a marker. Directly
applicable to loop-mode prompt construction: build [goal + instructions] as one block and
[NOTES.md/OUTSTANDING.md/iteration state] as a separate block appended after it, so a
cache-capable transport has a shot at reusing the stable half.

### E-C. Automatic 3-point cache-breakpoint policy (tools / system / latest turn)
opencode `packages/llm/src/cache-policy.ts:1-111` — default policy places Anthropic's cache
breakpoints at the last tool definition, the last system-prompt part, and the latest user message
only (not earlier turns, since those don't change once written) — reasoning that a single user
turn can explode into many assistant/tool round-trips, so caching at that boundary lets *every*
intra-turn call hit the prefix. A drop-in win **if** AIO ever keeps a persistent session across
loop iterations instead of spawning fresh processes.

### E-D. Structural (non-LLM) tool-output pruning, separate from summarization
opencode `packages/opencode/src/session/compaction.ts:28-31,271-311` — backward-scan keeps the
newest `PRUNE_PROTECT` (40k) tokens of tool output untouched; anything older than that, once total
reclaimable exceeds `PRUNE_MINIMUM` (20k), gets replaced with `"[Old tool result content
cleared]"` — zero model cost, pure structural truncation, tool-call/result shape preserved for
transcript coherence. `PRUNE_PROTECTED_TOOLS` exempts specific tool types. AIO's rough analogue:
NOTES.md/OUTSTANDING.md accumulate appended history across iterations with no cap on how much of
the *old* content gets re-read verbatim before any LLM-based curation runs — a same-shaped
"truncate stale local content before the iteration starts" guard would be free savings, ahead of
the existing 24k-char NOTES.md curation (which already exists, so this is about the read side, not
the write side).

### E-E. Per-mechanical-task cheap-model routing (real infrastructure, not just "use haiku")
jean `src/types/preferences.ts:776-843,1161,2298` — independently configurable models per
mechanical task (`commit_message_model`, `session_naming_model`, `context_summary_model`, etc.),
wired end-to-end through the preferences UI. opencode's simpler version: one `small_model` config
(`packages/core/src/v1/config/config.ts:77-78`) backing a dedicated `title` agent
(`packages/opencode/src/agent/agent.ts:234-247`). If AIO's loop mode has any mechanical chores
(run-title generation, status-summary formatting) riding the main model today, either pattern is a
low-risk structural change — start with opencode's single global cheap-model knob before building
jean's full per-task matrix.

### E-F. Deterministic output-compression proxy for known-noisy commands
rtk (whole project; `src/cmds/*` — 100+ filters for `git`, `pytest`, `cargo`, etc.) — sits between
shell commands and agent context, rewriting verbose output into compact forms (`git log` →
hash/author/subject; test runners → failures-only with pass counts; `git status` → grouped compact
stat) **before** it ever reaches the model. This is a different lever from compaction: instead of
compressing after the fact, never let the noise in. AIO's loop iterations run `npm run verify` and
similar — a deterministic filter for well-known noisy commands (test runners, linters, git) would
cut tokens with zero LLM involvement and zero information loss for the parts that matter (failures).
Also ships a user-facing "token-savings ledger" (`src/analytics/gain.rs`) — a good UX precedent for
making the payoff of these optimizations visible over time, not just theoretical.

### E-G. Provider-native/server-side compaction offload (zero client-side summarization cost)
hermes-agent `agent/native_compaction.py:1-75` — for supported models on direct routes, sends
`context_management=[{"type": "compaction", ...}]`; the provider does summarization server-side
and returns an opaque replayable compaction item — the client pays zero LLM-call cost for it.
Codex mirrors the client side (`codex-rs/core/src/compact_remote.rs`,
`compact_remote_v2.rs`) and separately has `compact_token_budget.rs`, which installs a fresh
context window with **no** summarization call at all when cheapness matters more than retained
detail. **Discovery gate before pursuing:** check whether the specific CLIs AIO shells out to
(Codex in particular) expose a `--resume`/session-continuation flag loop mode isn't currently
using — if AIO already treats each iteration as a fully stateless one-shot invocation, this
feature is being bypassed entirely regardless of what the provider supports.

### E-H. Cross-provider fallback for cheap-tier ("aux model") routing [added in addendum pass]
CodePilot `src/lib/provider-resolver.ts:1602-1633` (`resolveAuxiliaryModel`) — when the *main*
configured provider has no cheap/small model slot, or is proxy-only and structurally can't run a
cheap call (their example: Zhipu/Kimi), the resolver scans every *other configured* provider for
the first one that has a small/haiku-equivalent slot and borrows it — with an explicit
last-resort fallback (`context-compressor.ts:296-303`) that logs a warning and runs at main-model
cost rather than silently failing. AIO's existing 11-slot aux-model table and
`orchestrationRoutingPolicyJson` (per `fable_todo2.md` S4.2) route per-task but, on inspection,
appear to stay within whichever single provider is configured — no "if this provider has no cheap
tier, borrow one from a different connected provider" fallback was found. For a genuinely
multi-provider orchestrator (AIO's whole premise — Claude/Gemini/Codex/Copilot side by side) this
is a more valuable and more on-brand version of "cheap-model routing" than anything in Part 3
above, since AIO already has the multi-provider connections CodePilot's pattern needs.

### E-I. Content-addressed tool-result caching — see T4's correction, not proposed here
tura's `stable_context_cache_id` pattern (normalize-then-hash tool results for stable
serialization) initially looked like a plausible AIO gap but traced back to a mechanism AIO
already has for the equivalent goal — see T4 above for the full correction. Recorded here only so
this addendum's research trail is complete; not an open item.

---

## Part 4 — Tooltips everywhere + general UX clarity (concrete build plan)

Confirmed baseline: AIO has no shared tooltip *component*, but hints are not entirely absent —
143 inline `title="..."` attributes already exist across 29 of 55 renderer component templates
(`instance-row.component.html:95,103,106,115,118,133` and many more), with no delay control, no
rich content, no keyboard path, no central copy registry, and no way to audit coverage (a `title=`
easily goes stale or gets forgotten on a new control, and nothing catches that). The sharper,
listable gap: of the 53 templates containing a `<button>`, **12 have no `aria-label` and no
`title` anywhere in the file** — genuinely unlabeled interactive controls, not just
low-quality-tooltip ones:
```
node-service-panel.component.html          (remote-nodes)
browser-page.component.html                (browser)
browser-approval-request.component.html    (instance-detail)
browser-campaign-list.component.html       (browser)
orchestration-hud.component.html           (orchestration)
ask-council-page.component.html            (compare)
grpo-dashboard.component.html              (training)
browser-credential-authorization-panel.component.html (browser)
browser-escalation-queue.component.html    (browser)
browser-vault-control.component.html       (browser)
browser-unattended-panel.component.html    (browser)
codebase-panel.component.html              (codebase)
```
Notably clustered in the newer/more-advanced feature areas (browser-gateway automation, remote
nodes, orchestration HUD, GRPO training, codebase indexing) — consistent with these being younger
surfaces that haven't caught up to whatever labeling discipline the older/core panels have. This
list is the concrete starting point for UX3 below, not a hypothetical.

`@angular/cdk` is already a dependency (`package.json:123`), so a proper overlay-based tooltip is
a same-week build, not a redesign. This directly extends
`fable_todo2.md` S3.5 (behavior-gated tips) and U13 (release-notes dialog) without duplicating them
— those cover *contextual* hints and *release* messaging; this is the missing foundational
component both would sit on top of.

### UX1. Build one `TooltipDirective` on CDK Overlay [build first — everything else depends on it]
Reference: opencode `packages/ui/src/components/tooltip.tsx:35-163`. Copy the numbers and the
dismiss logic, not the Solid/Kobalte implementation:
- `openDelay: 400ms`, `skipDelayDuration: 300ms` (fast re-open moving between adjacent triggers),
  `closeDelay: 0`.
- Auto-suppress while the trigger itself has `aria-expanded="true"` (i.e. it opened a
  dropdown/popover) — prevents dueling floating layers. A `MutationObserver` on the host, or an
  `@Input()` signal the trigger component sets, both work in Angular.
- A short "just clicked" block window so a click that opens something else doesn't immediately
  re-trigger the tooltip on release.
- Real keyboard support: open on focus (Enter/Space via `(keydown)`), close on `(focusout)` — not
  mouse-only.
- Content via `<ng-template>` projection, so it's a rich-content slot (see UX3), not a plain string.
Build as: `TooltipDirective` (host directive, `CdkOverlay` positioning, `signal`-based open state)
consumed as `[aioTooltip]="templateRef"` or `[aioTooltipText]="string"` for the simple case.

### UX2. Centralized tooltip-copy registry, not inline strings
Reference: opencode's i18n-namespace convention (`packages/app/src/i18n/en.ts:226-234,788,966-967`,
consumed via `language.t("model.tooltip.reasoning")`, `model-tooltip.tsx:42-93`). AIO has no i18n,
so skip the localization machinery and keep just the discipline: a plain
`TOOLTIP_COPY` constant object (e.g. `TOOLTIP_COPY.instanceRow.hibernatedDot`,
`TOOLTIP_COPY.settings.repoMapTokenBudget`) that components import instead of inlining strings in
`.html`. This is what actually fixes "no centralized registry, no way to audit coverage" — a grep
for `TOOLTIP_COPY` shows every tooltip that exists, and a lint rule can eventually forbid bare
`title=` attributes on interactive controls once the migration is done.

### UX3. Status-dot / badge → tooltip via a pure `label(state)` function [apply first, highest ROI]
Reference: t3code `apps/web/src/components/ConnectionStatusDot.tsx:1-77` — `connectionPhaseDotClassName(phase)`
and a matching tooltip-text function are pure, exported, unit-testable; the dot itself is a real
`<button aria-label={tooltipText}>` so screen readers get the same text sighted users get on hover
— one string serves both. Companion: jean `src/components/chat/toolbar/McpStatusDot.tsx:10-84` —
`authHint(backend)`/`mcpStatusHint(status, backend)` return *actionable* copy ("Needs
authentication — run 'x' to authenticate"), not just a state name.
**Apply this first** to AIO's existing unexplained dots/chips flagged in `fable_todo2.md` and found
directly in `instance-row.component.html` (hibernated-overlay-dot, unread-dot, automation-clock,
`needsAttention` dot) — these are the single most confusing "what does this mean" surfaces in the
current UI and the fix is small per-dot once UX1/UX2 exist.

**A second, verified instance of the same underlying gap** [added iteration 5, direct inspection]:
loop-run status badges have exactly this "state exists, color-coding doesn't" problem, and it's
duplicated ad-hoc rather than centralized. `loop-formatters.util.ts:175-193`'s `loopStatusLabel()`
already enumerates the full 16-value status space (`completed`, `completed-needs-review`,
`cancelled`, `failed`, `cap-reached`, `error`, `no-progress`, `provider-limit`, `cost-exceeded`,
`needs-human-arbitration`, `reviewer-unreliable`, `reviewer-unavailable`, `builder-unreliable`,
`paused`, `running`) — but each consumer defines its own partial CSS color map by hand:
`loop-outstanding-panel.component.ts:273-274` colors only 2 of the 16 (`completed`,
`completed-needs-review`); `loop-past-runs-panel.component.ts:199-203` colors a *different* 5
(`completed`, `cancelled`, `cap-reached`, `error`, `no-progress`). Both independently checked
components leave `failed` — arguably the single most severe terminal status — with no color at
all, falling through to the same neutral gray as `paused`/`running`. Fix: add a
`loopStatusTone(status): 'success' | 'warning' | 'danger' | 'neutral'` function colocated with
`loopStatusLabel` in the same file (one source of truth for the full 16-value mapping), and have
both components' CSS key off `data-tone` instead of hand-rolled per-status color rules — the same
"pure `label(state)`/`tone(state)` function" principle this item already recommends, just proven
here against a second, independently-verified surface rather than asserted once and assumed to
generalize.

### UX4. Rich structured tooltip content for multi-fact rows
Reference: opencode `model-tooltip.tsx:26-124` — builds a tooltip as labeled rows (Model / Provider
/ Inputs / Reasoning / Context) instead of one paragraph, which a plain `title=` attribute
structurally cannot do. Apply to AIO's provider/model pickers and CLI-health rows where several
facts need showing at once — pairs directly with T3 above (surfacing "loop mode uses its own
threshold, not the global setting" as a structured tooltip on the relevant settings row rather
than a hidden fact).

### UX5. Keybind-aware tooltips pulled from the live registry, not duplicated strings
Reference: opencode `TooltipKeybind` (`tooltip.tsx:15-33`) and
`packages/app/src/components/command-tooltip-keybind.ts` — render "Action name" + a right-aligned
key chip sourced live from the keybind registry (`command.keybindParts(id)`), never a hardcoded
string that can drift from the actual binding. If AIO's tooltips ever need to show a shortcut,
wire to the live registry from day one.

### UX6. First-run / "what's new" tour, reusing existing dismissal conventions
Reference: jean `src/components/onboarding/FeatureTourDialog.tsx:16-317` — paged `TourStep[]`
(title/description/items, optional shortcut chip), full keyboard nav (arrows/Enter/S-to-skip,
clickable step dots), dismissal persisted as a single `has_seen_feature_tour` flag. This is the
concrete component `fable_todo2.md` U13 (release-notes dialog) was gesturing at, plus the
first-run case it didn't cover. Build once UX1–UX3 exist so tour content can reuse the same
tooltip/rich-content primitives rather than a bespoke dialog.

### UX7. Honest-degradation cost/context badge, hover-expandable [added in addendum pass — directly closes fable_todo2.md L8]
CodePilot `src/components/chat/ContextUsageIndicator.tsx:66-158` — a HoverCard-based badge with
two branches: when context capacity is known, a live progress ring plus a hover breakdown split
into input/output/cache usage; when capacity is *unknown*, it deliberately shows
`usedTokens · capacity unknown` with an explanatory popover rather than a bogus `∞%`/`NaN%` — a
comment in the source calls a misleading percentage there "breaking trust." Companion:
`src/components/settings/UsageStatsSection.tsx:233-290` ships a dedicated cache-hit-rate stat card
(`cache_read_tokens / (cache_read_tokens + total_input_tokens)`) sourced from real per-session
usage rows. AIO has no `HoverCard`/tooltip-based token-breakdown badge anywhere in the renderer,
and per `fable_todo2.md` L8, its instance-row/workboard cards show no cost/context info at all
even though the loop store already has the numbers — this is the concrete component to build for
that gap, with the honest-degradation branch as the one detail worth copying precisely (AIO's own
occupancy reporting is `unknown`/`aggregate-only` for several adapters per T1, so a badge that
handles "unknown" gracefully rather than faking a percentage is directly load-bearing, not
cosmetic polish). Also worth checking: AIO's own `prompt-cache.ts` already computes
`CachePerformanceMetrics`/hit-rate internally (per T5's earlier note) — confirm whether anything
in the renderer actually surfaces it before building a new stat card from scratch.

### UX8. Getting-started checklist bar as a lighter onboarding surface than a full tour
CodePilot `src/components/settings/OverviewGettingStartedBar.tsx:1-108` — a simpler onboarding
alternative to UX6's full tour: a sorted checklist (incomplete items first), per-item jump-to
action with no forced order, an N/M-complete counter, and the whole bar unmounts once everything
is done rather than lingering as permanent clutter. No positioning/step-sequencing logic needed —
just a sorted list plus gated visibility. Good first onboarding surface to build for AIO's
Settings Overview specifically, ahead of or instead of the heavier UX6 tour if sequencing effort
needs to be minimized.

### UX9. The loop config panel itself — an unimplemented option in a live dropdown, and an ungrouped 13-toggle Advanced section [added iteration 4, direct inspection of the literal "loop... UX" surface]
`src/renderer/app/features/loop/loop-config-panel.component.html` (460 lines) is the actual Loop
Mode configuration UI — the most on-topic single surface for this document's "looping better, UX
cleaner" goal, and one I hadn't directly read until this pass (prior work audited the loop
*backend* extensively but not this UI). Two concrete, verified findings:

1. **A dropdown option that does nothing different from another option, and says so** (lines
   262-269): the "Context strategy" `<select>` offers `same-session` / `fresh-child` /
   `hybrid — not yet implemented; falls back to fresh-child`. Traced the claim: `LoopContextStrategy`
   is typed to include `'hybrid'` (`loop.types.ts:76`), but the only place it's consumed,
   `default-invokers.ts:1216` (`const sameSession = contextStrategy === 'same-session'`), has no
   third branch — so `'hybrid'` and `'fresh-child'` are behaviorally identical, exactly as the UI's
   own hint text admits. The hint text is honest, not a lie, but the pattern itself — an
   unimplemented enum value left selectable in a live production dropdown — is exactly the kind of
   thing worth cleaning up rather than permanently disclaiming: either remove the option until
   `hybrid` is implemented, or render it `disabled` with the same explanatory text so it's visibly
   inert rather than a real-looking third choice a user could pick expecting different behavior.
   Small, contained, no backend change required.
2. **13 toggles in one flat, ungrouped list** when "Advanced" is expanded (lines 305-449): managed
   isolation, require-rename, run-verify-twice, compact-context (+ threshold sub-field),
   regenerate-on-stall, semantic-progress, operator-reviewed-completion, pause-on-token-burn,
   fresh-eyes-review, branch-select (+ fanout sub-field), next-objective-planning (+ cadence
   sub-field), cleanliness-scan, and allow-destructive — one `<div class="advanced-section">`, no
   sub-headers, no visual grouping by concern. This is the same "Advanced tab is an undifferentiated
   dump" pattern `fable_todo2.md` S3.2 already diagnosed for the Settings app (and recommended a
   common/advanced tiering + ghost-button pattern for) — but it's a *second, separate* instance of
   that problem in a completely different component that sweep never looked at. The toggles cluster
   naturally into at least three concerns worth actual subheadings: **safety/scope** (managed
   isolation, allow-destructive, require-rename), **stall/cost recovery** (compact-context,
   regenerate-on-stall, pause-on-token-burn, branch-select), and **review/quality** (semantic
   progress, operator-reviewed completion, fresh-eyes review, cleanliness scan, verify-twice,
   next-objective-planning). Grouping under those three labels (no new component needed, just
   `<h4>` separators within the existing `advanced-section` div) would make this panel scannable
   instead of requiring a full read top-to-bottom to find one toggle.

Notably, this panel already leans on **always-visible inline `<span class="hint">` text** rather
than hover tooltips for nearly every control (e.g. line 84, 106, 116, 340, 360, 365...) — a
different, arguably more discoverable pattern than UX1-UX8's hover-tooltip plan, since nothing is
hidden until hover. Worth explicitly deciding whether AIO standardizes on always-visible hints for
dense configuration panels (like this one) and reserves hover tooltips (UX1) for space-constrained
surfaces like status dots/chips/icon buttons (UX3, Part 4's 12-file unlabeled-button list) —
rather than retrofitting hover tooltips onto a panel that already solved discoverability a
different way. Don't convert this panel's hints to tooltips as part of UX1/UX2; treat "which
pattern for which surface" as a deliberate house-style decision, not a uniform mandate.

---

## Suggested delivery order

1. **T2** (gate `goalBlock`/`priorObservationsBlock` the same way `existingSessionContextBlock`
   already is) — smallest, safest, same file, immediate token savings on every same-session loop.
2. **T1** (recycle fallback for `aggregate-only`/`unknown`-occupancy adapters) — the actual
   unbounded-growth bug; needs a short discovery pass first (check for a cheaper per-adapter
   occupancy signal before committing to a wall-clock/iteration-count fallback).
3. **T3** (surface the loop-mode-vs-global-settings disconnect in the UI) and **UX9's item 1**
   (remove or disable the dead-end "Hybrid" context-strategy dropdown option) — both cheap,
   same-panel, prevent user confusion, no dependencies on anything else in this list.
4. **UX1 → UX2 → UX3** (tooltip directive → copy registry → apply to existing unexplained dots,
   starting from the 12-file unlabeled-button list in Part 4) — build the foundation once, then
   it's cheap to apply everywhere; UX3 alone fixes the most user-visible confusion.
5. **UX7** (honest-degradation cost/context badge) — closes `fable_todo2.md` L8 directly and pairs
   naturally with T1/T3's findings about occupancy reporting being `unknown` for several adapters;
   do this once UX1 exists so the hover-content slot is available.
6. **L-A / L-B** (health-model + named non-convergence diagnostics) — worth a dedicated design
   pass given this loop's own stall history; don't bolt on ad hoc.
7. Everything in **Part 3 (E-A…E-G)**, plus **E-H** (cross-provider aux-model fallback) — E-H is
   more contained than the others (one resolver function, no architecture change) and could move
   earlier if aux-model spend is a live pain point; the rest stay deferred until there's appetite
   to revisit loop mode's process-per-iteration design specifically for caching.
8. **UX4–UX6, UX8, UX9's item 2** (subheadings for the 13-toggle Advanced section) and the
   remaining **L-C…L-F** items — incremental, pick up opportunistically once the foundation from
   step 4 exists. UX8 (getting-started checklist) and UX9's item 2 (pure markup grouping, no new
   component) are the cheapest of these and reasonable to pull forward independently of the rest.

Before starting T1/T2/T3: read and reconcile against
`docs/plans/2026-02-22-token-memory-optimization-plan.md` — six months old, not marked
`_completed`, unknown current status. Confirm what (if anything) from it already shipped so this
plan doesn't re-propose already-done work or, worse, conflict with an in-flight one.

---

## Confirmed-empty corners (so a future sweep doesn't re-check these)

- **CodexDesktop-Rebuild**: not a source project — a build/patch harness that downloads and
  repackages the closed-source official Codex Electron binary. No orchestration/token/UX source to
  mine.
- **copilot-sdk**: protocol/RPC library only, confirmed again — no prompt-caching or compaction
  *implementation* (that lives in the CLI it wraps), but its docs describe adoptable *semantics*
  (see L-C, UX-adjacent context-management docs) worth citing even without source to copy.
- **oh-my-opencode-slim**: no frontend at all (CLI/plugin/hook system only) — skip for any future
  tooltip/UX sweep.
- **openclaw**: tooltip hits are all native SwiftUI `.help()` (macOS) — no portable pattern for
  Angular.
- **online-orchestrator**: thin Chrome-extension UI glue; only the dual-signal
  response-finished-detection recipe (content-script polling + hard timeout fallback) was worth
  recording (folded into Part 2 context, not repeated as its own item — narrower than L-C/L-D).
- **claw-code**: no onboarding/tooltip/coachmark code anywhere (terminal TUI, not applicable to
  AIO's Electron UI) — but its Rust runtime crate is otherwise the single richest token-economy
  source in the whole corpus (multi-stage compaction, stall heartbeats, cache-break diagnostics —
  folded into Parts 1-3 context above where directly relevant).
- **tura's GUI** (`apps/gui/app/src`) [addendum pass]: no tooltip component, no coachmark/tour/
  onboarding system — only scattered native `title=` attributes, i.e. the same unaudited pattern
  AIO itself has. Nothing to steal beyond what's already generic; its Rust runtime's token-economy
  content (the `stable_context_cache_id` pattern) is recorded in T4/E-I above, not here.
- **nanoclaw** [addendum pass]: pure backend/CLI (Discord-bot-style host + container agent-runner),
  no UI at all — tooltip/onboarding category correctly has nothing to report. Its cross-session
  context pruning is DB-row TTL hygiene for a delivery backlog, not LLM-context token economy, so
  it wasn't reported as a token-economy finding either; the one narrow thing worth keeping is its
  `PreCompact`-hook instruction-injection trick (preserving structured routing metadata across a
  CLI's own native compaction, `container/agent-runner/src/compact-instructions.ts:1-51`) — low
  priority, only relevant if AIO ever routes structured multi-target dispatch metadata through a
  CLI's native compaction instead of AIO's own compactor, which it currently avoids doing by
  design (`compaction-runtime.ts:415-424`, restart-with-summary sidesteps native compaction).


---

<a id="part-d-fable-todo2"></a>

## Part D · `fable_todo2.md` — Settings overhaul + UX/loop enhancements (round 2 sweep)

> Source: `fable_todo2.md` (2026-07-30). Verbatim; headings demoted one level.

Generated 2026-07-30. Method fixed from round 1: **two ground-truth agents inventoried AIO's actual
source first** (settings system; loop/UX current state), and every "AIO lacks X" below was checked
against those inventories or greps before being written. Claims are tagged:
- **[VERIFIED]** — confirmed against AIO source with paths (or the exact grep stated).
- **[CANDIDATE]** — reference-project idea whose AIO-side gap was *not* individually re-verified; run a discovery gate first.

Scope: settings/defaults (James: "our settings are pretty shit"), plus UX and loop items NOT already
in `fable_todo.md` or `docs/plans/2026-07-30-sibling-audit-round2_plan.md`. Where an item overlaps a
planned workstream it is cross-referenced, not re-proposed.

Raw agent reports: `_scratch/fable-round2/`.

---

### Verified current state of AIO settings (the short version)

From the ground-truth inventory (all paths verified):

- **186 keys** in `AppSettings` (`src/shared/types/settings.types.ts`, exhaustively counted via
  `SETTINGS_TOOL_POLICY` in `src/main/core/config/settings-control-policy.ts` which is
  compiler-enforced over every key). **120 have UI metadata; 66 have none; 22 are reachable from no
  UI at all** (incl. `orchestrationRoutingPolicyJson` — described in its own doc comment as "the
  cheapest lever on orchestration spend" — plus `injectRepoMap`/`repoMapTokenBudget`,
  `toolLoopAutoInterrupt`, `thinClientWs*`).
- **27 tabs** in 5 groups (`settings-navigation.ts`). Advanced renders **55 rows in one scroll**,
  16 of them in an unlabelled "Other advanced controls" dumping ground that includes
  security-critical keys (browser vault, shared-tab credential fill, instruction trust gate) below
  index-tuning knobs.
- **Search matches tab names only** (`settings.component.ts:327-338` filters `NAV_ITEMS`; it never
  touches `SETTINGS_METADATA`). Typing "quiet hours" or "repo map" finds nothing.
- **No per-setting reset** (`SettingsStore.resetOne()` + `SETTINGS_RESET_ONE` IPC exist and work;
  zero UI callers). Only "Reset all" on Advanced.
- **No presets/profiles, no experimental/labs concept** (greps in inventory).
- **Five coexisting interaction models** across tabs (instant-save rows / preview-then-apply /
  draft-then-apply / bespoke instant / non-AppSettings surfaces styled as settings). Dirty-state
  banners exist in only 4 tabs.
- **Validation is mostly invisible**: `setting-row` has no error slot; `SettingsStore._error` is
  written but never rendered; rejected writes silently revert; number inputs accept any parseable
  int (no clamp).
- **Per-key provenance exists as dead code**: `ResolvedConfig.sources` (project|user|default) is
  fully typed and populated by `mergeConfigs()`, but `resolveConfig()` has exactly one caller (the
  `CONFIG_RESOLVE` IPC handler) and no renderer component consumes it. `CONFIG_SOURCE_PRECEDENCE`
  has zero references. Project-scope settings (`.ai-orchestrator.json`) are defined end-to-end and
  wired into nothing.
- **Agent/GUI/CLI parity is three-way inconsistent** (12 keys agent-writable with no GUI control;
  ~25 GUI-writable but agent-blocked by design; 4 keys reachable by nobody).
- Outright bugs: 4 `json`-type settings render an **empty control cell** (`setting-row` has no json
  case: `graphScopesJson`, `graphAgentWritableAccountsJson`, `computerUseAllowedAppsJson`,
  `computerUseDeniedAppsJson`); `sessionFailoverProviders` is a multi-select with **no options** so
  it's unsettable from UI despite being open-tier; the 5 `computerUse*` rows render **twice**
  (Computer Use tab + Advanced) unsynchronised; the Advanced tab ships a hardcoded stale "Planned
  settings" list telling users notification preferences are planned (they shipped).

---
## Part 1 — Settings overhaul

### S1. Fix the broken/dead bits first [VERIFIED — all from the ground-truth inventory]

Cheap, unambiguous, no design debate needed:

1. **`setting-row` json case**: add a JSON editor (or delegate to a picker) for the 4 `type: 'json'` settings currently rendering label+description with an empty control cell.
2. **`sessionFailoverProviders` unsettable**: multi-select metadata has no `options` (`settings-metadata-runtime.ts:108-113`) though a 7-provider Zod enum exists — populate options from the schema.
3. **Wire per-setting reset**: `resetOne()` + IPC already work; `setting-row` needs the button (see S3.3 for the t3code row primitive with a reserved reset slot).
4. **Render `SettingsStore._error`**: rejected writes currently revert silently. Inline error on the row + a toast.
5. **De-duplicate the `computerUse*` rows** (Computer Use tab vs Advanced/MCP safety) — one canonical home, link from the other.
6. **Delete the stale "Planned settings" `<ul>`** (`advanced-settings-tab.component.ts:310-321`) — notification preferences shipped; the list lies to users.
7. **Clamp number inputs** to metadata min/max in `onNumberChange` (currently any parseInt-able value passes; schema bounds only exist where metadata does).
8. **Dead code sweep**: `SettingsStore.featureFlags` (zero consumers), `CONFIG_SOURCE_PRECEDENCE` (zero refs), `ValidationRowComponent`/`DangerZoneComponent` (never imported), `AuxiliaryLlmIpcService.saveSettings()` (only path to write 2 keys, no caller), privileged CLI `--all` flag (accepted, discarded via `void args.all`), duplicate `never-worse.ts` modules (`src/main/context/` + `src/main/util/`). Either wire or delete each.
9. **`customModelOverride` legacy row** still renders first in Advanced → Runtime controls despite an active migration to `customModelsByProvider` — retire it behind the migration.
10. **`residentClaudeSession`** is force-rewritten to `true` every launch (`settings-migrations.ts:170-175`) — it's a constant wearing a setting's costume; remove the key or make the migration one-shot.

### S2. Structural: one registry, complete metadata, provenance

#### S2.1 Complete the metadata, then enforce it [VERIFIED gap]
66 keys have no `SettingMetadata`; that's the structural reason whole tabs (Voice 8, Remote Nodes 15, Mobile 11, Auxiliary ~10) have zero per-setting help text and the reason 22 keys have no UI. `SETTINGS_TOOL_POLICY` proves the enforcement pattern works (`satisfies Record<keyof AppSettings, …>` — a new key won't compile without a policy entry). Apply the same trick: make `SETTINGS_METADATA` (or a successor registry) exhaustive over `keyof AppSettings`, with an explicit `surfacing: 'tab' | 'bespoke' | 'hidden' | 'internal'` field so "no UI" becomes a deliberate declaration instead of an accident.

#### S2.2 Grow metadata into a codex-style FeatureSpec registry [CANDIDATE — reference]
Reference: codex `codex-rs/features/src/lib.rs` (Stage lifecycle: UnderDevelopment | Experimental{name, description} | Stable | Deprecated | Removed; one const table; the /experimental menu is a filter over it; you *can't* add an experimental flag without user-facing copy; promotion to Stable removes it from the menu automatically). Also openclaw `ui/src/pages/labs/labs-registry.ts` (labs entries patch canonical config paths — no separate flag store; graduation = delete the registry row) and `src/config/schema.hints.ts` (one path-keyed hints map feeding forms, search, ordering, advanced-tiering, AND diagnostic redaction).
For AIO: add `stage`, `tab/group`, `order`, `advanced`, `sensitive`, `requiresRestart`, `dependsOn`, `keywords` to the registry; render tabs generically from it (t3code proves the pattern: `packages/contracts/src/settings.ts` schema annotations → `deriveProviderSettingsFields()` renders forms — no hand-written controls). AIO's half-mature subsystems (rlm, learning, debate, local-ai-guard) get a free auto-generated Experimental section, and deprecations get a lifecycle instead of `customModelOverride`-style limbo.

#### S2.3 Wire the provenance that already exists [VERIFIED: types exist, dead]
`ResolvedConfig.sources` is populated and typed; nothing consumes it. Two steps:
(a) Decide whether project-scope settings (`.ai-orchestrator.json` → `resolveConfig()`) should affect runtime at all — today they don't (one IPC caller, no spawn path reads them). Either wire them into instance spawn/loop config or delete the subsystem; a defined-but-inert scope is worse than none.
(b) If wired: show an origin chip (Default / User / Project) per row + a **"Modified from default" filter**. Reference for the full version: codex `config/src/fingerprint.rs` `record_origins` — per-leaf-dotted-path origins shipped alongside the effective config, enabling origin badges with zero extra plumbing; plus `WriteStatus::OkOverridden` (write-then-read-back-effective; if a higher layer still shadows the key, warn inline and snap the toggle back — kills the toggles-that-lie bug class).

#### S2.4 Don't persist values that equal the default [CANDIDATE — reference codex `tui/src/config_update.rs:117-128`]
Returning a setting to default should delete the key so untouched users inherit future default improvements; pair with an explicit "Pin current values" action. Verify first how electron-store + `writeDirtyFields()` handles key deletion vs writing the default value — GT notes the store seeds `DEFAULT_SETTINGS` wholesale, which may mean every user is already pinned to install-time defaults; if so this matters double.

#### S2.5 Migration + deprecation conventions [CANDIDATE — references]
AIO has 12 one-shot marker-key migrations (`settings-migrations.ts`) — working but ad-hoc (see `residentClaudeSession` repeating forever). Adopt: Actual Claude `main.tsx:324` version-counter pattern (run-once gate, per-source reads, don't-notify-users-who-never-saw-the-old-default); codex `config/src/key_aliases.rs` 3-field alias table for renames; codex structured deprecation records rendered as dismissible banners with one-click migrate.

### S3. Navigation & readability

#### S3.1 Real settings search [VERIFIED gap: tab-name search only]
Reference implementations, in order of directness:
- jean `src/components/preferences/preferences-search.ts` — typed entries {pane, section, item} with `keywords` carrying user-language synonyms, anchorId + fallbackAnchorId, item entries *generated from the same definition tables that render them* (anti-drift); Fuse weighted title×3/keywords×2.
- jean `PreferencesDialog.tsx:460-608` — the scroll-to-anchor trio AIO will need: retry across up to 20 RAF frames while the tab mounts, `.settings-search-highlight` pulse, ResizeObserver re-anchor for 1500ms as async rows load, cancel on user wheel/touch/key. AIO's tabs with async status rows (Remote Nodes, CLI Health) hit exactly this.
- Grouped display: jean `PreferencesSearchBar.tsx` (results grouped by pane, Fuse rank preserved within groups).
With S2.1's exhaustive registry, the index derives from metadata (label + description + keywords) for free; the existing tab-level `keywords` in `settings-navigation.ts` become the seed.

#### S3.2 Common/Advanced tiering computed from the registry [CANDIDATE — reference openclaw `src/config/schema.tiers.ts` + `ui/src/components/config-form.tiers.ts`]
Rule worth copying verbatim: **numeric tuning knobs are advanced by default** (exception: ports); booleans/enums the user actually chooses are common. Renderer shows the common group then a ghost button "N more advanced settings — Show advanced" (count visible so the tab doesn't lie); search auto-reveals. This alone fixes the Advanced tab's 55-row scroll and lets the 16-row dumping ground dissolve into real sections.

#### S3.3 One row primitive [VERIFIED gap: five interaction models]
Reference t3code `settingsLayout.tsx`: SettingsRow = title/description/status left, control right, with a **reserved reset-button slot** (no reflow when it appears), `SettingResetButton` with aria-label + tooltip; `useSettingsRestore()` diffs against defaults → "This will reset: {named labels}" confirm. Adopt as the single row component; migrate bespoke tabs onto it incrementally. Decide ONE save model (recommend: instant-save with per-row undo + the S2.3 origin chip; keep draft/apply only where a group is genuinely atomic, e.g. Network).

#### S3.4 Settings health notices [CANDIDATE — reference Actual Claude `utils/statusNoticeDefinitions.tsx`]
A declarative registry of {id, isActive(ctx), render(ctx)} evaluated over effective settings, catching cross-setting conflicts flat lists can't express. AIO has real instances of the class: quiet hours configured while `notificationQuietHoursEnabled` false; `crossModelReviewLocalEnabled` with no `crossModelReviewLocalSelectorId`; `remoteNodesRequireTls` false with `remoteNodesServerHost '0.0.0.0'`; aux endpoints JSON empty while routing mode 'local-first'. Two-branch remedy phrasing ("Trying to do X? … Trying Y? …").

#### S3.5 isRelevant() contextual tips [CANDIDATE — reference Actual Claude `services/tips/tipRegistry.ts`]
Behavior-gated, cooldown-scheduled hints surfacing a setting when usage proves the need (their example: plan-mode used repeatedly but default permission mode unset). AIO analogues: loops hitting provider limits while `instanceProviderLimitResumeEnabled` is false; repeated tool-loop toasts while `toolLoopAutoInterrupt` is false; N instances running with `showCost` off. GT confirms AIO has **no tips/tour system at all** (grep: coachmark/walkthrough/tour → nothing), so this doubles as the discoverability layer.

### S4. Profiles & task-keyed routing (the orchestrator-specific win)

#### S4.1 Named settings profiles as a delta layer [CANDIDATE; verified absent in AIO]
Reference codex `config/src/profile_toml.rs`: a profile bundles ~25 correlated settings and loads as a second user layer holding deltas only. AIO bundles that make sense: **Overnight loop** (auto-interrupt on, provider-limit resume on, aggressive notifications, spend caps), **Interactive dev** (current defaults), **Demo/safe** (yolo off everywhere, quiet notifications), **Remote-heavy** (offload flags on). UI: slim's three-level manager (`oh-my-opencode-slim/src/tui-preset.ts`: list → arrangement → item editor, working-copy staging, Save vs Save&Apply, "(active)" marker) + a starter gallery (slim ships cost-framed preset docs; AIO should ship them as data).

#### S4.2 Surface `orchestrationRoutingPolicyJson` as a task×model matrix [VERIFIED: exists, agent-writable, schema'd, zero UI]
The key already routes loop/workflow/verify/review/debate/debateSynthesis to a policy tier. jean goes further (`src/types/preferences.ts` ~960-1330): five parallel records keyed by TASK (18 tasks × model/effort/mode/provider/backend) with deliberately asymmetric defaults (investigation → opus/plan-mode; commit messages → sonnet/yolo) and `makePreset(model)` mass-set. AIO already has the aux-model 11-slot table (a per-task matrix for auxiliary calls!) — extend the same UI pattern to main-model routing: one grid, rows = task kinds (loop, verify, review, debate, magic-prompt classes), columns = provider/model/effort, with per-row reset and undefined=inherit / null=explicit semantics (jean's resolver rule).

#### S4.3 Per-provider default bundles [CANDIDATE — reference jean backend-conditional presets]
When the user switches default provider, rewrite dependent model defaults from a per-backend bundle instead of leaving stale model ids. AIO already has `defaultModelByProvider`, `loopModelByProvider`, `crossModelReviewModelByProvider` — the bundle concept unifies them.

### S5. Trust & lifecycle

- **Settings doctor / lint** [CANDIDATE — openclaw doctor postures + nanoclaw upgrade tripwire]: a "Check settings" action validating the file (unknown keys, renamed keys, invalid values, orphaned metadata), CI-usable `--json`; plus a schema-version marker written only by sanctioned migration paths, checked at startup, failing closed with a repair action and a dual-audience (human + coding-agent) error message. AIO's settings-manager has an in-memory version counter only — no on-disk schema version [VERIFIED].
- **Hot-reload robustness** [CANDIDATE — Actual Claude `utils/settings/changeDetector.ts`]: AIO's settings.json is agent-editable on disk (and the privileged CLI writes it); verify the watcher path handles self-write echo suppression, delete-then-recreate grace, and debounce. GT didn't cover the watcher — discovery gate first.
- **"Test" buttons for executable settings** [CANDIDATE — Actual Claude HOOK_VERIFICATION_FLOW]: any setting storing a command/path/URL (hooks, vault password file, TLS paths, aux endpoints, reachability probe host) gets a verify action; "a hook that silently does nothing is worse than no hook."
- **Parity clean-up** [VERIFIED list in inventory]: for each of the 12 agent-writable-but-no-GUI keys, either add the control (via S2.1) or downgrade the policy tier; for the 4 nobody-can-write keys decide owner or delete.
- **Export/import**: exists (Advanced tab) [VERIFIED] — after S2, export should skip is-default values (S2.4) so exports become readable deltas.
## Part 2 — Proposed defaults for James's workflow

Grounded in the verified inventory (current defaults are from `settings-defaults.ts` via the GT
agent). James's profile: heavy unattended loop mode + evidence ladder, 4+ providers, remote nodes,
mobile companion, subscription quotas that get hit, never-commit-unless-asked. Proposals marked ⚠
change behaviour of unattended runs — apply deliberately, ideally as the "Overnight loop" profile
(S4.1) rather than blanket defaults.

| Setting | Current | Proposed | Why |
|---|---|---|---|
| `instanceProviderLimitResumeEnabled` | `false` | **`true`** ⚠ | Quota walls are routine on subscription plans; loop runs already park as `provider-limit` and a resume scheduler exists (`provider-limit-resume-scheduler.ts`). Auto-resume is the whole point of unattended mode. |
| `toolLoopAutoInterrupt` | `false` (no UI!) | **`true`** ⚠ | Doom-loop detector is wired (WS-A2 landed) but critical detections only toast. Overnight, an uninterrupted tool loop burns quota for hours. Surface the setting (S2.1) and default it on for loop-heavy work. |
| `detectDegradedAdapterOutput` | `false` (no UI) | **`true`** | Degraded adapter output silently corrupts loop iterations; detection exists, is off, and is invisible. Verify its false-positive rate first, then enable. |
| `sessionHandoffStateEnabled` | `false` | **`true`** (after reading what it gates) | Handoff state service exists but the flag defaults off. For a four-provider user, cross-provider continuation should be on. Discovery gate: confirm what the flag actually enables and its cost. |
| `sessionFailoverProviders` | `[]` (unsettable via UI bug) | e.g. **`['codex','gemini']`** | Session failover can't help while the list is empty. Fix the UI bug (S1.2), then populate with the providers whose quotas are usually free when Claude's is exhausted. |
| `auxiliaryLlmDailySpendCapUsd` | `null` (uncapped) | **set a cap (e.g. 5)** | Unattended background LLM spend should have a ceiling; the setting exists and is surfaced. |
| `localAiGuardDailyFallbackBudgetUsd` | `null` | **set a cap** | Same rationale for guard fallbacks. |
| `autoTerminateIdleMinutes` | `30` | **`120`** ⚠ verify | With loops parked on provider limits or waiting on reviews, 30-min idle termination risks reaping instances that will resume. Verify parked/paused instances are exempt before raising; if they're already exempt, leave at 30. |
| `notificationQuietHoursEnabled` | `false` | leave off, **but** | James runs overnight loops and wants to know about blockers. Instead of quiet hours: add loop terminal-state notifications (Part 3, L1) so the *right* events fire; keep cooldown 30s. |
| `crossModelReviewProviders` | `['cursor','antigravity','codex']` | keep; review order quarterly | Reviewer priority should track which subscriptions currently have headroom — a profile concern (S4.1), not a hardcode. |
| `contextWarningThreshold` | `80` | **`70` for loop profile** | Loop iterations degrade near the window edge; earlier warning gives context-survival more room. Blanket default can stay 80. |
| `cumulativeTokenCompactionTrigger` | `0` (disabled) | evaluate a non-zero value for loops ⚠ | Compaction machinery exists and is UI-wired; the cumulative trigger being disabled means only threshold-based paths fire. Discovery gate: read `compaction-coordinator.ts` to see what this trigger adds before enabling. |
| `quotaPacingWarningEnabled` / thresholds | `true` / 90 / 72 | keep | Already sensible. |
| `injectRepoMap` / `repoMapTokenBudget` | `true` / `2000` (no UI) | keep, surface in UI | 2k tokens/session is fine for the value; the problem is invisibility, not the default. |
| `loopSurfaceCodemem` / `loopSurfaceLessons` | `true` / `true` (no UI) | keep, surface | Same. |
| `orchestrationRoutingPolicyJson` | all-`balanced` | route `verify` + `debateSynthesis` to a cheaper tier ⚠ | "The cheapest lever on orchestration spend" per its own doc comment; needs the S4.2 UI first, then tune per-task like jean (heavy=strong, mechanical=cheap). |
| `defaultYoloMode` | `false` | keep `false` | Safety floor; yolo belongs to per-run/loop config, not a global default. |
| `enableSpawnWorkerOffload` | `false` (no UI) | trial `true` when remote nodes are up ⚠ | Offload exists and is invisible; test on the actual node fleet before defaulting. |
| `notificationCooldownSeconds` | `30` | keep | |
| `mcpCleanupBackupsOnQuit` | `true` | keep | |
| `cliUpdatePolicy` | `'notify'` | keep | Auto-updating CLIs under a running loop is how flag breakage ships mid-run. |
| `codebaseAutoIndexEnabled` | `false` | keep off globally; consider per-project | Indexing cost on big repos; a project-scope setting once S2.3 wires project scope. |
| `maxTotalInstances` / `maxChildrenPerParent` | `20` / `10` | keep | |
| `pingPongMaxRounds` | `15` | keep | |

Also: the **11 aux-model slots** currently all route `provider: 'auto'` with `subQueryExecution`
disabled — once local models on the worker node are reliable, pin `routingClassification`,
`titleGeneration`, `approvalScoring` to local-first explicitly (they're already `quick`-tier) and
leave `compression`/`verifyOutputSummary` on quality. That's the S4.2 matrix in action.

**Delivery suggestion:** don't flip these one by one — implement S4.1 profiles and ship
"Overnight loop" / "Interactive" as the first two profiles, with the ⚠ rows differing between them.
## Part 3 — Loop enhancements (all AIO-side gaps verified by the ground-truth inventory)

### L1. Loop terminal-state notifications [VERIFIED gap]
Only ONE loop-originated desktop notification exists (`loop-failover`, `loop-coordinator.ts:3564`).
`completed / completed-needs-review / cap-reached / no-progress / needs-human-arbitration / provider-limit / cost-exceeded / failed` raise nothing directly — a notification only fires if the underlying instance happens to transition active→idle. For unattended overnight loops this is the single most valuable missing notification set. The notification service already has cooldown/dedupe/quiet-hours/digest machinery — this is just new `notify()` call sites keyed per terminal status, plus mobile push via the existing APNs sender.

### L2. Surface the doom-loop detector beyond a toast [VERIFIED: toast-only]
`instance:doom-loop` events reach the renderer but render as a transient toast (`app.component.ts:272-279`). Add: a per-instance badge on the row (the `needsAttention` dot machinery exists), a persistent entry in the notification center, and — for `critical` with `toolLoopAutoInterrupt` off — an actionable "Interrupt now / Enable auto-interrupt" prompt. Pairs with the Part 2 default change.

### L3. Branch-select (best-of-N) has zero UI [VERIFIED]
`loop-branch-select.ts` fans out candidates in worktrees, verifies, adopts a winner — and reports only via a `loop:branch-select` activity-feed event. Add to the loop inspector: a branch-select episode card (candidates, per-candidate verify result, winner, cost), and expose `exploration.enabled`/fanout/cost-cap in loop config UI (currently config-only). Reference for presentation: hermes spawn-history diff (round-1 fable_todo, hermes B2).

### L4. Findings panel for anchored review evidence [VERIFIED: feed-text only]
WS-A3 landed (anchors, evidence classes, demotion), but anchors/demotions surface only as `[verified]`/`[re-anchored]` text + an "N demoted" suffix in the activity feed (`loop.store.ts:282-300`). A structured findings panel (file/range/quote per blocking finding, demoted list with `demotedReason`, jump-to-diff) closes the loop-review UX. Reference: codex review findings as selectable code-located items (round-1 fable_todo, codex B6); jean's ReviewResultsPanel checkbox→dispatch pattern for "fix selected".

### L5. Epoch-stamp the loop-control channel [CANDIDATE — hermes `gateway/drain_control.py`]
Hermes stamps its drain marker with the instantiation epoch after an orphaned marker parked a fresh instance for ~52 minutes; markers from a previous boot are ignored, malformed markers fail toward quiescing. AIO's `.aio-loop-control/control.json` channel (secret-authenticated, 16KB cap) should verify: does a stale control file from a previous run/process get ignored? If not, add a run-epoch field. One-line class-of-bug fix.

### L6. Code-skew guard for long-lived loops [CANDIDATE — hermes `gateway/code_skew.py`]
AIO's Electron main runs for days while `git pull`/rebuilds change `dist/`. Hermes snapshots the boot revision and refuses risky lazy-load paths with "restart the gateway" instead of a cryptic import error. AIO analogue: stamp `dist/main` build id at boot; when the on-disk build id diverges (LT-012 was literally three days of stale dist), surface a "restart to pick up new build" banner instead of undefined behaviour.

### L7. Shutdown forensics [CANDIDATE — hermes `gateway/shutdown_forensics.py`]
"Who killed my instance / why did the loop die overnight" — a sub-10ms synchronous signal/ppid probe in the shutdown path plus a detached async `ps` walk that can't block teardown. Feeds the run ledger so a crashed loop's last entry says *what* killed it.

### L8. Loop cost/context on the instance row + workboard card [VERIFIED gap]
Loop control panel shows tokens/cost/iteration; the instance row and workboard card show none of it (grep: contextUsage/costEstimate/cumulativeTokens only in spec fixtures). Minimal: cost + context-% chips on rows for loop-running instances; the loop store already has the numbers. (Full attention-scale work is WS-C2 — this is the cheap subset.)

### L9. Aggregate CLI approvals across instances [VERIFIED: browser approvals aggregate, CLI approvals don't]
`browser-approvals-banner.component.ts` proves the pattern (root-level banner for the oldest pending approval across any instance — its header documents that requests used to expire unseen). CLI/tool permission approvals have no equivalent: `pendingApprovalCount` is a per-row chip only. Extend the banner (or the notification center) to cover `user-action-request` pendings from all instances, with jump-to-instance. The durable-approval-store (SQLite `pending_approvals`) already exists as the backing query. (Overlaps WS-C2's act-from-the-card; this is the narrower alerting slice.)

### L10. Notification sounds [VERIFIED absent: hard-coded `silent: false`, no sound config]
Per-event-class sounds with independent enable+choice (opencode `packages/app/src/utils/sound.ts`: 46 lazily-loaded sounds, promise-cached, separate agent-idle vs error routing; round-1 also noted focus-aware `when: always|focused|blurred` gating). For James: distinct sounds for "loop needs arbitration" vs "loop completed" are glanceable-from-another-room UX. Small, contained, high daily value.

### L11. OS-level progress for running loops [CANDIDATE — openclaw `packages/terminal-core/src/osc-progress.ts` + Electron equivalents]
Electron has native `setProgressBar` (Dock/taskbar). Map loop iteration progress (or indeterminate-while-running, error state on needs-arbitration) onto it; the tray/menubar rollup below (U-row) extends this. Honest-orphan lesson from t3code `agentActivityPayloads.ts`: phase-dependent TTLs (2h running / 24h waiting) keep "3 loops running" truthful when something died mid-run.

### L12. Loop-aware "while you were away" [round-1 deferred item, now sharpened]
The round-2 plan deferred the recap contract; GT confirms nothing like it exists. Narrow v1: on window focus after >N minutes with loop activity, one card per loop run summarizing status transitions + iterations advanced + blockers, built from the existing event store (`orchestration-event-store.ts`) with zero LLM calls (hermes session-recap discipline: recaps must be instant and free).
## Part 4 — New UX ideas (second-pass sweep; none previously captured)

All are [CANDIDATE] unless a ground-truth check is noted. Sources per item.

### Window / lifecycle / tray

#### U1. Multi-window with per-window ID registry
opencode `packages/desktop/src/main/window-registry.ts`, `windows.ts:54-251` — persisted window-UUID array; restore-on-launch recreates one window per id, each owning its own bounds file and renderer store; deliberate close removes the id + cleans files, quit keeps ids for session restore; a `setQuitting` flag distinguishes the two (also fired on Windows `session-end`, which never emits `before-quit`). **GT note:** AIO's `window-manager.ts` manages a single mainWindow — "second window with a different project/instance set" needs exactly this contract first.

#### U2. Menubar/tray residence with close-to-hide
CodePilot `electron/main.ts` (~285-330, 930-941): dedicated monochrome `trayTemplate.png` with `setTemplateImage(true)` (resized .icns renders blurry and ignores menubar tinting), window close intercepted to hide unless quitting-via-tray, single-instance lock, tray labels from `app.getLocale()`. **[VERIFIED gap: no `new Tray` in AIO src/main.]** AIO's loops keep working after window close — a tray with a live loop rollup (running/needs-you counts) is the natural home. Pair with t3code `agentActivityPayloads.ts` phase-dependent TTLs so the rollup stays honest, and with CodePilot's source-grep invariant tests (`src/__tests__/unit/menubar-resident-invariants.test.ts`) for the untestable-under-node parts.

#### U3. Unresponsive-renderer sampler + recovery dialog
opencode `main/unresponsive.ts` + `wireWindowRecovery()`: on `unresponsive`, sample `collectJavaScriptCallStack()` every 1s up to 15s, aggregate identical stacks by count, flush sorted; simultaneously a modal offers Relaunch / Export Logs / Keep Waiting (Export doesn't dismiss). GT notes AIO's `captureWindowSample` is darwin-only single-shot `sample(1)`. Also U3b: serve the renderer from a privileged `app://` scheme with traversal guard + `Document-Policy: include-js-call-stacks-in-crash-reports` (opencode `windows.ts:33-43, 416-458`) so those stacks are collectable at all.

### Composer / editor

#### U4. Composer internals bundle (opencode `packages/app/src/components/prompt-input/`)
Four self-contained pieces AIO's composer will want as it grows pills/attachments:
- `editor-dom.ts` — pill-aware cursor arithmetic (pills count as length-1 atoms; zero-width-space normalization; caret placement before/after pills).
- `paste.ts` — paste-mode switch: native only for single-line <8000 chars; manual path past 120 newlines; >200 breaks degrade to one text node instead of thousands of `<br>`s. Pasting a 5k-line log is a routine AIO action and a classic freeze.
- `history.ts` — caret-gated prompt history (Up enters history only at position 0), saved-draft slot restored on the way back down, structural dedupe, entries carry attachments.
- `handoff.ts` + composer controller — 40-entry LRU of unsent drafts keyed by session, serialized on every change; switching instance tabs mid-typing (AIO's most common navigation) restores the draft.

#### U5. External-editor round-trip for prompts
codex `tui/src/external_editor.rs` — $VISUAL/$EDITOR resolution (shlex/winsplit split, `which` on Windows so `code`→`code.cmd` works), seed a .md temp file, read back as the prompt. "Edit this long orchestration prompt in my real editor" is cheap and high-leverage in Electron too.

### Attachments / clipboard / drag-drop

#### U6. Capability-token file picker
opencode `main/attachment-picker.ts` — native picker returns a UUID token bound to {webContentsId, path set, 20MB byte budget}; each path readable exactly once; token self-deletes. Sandboxed renderer attaches files with no general fs IPC.

#### U7. Drop-navigation catch-all
jean `src/hooks/usePreventFileDropNavigation.ts` — window-level dragover/drop preventDefault when files present, never stopPropagation so per-view handlers still fire. One-file safety net for the "stray drop opens the file fullscreen and locks the window" failure.

#### U8. Clipboard + image correctness pair
codex `tui/src/clipboard_copy.rs` — env-aware copy ladder; `ClipboardLease` keeps the clipboard handle alive because X11/Wayland serve contents from the owning process; `clipboard_paste.rs` prefers clipboard FILE LISTS over bitmap (Finder copies files, Chrome copies pixels). opencode `packages/core/src/image/photon.ts` — deterministic downscale×quality ladder to hit a base64 byte budget (size ladder ×0.75, PNG then JPEG at [80,85,70,55,40], first-under-budget wins, structured SizeError). Both are non-obvious correctness bugs AIO's image paste path will hit.

### Performance

#### U9. Off-main-thread rendering bundle
- opencode `session-ui/src/components/markdown-worker.ts` — streaming syntax-highlight worker with SUPERSEDE semantics (new keystroke rejects the in-flight request for that block, never queues), 200-key LRU, terminate+permanently-disable on worker error instead of thrashing respawns.
- t3code `DiffWorkerPoolProvider.tsx` — diff worker pool sized `clamp(cores/2, 2, 6)`, AST LRU 240, `tokenizeMaxLineLength: 1000` so a minified line can't stall a worker, theme-sync pushed only on actual change.
AIO renders four CLIs' streaming output + diffs concurrently; these are the two main-thread freeze sources.

#### U10. Offscreen render freeze via stable element reference
Actual Claude `components/OffscreenFreeze.tsx` — return the identical cached element reference while offscreen so the reconciler bails with a zero diff. Angular analogue: detach change detection / reuse the rendered subtree for off-screen instance panes and inactive tabs.

### Panes / layout

#### U11. Thread-scoped right-panel "surface" workspace model
t3code `apps/web/src/rightPanelStore.ts` — per-thread ordered list of tagged surface descriptors (preview / terminal with splits / file with revealLine / singleton diff/files/plan), browser-tab-strip actions (close-others, close-to-right), versioned persistence. A principled replacement for boolean showDiff/showTerminal flags, per-instance persistent.

#### U12. Resize handle with collapse preview
opencode `packages/ui/src/components/resize-handle.tsx` — direction+edge determine delta sign (one component for all sidebars/docks), body userSelect lock during drag, `onCollapseChange(true)` fires the instant size crosses the threshold (live preview of the collapsed state mid-drag), commit only on mouseup.

### Misc high-value

#### U13. Release-notes dialog as paged highlights
opencode `dialog-release-notes.tsx` — media-carrying highlight pages, arrow-key paging, "don't show again". AIO ships updates constantly (auto-update settings exist); a what's-new surface is missing.

#### U14. i18n scaffolding done cheap
opencode `packages/ui/src/context/i18n.tsx` (key-type-from-English-dict, `{{param}}` templating, non-throwing fallback) + tura `assertDictionaryParity()` (throws if locales' key sets diverge). GT: zero i18n in AIO. Even if AIO stays English-only, the key-typed dictionary centralizes UI copy — which S3/S2 registries want anyway.

#### U15. Deep-link contract with provenance interstitial
Actual Claude `utils/deepLink/` — values Unicode-sanitized and REJECTED (not truncated) on control chars / >5000 chars / slug-regex failure; a banner shows which cwd (and which CLAUDE.md) loaded and repo staleness before anything runs. If AIO ever registers `aio://` handlers (mobile pairing, "open this instance"), copy this contract wholesale.

#### U16. Cassette-based HTTP/WS recording for tests + fixture cost report
opencode `packages/http-recorder/src/recorder.ts` — CI replays, local records-if-missing, scope finalizer FAILS if recorded interactions went unused ("used N of M"); `recording-cost-report.ts` prices what the fixture suite costs against live model pricing. Directly applicable to AIO's adapter tests (the round-1 parity-matrix/fixture-replay backlog item).

#### U17. Redacted-by-default, fail-closed LLM trace
CodePilot `src/lib/aisdk-trace.ts` — off unless env-flagged; allowlisted metadata keys survive, everything else (including future SDK fields) becomes `[redacted sha256:… len:…]` so devs correlate same-content without seeing it; content subtrees collapse to digests BEFORE recursion; no raw mode, deliberately. The right shape for any AIO prompt/telemetry debugging surface, given James's creds-hygiene rules.

### Confirmed-empty corners (so nobody re-sweeps them)
The second-pass agent found nothing new in: undo systems outside checkpoints (none exist anywhere in the corpus), printing/PDF reports, accessibility beyond ordinary ARIA labels, copilot-sdk UX (protocol-only). Round-1 exclusion list held: no double-reported items.
## Appendix — Reference default values shipped by comparable orchestrators

Collected verbatim from source (hermes-agent [HE], openclaw [OC], nanoclaw [NC], tura [TU],
oh-my-opencode-slim [omos], t3code [t3], jean). Use as calibration when tuning AIO's numeric
settings — not as gospel. Full table + paths in `_scratch/fable-round2/` raw reports.

| Concern | Value | Src |
|---|---|---|
| Agent idle timeout / still-running warn / notify interval | 1800s / 900s / 180s | HE |
| Waiting-on-user clarification timeout | 3600s (600s evicted mid-think — real bug) | HE |
| App-level API retries / aux retries | 3 / 2 | HE |
| Max turns: main / delegate / goal loop | 90 / 50 / 20 | HE |
| Tool output truncation | 50,000 bytes · 2,000 lines · 2,000 chars/line | HE |
| Compression trigger/target/protect | 0.5 of window → 0.2; keep last 20 + first 3 msgs; 3 attempts | HE |
| Tool-loop guardrails | warn 2/3/2 → hard-stop 5/8/5 | HE |
| Concurrency | 3 children depth 1 [HE]; 4 agents / 8 subagents / 5 children [OC] |  |
| Subagent archive-after | 60 min | OC |
| Heartbeat cadence | 30m | OC |
| Failover | 15s timeout, 500ms retry delay, 3 consecutive 429s before model swap, 0-token response counts as failure | omos |
| Poll intervals | 500ms foreground / 2000ms background, stable-polls 3, 250ms stagger for parallel launches | omos |
| Host sweep / stuck ceiling | 60s tick; kill tolerance = max(60s, the tool's own declared timeout); 30min absolute | NC |
| Startup crash backoff | [0,0,10,30,120,300,900]s within a 1h window | NC |
| Curation | stale 30d / archive 90d / cadence 7d / idle-gate 2h / keep 5 backups / first pass deferred one full interval | HE |
| Sessions | retention 90d, auto-archive 3d, rescan gate 24h | HE |
| Checkpoints | 20 snapshots, 500MB total, 10MB/file, 7d retention | HE |
| Config watch debounce / write rate limit | 300ms / 30 req per 60s per method | OC |
| Restart-loop guard | 3 restarts per 60s; respawn storm 5 per 120s | HE |
| Git/remote poll | 10–600s (def 30) / 30–600s | jean |
| Approval prompt timeout | 300s | HE |
| Log rotation | 5MB × 3 | HE |
| Destructive vs reversible confirms | delete gated, archive not | t3 |
| Supply-chain: min package release age | 3 days | NC |

Also worth stealing as *practice*, from hermes `config.py`: **every numeric default carries an
inline "why this number / lower it when / raise it when" comment** (e.g. `clarify_timeout: 3600 —
"the old 600s default evicted the entry mid-think, so a later button tap landed on a dead entry"`).
Adopt as the help-text standard for AIO's numeric settings (S3.2's advanced tier is only usable if
each knob explains itself).

---

### Raw reports (in `_scratch/fable-round2/`)
- `settings-claude-codex.md` — Actual Claude + codex settings/config patterns (27 findings)
- `settings-opencode-t3-jean.md` — opencode/slim/t3code/jean settings patterns (21 findings)
- Ground-truth inventories and the claw/hermes/tura + second-pass reports are preserved in the
  conversation transcript; their load-bearing facts are inlined above with paths.

### Relationship to the round-2 plan
This file deliberately does NOT re-propose plan workstreams. Touching points: L8/L9 are the cheap
subset of WS-C2 (attention scale); L4 builds on landed WS-A3; the Part-2 defaults assume WS-B4's
cache contract stays intact (date-only ages etc.); S2.2's stage registry is where the plan's
"Labs" deferred item should land. When any of this graduates to implementation, follow the plan
convention: dated plan doc, discovery gate, one workstream per run, fresh-eyes gate.
