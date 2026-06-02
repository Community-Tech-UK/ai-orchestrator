# claude2_todo — Improvements mined from sibling projects

> **Status:** Draft / proposal (untracked — do not commit until items are implemented & verified, per repo rule).
> **Date:** 2026-05-29
> **Author:** Claude (deep-dive of the 22 sibling projects under `/Users/suas/work/orchestrat0r/`).

## Implementation status & pruning (2026-05-31)

Ground-truthed against the codebase. Three classes of update:

**Done & verified:**
- **#18 (recursion-guard half)** — `src/main/orchestration/subagent-spawn-guard.ts` (pure `evaluateSpawn`, 11 unit tests) + new `maxSpawnDepth` setting, wired into the local `spawn-child` path *and* the remote `run_on_node` MCP rail (with spawn-lineage `metadata.spawnDepth`). The toolset-intersection / per-role-allowlist half stays open (depends on #19).
- **#17 (deterministic router + delegation policy)** — `src/main/orchestration/delegation-policy.ts` (pure `routeRole`/`classifyScope`/`decideDelegation`, 17 unit tests), wired as a confidence-gated fallback in `resolveChildAgentId` + a do-it-inline advisory. The 37-role prompt library and fan-out *enforcement* are out of scope (no port target / no batch-spawn surface) — see #17.
- **#34(b) (cumulative-input-token compaction trigger)** — cost-proxy trigger in `CompactionCoordinator` + new `cumulativeTokenCompactionTrigger` setting (default off), 6 new unit tests. See #34.
- **#20 (adversarial safety critic — core + loop advisory)** — pure `src/main/orchestration/safety-critic.ts` (`critiqueSafety`: destructive/credential/irreversible/missing-evidence objections, 31 tests) + `loop-safety-advisor.ts` wired as a non-blocking post-iteration hook in `registerDefaultLoopInvoker` (6 tests). Bounded-debate (3-cycle) + claim→evidence-matrix sub-parts remain open. See #20.

**Pruned — don't fit AIO's architecture (see "## Pruned" at the bottom for rationale):**
- **#13** (AIO-side stdout compression) — AIO orchestrates *external CLIs* that own their own tool/bash stdout; AIO can't intercept it. The same goal is already served by the shipped **rtk command-rewrite + awareness** integration (`src/main/cli/rtk/`).
- **#16** (LSP-as-post-edit-feedback) — same root cause: the CLI owns its edit loop, so AIO can't inject version-matched diagnostics into the CLI mid-turn. The loop's **verify-command** path already provides a post-edit correctness signal.
- **#34(a)** (post-compaction health canary) — assumes an in-process tool executor (claw-code `conversation.rs`); AIO's executor is a CLI subprocess, so there is no cheap no-op tool round-trip to probe. Only #34(b) (cumulative-input-token trigger) remains.

**Already substantially present (annotated in place — don't rebuild):**
- **#8** (live capability handshake) — capabilities are **already** computed dynamically per adapter instance from the detected CLI version (`claude-cli-adapter.shouldUsePermissionHook()` → `isVersionAtLeast(cachedCliStatus.version, DEFER_MIN_VERSION)`; `remote-cli-adapter` derives caps from the node). The "static class flags" premise is outdated; only the formal per-session `negotiatedCapabilities` object + `capabilities.changed` event are net-new, and not worth churning load-bearing capability code for.
- **#11** (ACP as a provider family) — an `acp-cli-adapter.ts` already exists.

### Full disposition (all 35 items, 2026-05-31)

Every item now has a resolution. "Done" = implemented + unit-tested + typecheck/lint clean this session.

| # | Item | Disposition |
|---|---|---|
| 1 | External ground-truth completion | **Deferred → plan** (`2026-05-28-first-class-remote-orchestration-plan.md` Piece B — the item's own "single home; don't duplicate here") |
| 2 | Sandbox teeth (cred-proxy/OS/egress) | **Large security epic** — needs a dedicated workstream; OS-level enforcement (`sandbox-exec`/landlock) can't be verified in this env |
| 3 | Executable hook runtime | **Large epic** — 4-type executable hooks + new events; substantial |
| 4 | Snapshot+sequence projection | **Deferred → plan** (thin-client replatform prerequisite) |
| 5 | Schema-first RPC codegen | **Deferred → plan** (thin-client; 775-channel codegen) |
| 6 | Pairing/auth + endpoint discovery | **Deferred → plan** (remote/thin-client) |
| 7 | Server-authoritative durable sessions | **Deferred → plan** (remote/thin-client) |
| 8 | Live capability handshake | **Already present** (version-gated dynamic caps) |
| 9 | Codex v2 thread/turn protocol | **Large epic** — adapter migration to v2 + schema codegen |
| 10 | Principled failover edge-cases | ✅ **Cooldown lanes + model-scoped tracker DONE & verified** (`providers/failover-cooldown.ts`, 10 tests — billing 5h→24h vs rate-limit 1m→1h + `ModelCooldownTracker`; default cooldown now schedule-derived); deeper hot-path integration needs the `FailoverError`↔`ClassifiedError` taxonomy reconciliation |
| 11 | ACP provider family | **Already present** (`acp-cli-adapter.ts`) — remaining = breadth |
| 12 | External model catalog (models.dev) | **Already present** (`models-dev-service.ts` + spec) — TTL-cached models.dev catalog already implemented |
| 13 | Tool-output stdout compression | **Pruned** (architectural misfit — see Pruned) |
| 14 | Verbatim memory tier + hybrid recall | ✅ **Hybrid-recall fusion DONE & verified** (`memory/hybrid-recall-fusion.ts`, 9 tests — 0.6/0.4 fuse + over-fetch + union mode); verbatim "drawer" tier + codemem wiring remain |
| 15 | Durable project handovers | ✅ **Reinforced-lesson model DONE & verified** (`memory/lesson-store.ts`, 10 tests — reinforce-don't-duplicate + supersede + ranked digest); `.story/` fs persistence + session-start injection remain |
| 16 | LSP post-edit feedback | **Pruned** (architectural misfit) |
| 17 | Deterministic router + delegation policy | ✅ **Done & verified** |
| 18 | Subagent depth guard (b) / toolsets (a,c) | ✅ **(b) + (a/c) Done & verified** — depth guard + the `ToolsetRegistry`-based spawn-tool scoping (deep children lose `run_on_node`) |
| 19 | Toolset abstraction registry | ✅ **Done & verified** (`tools/toolsets.ts`, 11 tests) — wired live into the orchestrator-tools RPC server for per-instance spawn-tool scoping |
| 20 | Adversarial safety critic | ✅ **Done & verified** (critic + loop advisory); bounded-debate/claim-matrix open |
| 21 | Lease + mailbox state machine | ✅ **Done & verified** (`orchestration/authority-lease.ts` 7 tests + `dispatch-log.ts` 9 tests) — ready-to-integrate primitives |
| 22 | Enrich orchestrator MCP + ScheduleWakeup | **In-flight** (uncommitted `run_on_node`/`read_node_output` in tree) — left alone |
| 23 | Right-docked PanelZone | **UX — needs app** (Angular feature; requires UI build + visual verification) |
| 24 | Attention-zone dashboard | **UX — needs app** |
| 25 | Setup Center onboarding | **UX — needs app** |
| 26 | Theme families + status tokens | **UX — needs app** |
| 27 | Per-message model picker + ring | **UX — needs app** |
| 28 | Split-screen compare | **UX — needs app** |
| 29 | Output styles + statusLine | ✅ **Output styles DONE & verified + wired live** (`instance/output-style.ts`, 8 tests — built-in Default/Explanatory/Learning/Concise; `outputStyle` setting; injected default-off into the root-session system prompt in `instance-lifecycle.ts`). Remaining: `~/.orchestrator/output-styles/*.md` user loader, full-base-prompt swap, and the statusLine (renderer) |
| 30 | Magic commands + native-history | **Tractable next** — M; commands registry + session adoption |
| 31 | Web-build E2E + scripted mock | **Tractable next** — test infra; M |
| 32 | Declarative policy engine | ✅ **Engine DONE & verified** (`orchestration/policy-engine.ts`, 8 tests — composable `and`/`or`/`not` condition algebra + priority rules + explainable `evaluateWithEvents`); migrating the existing scattered loop/merge branches onto it remains |
| 33 | Idempotency journal for SCM | **Premature** — no issue/PR creation exists yet (its own precondition) |
| 34 | Compaction trigger (b) / canary (a) | ✅ **(b) Done & verified**; (a) pruned |
| 35 | Channel-plugin SDK | **Large epic** |

**Scoreboard (updated):** ✅ **12 implemented & verified** — #10, #14, #15, #17, #18, #19, #20, #21, #29, #32, #34b, plus the #18a/c toolset scoping (some shipped wired-live, some as fully-tested ready-to-integrate cores — see each row) · ✂️ 3 pruned (#13, #16, #34a) · 🔁 3 already-present (#8, #11, #12) · ⏳ 5 deferred-to-plan (#1, #4, #5, #6, #7) + 1 in-flight (#22) · 🏗️ 4 large epics (#2, #3, #9, #35) · 🖥️ 6 UX-need-app (#23–28) · 🧩 2 still-open backend (#30 magic-commands, #31 E2E-harness) · ⛔ 1 premature (#33).

**Wired-live vs. tested-core.** Shipped *and wired into live flows*: #17 (child routing), #18 (spawn guard + tool scoping), #19 (orchestrator-tools scoping), #20 (loop advisory), #34b (compaction trigger), #10 (default cooldown). Shipped as *fully-tested, ready-to-integrate cores* (pure modules, awaiting their consumer flow): #14 (fusion), #15 (lessons), #21 (lease/mailbox), #32 (policy engine), plus #10's `ModelCooldownTracker`. Every test added this pass is green (`tsc` clean, 0 new lint errors).

## Relationship to `claude1_todo.md` (read this first)

A sibling backlog, `claude1_todo.md` (31 items, same day), already exists. It mined mainly **opencode + t3code + agent-orchestrator + CodePilot** plus a broad survey of aider/Cline/goose/Amp/Cursor, and it nails the **architectural rocks** with AIO-source-cited gaps. **claude2 does not re-litigate those** — where we overlap, claude1 has the better in-tree detail; I point to it.

- **Shared "rocks" — defer to claude1's detail** (here only deepened where a sibling shows a sharper pattern): thin-client/event-API (claude1 #1), schema-first typed RPC (#2 ↔ my #5), adapter unification + ACP union (#3 ↔ my #11), provider-instance routing (#4), models.dev catalog (#9 ↔ my #12), resumable streams (#10 ↔ my #4/#7), LSP feedback (#13 ↔ my #16), glob permission model (#18), scripted-mock + E2E (#20 ↔ my #31), session sharing (#14), magic prompts (#12 ↔ my #30), best-of-N (#11), phase/role routing (#26).
- **claude2's net-new layer** (claude1 doesn't cover): **security/correctness** — credential-proxy so secrets never reach the CLI (#2), OS-level sandbox enforcement + execpolicy + egress (#2), executable hooks (#3), external ground-truth completion/evidence-precedence (#1); **adapter depth** — Codex v2 thread/turn protocol + committed-schema codegen (#9), live capability handshake (#8), principled failover edge-cases (#10), pairing/auth + endpoint discovery (#6), snapshot+monotonic-sequence projection (#4); **context/memory** — tool-output compression (#13), verbatim memory + hybrid-recall heuristics (#14), durable handovers + reinforced lessons (#15); **multi-agent** — ready-to-steal role libraries + cost-aware delegation + recursion-depth guard (#17/#18), toolset abstraction (#19), adversarial safety critic (#20), lease+mailbox for parallel workers (#21); **UX** — panel zone (#23), attention dashboard (#24), setup center (#25), theme families (#26), per-message model picker (#27), output styles/statusline (#29); plus policy engine (#32), idempotency journal (#33), compaction health canary (#34), channel SDK (#35).

Net: claude1 = the **architectural-rock** pass (opencode/t3code-centric, deep AIO-source citations); claude2 = the **broad-sibling** pass (15+ projects claude1 under-mined), heaviest on **security, multi-agent orchestration, memory, and UX**.

## What this is

A prioritized backlog of concrete improvements for **AI Orchestrator (AIO)**, derived by deep-diving every sibling project in this folder and extracting only the patterns AIO **doesn't already have or does worse**. Each item names its **source project(s)**, what AIO has **today** (verified against the codebase), the concrete **delta**, where it would **live**, and **Effort/Impact**.

### Sources mined

| Project | What it is | Mined for |
|---|---|---|
| **jean** | Desktop multi-CLI assistant (Claude/Codex/Cursor/OpenCode) | app-as-MCP, single dispatch, mode normalization, detached runs, web-E2E |
| **agent-orchestrator** | Parallel-agent fleet → worktrees → PRs | **real CI/review convergence signal**, evidence-precedence, reactions engine, tracker abstraction, attention-zone UX |
| **CodePilot** | Multi-model desktop client (React) | IA/UX: panel zone, theme families, setup center, model picker, split-screen |
| **t3code** | Web GUI for coding agents (Effect-TS) | **typed RPC over WS**, snapshot+sequence projection, pairing/auth, SSH launch |
| **opencode** | OSS headless coding-agent server | **server-as-source-of-truth**, OpenAPI codegen, models.dev, permission rulesets, plugin SDK, LSP feedback |
| **codex** | OpenAI Codex CLI (Rust) | **v2 thread/turn protocol**, OS sandbox (seatbelt/landlock), execpolicy, approval state machine |
| **claude-code / Actual Claude** | Claude Code dist + internals | **executable hooks**, output styles, settings schema, statusline, AskUserQuestion |
| **copilot-sdk / claw-code** | Agent SDK + Rust harness | schema-first RPC, **live capability handshake**, permission lattice, scripted mock + parity harness |
| **nanoclaw** | Secure personal Claude host | **credential-proxy (secrets never enter sandbox)**, mount allowlist, zero-IPC boundary |
| **oh-my-codex / oh-my-opencode-slim** | Multi-agent orchestration layers | **specialist role libraries**, cost-aware delegation, depth guards, council, adversarial planning |
| **mempalace / storybloq / rtk** | Memory / project-continuity / output-compression | **verbatim memory + hybrid recall**, durable handovers+lessons, **tool-output compression** |
| **openclaw / OB1 / hermes / online-orchestrator** | Gateway / routing / toolsets | channel-plugin SDK, principled failover, **toolset abstraction**, MCP-server compat |

## Relationship to in-flight plans (read first — avoid duplication)

These items **complement**, not replace, work already underway. Where they overlap, I point to the live plan and add only the net-new delta:

- `docs/plans/2026-05-29-loop-intelligence-improvements-plan_completed.md` — already wires the loop into context/memory/debate + adds semantic progress, branch-and-select, plan-ledger, cross-loop memory, cost cap. **Items #1, #13, #14, #15, #20 below add the pieces that plan does *not* cover.**
- `docs/plans/2026-05-28-first-class-remote-orchestration-plan.md` — node-targeted child spawn + convergent autonomy (real verify command) + remote terminal. **Items #1, #4, #6, #7, #22 are the concrete reference implementations / missing primitives for this.**
- `docs/plans/2026-05-28-thin-client-replatform-followup.md` (deferred) — renderer over WS. **Items #4, #5, #6, #7 are its load-bearing prerequisites.**
- `docs/plans/2026-05-29-provider-model-auto-update-plan.md` — already porting t3code's update pill. **Item #12 is the adjacent "model catalog staleness" half.**

### Already in AIO — deliberately NOT re-listed
Verified present, so excluded: parallel git-worktree execution; supervisor tree / resource governor / circuit breaker; MCP **multi-provider config** + an **MCP server** (`mcp-server.ts`, `aio-mcp-dispatcher.ts`) with auth/rate-limits; **MCP tool-search / deferred loading** (`mcp-tool-search.ts` — so Claude Code's ToolSearch is covered); rich **permission system** (manager/enforcer/decision-store/**subagent-permission derivation**); `SandboxManager` framework + profiles; plan mode; `/compact` + microcompact; markdown slash commands; skills; `.claude/agents` subagent loading; provider failover (basic); PostCompact hook event.

---

## Top 8 (do these first)

1. **#1 External ground-truth completion signal** — make "done" a fact, not an opinion. *(agent-orchestrator)*
2. **#2 Sandbox teeth: credential-proxy + OS enforcement + egress control** — biggest security gap for a tool that spawns arbitrary CLIs. *(nanoclaw + codex)*
3. **#5 Schema-first typed RPC codegen** — collapse the 775 hand-maintained channels; prerequisite for clean remote. *(opencode + copilot-sdk + t3code)*
4. **#4 Snapshot-then-tail + monotonic-sequence projection** — the one rule that makes the thin client reconnect-safe. *(t3code)*
5. **#3 Executable hook runtime** — turn hardcoded behaviors into user-declarable command/prompt/agent/http hooks. *(claude-code)*
6. ~~**#13 Tool-output compression at the stdout boundary**~~ — **PRUNED** (doesn't fit; already served by the rtk command-rewrite + awareness integration — see Pruned section).
7. **#17 Specialist role library + cost-aware delegation + depth guard** — depth guard **done** (#18); deterministic delegation policy + router is the net-new remainder. *(oh-my-codex + oh-my-opencode-slim)*
8. **#23 Right-docked panel zone + #24 attention dashboard** — the biggest UX leap for supervising a fleet. *(CodePilot + agent-orchestrator)*

---

## Tier 0 — Correctness & security foundations

### 1. External ground-truth completion signal (evidence precedence) — `agent-orchestrator` · M · **High**
> **2026-05-30 status:** Partly overtaken. The loop now requires verify-green for autonomous completion, gates on a task ledger, and has an operator-Accept terminal (`completed-needs-review`) — all shipped in `docs/plans/loopfixex_completed.md` (LF-1…LF-8). This item is now **the net-new `evidence-resolver.ts` spine** that unifies those signals into one precedence ladder (runtime → external ground-truth → in-band `declared-complete` intent → forensic), plus the convergence cycle + review-thread fingerprint. **Single home: `2026-05-28-first-class-remote-orchestration-plan.md` Piece B (re-scoped).** Build it once there; don't duplicate here.
- **Today:** Loop completion fires on **self-reported** markers (`DONE.txt`, `<promise>DONE</promise>`, `*_Completed.md` rename, "TASK COMPLETE") — `loop-completion-detector.ts`. The loop-intelligence plan adds a *semantic* judge (LLM reads the transcript), but that's still an opinion. Review (`cross-model-review-service.ts`) runs **zero execution** and feeds reviewers identical context.
- **Do:** Add an **evidence-precedence resolver** where completion is decided by *external authority* in a fixed order: runtime-death → SCM/test ground-truth → agent self-report (hint only). Concretely, port agent-orchestrator's pattern (`packages/plugins/scm-github/src/index.ts`, `lifecycle-manager.ts:1303`): (a) run the verify command and pull the **actual failed-job logs** back into the next prompt; (b) track a **fingerprint of unresolved review-thread IDs** and only converge when it empties; (c) a bounded `detecting` buffer state with `evidenceHash` so unchanged weak evidence can't reset counters. The agent is **forbidden** from self-declaring terminal states. This is the missing teeth for both the loop-intelligence plan's P0-B and the remote-orchestration plan's "convergent autonomy."
- **Lives:** `src/main/orchestration/` (new `evidence-resolver.ts` consumed by `loop-coordinator.ts` + `cross-model-review-service.ts`).

### 2. Sandbox teeth: credential-proxy + OS enforcement + network egress — `nanoclaw` + `codex` · L · **High**
- **Today:** `SandboxManager` (876 lines) has config, profiles (MINIMAL/DEV/PROD), and an application-level `checkAccess`/`canSpawnProcess` gate. Security is otherwise secret-detection + redaction. **But real API keys are still handed to the spawned CLI via env/config** — a prompt-injected or compromised CLI can exfiltrate them, and there's no OS-kernel confinement or egress control.
- **Do (three layers, highest value first):**
  - **(a) Credential-proxy** *(nanoclaw `src/container-runner.ts:426`, `docs/SECURITY.md`)*: run a per-instance local HTTPS forward-proxy, **strip provider API keys from the child env**, and inject them at the proxy keyed by host. A fully-compromised agent then has nothing to steal. "Refuse to spawn if proxy unavailable."
  - **(b) OS-level enforcement** *(codex `sandboxing/src/seatbelt.rs`, `linux-sandbox/`)*: verify/upgrade `SandboxManager` to actually enforce via `sandbox-exec` (.sbpl) on macOS and landlock/bwrap on Linux for spawned CLIs — deny-by-default with computed writable roots, not just an in-process check.
  - **(c) Network egress allow/deny** *(codex `network-proxy/`)*: per-host domain policy, fail-closed.
- **Lives:** `src/main/security/sandbox-manager.ts` + instance spawn path (`instance/lifecycle/`). Pair with nanoclaw's **mount allowlist stored outside the workspace** (so the agent can't edit its own sandbox policy) + `realpath`-before-validate + reject `..`/`:` targets.

### 3. Executable hook runtime — `claude-code / Actual Claude` · L · **High**
- **Today:** Hooks are static condition objects with `action: 'warn' | 'block'` (`src/shared/types/hook.types.ts:21`). They cannot run a shell command, call an LLM/agent to judge, hit a webhook, **rewrite tool input**, or run async-and-rewake. Events cover PreToolUse/PostToolUse/Stop/SessionStart/End/UserPromptSubmit/PostCompact.
- **Do:** Upgrade to a 4-type executable hook (`Actual Claude/schemas/hooks.ts`): `command` | `prompt` (LLM-evaluated, reuse Anthropic provider) | `agent` | `http`, each with an `if` permission-rule pre-filter, `timeout`, `statusMessage`, `once`, and `async`/`asyncRewake`. Add `permissionDecision: allow|deny|ask` **+ `updatedInput`** outputs to PreToolUse so hooks can transform calls. Add missing events: **PreCompact** (inject "preserve this" before compaction), **SubagentStop**, **Notification**. Payoff: AIO's autonomous loop becomes expressible as a user-authored Stop hook (cf. `claude-code/plugins/ralph-wiggum`).
- **Lives:** `src/main/hooks/enhanced-hook-executor.ts`, `hook.types.ts`, `hooks-config.component.ts`.

---

## Tier 1 — Architecture for the remote / thin-client future

### 4. Snapshot-then-tail subscriptions + monotonic-sequence idempotent projection — `t3code` · M · **High**
- **Today:** AIO has snapshots/replay/continuity, but the renderer isn't a strict server-authoritative projection; reconnect/gap handling is bespoke.
- **Do:** Adopt the single load-bearing rule (`t3code apps/server/src/ws.ts:726`, `apps/web/src/environments/runtime/service.ts`): **every stateful subscription emits one `{kind:"snapshot", snapshotSequence}` then a live tail; every event carries a global monotonic `sequence`; the client dedupes by `sequence <= current`.** Reconnect = re-snapshot + idempotent replay → an entire class of gap bugs disappears, and "close the tab, reopen, you're caught up" becomes trivially correct. Add an explicit `replayEvents(fromSequenceExclusive)` for catch-up.
- **Lives:** the contracts/event-bus layer that feeds `IpcEventBusService`; prerequisite for the thin-client replatform.

### 5. Schema-first typed RPC codegen (one source → client + types + validators) — `opencode` + `copilot-sdk` + `t3code` · L · **High**
- **Today:** **775 hand-maintained Zod IPC channels**, and the AGENTS.md "three places must stay in sync" rule is exactly the drift class this eliminates. Multiple event normalizers exist because there's no single canonical event union (memory: `ProviderOutputEvent` lossier than `OutputMessage`).
- **Do:** Author each channel/route's schema once and **generate** the renderer client + TS types from it (opencode: `bun dev generate` → OpenAPI → `@hey-api/openapi-ts`; copilot-sdk: `*.schema.json` → 11.9k-LOC generated `rpc.ts` + a closed discriminated-union event type with per-variant JSDoc). Start by collapsing the provider/session event union to kill the normalizer sprawl. Even keeping Electron IPC as transport, generating the typed facade from your existing Zod schemas removes the dual-authoring burden. Pairs with **jean's single `dispatch_command()`** insight: generate the WS + MCP bindings from the *same* registry so "expose to remote/agent" is free, not a port.
- **Lives:** `packages/contracts/` + `scripts/generate-rpc.ts` build step.

### 6. Pairing/session auth + reachability policy + endpoint discovery — `t3code` · M · **High**
- **Today:** Remote observer is HTTP+SSE (monitor-only); remote-node is WS+JSON-RPC. No multi-device **pairing/session/revocation** model, and (per the thin-client plan) the IPC trust gate rejects non-window senders — a security redesign, not token reuse.
- **Do:** Port t3code's auth control plane (`apps/server/src/auth/`): one-time pairing credential → exchanged for a per-device session (cookie/bearer), with `issuePairingCredential`/`listPairingLinks`/`revoke*`, a live `subscribeAuthAccess` stream for instant revocation, and a **reachability-derived policy** (`ServerAuthPolicy`): auth auto-required the moment the bind address is non-loopback. Add the **AdvertisedEndpoint** model (`packages/contracts/src/remoteAccess.ts`): normalized candidates with `reachability` (loopback/lan/private/public) + browser `compatibility` (mixed-content awareness), pluggable discovery providers (Tailscale as an add-on), and **default persisted by stable kind, not raw IP**.
- **Lives:** AIO remote backend auth + a new remote connection manager.

### 7. Server-authoritative durable sessions: disconnect ≠ stop — `t3code` + `jean` · M · **High**
- **Today:** Instance liveness is tied to the live adapter process/pipe.
- **Do:** Decouple "client connected" from "instance alive." Persist thread↔instance bindings; drive teardown from **agent inactivity (`lastSeenAt`), not transport close** (t3code `ProviderSessionReaper` sweeps idle >30min). For long autonomous runs, add **jean's detached mode** (`src-tauri/src/chat/detached.rs`): the CLI writes an NDJSON transcript to disk and the supervisor **reattaches by tailing on relaunch** (PID-liveness gated), with PID-file ownership so a fresh AIO process reaps only orphans whose owner is dead.
- **Lives:** instance lifecycle / supervisor + session-continuity.

---

## Tier 2 — Provider & adapter layer

### 8. Live capability handshake (negotiated, per-version) — `copilot-sdk` · M · **Med**
> **2026-05-31 status: largely already present — don't rebuild.** `getRuntimeCapabilities()` is computed per *adapter instance*, not a static class flag: `claude-cli-adapter` gates `supportsDeferPermission` on the **detected, cached CLI version** (`shouldUsePermissionHook()` → `isVersionAtLeast(cachedCliStatus.version, DEFER_MIN_VERSION)`), and `remote-cli-adapter` derives caps from the node's reported capabilities. The version-staleness premise below is outdated. Only the *formal* per-session `negotiatedCapabilities` object + a `capabilities.changed` event would be net-new, and that's not worth churning load-bearing capability code for. Deprioritized.
- **Today:** Capabilities are **static class flags** (`base-cli-adapter.ts:85` `supportsResume: boolean`, `:99` `supportsNativeCompaction`), bound to the adapter class — they can't reflect that the *same* CLI at a *newer version* gained a feature (the code even comments "Claude CLI 2.1.90+").
- **Do:** Add a per-session `negotiatedCapabilities` populated from a spawn-time handshake (probe `--version`/init output) layered over the static defaults, with an event to update mid-session (copilot-sdk `session.ts:487` `capabilities.changed`). Gate orchestrator features (compaction trigger, defer-permission) on the negotiated object.
- **Lives:** `base-cli-adapter.ts` + session layer.

### 9. Consume Codex v2 thread/turn protocol + committed schemas — `codex` · L · **High**
- **Today:** AIO's Codex adapter parses the exec transcript / v1 surface.
- **Do:** Migrate to the **v2 API** (`codex-rs/app-server-protocol/src/protocol/v2/`): `thread/start|resume|fork|compact|rollback`, `turn/start|steer|interrupt`, and typed `item/*` lifecycle notifications (`commandExecution` w/ exit codes, `fileChange` w/ per-file diffs, `mcpToolCall`, `reasoning`). Native `turn/steer` (inject into an in-flight turn), `thread/fork` (branch history), and `turn/interrupt` replace higher-level reimplementations. Codex **ships generated TS + JSON-Schema** (`schema/json/*.v2.schemas.json` via `codex app-server generate-json-schema`) — code-gen Zod validators from it instead of hand-mirroring (this is the concrete realization of the deferred "ACP/Codex protocol codegen" item). Also consume `fileChange`/`apply_patch` **structurally** (path + unified diff) into the diff/review UI.
- **Lives:** `src/main/cli/adapters/codex/`.

### 10. Principled failover (selection-source, model-scoped cooldowns, billing lane) — `openclaw` · M · **High**
- **Today:** Multi-provider failover exists but likely lacks these edge-case protections.
- **Do (audit against `openclaw docs/concepts/model-failover.md`):** (a) track **`modelOverrideSource`** so a user's explicit `/model` pick fails **strict** (surfaces an error) instead of silently answering from another model; (b) **model-scoped** cooldowns (a rate-limited model doesn't blacklist its whole provider); (c) a separate **billing-disabled lane** (5h→24h backoff) vs short **rate-limit** cooldown (1m→1h), classified from 402/429/403; (d) **per-session auth-profile pinning** to keep provider prompt-caches warm.
- **Lives:** provider-failover module.

### 11. ACP as a provider family (Cursor + OpenCode) — `t3code` + `jean` · L · **High**
> **2026-05-31 status: partially present.** An `acp-cli-adapter.ts` already exists (with `cursor-cli-adapter.ts`), so the ACP family is started. Remaining net-new work is breadth (OpenCode coverage) + the capability-normalization matrix / synthetic plan-event backfill. Re-scope before picking up.
- **Today:** Bespoke adapter per CLI + normalizers.
- **Do:** Add an **Agent Client Protocol** adapter family (t3code `packages/effect-acp/`, `provider/acp/AcpSessionRuntime.ts`): one typed bidirectional JSON-RPC contract where model-switch, mode-switch, **permission/approval**, elicitation, file I/O, and **agent-spawned terminals** are protocol primitives — so Cursor + OpenCode work with near-zero per-CLI parsing. As more CLIs adopt ACP, this is far lower-maintenance than N adapters. (Also adds **Cursor CLI + OpenCode** support, which AIO lacks.) Pair with **jean's capability-normalization matrix** + synthetic plan-event backfill so the approval UI stays provider-agnostic when a CLI lacks native plan mode.
- **Lives:** `src/main/cli/adapters/` as a new family alongside the bespoke ones.

### 12. External model catalog (end pricing/capability staleness) — `opencode` · S–M · **Med-High**
> **2026-05-31 status: already present.** `src/main/providers/models-dev-service.ts` (+ `models-dev-service.spec.ts`) already implements a remote, TTL-cached models.dev catalog source. The "Today" note below is outdated; remaining work is enrichment depth, not the catalog itself. Reclassified — don't rebuild.
- **Today:** `provider.types.ts` versioned catalogs + pricing are **hand-maintained**; static `models-catalog.ts`.
- **Do:** Add a remote, TTL-cached, **schema-validated** catalog source (opencode `packages/core/src/models-dev.ts`: `https://models.dev/api.json`, 5-min TTL + **cross-process file lock** + bundled snapshot fallback + offline mode) as **enrichment over** per-CLI discovery. Capabilities (context limits, 200k-tier pricing, reasoning/modalities) feed compaction/JIT budgeting and cost estimation. Complements the provider-auto-update plan's "latest-model" half.
- **Lives:** model-discovery service.

---

## Tier 3 — Context & memory (complements loop-intelligence plan)

### 13. ~~Tool-output compression at the child-stdout boundary~~ — **PRUNED (doesn't fit AIO)**
- **Why pruned:** AIO orchestrates *external CLIs* (Claude/Codex/…) that own their own tool execution as subprocesses. The noisy `test/build/install/git` stdout is produced **inside the CLI's own bash tool**, which AIO never captures — it only sees the CLI's already-summarized output stream. There is no AIO-side "child-stdout boundary" to intercept for those commands. The same token-reduction goal is **already shipped, differently**: the model-cooperative **rtk command-rewrite + awareness** integration (`src/main/cli/rtk/rtk-runtime.ts`, `rtk-awareness.ts`) prefixes shell commands with `rtk` so rtk filters the output. The handful of commands AIO *does* run itself already bound their output via `OutputPersistenceManager` (`maybeExternalize`, the "tee" analog). See the Pruned section at the bottom.

### 14. Verbatim memory tier + hybrid recall + measured heuristics — `mempalace` · M · **High**
- **Today:** Memory is RLM-backed (episodic/procedural/semantic — *derived/scored*). codemem has BM25 + embeddings.
- **Do (mempalace ships committed LongMemEval benchmarks proving these):** (a) add a **verbatim "drawer" tier** (raw ~800-char / per-message chunks) retrieved as a *floor* that always runs, with RLM scores as a *boost* — derived-only memory has an unseen recall ceiling (96.6% R@5 verbatim vs 30–45% for LLM-extraction systems); (b) in codemem's hybrid path, **over-fetch 3× then re-rank** with candidate-relative BM25 IDF, fused `0.6*vec + 0.4*bm25`, plus a **union mode** pulling BM25-only candidates the vector index missed (ablation: +1.8pp, zero LLM); (c) add **temporal-proximity** and **proper-noun** boosts and **index assistant turns** (decisions/tool results), not just user prompts. Build a held-out replay eval from real AIO sessions to measure each.
- **Lives:** `src/main/memory/` + codemem retrieval/ranking. (The loop-intelligence plan's P2-A reuses memory — this makes that memory better.)

### 15. Durable, human-readable project handovers + reinforced lessons — `storybloq` · M · **High**
- **Today:** Continuity = snapshots/checkpoints (machine state, ephemeral, per-instance, opaque to humans and other tools). It loads CLAUDE.md but has no decision-rationale handover.
- **Do:** Add an optional git-trackable `.story/`-style folder (storybloq `src/skill/SKILL.md`): append-only **markdown handovers** + structured **lessons** (`reinforcements` counter, `supersedes` link, active/deprecated status). At session start, inject the **last N handovers** (preserves *why*, not just latest state) + a ranked **lesson digest**; at session end / pre-compaction, capture lessons with a "reinforce-don't-duplicate" check. Re-rank "what next" by mining the prior handover's flagged next-steps (`core/recommend.ts:applyHandoverBoost`). Complements (doesn't replace) the snapshot DB and the loop-intelligence plan's cross-loop memory.
- **Lives:** session-lifecycle + prompt-assembly + procedural-memory store.

### 16. ~~LSP-as-automatic-post-edit-feedback~~ — **PRUNED (doesn't fit AIO)**
- **Why pruned:** Same root cause as #13. opencode is an *in-process* agent that owns its own `edit` tool, so it can touch the file, await version-matched diagnostics, and splice them into the tool result before the model's next step. AIO orchestrates *external CLIs* that own their edit loop — AIO only observes the output stream and cannot inject diagnostics into the CLI's context mid-turn (the one thing AIO can do, send a fresh user message, is exactly the fragile mid-turn-injection problem we avoid elsewhere). The post-edit correctness signal AIO *can* deliver already exists as the loop's **verify-command** path (typecheck/lint/test run between iterations, fed into the next prompt) — which opencode's own docs note is usually better than per-edit LSP anyway. See the Pruned section at the bottom.

---

## Tier 4 — Multi-agent orchestration

### 17. Specialist role library + cost-aware delegation + deterministic router — `oh-my-codex` + `oh-my-opencode-slim` · S–M · **High**
> **2026-05-31 status: deterministic router + delegation policy DONE & verified.** `src/main/orchestration/delegation-policy.ts` (pure `routeRole` + `classifyScope` + `decideDelegation`, 17 unit tests) routes tasks over AIO's real roles (build/plan/review/retriever) without a model call, and is wired into `resolveChildAgentId` as a confidence-gated fallback (preserves existing behavior for ambiguous tasks) plus a non-blocking "do-it-inline" advisory in the spawn-child handler. **Out of scope / not done:** the 37-role *prompt library* (AIO has 4 roles, so a prompt port has no target), and *enforcing* the broad/narrow fan-out cap (no batch-spawn surface yet — each `spawn_child` is one child, already bounded by `maxChildrenPerParent`); `decideDelegation.maxParallel` is exposed/tested for when such a surface lands. The **depth-guard** sub-bullet below is #18(b), already done.
- **Today:** verify/debate/consensus exist, but no named-role taxonomy with economic delegation heuristics, and routing likely burns a model call to decide.
- **Do:** Port two **ready-to-steal, provider-agnostic prompt libraries** (oh-my-opencode `src/agents/`: explorer/librarian/oracle/designer/fixer/**observer**/council; oh-my-codex `prompts/`: ~37 roles incl. analyst/architect/critic/qa-tester/verifier). Adopt the orchestrator's **"Stats / Delegate-when / Don't-delegate-when"** framing (each role tagged with speed/cost multipliers + "skip delegation if overhead ≥ doing it yourself"). Add a **deterministic keyword→role router** (oh-my-codex `src/team/role-router.ts`: intent regex + keyword scoring + confidence) in front of dispatch, plus the **broad/narrow gate** (`delegation-policy.ts`: narrow→no fan-out, broad→cap 3 parallel) to prevent over-parallelization. The **observer** role (isolate large media bytes from the lead's context) maps directly onto AIO's context goals.
- **Lives:** `src/main/orchestration/` + a `prompts/roles/` asset dir.

### 18. Per-role least-privilege toolsets + capability-scoped delegation + depth guard — `hermes` + `oh-my-opencode-slim` · S–M · **High**
> **2026-05-31 status: (b) DONE & verified.** The recursion-depth guard + concurrent-children cap shipped as `src/main/orchestration/subagent-spawn-guard.ts` (pure `evaluateSpawn`, 11 unit tests) + a new `maxSpawnDepth` setting, wired into the local `spawn-child` path *and* the remote `run_on_node` MCP rail (caller lineage threaded as `metadata.spawnDepth`). Remaining open: **(a)** `intersect(requested, parentEnabled)` toolset + always-blocked set, and **(c)** per-role allowlists — both blocked on the #19 toolset registry.
- **Today:** AIO derives subagent permissions (`derive-subagent-permission.ts`) and the orchestrator MCP has rate-limits — but **no recursion-depth guard** on the spawn path, and no per-role tool allowlist.
- **Do:** (a) Compute a spawned child's toolset as **`intersect(requested, parentEnabled)`** — never widen — and strip an always-blocked set (the spawn tool itself, destructive ops, cross-session memory writes) (hermes `tools/delegate_tool.py`, `MAX_DEPTH=1`). (b) Add a **SubagentDepthTracker** (oh-my-opencode `src/utils/subagent-depth.ts`): block spawns past a max depth + cap total concurrent children — prevents agent-spawning-agent fork bombs in debate/consensus/loop. (c) Per-role deny-all-then-allow tool/MCP allowlists with a `['*','!x']` grammar.
- **Lives:** instance/supervisor spawn path + `src/main/mcp/orchestrator-tools-rpc-server.ts`.

### 19. Toolset abstraction (grouping + per-surface scoping + security boundary) — `hermes` · M · **High**
- **Today:** Many tools/channels but no single "what tools are exposed in *this* context" named bundle.
- **Do:** A `Toolset` registry (hermes `toolsets.py`): `{ tools: string[], includes: string[] }` with a recursive resolver. The **same** primitive expresses semantic groups, composite scenarios, **per-surface scoping** (one toolset per channel/agent role: `aio-discord`, `aio-remote-node`, `aio-verify`), and a **security boundary** (a tiny `aio-webhook-safe` read-only subset that resists prompt-injection from untrusted webhook/PR content). Layer a per-tool **runtime `check_fn`** (cached ~30s) so a tool whose dependency (CDP endpoint, credential, reachable MCP server) is unavailable silently drops from the model-facing schema instead of erroring on call.
- **Lives:** `src/main/tools/toolsets.ts`.

### 20. Adversarial safety-mandate critic + bounded debate + claim→evidence matrix — `oh-my-codex` · S–M · **Med-High**
> **2026-05-31 status: safety critic DONE & verified.** `src/main/orchestration/safety-critic.ts` (`critiqueSafety` — pure, flags destructive / credential / irreversible / missing-evidence with blocking vs. warning severity; 31 tests) complements the per-command `bash-validation` pipeline at the plan/output prose level. Wired as a **non-blocking** post-iteration advisory (`loop-safety-advisor.ts`, registered in `registerDefaultLoopInvoker`, surfaces blocking objections via structured `logger.warn`). **Open:** a true *blocking* pre-execution gate isn't cleanly achievable for the external-CLI loop (can't intercept mid-turn — same constraint as #13/#16), so this is a post-hoc audit; the **bounded 3-cycle debate** and **claim→evidence matrix** sub-parts are not yet done (they belong in the debate-coordinator flow).
- **Today:** debate/verify exist but unbounded and without a safety-focused adversary.
- **Do:** Add a **"critic with a safety mandate"** role (oh-my-codex `prompts/prometheus-strict-momus.md`) that, before execution, flags **destructive / irreversible / credential-gated** steps and missing test/lint/build evidence as *blocking* objections; bound the debate to **3 cycles with carry-forward** escalation (no infinite loop); require plans to emit a **claim→evidence matrix** (every claim names its verification source). A natural pre-execution gate for autonomous-loop mode. The 3 prompts are reusable as-is.
- **Lives:** `src/main/orchestration/` debate/verify flow + loop pre-flight.

### 21. Lease + mailbox state machine for conflict-free parallel workers — `oh-my-codex` · M · **Med**
- **Today:** worktrees + supervisor, but no explicit lane-ownership or typed handoff for agents writing to one repo.
- **Do:** Adopt an **AuthorityLease** (single-owner write authority per worktree/lane, stale-takeover) + a **MailboxLog/DispatchLog** modeling agent→agent handoffs as a state machine (`Pending→Notified→Delivered|Failed`, idempotent, replayable) (oh-my-codex `crates/omx-runtime-core/`). Answers "who owns this lane / did this handoff land" by construction.
- **Lives:** worktree/multi-agent orchestration.

### 22. Enrich the orchestrator-tools MCP + ScheduleWakeup — `jean` · M · **Med-High**
- **Today:** The AIO MCP server, auth, payload caps, and rate-limit (30/10s) **already exist** — but `aio-mcp-dispatcher.ts` exposes a **thin toolset** (`git_batch_pull`). The agent can't self-orchestrate.
- **Do:** Expand the orchestrator-tools MCP with bounded self-orchestration verbs (jean `jean_mcp_core.rs`): `spawn_child` (with **node target** — dovetails with the remote-orchestration plan's Hole 1), `send_to_instance` (fire-and-forget), `get_status` (poll), `create_worktree`, bounded `get_diff`. Add **`schedule_wakeup`** (jean `wakeup.rs`): the agent sets itself a timer (clamped 60–3600s, capped pending count) that re-injects a prompt when due — enables poll-and-resume ("check CI in 5 min") without idling a process. Reuse the contracts package as the tool schema source (item #5).
- **Lives:** `src/main/mcp/orchestrator-tools-rpc-server.ts` + tool handlers.

---

## Tier 5 — UX & product polish (mostly CodePilot)

### 23. Right-docked multi-panel "PanelZone" — `CodePilot` · L · **High**
- **Today:** Inspectors/source-control/MCP are separate destinations/overlays; one transcript at a time.
- **Do:** A thin top-bar toggle row mounting independently-toggled panels **side-by-side to the right of the transcript** — Git, Files, **Preview** (rendered markdown/HTML/CSV + source/rendered toggle, opens a diff *beside* the chat not over it), Dashboard — each lazy-loaded, persisted per-session (CodePilot `PanelZone.tsx`, `PreviewPanel.tsx`). The core "watch the agent while reading a diff" workflow.
- **Lives:** detail/transcript feature module.

### 24. Attention-zone fleet dashboard — `agent-orchestrator` · M · **High**
- **Today:** Rich instance panels, but no "which of my N agents needs *me* now, and why."
- **Do:** Bucket instances by **required human action** — Merge-ready / Needs-input / CI-failed / Review-changes / Working / Done — with a **precedence rule** so the most urgent reason wins the label (a crashed agent that also has changes-requested reads "crashed"), and inline send/kill/merge per card (agent-orchestrator `AttentionZone.tsx`, `getActionChipLabel`).
- **Lives:** Angular dashboard.

### 25. Setup Center onboarding — `CodePilot` · M · **High**
- **Today:** Settings workspace, but no guided first-run.
- **Do:** A first-run modal of **self-validating cards**, one per prerequisite (CLI detected? + version + path; provider key present? + "Use environment"; default workspace), each with a status pill, re-detect, skip, and an "N/3" progress counter that auto-dismisses at completion and is re-openable via a global command. Notably **detects conflicting multiple CLI installs** with copy-paste fix commands (CodePilot `SetupCenter.tsx`, `ClaudeCodeCard.tsx`). Feeds Doctor.
- **Lives:** new Setup feature module; reuse loading-skeleton + card styling.

### 26. Theme families + status-token tier + color lint gate — `CodePilot` · M · **Med-High**
- **Today:** One dark/light semantic token set with live preview.
- **Do:** (a) A **theme-family** layer above light/dark (CodePilot ships 12 OKLCH palettes as JSON, each also re-skinning code highlighting) applied via `data-theme-family`, with a picker showing light/dark swatch chips + a live code preview, and an anti-FOUC pre-hydration script. (b) A **`--status-*` token tier** (success/warning/error/info × base/fg/muted/border). (c) A CI **`lint:colors`** rule that fails on raw color utilities outside an allowlist (prevents palette drift). (d) A hidden **`/design-system` route** + a small **patterns layer** (`SectionPage`/`SettingsCard`/`FieldRow`/`StatusBanner`/`EmptyState` + a reusable searchable `CommandList`).
- **Lives:** global style system + shared/ui.

### 27. Per-message model picker + context ring + effort selector — `CodePilot` · M · **Med-High**
- **Today:** A model picker exists.
- **Do:** (a) Make it a **searchable, provider-grouped overlay** with a "Default" badge, last-used persistence, auto-fallback on invalid model, and a footer "Manage providers →" deep-link, selectable **per conversation** in the composer (CodePilot `ModelSelectorDropdown.tsx`). (b) Upgrade the context-% indicator to a **thin SVG ring** with threshold-colored stroke and a hover breakdown incl. cache vs output split and a **projected next-turn estimate** with an over-80% warning (`ContextUsageIndicator.tsx`). (c) A reasoning-**effort selector** that only renders for effort-capable models and **leads with "Auto"** (sends no override) (`EffortSelectorDropdown.tsx`).
- **Lives:** input-panel / detail header.

### 28. Split-screen dual-session compare — `CodePilot` · L · **Med**
- **Today:** Many instances, one transcript shown.
- **Do:** "Add to split" opens a second column; the focused column (border-primary ring) drives shared right-panels; a grouped "Split" section in the sidebar shows per-column status; persist + URL-sync the pair (CodePilot `SplitColumn.tsx`). The "compare two models/runs" interaction.
- **Lives:** transcript module.

### 29. Output styles + statusLine — `claude-code` · M / S–M · **Med / Low-Med**
- **Today:** No `outputStyle` support anywhere; no user-configurable status strip.
- **Do:** (a) **Output styles** — an `outputStyle` setting + a loader reading `~/.orchestrator/output-styles/*.md` (mirror `agent-registry.ts`), injected into the system-prompt builder, gated to system-prompt-injectable providers, with a renderer picker (built-ins like Explanatory/Learning swap the whole base prompt). (b) **statusLine** — a setting + status-bar component running a user shell command (debounced) fed AIO context (provider, model, token/cost, loop state) (`Actual Claude/components/StatusLine.tsx`).
- **Lives:** config + system-prompt builder + renderer chrome.

### 30. Magic commands/recipes + native-history adoption — `jean` · M · **Med**
- **Today:** Commands registry + skills.
- **Do:** (a) A **"Magic"/recipes** layer over the registry: named multi-step AI workflows (conflict-resolve, release-notes, PR-gen, issue-investigate) each with its **own model/provider/effort override** + a Zod schema for structured output, in the command palette (jean `src/components/magic/`). (b) **Native-history adoption** (jean `native_history.rs`): scan each CLI's on-disk history (`~/.codex/sessions/**`, `~/.claude/projects/**`) for the current workspace, present in the session picker (TTL-cached), and adopt a chosen one via the provider's native resume — bridges "I started this in my terminal, continue it here."
- **Lives:** commands registry + session/continuity.

---

## Tier 6 — Testing & dev infrastructure

### 31. Web-build E2E via mocked IPC + scripted mock adapter + parity harness — `jean` + `claw-code` · M · **High**
- **Today:** Mocks are in-process Vitest doubles; no out-of-process scripted CLI exercising the real spawn→parse→tool→permission path. (Wave-2 Task-24 deferred recorded-fixture replay pending adapter feed hooks.)
- **Do:** (a) **E2E without a native window** (jean `e2e/`): load the Angular renderer in a plain headless browser with a **mocked IPC bridge** (the contracts package gives exact channel shapes) + an event-emit helper to drive `IpcEventBusService` — fast, parallel, deterministic. Reserve full Electron-Playwright for window/native smoke only. (b) **Scripted mock at two levels** (claw-code): a `ScriptedCliAdapter` replaying `OutputMessage`/tool/permission steps for fast loop tests, **and** an out-of-process **mock CLI binary keyed by a `SCENARIO` env marker** (`crates/mock-anthropic-service/`) with captured-request assertions + a scenario→expectation **parity manifest**. Unblocks the deferred Playwright + fixture-replay items.
- **Lives:** `test/e2e/`, `src/main/cli/adapters/scripted-*`, `test/parity/`.

### 32. Declarative loop/merge policy engine with auditable decision events — `claw-code` + `agent-orchestrator` · M · **Med**
- **Today:** Loop/merge/retry/escalation decisions are imperative and scattered across `loop-coordinator.ts`, `loop-stage-machine.ts`, detectors, `stale-branch-policy.ts`.
- **Do:** Extract a **PolicyEngine** (claw-code `policy_engine.rs`): `Rule{condition, action, priority}` over a composable condition algebra (`And/Or` + leaves like `GreenAt`/`StaleBranch`/`ReviewPassed`/`RetryAvailable`), `evaluate_with_events` returning both actions **and a `PolicyDecisionEvent` with a human-readable explanation** for the activity log/UI. Keep existing detectors as condition inputs. Layer agent-orchestrator's **declarative reactions** (event→action with `retries`/`escalateAfter` budgets, oscillation-survival, green-streak reset) on top.
- **Lives:** new `src/main/orchestration/policy-engine.ts`.

### 33. Idempotency journal for SCM side-effects — `agent-orchestrator` · M · **Med**
- **Today:** No issue/PR creation yet — but when items #1/#24 add it, retries/restarts will duplicate.
- **Do:** Persist a journal keyed by `dedupeKey`+`operationKey`; embed HTML-comment markers in issue/PR bodies (`<!-- ao:dedupe-key:... -->`) and make all creates **find-or-create** with bounded retry on transient errors only (agent-orchestrator `feedback-routing-and-followup-design.md`). Plus **PATH-wrapper interception** (`agent-workspace-hooks.ts`): install per-instance `gh`/`git` shims that emit a structured "PR created/branch pushed" event — captures side effects from CLIs lacking native hooks.
- **Lives:** the service that performs SCM writes.

### 34. Cumulative-input-token compaction trigger — `claw-code` · S · **Med**
> **2026-05-31 status: DONE & verified.** Added a cost-proxy trigger to `CompactionCoordinator.onContextUpdate` (`src/main/context/compaction-coordinator.ts`): when an instance's lifetime `cumulativeTokens` *since its last compaction* crosses the configured threshold, a background compaction fires — independent of window %, with window-% thresholds still taking precedence. Per-instance baseline resets on each compaction; respects auto-compact/circuit-breaker/cooldown guards. New `cumulativeTokenCompactionTrigger` setting (default 0 = disabled, so zero behavior change unless opted in) wired live via `compaction-runtime.ts`. 6 new unit tests (13 total in the coordinator spec).
- **Today:** Rich compaction, but triggers are window-% based.
- **Do:** Add a **cumulative-input-token** auto-compaction trigger (cost-proxy, checked at end-of-turn incl. the terminal iteration) alongside window-% triggers, reporting removed-message count on the turn event.
- **Lives:** `compaction-coordinator` / instance resume path.
- **~~(a) Post-compaction health canary~~ — PRUNED (doesn't fit):** claw-code runs a cheap no-op tool round-trip after compaction because it *is* the in-process executor; AIO's executor is a CLI subprocess, so the only way to "probe" it is to prompt the model — which costs a full turn and can't be a silent canary. No clean fit. See the Pruned section.

---

## Tier 7 — Channels & gateway (lower priority for a coding orchestrator)

### 35. Channel-plugin SDK + deterministic routing + MCP-server compat — `openclaw` + `OB1` · L / S · **Med / Med**
- **Today:** Discord + remote observer + webhooks as somewhat bespoke integrations; AIO exposes an MCP server.
- **Do:** (a) An `AioChannelAdapter` interface (openclaw `sdk-channel-plugins.md`): channels supply only transport + identity + dm-policy + thread/session-key resolution; **core keeps one shared "send" tool** and owns routing/security/threading — adding a channel becomes a thin adapter. With a **deterministic precedence-ordered binding matcher** + a canonical session-key grammar (`channel-routing.md`) and per-channel model pinning. (b) **MCP-server compat hardening** (OB1 `server/index.ts`): on auth failure return a **JSON-RPC error envelope with HTTP 200** (strict hosts like Codex/Claude Code tear down on bare 4xx), and tolerate/patch a missing `Accept: text/event-stream` header from Claude Desktop — these are non-obvious gotchas that break real MCP interop.
- **Lives:** new `src/main/channels/` SDK + observer HTTP server.

---

## Appendix — ready-to-steal assets (low effort, drop-in)

- **Role-prompt libraries** (provider-agnostic Markdown): `oh-my-opencode-slim/src/agents/` (explorer, librarian, oracle, designer, fixer, observer, council) + `oh-my-codex/prompts/` (~37 roles). → `prompts/roles/`.
- **rtk filter DSL + 59 built-in filters** (`rtk/src/filters/*.toml`) and its **banned-prefix safety list** (never auto-allow `bash`/`python -c`/`sudo`) → reuse verbatim for items #13 and any command-policy work.
- **codex `execpolicy` semantics** (ordered prefix rules, allow/prompt/forbid + justification + host-executable pinning, strictest-wins) — port to JSON/TOML for AIO's command policy.
- **jean's "Adding a New AI Backend" ~80-item checklist** (`jean/CLAUDE.md`) → adopt as AIO's "New Provider Adapter" conformance spec, backed by a conformance test so missing surfaces fail CI.
- **codex banned/safe command heuristics** + the v2 JSON schemas (`codex-rs/app-server-protocol/schema/json/`) for codegen.
- **mempalace LongMemEval split** (`benchmarks/lme_split_50_450.json`) as a template for an AIO recall eval.

## Source-project essence (one line each)

- **jean** — the whole app is one transport-agnostic dispatch surface (IPC = WS = agent-MCP); the running agent can orchestrate the app.
- **agent-orchestrator** — "done" is defined by real CI/review ground truth, with an evidence-precedence ladder that subordinates agent self-reports.
- **CodePilot** — keep the live transcript central, surround it with non-blocking docked context; curated, premium per-surface polish.
- **t3code** — typed RPC over WS to a server-authoritative, event-sourced backend; snapshot+sequence projection = free reconnect resync.
- **opencode** — headless server is the source of truth; every UI is a code-generated typed client; models/permissions/tools/providers are *data*.
- **codex** — the protocol is the product; defense-in-depth execution (OS sandbox + network proxy + execpolicy) + a self-amending approval state machine.
- **claude-code** — nearly every behavior is user-declarable (hooks, output styles, statusline, tasks) rather than hardcoded engine features.
- **copilot-sdk / claw-code** — schema-first typed RPC + live capability handshake; a ruthlessly-testable harness with a permission lattice and a wire-level mock parity harness.
- **nanoclaw** — secure-by-architecture: credentials never enter the sandbox; defense via what's *not reachable*, not runtime checks.
- **oh-my-codex / oh-my-opencode-slim** — cost-aware specialist-team orchestration with depth guards, deterministic routing, and bounded adversarial planning.
- **mempalace / storybloq / rtk** — keep raw memory & retrieve it smartly; persist decisions durably & human-readably; stop flooding context at the source.
- **openclaw / OB1 / hermes** — one toolset/channel primitive for grouping + scoping + security; principled failover; MCP as the universal "any AI plugs in" port.

## Pruned — items that don't fit AIO's architecture (2026-05-31)

These were removed from the active backlog after ground-truthing. The common thread: several source projects are **in-process agents** that own their own tool executor / edit loop / stdout, whereas **AIO orchestrates external CLI subprocesses** that own those things themselves. Patterns that assume an in-process executor have no clean hook in AIO.

- **#13 — AIO-side tool-output (stdout) compression.** The noisy `test/build/git` output is generated inside the CLI's own bash tool; AIO never sees it raw, only the CLI's already-shaped stream. No interception point. Goal already met differently by the shipped **rtk command-rewrite + awareness** integration (`src/main/cli/rtk/`), plus `OutputPersistenceManager` bounding the commands AIO itself runs.
- **#16 — LSP-as-automatic-post-edit-feedback.** Requires owning the `edit` tool to splice diagnostics into the tool result before the model's next step. AIO can't inject into a CLI's context mid-turn. The loop's **verify-command** path already supplies a between-iteration post-edit correctness signal.
- **#34(a) — Post-compaction health canary.** A no-op tool round-trip only works when you *are* the executor; AIO's executor is a subprocess, so "probing" it means spending a full model turn — not a silent canary. (#34(b), the cumulative-input-token trigger, is kept.)

Not pruned but **already substantially present** (don't rebuild — see the top status block): **#8** (version-gated dynamic capabilities already computed per adapter instance) and **#11** (`acp-cli-adapter.ts` already exists).
