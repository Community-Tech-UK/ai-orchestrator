# AI Orchestrator — Improvement Backlog (fable pass 2, complete)

> **➡ Plan drawn (2026-07-13):** this catalogue has been triaged against the live codebase and turned into [`docs/plans/2026-07-13-fable-implementation-plan.md`](docs/plans/2026-07-13-fable-implementation-plan.md) — 16 verified workstreams + a disposition ledger covering every headline item (roughly half the Top-25 already existed in the codebase). **Reviewed &amp; APPROVED by James 2026-07-13** — all 16 workstreams, drops, and sequencing; decision answers recorded in the plan's §3. This file stays as the reference catalogue; do not plan from it directly.

> **What this is.** A discovery catalogue of concrete, file-cited techniques worth *stealing* from every sibling project in `/Users/suas/work/orchestrat0r/` to improve AI Orchestrator (AIO). Notes-for-a-plan, not a plan — each item records *where it lives*, *what it is*, *why AIO wants it*, and a rough effort (S/M/L). James draws the real plan from this.
>
> **Why pass 2 exists.** Pass 1 (the prior version of this file) did NOT investigate every project. This pass launched **one dedicated deep-dive agent per project — all 23 directories, no exceptions** — each briefed on AIO's existing capabilities so it filtered out things AIO already does as well. Every path below was read by an investigator. The coverage table proves each project was examined.
>
> **Effort:** S = a file/few functions · M = a subsystem · L = architectural. **Tags:** `Adapter` = improves an AIO provider adapter that drives a CLI · `Engine` = improves AIO's own core.
>
> **Raw agent reports** are preserved under `_scratch/fable_pass2/*.md` (one per project) for drill-down.

---

## Coverage table (all 23 projects examined)

| Project | What it is | Status | Headline steal |
|---|---|---|---|
| Actual Claude | Decompiled Claude Code source | full | microcompact, prompt-cache-break detector, speculative CoW execution |
| claude-code (official) | Anthropic public repo (CHANGELOG+plugins) | full CHANGELOG read | CLI flags/env AIO's Claude adapter isn't using; hook schemas |
| CodePilot | Electron multi-runtime agent client | full | Provider Doctor, shadow-HOME, generative widgets |
| codex | OpenAI Codex CLI (Rust workspace) | full (+4 sub-dives) | sandbox escalate-on-denial, credential broker, canonical exec events |
| codex-plugin-cc | Codex-as-CC-plugin broker | full | app-server broker (one shared child, busy-lock), stop-review gate |
| CodexDesktop-Rebuild | Rebuild-from-upstream + ASAR tooling | full | ASAR integrity re-patch, native-module sync (better-sqlite3 pain) |
| openclaw | Personal-assistant agent platform (3.1G) | full (6 clusters) | heartbeat wake bus, skill scanner, sandbox-per-scope, A2UI widgets |
| opencode | opencode agent (TS monorepo) | full | 9-strategy edit replacer, shadow-git revert, per-provider transforms |
| t3code | Provider-runtime TS monorepo | full | canonical lossless event union, hidden-git-ref checkpoints, ACP ext |
| hermes-agent | Python agent framework | full | verify-on-stop evidence ledger, PTC, progressive tool disclosure |
| jean | Tauri app driving Claude Code | full | self-orchestration MCP, kill-on-blocking-tool, Mr-Robot auto-fix |
| agent-orchestrator | Go daemon + Electron + mobile | full | hook-based activity detection, PR feedback nudge reducer, reconcile |
| storybloq | Cross-session context state machine | full | guide-driven autonomous FSM, deterministic multi-lens review judge |
| mempalace-reference | Memory/retrieval + benchmarks | full | LongMemEval eval harness, ranking-not-gate, query sanitizer |
| OB1 | Personal AI memory (Postgres/pgvector) | full | provenance trust-tiers, recall traces, unsafe-writeback guard |
| nanoclaw | Containerized agent runner | full | fail-closed egress lockdown, two-SQLite mailbox, self-mod approval |
| oh-my-codex | Codex CLI enhancement suite | full | sparkshell output compression, auth hotswap+resume, stall detection |
| oh-my-opencode-slim | opencode enhancement pack | full | secondary-model smartfetch, background job board, foreground fallback |
| claw-code | Claude-Code reimplementation (Rust) | full | mock-Anthropic parity harness (fixture replay), worker-boot evidence |
| pi | Coding-agent with runtime-TS extensions | full | jiti hot-load extensions, session-as-tree, RPC UI bridging |
| rtk | Rust CLI output-compression tool | full | TOML filter DSL, never-worse guard, token-savings ledger |
| online-orchestrator | Browser-extension multi-AI fan-out | full | DOM-stability completion heuristics, merge-prompt |
| copilot-sdk | GitHub Copilot CLI SDK | full | server-mode JSON-RPC, scoped permissions, context attribution |

**Not separately re-mined:** none. (Prior `_completed` passes: `copilot_todo_completed.md`, `docs/codex_todo_completed.md`, `docs/claude_todo_completed.md` — superseded/augmented by this pass.)

---

## Top 25 highest-leverage picks

Curated across all projects by value-per-effort and by how many independent projects converged on the same idea.

1. **Canonical lossless provider-event union with a typed `raw` escape hatch + dual native/canonical NDJSON logging** — `[t3code]` `packages/contracts/src/providerRuntime.ts:34-40,248-262`, `apps/server/src/provider/Layers/EventNdjsonLogger.ts:31`. Directly fixes AIO's lossy `ProviderOutputEvent` (Wave 2 Task 16) and *is* the capture side of fixture replay (Task 24). **(L)**
2. **Fixture-replay harness — two independent working shapes**: `[t3code]` `TestProviderAdapter.integration.ts` (replay canonical event arrays through the real adapter shape) and `[claw-code]` `rust/crates/mock-anthropic-service/src/lib.rs:13` (scripted mock Anthropic server + real CLI, `PARITY_SCENARIO:` routing, stateful tool roundtrips). Plus `[Actual Claude]` `services/vcr.ts` (hash req → fixture, record-on-miss) at the API layer — no `__feedRaw` hooks needed. **(L)**
3. **Two-layer retry: connect-retry vs mid-stream-replay + transport fallback** — `[codex]` `codex-client/src/retry.rs:8` + `core/src/responses_retry.rs:22` (WebSocket→HTTPS after max retries); `[opencode]` `session/retry.ts:26` (header-aware, HTTP-date Retry-After, "retrying at T" UI); `[Actual Claude]` `services/api/withRetry.ts:57` (foreground-only 529 retry). Everyone splits retry classes. **(M)**
4. **Microcompaction — evict old tool-result bodies, keep structure + cache prefix** — `[Actual Claude]` `services/compact/microCompact.ts:253`, `[opencode]` `session/compaction.ts:243`, `[codex]` `compact_token_budget.rs`, `[claw-code]` `trident.rs` (supersede file ops). Cheaper than full summarization; four projects do it. **(M)**
5. **Verify-on-stop gate backed by a passive evidence ledger** — `[hermes]` `agent/verification_evidence.py:34` + `verification_stop.py:245` (SQLite ledger of verify commands, doc-only-edit suppression, targeted-vs-full honesty). Mechanically enforces AIO's own "never claim done without verification" rule. **(M)**
6. **Guide-driven autonomous state machine (LLM as actuator, tool as controller)** — `[storybloq]` `src/autonomous/state-machine.ts`, recipe `recipes/coding.json`, per-state `RECOVERY_MAPPING`. The architecture AIO's loop-intelligence plan needs to de-island loop mode. **(L)**
7. **Self-orchestration: expose AIO-as-MCP-server to its own child agents** (spawn/steer/monitor siblings, recursion + rate guards via `JEAN_MCP_DEPTH` env) — `[jean]` `src-tauri/src/jean_mcp_core.rs:130`. **(L)**
8. **Hook-based agent activity detection** (install native agent hooks → hidden `ao hooks <event>` → active/idle/waiting_input/exited, works across 13 harnesses) — `[agent-orchestrator]` `backend/internal/adapters/agent/activitydispatch/dispatch.go:27`. Sees permission prompts inside a raw PTY that stdout-JSON parsing can't. **(M)**
9. **LongMemEval-style retrieval eval harness + "summary/index is a ranking signal, never a gate" + verbatim floor** — `[mempalace]` `benchmarks/longmemeval_bench.py:53`, `searcher.py:1106`; backed by their own numbers (raw 96.6% R@5 vs compressed 84%). AIO's biggest methodology gap: no way to prove a ranking change helped. **(L)**
10. **Sandbox escalate-on-denial loop + Seatbelt/landlock/seccomp recipes AIO can ship verbatim** — `[codex]` `core/src/tools/orchestrator.rs:286`, `sandboxing/src/seatbelt_base_policy.sbpl`, `denial.rs:6`. Run any spawned CLI in an OS jail; escalate on denial with consent. **(M-L)**
11. **Credential broker: child gets DUMMY env values, MITM proxy swaps the real secret only for the bound host** — `[codex]` `network-proxy/src/credential_broker.rs:12`; API-key-out-of-subprocess variant `[codex]` `responses-api-proxy/src/lib.rs:163`; `[nanoclaw]` proxy-side injection `src/container-runner.ts:480`. Agents "use" a token never readable in their env. **(M/L)**
12. **Container egress lockdown (Docker `--internal` net, forced proxy hop, fail-closed, self-heal)** — `[nanoclaw]` `src/egress-lockdown.ts:62`. Kernel-enforced "secrets never leave the box" as an opt-in hardened run mode. **(M)**
13. **Kill-on-blocking-tool: SIGKILL the `--print` CLI the instant `AskUserQuestion`/`ExitPlanMode` appears, surface it in the UI, resume with the answer** — `[jean]` `src-tauri/src/chat/claude.rs:1441`. **Adapter.** How plan mode works at all in a batch driver. **(M)**
14. **Ticket → headless agent pipeline** (issue → worktree → plan → auto-approve → yolo, with quota/auth circuit breaker + auto-archive) — `[jean]` `auto_fix/scheduler.rs:179`; `[agent-orchestrator]` tracker intake `observe/trackerintake/observer.go`; `[storybloq]` orphan-detector proves work landed before declaring done. **(M/L)**
15. **Progressive tool disclosure / lazy tool loading with a threshold gate** — `[hermes]` `tools/tool_search.py:64` (defer when schemas >10% of window, stateless catalog), `[Actual Claude]` `utils/toolSearch.ts:44` (auto:N). Fix for AIO's per-turn tool-schema tax. **(M)**
16. **Context attribution: "what is eating my window, by source"** — `[copilot-sdk]` `rpc.ts:17661` (per-source cost tree), `[CodePilot]` `context-breakdown.ts:174` (10-category, anti-fake-data), `[oh-my-codex]` friction report `session-history/friction.ts`. Novel observability panel. **(M)**
17. **Runtime-TS extension API with live `registerProvider`/tool/command via jiti (no rebuild)** — `[pi]` `packages/coding-agent/src/core/extensions/loader.ts:389`. Gold-standard self-extension surface; AIO's skills/plugins are static. **(L)**
18. **rtk TOML output-compression DSL + "never-worse" guard** — `[rtk]` `src/core/toml_filter.rs`, `guard.rs:6`. Data-only per-command output shrinking (git/test/build/docker) before context; guaranteed never to inflate. Complement: `[oh-my-codex]` sparkshell `crates/omx-sparkshell/src/main.rs` (LLM-summarize + pane-hash "unchanged" short-circuit). **(M)**
19. **Provider Doctor: parallel probes + one-click repairs bound to findings + a live 1-turn probe** — `[CodePilot]` `src/lib/provider-doctor.ts:1042`. Uses the exact same env builder as real chat to avoid "doctor green, chat broken". **(M)**
20. **Multi-strategy edit replacer (9 matchers, first-unique-wins) + disproportionate-match guard** — `[opencode]` `packages/opencode/src/tool/edit.ts:682`; fuzzy matcher `[codex]` `apply-patch/src/seek_sequence.rs:12`; apply_patch rescue `[oh-my-opencode-slim]` `hooks/apply-patch/matching.ts`. For AIO's own edit tooling in review agents/automations/MCP. **(M)**
21. **Turn-granular checkpoint via an isolated git index / hidden refs** (four independent impls) — `[t3code]` `vcs/GitVcsDriver.ts:650` + `CheckpointReactor`, `[opencode]` shadow-git `snapshot/index.ts:66`, `[Actual Claude]` message-ID file history `utils/fileHistory.ts`, `[CodePilot]` file-checkpoint. "Undo this agent turn" without touching the user's git. **(L)**
22. **Copilot server-mode JSON-RPC + scoped session-permissions + steering** — `[copilot-sdk]` `nodejs/src/client.ts:93`, `generated/rpc.ts:8047`. One architectural move (server mode over exec-per-message) unlocks steering, per-command approvals, quota RPC, context attribution. **Adapter.** **(L)**
23. **Prompt-cache break detector (fingerprint each request, name why the cache broke)** — `[Actual Claude]` `services/api/promptCacheBreakDetection.ts:247`, `[claw-code]` `api/src/prompt_cache.rs:260`. Nothing in AIO explains why cache costs spiked. **(M)**
24. **Heartbeat wake bus: coalesce + priority + retry backoff + flood guard + `HEARTBEAT_OK` suppression** — `[openclaw]` `src/infra/heartbeat-wake.ts:139`, `heartbeat-cooldown.ts:85`, `auto-reply/heartbeat.ts:186`. "Many things want to poke the agent, don't stampede; only interrupt the user when there's something real." **(M)**
25. **ASAR-integrity re-patch + native-module sync recipe** — `[CodexDesktop-Rebuild]` `scripts/build-from-upstream.js:255`, `sync-native-modules.js:52`. Fixes AIO's better-sqlite3 cross-platform packaging pain and the "modified asar won't launch" trap. **(M)**

---

## Cross-project convergence (high-confidence buys)

When several independent projects land on the same technique, it's a strong signal:

- **Microcompaction / evict-old-tool-output** — Actual Claude, opencode, codex, claw-code (supersede). Full summarization is the fallback, not the default.
- **Turn-granular checkpoint via isolated git** — t3code, opencode, Actual Claude, CodePilot (four impls).
- **Subdirectory-scoped instruction injection via tool-result append (cache-preserving)** — opencode `session/instruction.ts:179`, hermes `agent/subdirectory_hints.py:57`, CodePilot `subdirectory-hint-tracker.ts:71`. All three credit "append to the read output, not the system prompt."
- **Two-layer / reset-aware / header-aware retry** — codex, Actual Claude, opencode, openclaw, hermes. Everyone splits retry classes and honors reset/Retry-After headers.
- **Cross-session rate-limit guard file** — hermes `nous_rate_guard.py`, oh-my-codex quota detector. First 429 written to a shared file all sessions check → kills amplification.
- **Cheap-model delegation for read-heavy subtasks** — oh-my-opencode-slim smartfetch, CodePilot 5-tier aux model, mempalace single-pick rerank, Actual Claude side-question/away-summary. "Big model asks, small model reads."
- **Fingerprint-gated notification/wake dedupe** — oh-my-codex idle-cooldown, openclaw heartbeat, agent-orchestrator lifecycle CDC. Content fingerprint, not just time cooldown.
- **Kill-on-blocking-tool / hook-based state** — jean (SIGKILL), agent-orchestrator (native hooks). Both solve "batch CLI can't answer interactive tools / can't see permission prompts."
- **Provenance / evidence gates** — OB1 (memory trust tiers), hermes (verify-on-stop), storybloq (green contract + orphan proof), claw-code (approval tokens). "Prose 'approved'/'done' is not executable evidence."
- **Injection-safe PTY writes** — jean, agent-orchestrator (`send-keys -l`, isolated Enter, control-char sanitize), oh-my-codex (marker loop-guard). If AIO types into terminals, steal verbatim.

---

## Per-project findings

Each item: **name** — `path:line` — what / why AIO wants it — (effort). Full detail in `_scratch/fable_pass2/<project>.md`.

### Actual Claude (decompiled Claude Code)
- **Foreground-only 529 retry** — `services/api/withRetry.ts:57` — background calls (summaries/titles) bail immediately; "each retry is 3-10× gateway amplification." **(S)**
- **Persistent unattended retry with heartbeat yields** — `withRetry.ts:433` — waits until `anthropic-ratelimit-unified-reset`, chunks sleeps into 30s yields emitting `api_retry` so the host doesn't mark idle. **(S)**
- **max_tokens context-overflow auto-adjust** — `withRetry.ts:384` — parses the "X + Y > Z" 400, retries with adjusted max_tokens. **(S)**
- **Prompt-cache break detector (two-phase)** — `promptCacheBreakDetection.ts:247` — hashes cache-key inputs, names which tool schema changed when cache_read drops. **(M)**
- **Time-based microcompact** — `services/compact/microCompact.ts:253` — if the gap since last assistant msg exceeds threshold, content-clear old tool results before the request (cache is cold anyway). **(S)**
- **Cached microcompact via cache_edits API** — `microCompact.ts:52` — delete old tool results server-side without invalidating the cached prefix. **(M)**
- **Autocompact circuit breaker + reserved-output sizing** — `services/compact/autoCompact.ts:28` — stop after 3 failures (their BQ data: 3,272 doomed retries ≈ 250K wasted calls/day); reserve 20k for the summary. **(S)**
- **9-section compaction prompt + anti-tool-call preamble** — `services/compact/prompt.ts:19` — all-user-messages-verbatim + quoted next step; NO_TOOLS_PREAMBLE blocks tool calls during compaction. **(S)**
- **Speculative execution with copy-on-write overlay** — `services/PromptSuggestion/speculation.ts:402` — run the predicted next prompt in a CoW overlay while the user reads; halts at boundaries. **(L)**
- **Message-ID file checkpointing** — `utils/fileHistory.ts:31` — content-hash backups grouped by message UUID → /rewind to any point. **(M)**
- **Client-side secret scanner (~40 gitleaks regexes ported Go→JS)** — `services/teamMemorySync/secretScanner.ts:1` — run before any memory/webhook/upload leaves the box. **(S)**
- **Rate-limit early-warning pacing** — `services/claudeAiLimits.ts:38` — warn on utilization-vs-time-elapsed (5h: 90% used at ≤72% elapsed), not a fixed threshold. **(S)**
- **OAuth usage endpoint** — `services/api/usage.ts:12` — `GET /api/oauth/usage` → five_hour/seven_day {utilization, resets_at} + credits. **(S)**
- **VCR fixture record/replay for LLM calls** — `services/vcr.ts:23` — hash req → fixture, record on miss (CI fails with re-run hint). Solves Task 24 at the API layer. **(S)**
- **Deferred tool loading auto-threshold** — `utils/toolSearch.ts:44` — auto-enable ToolSearch when MCP tool defs exceed N% (10%) of window. **(M)**
- **Pure-TS nucleo fuzzy file index** — `native-ts/file-index/index.ts:1` — queryable-before-done contract, 270k paths searchable while still building. **(M)**
- **Session ingress with Last-Uuid optimistic concurrency** — `services/api/sessionIngress.ts:22` — PUT with Last-Uuid, on 409 adopt server's last UUID and retry. For mobile/remote transcript mirroring. **(M)**
- **Container egress proxy NO_PROXY portability note** — `upstreamproxy/upstreamproxy.ts:1` — each host needs three forms (`*.x.com`/`.x.com`/`x.com`) because Bun/curl/Go/Python parse differently. **(M)**
- Plus: /btw side questions on shared cache, away-summary, self-healing caffeinate, NDJSON stdout guard, API preconnect, paste store, priority message queue, coordinator scratchpad, Haiku mobile tool-batch summaries.

### claude-code (official repo) — Adapter-focused
- **`--bare` fast headless mode** (CHANGELOG 2.1.81) — skips hooks/LSP/plugin-sync, ~14% faster; use `--bare -p` for utility calls. **Adapter (S)**
- **`claude agents --json` roster + background daemon** (2.1.145, 2.1.139) — reconcile AIO's instance table against Claude's own daemon; decide own-PTY vs attach. **Adapter (M/L)**
- **`--fallback-model` (up to 3)** (2.1.166) — pass a fallback chain on every spawn. **Adapter (S)**
- **`--json-schema` + StructuredOutput tool** (2.1.187) — schema-validated print-mode output; switch review agents off free-form parsing. **Adapter (M)**
- **Retry/watchdog + hygiene env** — `CLAUDE_CODE_RETRY_WATCHDOG`, `CLAUDE_STREAM_IDLE_TIMEOUT_MS`, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, `DISABLE_UPDATES`, `CLAUDE_CODE_TMPDIR` — set in loop-mode spawn env. **Adapter (S)**
- **Correlation headers + TRACEPARENT** (2.1.86, 2.1.145) — join AIO traces to Claude's OTel spans (agent_id/parent_agent_id). **Adapter (M)**
- **Complete hook-event catalog + I/O schemas** (CHANGELOG) — reference taxonomy for an externalizable AIO lifecycle; SubagentStart/Stop, PermissionRequest, WorktreeCreate/Remove. **(L)**
- **`asyncRewake` background-review hook** — `plugins/security-guidance/hooks/hooks.json:34` — PostToolUse runs an LLM review in background, re-wakes the agent with findings. **(M)**
- **Ralph-wiggum stop-hook loop + completion-promise anti-lying contract** — `plugins/ralph-wiggum/hooks/stop-hook.sh:114`. **(M)**
- **Hookify: user-authored guardrails as markdown rules** — `plugins/hookify/` — one engine evaluates `.claude/hookify.*.local.md` across events. **(M)**
- **Devcontainer default-deny egress firewall** — `.devcontainer/init-firewall.sh` — iptables+ipset, GitHub-meta IPs fetched live, verify-by-probe. **(M)**
- **MCP context-cost controls** (2.1.7) — tool-search auto-defer >10%, per-server alwaysLoad, `maxResultSizeChars` annotation. **(M)**
- **Sandbox preset configs** — `examples/settings/settings-{strict,lax,bash-sandbox}.json` — ship as AIO presets. **Adapter (S)**
- Plus: `--from-pr`, `CLAUDE_CLIENT_PRESENCE_FILE`, statusline JSON contract, `/goal` completion condition, plugin manifest standard, `claude ultrareview --json`.

### CodePilot
- **Provider Doctor** — `src/lib/provider-doctor.ts:1042` — 5 parallel probes + live 1-turn probe with the real env builder + repair actions bound per finding. **(M)**
- **Structured error classifier with recovery actions** — `error-classifier.ts:407` — pattern+errno → {category, recoveryActions[]}; decides whether to clear the resume session id. **(M)**
- **Per-request shadow `~/.claude` HOME** — `claude-home-shadow.ts:236` — strip ANTHROPIC_* from settings while symlinking skills/plugins back; one shared env builder for chat+aux+doctor. **(M)**
- **Native timeout controller with reason codes** — `native-timeout.ts:174` — connect/first-token/tool/total budgets each anchored to a stream signal; guardStream races hung tools. **(M)**
- **Snapshot file checkpoint + rewind** — `file-checkpoint.ts:41` — per-turn stack, never `git checkout HEAD`, pre-session changes survive. **(M)**
- **Compaction rowid boundary + circuit breaker + planStreamHandoff** — `context-compressor.ts` — clears SDK resume id after compaction so the SDK doesn't defeat the summary. **(M)**
- **Sandboxed generative-widget iframe** — `widget-sanitizer.ts:87` + `widget-css-bridge.ts` — streamed HTML, CDN-first re-exec, CSP `connect-src 'none'`, theme-token bridge. **(L)**
- **Untrusted-HTML CSP intersection injection** — `inline-html-csp.ts:116` — always front-inject lockdown CSP even if content has its own. **(S)**
- **Skill-nudge** — `skill-nudge.ts:37` — ≥8 steps & ≥3 tools → offer to save as a skill. **(S)**
- **Context breakdown anti-fake-data contract** — `context-breakdown.ts:174` — 10 categories, source breadcrumbs, unsupported hidden not faked-0, floor for proxies reporting input=0. **(M)**
- **Model discovery enable_source three-state ownership** — `model-discovery.ts` — manual_enabled/manual_hidden never touched by auto-apply. **(M)**
- **Permission HMAC token + convergent-exit registry** — `permission-approval-token.ts`, `permission-registry.ts:84`. **(S)**
- **Codex approval → common permission UI bridge (idempotent)** — `codex/approval-bridge.ts:126`. **(M)**
- Plus: heartbeat suppression, scheduler stale-running recovery, IM permission broker, Claude session JSONL importer, keyword-gated in-process MCP, safe-stream wrapper, log secret sanitizer.

### codex (OpenAI Codex CLI) — Adapter + Engine
- **Sandbox escalate-on-denial loop** — `core/src/tools/orchestrator.rs:286` — run sandboxed, on Denied re-check policy + request approval + retry unsandboxed/proxied. **(M)**
- **Sandbox-denial heuristic** — `sandboxing/src/denial.rs:6` — 7 keywords + 128+SIGSYS, quick-reject 2/126/127. **(S)**
- **Guardian auto-review of approvals** — `core/src/guardian/mod.rs` — LLM adjudicates low-risk approvals, fails closed, caps denials. **(M)**
- **Unified exec: persistent PTY across tool calls** — `core/src/tools/handlers/unified_exec.rs:28` — keep a live shell/REPL between calls. **(M)**
- **Retry taxonomy + rate-limit header family parser** — `codex-client/src/retry.rs:8`, `codex-api/src/rate_limits.rs:23` — per-window used-percent/reset-at + credits. **(S/M)**
- **Stream retry with WebSocket→HTTPS fallback** — `core/src/responses_retry.rs:22` — flip transport after max retries, "Reconnecting N/M" UI. **(M)**
- **Credential broker (dummy env, real secret at proxy)** — `network-proxy/src/credential_broker.rs:12`; API-key-out-of-subprocess `responses-api-proxy/src/lib.rs:163`; stdin+mlock+zeroize key reader `read_api_key.rs:16`. **(M/L)**
- **Seatbelt/landlock/seccomp recipes** — `sandboxing/src/seatbelt.rs:623` (-D KEY=path injection-safe), `seatbelt_base_policy.sbpl` (deny-default + allowlist), `linux-sandbox/src/landlock.rs:169` (network seccomp), `bwrap.rs` (mask-then-rebind + userns probe). **(M)**
- **One-policy → per-OS argv wrapping** — `sandboxing/src/manager.rs:321` — neutral PermissionProfile → sandbox-exec / codex-linux-sandbox / windows wrapper. **(M)**
- **execpolicy prefix-rule DSL + read-only classifier + bash -lc tree-sitter decomposition** — `execpolicy/src/policy.rs:188`, `shell-command/src/command_safety/is_safe_command.rs:67`, `bash.rs:29`. **(S/M)**
- **Pre-main process hardening** — `process-hardening/src/lib.rs:12` — PR_SET_DUMPABLE=0, strip LD_*/DYLD_*, RLIMIT_CORE=0. **(S)**
- **PKCE loopback OAuth + dual token exchange + pluggable auth storage + guarded refresh** — `login/src/{pkce,server,auth/storage,auth/manager}.rs` — file/keyring/secrets backends, single-flight refresh for concurrent workers. **(M)**
- **apply_patch envelope grammar + multi-pass fuzzy matcher** — `apply-patch/src/parser.rs:1`, `seek_sequence.rs:12` — model-friendly diff format surviving stale context. **(M/S)**
- **Rollout JSONL schema + resume/fork + external-agent (Claude) import + config migration** — `rollout/src/recorder.rs`, `external-agent-sessions/`, `external-agent-migration/` — import a competitor CLI's whole config. **(M/L)**
- **Two-phase memory pipeline (extract→consolidate, git-diff as agent input)** — `memories/` — lease/claim dedup + git-baseline diff. **(L)**
- **Git-baseline "ghost commit" diff engine** — `git-utils/src/baseline.rs:69` — throwaway .git as diff baseline, in-memory blob hashing. **(M)**
- **OTel metric/event taxonomy + model catalog ETag refresh** — `otel/`, `models-manager/src/manager.rs:319`. **(S/M)**
- **Adapter: `codex exec --experimental-json` + exec JSONL ThreadEvent schema + app-server JSON-RPC (turn/steer, wire approvals) + stdio transport** — `exec/src/{cli,exec_events}.rs`, `app-server-protocol/src/protocol/common.rs`. exec = low-effort; app-server = high-fidelity live UI. **Adapter (S-L)**

### codex-plugin-cc
- **App-server broker: one shared child multiplexed over Unix-socket/named-pipe with busy-lock** — `scripts/app-server-broker.mjs` — coalesce many callers onto one expensive long-lived provider process with single-flight arbitration. **(L)**
- **JSON-RPC transport abstraction + auto-fallback (broker vs direct)** — `scripts/lib/app-server.mjs`. **(M)**
- **Turn-capture state machine incl. subagent fan-out + inferred completion** — `scripts/lib/codex.mjs:302`. **(L)**
- **Filesystem-backed background-job store keyed by workspace hash** — `scripts/lib/state.mjs` — DB-free ephemeral job tracking (no better-sqlite3 risk). **(M)**
- **Detached self-forking background worker** — `codex-companion.mjs:671` — re-invoke self with `task-worker`, survives parent exit. **(M)**
- **Cross-platform process-tree kill** — `scripts/lib/process.mjs:57` — win32 taskkill /T /F, POSIX group-first. **(S)**
- **Stop-hook review gate (ALLOW:/BLOCK: first-line contract)** — `scripts/stop-review-gate-hook.mjs` — keep the agent working until issues fixed. **(M)**
- **Git review-context collector with adaptive inline-vs-self-collect budgeting** — `scripts/lib/git.mjs` — measure diff bytes, shell:false. **(M)**
- **External-agent session import via content-hash reconciliation + path-traversal guard** — `scripts/lib/claude-session-transfer.mjs`. **(M)**
- **Reusable XML prompt-block library + adversarial-review prompt + JSON schema** — `skills/gpt-5-4-prompting/references/prompt-blocks.md`, `prompts/adversarial-review.md`. **(M)**
- **Session-lifecycle env-file append + kill-orphans-on-session-end** — `scripts/session-lifecycle-hook.mjs`. **(M)**

### CodexDesktop-Rebuild
- **ASAR header-hash integrity re-patching (mac plist + win exe binary-search)** — `scripts/build-from-upstream.js:255` — keep Electron's integrity fuse happy after any post-build ASAR edit. **(M)**
- **electron-rebuild + sync-native-modules to match upstream module list** — `scripts/sync-native-modules.js:52` — surgically swap only `.node`-bearing modules; directly relevant to better-sqlite3 pain. **(M)**
- **Ad-hoc re-sign + de-quarantine flow for a modified .app** — `build-from-upstream.js:159` — codesign --remove-signature → edit → xattr -rd → --sign - --force --deep. **(S)**
- **Version-diff-gated daily upstream CI** — `.github/workflows/sync.yml` + `check-update.js` — exit-code gates build jobs; only rebuild adapters when an upstream CLI version actually changed. **(M)**
- **AST-based binary patcher (acorn walk → offset splice, idempotent)** — `scripts/patch-*.js` — hot-patch a bundled third-party CLI's minified JS without forking. **(L)**
- **Node missing-intermediate-CA workaround** — `scripts/fetch-msstore.js` — `https.globalAgent.options.ca = [...tls.rootCertificates, ...extra]`. **(M)**
- **Electron fuses reference config for an agent-hosting app** — `forge.config.js:84`. **(S)**

### openclaw (6 clusters)
**Device/canvas/browser/talk:**
- **A2UI JSONL streaming UI protocol** — `extensions/canvas/src/a2ui-jsonl.ts:4` — agent paints structured UI (plans/diffs/approvals) via newline-delimited JSON. **(M)**
- **Sandboxed self-contained widget hosting + CSP + iframe auto-size** — `extensions/canvas/src/widget-tool.ts:36`. **(M)**
- **Server-side CDP Target.* synthesis with a dumb browser-extension transport** — `extensions/browser/src/browser/extension-relay/relay-bridge.ts:1` — "keep the untestable client dumb, synthesize protocol server-side." **(L)**
- **Proxy/DNS-rebinding-aware navigation SSRF guard** — `navigation-guard.ts:34` — Chromium resolves DNS separately, so pin hostnames yourself. **(M)**
- **Self-healing mDNS advertiser with restart budgets + config-in-TXT** — `extensions/bonjour/src/advertiser.ts:90`. **(M)**
- **Realtime-voice → full-agent consult delegation (policy-gated, strips reasoning)** — `src/talk/agent-consult-tool.ts:37`. **(M)**

**Channels/routing:**
- **Keyed inbound debouncer with same-key serialization** — `src/auto-reply/inbound-debounce.ts:63` — coalesce a user's 5 rapid lines into one turn, never reorder a stop/abort. **(M)**
- **DM-scope session-key derivation with cross-channel identity linking** — `src/routing/session-key.ts:222` — same human on Telegram+Discord collapses to one session. **(M)**
- **Foreground reply fence: generation-based stale suppression** — `src/auto-reply/dispatch.ts:117` — don't post the now-obsolete answer once a newer turn produced a delivery. **(L)**
- **Streaming draft edit-in-place loop (single-flight, throttled, re-park on rate-limit)** — `src/channels/draft-stream-loop.ts:25`. **(M)**
- **Markdown-safe chunking (never split code fences/surrogate pairs)** — `src/auto-reply/chunk.ts:194`. **(M)**
- **Allowlist match with wildcard + ordered candidate sources + match-metadata** — `src/channels/allowlist-match.ts:78`. **(S)**
- **Group activation / mention gating** — `src/channels/mention-gating.ts:171`. **(M)**
- **Inbound prompt envelope (weekday prefix because small models can't derive DOW)** — `src/auto-reply/envelope.ts:171`. **(S)**

**Skills/plugins/sandbox:**
- **Static skill scanner rule engine (LINE/SOURCE/CONTENT rules, severity)** — `src/skills/security/scanner.ts:163` — the scanning model AIO lacks entirely. **(M)**
- **Comment/string-stripping pre-pass + context-window correlation rules** — `scanner.ts:296,194` — env-harvesting fires only when process.env AND network-send co-occur within 8 lines. **(S)**
- **Workshop scan-gate → quarantine on critical + human-approval gate** — `src/skills/workshop/{service,policy}.ts` — agent can't self-approve a malicious skill. **(M)**
- **Plugin/hook supply-chain audit** — `src/security/audit-plugins-trust.ts` — unpinned specs, missing integrity, version drift, phantom allowlist entries, synthetic tool probe. **(M)**
- **Skill dep install `--ignore-scripts` by default** — `src/skills/lifecycle/install.ts:101`. **(S)**
- **Docker container-per-scope with hardened create args** — `src/agents/sandbox/docker.ts:405` — --init, no-new-privileges, cap-drop, config-hash label, hot-vs-cold recreate. **(L)**
- **Runtime bind/network security validation (symlink re-resolution)** — `validate-sandbox-security.ts:23`. **(M)**
- **Read-only skill overlay inside writable sandbox** — `workspace-mounts.ts:63`. **(M)**
- **Layered exec-approval + allowlist with argv rewriting + skillBins auto-trust** — `src/node-host/{exec-policy,invoke-system-run-allowlist}.ts`. **(M/L)**

**Cron/heartbeat/daemon:**
- **Heartbeat wake bus (coalesce+priority+retry backoff)** — `src/infra/heartbeat-wake.ts:139`. **(M)**
- **Wake defer/cooldown matrix (due-time + 30s floor + flood guard)** — `src/infra/heartbeat-cooldown.ts:85`. **(S)**
- **Deterministic phase-staggered scheduling (sha256 seed offsets)** — `src/infra/heartbeat-schedule.ts:13` — no thundering herd. **(S)**
- **Active-hours window seek** — `heartbeat-active-hours.ts:70` — quiet hours without per-tick Intl. **(M)**
- **`HEARTBEAT_OK` suppression + structured heartbeat_respond tool (notify true/false)** — `src/auto-reply/heartbeat.ts:186`, `heartbeat-tool-response.ts:9`. **(S)**
- **Transcript artifact scrubbing** — `heartbeat-filter.ts:448` — keep visible responses, strip poll noise. **(M)**
- **Cron failure retry-hint classifier + persisted-shape validator (quarantine bad jobs)** — `src/cron/{retry-hint,persisted-shape}.ts`. **(S)**
- **Safe-restart preflight (drain active work) + detached launchd/schtasks restart handoff** — `src/infra/restart-coordinator.ts:75`, `src/daemon/launchd-restart-handoff.ts:97`. **(M/L)**
- **Retry-After-aware jitter (positive-only so retries never land before server-cleared)** — `src/infra/retry.ts:104`. **(S/M)**

**Memory/context/sessions:**
- **Plain-text tool-call repair (promote/scrub leaked tool calls in 3 grammars)** — `packages/tool-call-repair/src/stream-normalizer.ts:1203` — recovers dropped actions from heterogeneous CLIs. **(L)**
- **Tool-pair-preserving chunk split + orphan repair during compaction** — `src/agents/compaction-planning.ts:90` — prevents "unexpected tool_use_id" 400s. **(M)**
- **Identifier-preservation + task-continuity compaction instructions** — `src/agents/compaction.ts:64`. **(S)**
- **Spaced-repetition memory promotion scoring** — `extensions/memory-core/src/short-term-promotion.ts:105` — frequency/diversity/recency/consolidation/tags. **(L)**
- **Session lifecycle admission + exclusive mutation coordination** — `src/sessions/session-lifecycle-admission.ts:199` — pause everything else, run compaction, drain with timeout, never suspend own turn. **(M/L)**
- **Input provenance + inter-session prompt-injection guard** — `src/sessions/input-provenance.ts:38`. **(S/M)**
- **Memory-recall subagent with circuit breaker + TTL cache + untrusted tagging** — `extensions/active-memory/index.ts:374`. **(M)**
- **Structured claim health / freshness + contradiction clustering** — `extensions/memory-wiki/src/claim-health.ts:74`. **(M)**

### opencode
- **Multi-strategy edit replacer (9 matchers) + disproportionate-match guard + CRLF/BOM preservation + per-file locks** — `packages/opencode/src/tool/edit.ts:682,731,22,35`. **(M/S)**
- **Shadow-git snapshot repo (separate GIT_DIR) + object-DB alternates seeding + per-message revert** — `snapshot/index.ts:66,195,408` + `session/revert.ts:38`. **(L)**
- **Header-aware retry (HTTP-date Retry-After, "retrying at T" status)** — `session/retry.ts:26`. **(M)**
- **Compaction: budgeted tail preservation + mid-turn split + tool-output pruning (mark not delete) + overflow last-message replay** — `session/compaction.ts:80,243,310`. **(L)**
- **Directory-walk instruction injection via Read tool (cache-preserving, survives restart via read metadata)** — `session/instruction.ts:179`. **(L)**
- **Doom-loop breaker (last 3 identical tool calls → permission ask)** — `session/processor.ts:352`. **(M)**
- **Retry-safe stream processor with orphan tool-call cleanup** — `session/processor.ts:539` — fixes dangling tool_use across retries/aborts. **(L)**
- **Bash permission scanning via tree-sitter + command-arity table** — `tool/shell.ts:257`, `permission/arity.ts:1` — `git status *` not `git *`. **(L/M)**
- **Wildcard permission ruleset (last-match-wins) + auto-settle queued asks + reject-with-feedback** — `permission/index.ts:28`. **(M)**
- **models.dev catalog sync (flock, ETag, hourly refresh, snapshot fallback)** — `packages/core/src/models-dev.ts:123` — live model/pricing/context-limit table. **(M)**
- **Per-provider request transform layer (surrogate scrub, cache-control breakpoints, reasoning variants, JSON-Schema sanitizers per provider)** — `provider/transform.ts` — the single richest quirk catalogue. **(L)**
- **Tool-output truncation to spillover files with agent-aware hint** — `tool/truncate.ts:85`. **(M)**
- **Edit → format → LSP diagnostics feedback loop** — `tool/edit.ts:196` + `format/index.ts:73` — the highest-leverage use of the LSP investment; closes the loop into the tool result. **(M)**
- **Background subagents with result injection + promotion + resume + cascade-cancel** — `tool/task.ts:25`. **(L)**
- **Structured output via forced tool** — `session/prompt.ts:74` — provider-agnostic. **(S)**
- **Config {env:}/{file:} substitution + JSONC caret diagnostics** — `config/{variable,parse}.ts`. **(S)**
- **Different-model history degradation (strip reasoning signatures on model switch)** — `session/message-v2.ts:245`. **(M)**
- **Media-in-tool-result extraction (hoist unsupported attachments to a follow-up user msg)** — `message-v2.ts:137`. For AIO's browser gateway screenshots. **(M)**
- Plus: MCP OAuth credential store, skill distribution via static URL index, built-in self-config skill, session-title small-model.

### t3code
- **Canonical ProviderRuntimeEvent union (47 variants) with typed `raw` escape hatch + providerRefs** — `packages/contracts/src/providerRuntime.ts:34,248` — the fix for AIO's lossy ProviderOutputEvent. **(L)**
- **Item-lifecycle taxonomy instead of tool-shaped events** — `providerRuntime.ts:104`. **(M)**
- **Fixture-driven test provider adapter (replay harness)** — `apps/server/integration/TestProviderAdapter.integration.ts:29` — real ProviderAdapterShape, queueTurnResponse replays canonical events, mutates workspace. **(L)**
- **Dual native/canonical NDJSON event log streams** — `apps/server/src/provider/Layers/EventNdjsonLogger.ts:31` — records ARE replay fixtures. **(M)**
- **Hidden-git-ref checkpoint with isolated index** — `apps/server/src/vcs/GitVcsDriver.ts:650` — temp GIT_INDEX_FILE → write-tree → commit-tree → update-ref refs/t3/checkpoints/...; invisible in log/reflog. **(L)**
- **CheckpointReactor: turn-boundary auto-checkpointing + revert with conversation rollback sync** — `orchestration/Layers/CheckpointReactor.ts:479,610` — co-rolls the CLI conversation the same N turns. **(L/M)**
- **Event store with causation/correlation + inline stream versioning (no read-modify-write race)** — `persistence/Layers/OrchestrationEventStore.ts:102`. **(M)**
- **Command receipts for idempotent dispatch** — `persistence/Migrations/002` — re-dispatched commands return the original result. **(S)**
- **ACP vendor-extension wrapper (xAI/Cursor quirks decorated around a standards-only runtime)** — `provider/acp/{XAiAcpExtension,CursorAcpExtension}.ts` — absorb per-CLI protocol quirks without polluting the core adapter. **(L/M)**
- **Codex shadow-home overlay for multi-account instances** — `provider/Drivers/CodexHomeLayout.ts:301` — symlink shared ~/.codex, keep auth.json private; ClaudeHome does the HOME-override equivalent. **(L)**
- **Dynamic adapter subscription reconciliation** — `provider/Layers/ProviderService.ts:300` — hot add/remove/reconfigure instances without restart. **(M)**
- **Declarative source-control provider discovery specs (gh/glab/az/bitbucket)** — `sourceControl/SourceControlProviderDiscovery.ts:31` — new hosts as data with auth-output sanitization. **(M)**
- **Worktree creation guard rails + setup-script-in-terminal handoff** — `git/GitManager.ts:1543`. **(M)**
- **ProcessRunner with typed failure taxonomy + localized Windows command-not-found detection** — `processRunner.ts:64`. **(M)**
- Plus: DrainableWorker, KeyedCoalescingWorker, ServerSecretStore (wx create + concurrent-create race), provider status cache with identity-verified hydration, ProviderSessionReaper.

### hermes-agent
- **Verification evidence ledger (SQLite) + verify-on-stop nudge + canonicalization + targeted-vs-full honesty + doc-only suppression** — `agent/verification_evidence.py:34`, `verification_stop.py:245`. **(M)**
- **RuntimeMode/ContextProfile seam (coding posture resolved once, all domains read it)** — `agent/coding_context.py:272`. **(M)**
- **ProjectFacts detection (hand each instance its test/lint/build commands at spawn)** — `coding_context.py:741`. **(S)**
- **Subdirectory hint tracker (append to tool result, cache-preserving)** — `agent/subdirectory_hints.py:57`. **(M)**
- **Three-tier system prompt (stable/context/volatile) + cache-breakpoint carrier check** — `agent/system_prompt.py:1`, `prompt_caching.py:52`. **(M/S)**
- **Programmatic tool calling (model writes a script calling its own tools over RPC; only stdout returns; guardrails still fire)** — `tools/code_execution_tool.py:1`. **(L)**
- **Progressive tool disclosure with threshold gate (stateless catalog)** — `tools/tool_search.py:64`. **(L)**
- **Tool-call loop guardrails (spin detection: repeated failures / identical results)** — `agent/tool_guardrails.py:63`. **(M)**
- **Three-level tool-output overflow defense (per-tool + per-result persist-with-path + per-turn aggregate 200K budget)** — `tools/tool_result_storage.py:1`. **(M)**
- **Background review fork (cache-inheriting daemon replays turn, decides what to persist; do-NOT-capture list)** — `agent/background_review.py:1`. **(L)**
- **Async delegation (idle-turn-only delivery, self-contained completion payloads) + cross-agent file-state registry** — `tools/async_delegation.py:1`, `tools/file_state.py:1`. **(M)**
- **Skills guard trust-tiered scanner + scoped threat-pattern library (detect broadly, block narrowly)** — `tools/skills_guard.py:1`, `tools/threat_patterns.py:1`. **(M)**
- **Cross-session rate-limit guard file** — `agent/nous_rate_guard.py:1`. **(S)**
- **Streaming think-block scrubber (state machine, not per-delta regex)** — `agent/think_scrubber.py:1`. **(S)**
- **Checkpoint manager: single shared shadow git store (dedup across projects)** — `tools/checkpoint_manager.py:1`. **(L)**
- **LSP diff-aware diagnostic delta filter** — `agent/lsp/range_shift.py:1`. **(M)**
- Plus: iteration budget with refund, empty-response nudge, mid-turn steer drain, curator lifecycle (archive-never-delete), write-approval staging, session FTS5 search with bookends, replay cleanup, clarify tool.

### jean
- **Agent-facing MCP registry routed through the app's own command dispatcher (20 tools, feature parity, zero dup logic)** — `src-tauri/src/jean_mcp_core.rs:130`. **(L)**
- **Recursion-depth chain via env var + per-source per-tool rate limit on mutating tools only** — `jean_mcp_core.rs:58,23`. **(S)**
- **Stdio-MCP proxy over token-authed local socket (no HTTP port)** — `jean_mcp_stdio.rs`, `jean_mcp_socket.rs`. **(M)**
- **create_worktree(start_autoinvestigating): one call = worktree + issue context + session + fire-and-forget** — `jean_mcp_core.rs:290`. **(M)**
- **Kill-on-blocking-tool (SIGKILL --print CLI on AskUserQuestion/ExitPlanMode, surface in UI, resume with answer)** — `chat/claude.rs:1441`. **Adapter (M)**
- **Execution modes → permission-mode mapping + ExitPlanMode ban after approval** — `claude.rs:94`. **(S)**
- **Fully detached CLI spawn surviving app quit (`set -m; cat | nohup ...; echo $!`)** — `chat/detached.rs:31`. **(L)**
- **NDJSON tail with adaptive poll + crash recovery via run manifest + PID liveness** — `chat/tail.rs`, `run_log.rs:2002`. **(M)**
- **Cancellation registry with pending-cancel race handling (per-backend strategy)** — `chat/registry.rs:19`. **(M)**
- **ScheduleWakeup tool (agent schedules its own future prompt, survives restart)** — `chat/wakeup.rs:1` — bridge for integrating loop-mode island into normal sessions. **(M)**
- **Monitor tool stream-keepalive protocol** — `chat/claude.rs:1331`. **(M)**
- **Mr-Robot auto-fix scheduler (issue→worktree→plan→auto-approve→yolo, quota/auth circuit breaker, auto-archive)** — `auto_fix/scheduler.rs:179`. **(L)**
- **Shared context-file store + combined `--append-system-prompt-file`** — `chat/claude.rs:719` — sidesteps "only last --append wins", keeps huge contexts out of argv. **(M)**
- **Cross-backend handoff digest on provider switch** — `chat/handoff.rs:31`. **(M)**
- **MCP auto-allow both forms + ChunkCoalescer 30ms batching + end-of-turn ## Recap contract** — `claude.rs:1056`, `chat/coalesce.rs:1`, `chat/mod.rs:34`. **(S)**

### agent-orchestrator
- **PR feedback nudge reducer with persisted dedup (CI/review/conflict routed back to the owning agent idempotently)** — `backend/internal/lifecycle/reactions.go:134`. **(M)**
- **CI failure log tail injected into the nudge** — `adapters/scm/github/provider.go:140`. **(S)**
- **Hook-based activity detection (native agent hooks → hidden `ao hooks`, active/idle/waiting_input/exited)** — `adapters/agent/activitydispatch/dispatch.go:27`. **(M)**
- **Durable facts / derived display status (worst-wins over open PRs, computed at read time)** — `service/session/status.go:27`. **(L)**
- **Honest `no_signal` status (hook-capable session that never fired ≠ confident idle)** — `status.go:16`. **(S)**
- **Multi-PR sessions + stacked-PR topology awareness** — `service/session/stack.go:21`. **(M)**
- **Reviewer-agent subsystem (per-(PR,SHA) freshness, persistent reviewer pane reused, gh-native loop back to worker)** — `review/{planner,launcher,prompt}.go`. **(L)**
- **Control-char sanitization of everything entering an agent PTY** — `domain/text.go:19`. **Security. (S)**
- **SQLite change_log CDC → broadcaster → SSE/WS (durable catch-up by seq offset)** — `cdc/poller.go:13`. **(M)**
- **Boot-time Reconcile: adopt / reap / restore (sessions survive daemon restart via external tmux runtime)** — `session_manager/manager.go:933`. **(L)**
- **tmux `send-keys -l` message injection** — `adapters/runtime/tmux/tmux.go:192` — makes every feedback loop work against any interactive CLI. **(M)**
- **Orchestrator session kind (agent-orchestrates-agents via `ao spawn`/`ao send`, restore-time recompute)** — `manager.go:1610`. **(M)**
- **Embedded "using-ao" skill (binary version IS skill version) + 2-line prompt pointer** — `skillassets/skillassets.go:1`. **(S)**
- **Browser preview element-annotation mode (click element → selector+rect+ARIA+styles → bounded agent msg with constraints)** — `frontend/src/shared/browser-annotations.ts:66`. **(M)**
- **Connect-Mobile bridge (QR pairing, separate LAN listener, socket-identity-not-headers gating, silent 404)** — `mobilebridge/config.go`, `httpd/lan_listener.go:44`. **(M)**
- **Single-WebSocket mobile mux with reconnect re-open (base64 PTY frames, RN Origin pin)** — `packages/mobile/lib/mux.ts:95`. **(M)**
- **Tracker issue intake → auto-spawn worker (bot comments reach the worker via ApplyTrackerFacts)** — `observe/trackerintake/observer.go`. **(M)**
- **Windows ConPTY out-of-process PTY host + ring (survive daemon restart on Windows)** — `adapters/runtime/conpty/`. **(M)**
- Plus: probe trichotomy (alive/dead/failed) + activity-corroborated death, generic auth probe, declarative binary discovery, `ao doctor` same-binary check, daemon attach/takeover, ready-to-merge predicate with bot-comment exclusion.

### storybloq
- **Guide-driven autonomous state machine (declarative transition table, server-enforced, LLM only works inside each stage)** — `src/autonomous/state-machine.ts`, `recipes/coding.json`. **(L)**
- **Per-state crash/compaction recovery mapping** — `guide.ts:160`. **(S)**
- **Context-pressure tiers from cheap session signals (compact at stage boundaries, not mid-task)** — `context-pressure.ts:23`. **(S)**
- **PreCompact/SessionStart hook pair + `.claude/rules/` resume marker (100% compaction survival)** — `session-compact.ts:49`, `resume-marker.ts:23`. **(M)**
- **Heartbeat sidecar + PID-reuse-safe lock (crash vs zombie detection with zero IPC)** — `liveness.ts:33,309`. **(M)**
- **Probe-based health model (8 three-valued probes → pure reducer, binary-drift detection)** — `health-model.ts:59`. **(M)**
- **Finished-orphan detection with git-ancestry proof (verify work landed before declaring dead)** — `orphan-detector.ts:36`. **(M)**
- **Cross-client session ownership: leases + owner-task adoption** — `guide.ts:94`. **(M)**
- **Multi-lens review: parallel fan-out, PROGRAMMATIC merge, DETERMINISTIC judge with convergence stop-rule** — `lens-harness/{prepare,synthesize,judge}.ts` — strictly better/cheaper than an LLM merge/judge. **(L)**
- **Per-artifact-hash lens finding cache (round 2 touching 3/15 files reuses untouched lenses)** — `lens-harness/cache.ts:50`. **(M)**
- **Secrets gate with in-diff redaction before prompts leave the process** — `lens-harness/secrets-gate.ts:28`. **(M)**
- **Diff-scope origin classifier → auto-file pre-existing findings (kills "reviewer blocks on legacy code")** — `lens-harness/diff-scope.ts:28`. **(S)**
- **Risk-scaled review depth + reviewer alternation + landing cap** — `review-depth.ts:27`. **(M)**
- **Field-classified structured 3-way JSON merge driver + distributed ID reservation via git remote refs** — `core/{field-classification,merge-driver,remote-refs}.ts`. **(L/M)**
- **Advisory claims: annotate + downrank, never hide (soft locks that can't deadlock the queue)** — `core/claims.ts:60`. **(S)**
- **File-based channel inbox with atomic rename-claim + HMAC-signed permission requests** — `channel/inbox-watcher.ts:207`, `permission-handler.ts:47`. **(M)**
- **Lessons with reinforcement ranking + LESSON_CAPTURE stage** — `core/lessons.ts:12`. **(M)**
- **VERIFY stage with endpoint auto-detection from the diff** — `stages/verify.ts:32`. **(S)**
- **Orchestrator-mode doctrine ("two planes, one pen"; MCP-vs-manual priming benchmark: 34x faster, 30% fewer tokens)** — `src/skill/orchestrator-mode.md`. **(S)**

### mempalace-reference
- **LongMemEval retrieval eval harness (R@k/NDCG@k, per-question-type, 8-architecture compare, dev/held-out split)** — `benchmarks/longmemeval_bench.py:53` — ports 1:1 to TS; AIO's biggest methodology gap. **(L)**
- **Ranking-signal-not-gate closet boosting (index hits add a bounded boost, never gate)** — `searcher.py:1106`. **(S)**
- **Verbatim-beats-extraction (raw 96.6% R@5 vs compressed 84%)** — `BENCHMARKS.md:7` — index verbatim ledger; compaction summaries are additional docs, never replacements. **(finding)**
- **Query sanitizer against prompt-contaminated searches (measured 89.8%→1.0% R@10)** — `query_sanitizer.py:1` — AIO's MCP/agent-facing memory search is exposed to exactly this. **(S)**
- **Hybrid keyword-overlap distance fusion + temporal-proximity + quoted-phrase/name boosts (all empirically priced)** — `longmemeval_bench.py:1763,1540,1434`. **(S)**
- **Single-pick LLM rerank (promote-to-rank-1, degrades to $0/offline; Haiku ≈ Sonnet, 3× cheaper)** — `longmemeval_bench.py:2765`. **(M)**
- **BM25+vector convex-combination rerank with metric-aware normalization (absolute-not-relative-to-max)** — `searcher.py:75`. **(M)**
- **BM25-only SQLite fallback when the vector index is corrupt** — `searcher.py:483` — retrieval degrades, never dies. **(M)**
- **Temporal knowledge graph with validity windows ("what was true when")** — `knowledge_graph.py:1`. **(L)**
- **Hebbian/Ebbinghaus connection dynamics (potentiation + decay floored, spacing effect)** — `dynamics.py:40`. **(M)**
- **4-layer wake-up stack with token budgets** — `layers.py:1`. **(M)**
- **Small-model eval harness (model × task × mode matrix; a 4B local model beat all cloud models on open-set classification)** — `benchmarks/model_eval/`. **(L)**
- **Benchmark-integrity discipline (dev/held-out, teach-to-test disclosure)** — `BENCHMARKS.md:483`. **(process)**
- Plus: synthetic paraphrase docs same corpus_id, diary-mode all-or-nothing warning, PreCompact save-before-compaction hook, idempotent sweeper.

### OB1
- **Governed agent-memory schema (provenance_status, use-policy booleans, DB CHECK: instruction-grade REQUIRES user_confirmed)** — `schemas/agent-memory/schema.sql:22` — prevents agent "lessons" silently becoming rules. **(M)**
- **Recall traces + usage feedback loop (which memories were used vs ignored)** — `schema.sql:181`, `integrations/agent-memory-api/index.ts:377` — closed-loop retrieval eval AIO's RLM needs. **(M)**
- **Provenance-blended ranking function** — `index.ts:249` — similarity + provenance bonus + policy + confidence. **(S)**
- **Unsafe-writeback guard (reject keys/creds/large-code/raw-transcript before storing)** — `index.ts:204`. **(S)**
- **Idempotent memory writeback + structured payload buckets** — `index.ts:450`. **(S/M)**
- **Memory review-action state machine (confirm/reject/mark_stale/dispute/merge/supersede, append-only audit)** — `index.ts:632`. **(M)**
- **Provenance chains (derivation DAG, recursive-CTE trace)** — `schemas/provenance-chains/schema.sql:34`. **(M)**
- **Hybrid cheap-filter → expensive-classify with HARD cost cap (assertPricingKnown refuses to start if any model unpriced)** — `recipes/typed-edge-classifier/classify-edges.mjs:9` — AIO has no pre-flight spend cap for background LLM jobs. **(S/M)**
- **Recency-boosted vector search (threshold gates on RAW similarity)** — `schemas/recency-boosted-match-thoughts/schema.sql:37`. **(S)**
- **Editorial-policy drift/contradiction auditor (fixed failure taxonomy, "empty findings is correct", page-only-on-critical)** — `recipes/editorial-policy/auditor/index.ts:122` — strongest LLM-as-auditor prompt in the repo. **(M)**
- **Smart-ingest extract→reconcile→execute (fail-closed on embedding failure: "skip, don't add duplicates when the system is weakest")** — `integrations/smart-ingest/index.ts:56`. **(M)**
- **Consolidation worker (canonical subject-scoped profile synthesis)** — `consolidation-workers/bio/index.ts:114`. **(M)**
- **Ops health views for memory pipelines (SQL: enrichment gaps, stalled queue, graph coverage)** — `recipes/brain-health-monitoring/ops-views.sql:20`. **(S)**
- **Nested-Claude spawn hygiene (STRIP_KEYS to un-detect nested; keep extraction LLMs tool-less against injection)** — `recipes/atomizer/lib/claude-cli.mjs:16`. **(S)**
- Plus: append-only mutation audit with recovery diffs, hashed per-agent identity keys, prompt-injection envelope hygiene, live-retrieval discipline skill, three-pass entity resolution.

### nanoclaw
- **Fail-closed egress lockdown (Docker `--internal` net + gateway alias, self-heal every 60s)** — `src/egress-lockdown.ts:62`. **(M)**
- **Secrets-never-in-the-box (proxy-side credential injection + stub files + agent skill)** — `container-runner.ts:480`, `skills/onecli-gateway/SKILL.md`. **(L)**
- **Human-in-the-loop credential approval holding the HTTP request open** — `modules/approvals/onecli-approvals.ts:92`. **(M)**
- **Two-SQLite-file mailbox with cross-mount invariants (VirtioFS coherency findings)** — `session-manager.ts:1`, `db/connection.ts:1`. **(L)**
- **Heartbeat-file liveness + tool-aware stuck detection (honour the tool's declared timeout)** — `host-sweep.ts:83`. **(M)**
- **Crash-recovery ladder (claim reset + backoff + orphan-claim clearing, ordering hazard comments)** — `host-sweep.ts:329`. **(M)**
- **Mount allowlist outside the project root, fail-safe parsing** — `modules/mount-security/index.ts:41`. **(M)**
- **Symlink-proof attachment staging (CWE-59: agent pre-places symlinks, host writes through them)** — `inbox-safety.ts:50`. **(M)**
- **Agent self-modification with admin approval → per-group image rebuild → verify** — `mcp-tools/self-mod.ts:39`. **(L)**
- **Script-gated scheduled tasks (bash pre-check decides whether to wake the LLM)** — `scheduling/task-script.ts:19` — best idea here for AIO monitoring automations. **(M)**
- **`ncl` CLI over session-DB with group-scope enforcement + approval-gated verbs** — `cli/ncl.ts:41`, `cli/dispatch.ts:54`. **(L)**
- **Engage modes + accumulate-as-context routing (lurk, accumulate, engage only when addressed)** — `router.ts:296`. **(M)**
- **Spawn-time CLAUDE.md composition with RO nested mounts (composed=host-owned RO, memory=agent-RW)** — `claude-md-compose.ts:47`. **(M)**
- **Blocking ask_user_question MCP tool over the DB mailbox** — `mcp-tools/interactive.ts:37`. **(M)**
- **SQLite UTC timestamp parse guard (one-liner bug class)** — `host-sweep.ts:52`. **(S)**
- Plus: circuit breaker, install-scoped orphan reaping, upgrade tripwire (error text written for the coding agent), wake dedup promise map, outbound envelope protocol, A2A return-path routing, RO source mount + tini + pinned pnpm.

### oh-my-codex
- **sparkshell: threshold-gated LLM output compression with pane-hash "unchanged" cache** — `crates/omx-sparkshell/src/main.rs:136` — ≤12 lines raw, larger → redact + summarize; identical re-observation returns "unchanged" at zero tokens. **(L)**
- **sparkshell secret redaction before summarization (count in telemetry)** — `redaction.rs:9`. **(S)**
- **Auth slot hotswap (quota-triggered account rotation + `codex resume <id>` preserving flags)** — `src/auth/hotswap.ts:137`, `quota-detector.ts:31`. **(L)**
- **Fingerprint-gated idle-notification dedupe (two-tier: cooldown + content fingerprint)** — `notifications/idle-cooldown.ts:131`. **(S)**
- **Auto-nudge stall detection with false-positive filters (permission-seeking / planning / test-output stripped)** — `scripts/notify-hook/auto-nudge.ts:310`. **(M)**
- **Injection guard stack (loop-guard marker + SHA dedupe + per-pane cap + cooldown)** — `scripts/tmux-hook-engine.ts:96`. **(M)**
- **Injection-safe tmux send (`send-keys -l --`, isolated C-m, newline strip; fixes two CVE-class bugs)** — `notifications/tmux-detector.ts:89`. **(S)**
- **Multi-source progress evidence (git mtime across worktrees + nudge state + task baseline)** — `team/progress-evidence.ts:67` — objective stall detector. **(S)**
- **Turn-count no-progress highlighting** — `sidecar/collector.ts:287` — "burning turns without task movement." **(M)**
- **Reply-listener daemon (chat reply → tmux injection with correlation registry + redacted ack)** — `notifications/reply-listener.ts:548`. **(L)**
- **Process-tree runner (descendant count kill, byte-limit kill, exit-vs-close early sweep)** — `runtime/process-tree.ts:112`. **(M)**
- **Exec followup queue (inject prompts at the next stop-hook, deferred delivery)** — `exec/followup.ts:1`. **(M)**
- **Capabilities lockfile (hallucinated-tool / surface-drift gate)** — `capabilities/lockfile.ts:7`. **(M)**
- **Session friction report (metadata-only transcript health scan → "compact or split" signal)** — `session-history/friction.ts:34`. **(M)**
- Plus: lifecycle-dedupe stableSerialize, pane-state heuristics, NudgeTracker bounded escalation, task claims with expiring lease, fail-closed agent-pane resolver, notification template engine.

### oh-my-opencode-slim
- **Cheap secondary-model extraction in webfetch ("big model asks, small model reads")** — `tools/smartfetch/secondary-model.ts:131` — page bytes never enter the expensive model. **(M)**
- **llms.txt probing + fetch quality signals + ETag revalidation** — `tools/smartfetch/network.ts:527`. **(M)**
- **Background Job Board injected as system-reminder (alias/taskID/agent/state, "don't poll, reconcile terminal jobs")** — `utils/background-job-board.ts:479`. **(L)**
- **Warm-session reuse by alias with per-agent LRU cap (state-gated, silent degrade)** — `hooks/task-session-manager/index.ts:393`. **(M)**
- **Per-job read-context tracking ("Context read by exp-1: …")** — `task-context-tracker.ts:64`. **(M)**
- **Event-driven rate-limit model fallback (try new model WITHOUT aborting first; sticky deepest fallback; chain isolation)** — `hooks/foreground-fallback/index.ts:33`. **(M)**
- **Tool-output self-repair appenders (error → one-line fix hint + corrected example in-band)** — `hooks/delegate-task-retry/patterns.ts:7`, `hooks/json-error-recovery/hook.ts:12`. **(S)**
- **Internal-initiator marker + Copilot `x-initiator: agent` header (billing/quota lever)** — `utils/internal-initiator.ts:9`, `hooks/chat-headers.ts:66`. **(S)**
- **Image strip-to-disk + delegate-to-vision-agent (keep raw bytes out of the coordinator's context)** — `hooks/image-hook.ts:156`. **(S/M)**
- **apply_patch rescue pipeline (comparator ladder + LCS rescue, ambiguous→refuse)** — `hooks/apply-patch/matching.ts:47`. **(L)**
- **Per-agent skill-visibility prompt filtering** — `hooks/filter-available-skills/index.ts:69`. **(S)**
- **cancel with abort→verify→delete escalation + late-error normalization ("cancellation is not rollback")** — `tools/cancel-task.ts:219`. **(M)**
- **Codemap skill (hierarchical prose maps + hash change detection, incremental cheap-model refresh)** — `src/skills/codemap/SKILL.md:20`. **(M)**
- **/loop with typed success criteria + per-attempt history files** — `hooks/loop-command/index.ts:11`, `loop/loop-session.ts:30` — directly relevant to AIO's loop-intelligence plan. **(M)**
- **/reflect session-mining command ("create nothing" is a valid outcome)** — `hooks/reflect/index.ts:3`. **(S/M)**
- **Deepwork workflow (persistent plan file, reviewer-context priming, design-intent guardrail)** — `src/skills/deepwork/SKILL.md:13`. **(S)**
- Plus: phase reminder anti-drift pair, subagent depth guard, deferred session close, council retry semantics, clonedeps skill.

### claw-code
- **Deterministic mock-Anthropic parity harness (scripted mock /v1/messages, PARITY_SCENARIO routing, stateful tool roundtrips, hermetic real-CLI spawn)** — `rust/crates/mock-anthropic-service/src/lib.rs:13` — AIO's fixture-replay gap inverted (script the provider side). **(L)**
- **Streaming JSON-assembly torture chunks (split input_json_delta mid-token)** — `lib.rs:352` — the exact regression class for stream parsers. **(S)**
- **Worker-boot state machine + startup evidence bundle + failure classifier (trust_required/prompt_misdelivery/transport_dead/...)** — `rust/crates/runtime/src/worker_boot.rs:29` — AIO's "instance stuck at boot" with no diagnosis. **(L)**
- **Trust-prompt auto-resolution with worktree allowlist** — `trust_resolver.rs:5`. **(M)**
- **Recovery recipes (one-auto-attempt-then-escalate, typed EscalationPolicy)** — `recovery_recipes.rs:18`. **(M)**
- **Typed lane-event contract with provenance + dedupe ("if a structured event exists, pane text is supporting evidence only")** — `lane_events.rs:5`. **(M)**
- **Green contract (ordered verification levels + evidence requirements)** — `green_contract.rs:1`. **(M)**
- **Compaction tool-use/tool-result boundary guard + non-nesting summary re-merge + post-compaction health canary** — `compact.rs:128,290`, `conversation.rs:306`. **(S)**
- **Prompt-cache break detector (FNV fingerprints, unexpected-break in persisted stats)** — `api/src/prompt_cache.rs:260`. **(M)**
- **Bash validation pipeline (6 upstream submodules ported, no deps, direct TS transliteration)** — `bash_validation.rs:52`. **(M)**
- **Sandbox capability probing (actually run `unshare` once; "binary exists ≠ feature works")** — `sandbox.rs:108`. **(S)**
- **Trident 3-stage compaction (supersede file ops, collapse, cluster)** — `trident.rs:1`. **(M)**
- **Scoped one-time approval tokens with delegation chain ("prose 'approved' is not an executable approval")** — `approval_tokens.rs:4`. **(M)**
- **Upstream surface extractor for parity diffing (alert when a CLI's tool/flag surface drifts)** — `compat-harness/src/lib.rs:95`. **(M)**
- Plus: scenario↔doc drift gate, captured-request sequence assertion, anti-slop triage taxonomy, roadmap→board generator with evidence freeze, stale-branch detection, branch-lock collision detection.

### pi
- **Jiti runtime-TS extension loader (live registerProvider/tool/command, no rebuild, virtualModules for compiled binaries)** — `packages/coding-agent/src/core/extensions/loader.ts:389` — THE headline steal; AIO's skills/plugins are static. **(L)**
- **Full typed lifecycle event surface (~35 events, tool_call block/mutate, context pipe, before_agent_start replaces system prompt)** — `extensions/types.ts:1170`, `runner.ts:749`. **(L)**
- **Registration/action split with late-bound runtime + poisoned stale-context invalidation** — `loader.ts:160`. **(M)**
- **Session-as-append-only-tree (id/parentId, branch = move leaf pointer, fork-in-place)** — `session-manager.ts:780`. **(L)**
- **Branch summarization on tree navigation (abandoned branches not lost)** — `compaction/branch-summarization.ts:1`. **(M)**
- **Compaction: cut-point + split-turn prefix summary + iterative summary update + persistent file-op tracking** — `compaction/compaction.ts:377`. **(M)**
- **Context-overflow recovery: compact-then-retry with one-shot guard** — `agent-session.ts:1894`. **(M)**
- **Steering vs follow-up message queues with drain modes** — `packages/agent/src/agent.ts:123`. **(M)**
- **RPC mode: JSONL stdio with session-tree ops + reverse UI bridging (extension dialogs tunneled out headless)** — `modes/rpc/rpc-types.ts:20`. **(L)**
- **Bandwidth-lean stream proxying (strip partial, reconstruct client-side)** — `packages/agent/src/proxy.ts:36`. **(M)**
- **Runtime provider registration incl. OAuth + `!command` secret syntax** — `types.ts:1380`. **(M)**
- **Project trust gating for project-local code execution** — `project-trust.ts:1`. **(S)**
- **ExtensionUIContext keyed-slot contribution model (→ Angular component outlets)** — `types.ts:126`. **(L)**
- **Fail all tool calls when stopReason === "length" + per-file mutation queue** — `agent-loop.ts:207`, `file-mutation-queue.ts:28`. **(S)**
- Plus: handoff-instead-of-compact, subagent-as-child-pi, session export to HTML, OAuth double-checked-lock refresh, lazy session flush.

### rtk
- **TOML filter DSL (8-stage declarative pipeline; 64 filter files driven by one ~1700 LOC engine)** — `src/core/toml_filter.rs:16` — port ~200 LOC to TS, new CLI recipes become config not code. **(M)**
- **Never-worse guard invariant (if filtered > raw tokens, emit raw)** — `src/core/guard.rs:6` — keystone making aggressive filtering low-risk. **(S)**
- **`unless` anti-swallow clause on short-circuit rules** — `toml_filter.rs:43` — the two-line fix for "success → one-liner swallows errors." **(S)**
- **Tee raw-output recovery with hint line** — `src/core/tee.rs:8` — filter aggressively knowing nothing is lost. **(S)**
- **Token-savings ledger per command + parse-failure telemetry → filter-gap discovery** — `src/core/tracking.rs:249`, `src/discover/` — mine transcripts to rank which outputs to filter next. **(M)**
- **Force machine-readable reporter then compress (vitest --reporter=json, tiered fallback enum)** — `src/cmds/js/vitest_cmd.rs:301`. **(M)**
- **Semantic "ok" collapses for state-changing commands (git add → "ok N files", 92% savings)** — `src/cmds/git/git.rs:926`. **(S)**
- **Generic err/test wrapper for unknown commands (~15 error-shape regexes, 90% savings zero per-tool work)** — `src/cmds/rust/runner.rs:14`. **(S)**
- **Streaming filter architecture (BlockHandler/LineHandler traits)** — `src/core/stream.rs:9`. **(M)**
- **Command-string rewrite registry (`rtk rewrite`) + thin TS plugin delegate** — `src/discover/registry.rs:482`, `openclaw/index.ts:27`. **(S delegating / L porting)**
- **Trust-gated project-local filter files (hash-pinned behind approval)** — `toml_filter.rs:191`. **(S)**
- Plus: inline filter tests + `rtk verify`, log dedup via normalize-then-count, grep grouping shrink-only, weighted cost-per-token economics.

### online-orchestrator
- **DOM-stability streaming-completion heuristics for chat web UIs (Stop button + text-unchanged + MutationObserver)** — `multi-ai-query/content-scripts/chatgpt.js:236`, `shared/utils.js:69` — for AIO's browser gateway "wait for response" logic. **(M)**
- **Multi-fallback selector + React-friendly input injection + paste-based image attachment** — `chatgpt.js:61`, `shared/utils.js:100`. **(M)**
- **Fan-out one query to N logged-in tabs → merge via a synthesis prompt** — `background/service-worker.js:57` — minimal browser-based debate; merge-prompt wording + ready-tab registry are the reusable pieces. **(S)**

### copilot-sdk (all Adapter/Engine)
- **Server-mode JSON-RPC transport with protocol negotiation (stdio/TCP-with-token)** — `nodejs/src/client.ts:93` — one move unlocks everything below vs exec-per-message. **(L)**
- **Steering (immediate) vs queueing (enqueue) on send + queue-inspection RPC** — `types.ts:2723`. **(M)**
- **Scoped permission decision protocol (discriminated union: shell/write-with-diff/read/mcp/url/memory; approve-for-session/location/permanently, reject-with-feedback)** — `generated/rpc.ts:8047`. **(L)**
- **Session-scoped quota + usage metrics RPC (per-model tokens, lines-changed, nanoAiu cost)** — `rpc.ts:2694,15060` — replaces AIO's endpoint probing. **(S)**
- **Session budget caps + exhausted-budget interactive top-up flow** — `docs/features/session-limits.md`. **(M)**
- **Elicitation protocol + confirm/select/input sugar over one JSON-Schema primitive** — `session.ts:208`, `types.ts:679`. **(M)**
- **Full hooks surface (preToolUse modifiedArgs, postToolUseFailure hidden guidance, userPromptSubmitted modifiedPrompt)** — `types.ts:1172`. **(M)**
- **System-message section surgery (12 named sections, live transform callbacks over RPC)** — `types.ts:889`. **(M)**
- **Custom tool registration (overridesBuiltInTool, defer:auto, 5-value resultType)** — `types.ts:593` — expose AIO's MCP tools natively inside Copilot. **(L)**
- **Client mode:"empty" (secure-by-default multi-tenant profile, fails closed at construction)** — `types.ts:233`. **(M)**
- **Infinite sessions: dual-threshold background compaction (80% async / 95% block) + summarizeForHandoff + saveLargePaste** — `types.ts:1600`. **(M)**
- **Context attribution / heaviest-messages introspection** — `rpc.ts:17661`. **(M)**
- **Event log cursor/long-poll + interest registration (gate expensive event production)** — `rpc.ts:17811`. **(M)**
- **Session management RPC (fork-at-event, getLastForContext, checkInUse locks, dry-run pruning)** — `rpc.ts:16096`. **(M)**
- **Resume with continuePendingWork (re-emit pending approvals)** — `types.ts:2380`. **(M)**
- **Background tasks + promote-to-background + inter-agent messaging** — `rpc.ts:16774`. **(L)**
- **Fleet mode (parallel sub-agents, SQL todos with dependency edges as host-visible state)** — `rpc.ts:16724`. **(M)**
- **SessionFs provider (FS + SQLite virtualization over RPC — session state wherever the host says)** — `rpc.ts:18001`. **(L)**
- **LLM inference interception (CopilotRequestHandler — AIO-side metering/caching/redaction of embedded runtime traffic)** — `copilotRequestHandler.ts:33`. **(L)**
- **BYOK registry + never-serialize-credentials bearer callbacks + secrets.addFilterValues (log redaction)** — `types.ts:1963`, `rpc.ts:15770`. **(M)**
- **140+ typed session events (JSON-Schema→discriminated-union codegen)** — `generated/session-events.ts` — the codegen pattern for AIO's IPC contracts. **(L)**
- **Teardown-resilient JSON-RPC writer (suppress writes during teardown)** — `client.ts:446` — immediately portable to AIO's MCP clients + LSP workers. **(S)**
- Plus: model listing with billing/policy metadata, ephemeral query on live context, sendAndWait idle correlation, debug bundle, embedded CLI installer.

---

## Six strategic bets (where the evidence points)

1. **Make the canonical provider event lossless + event-sourced** — t3code raw union + NDJSON, codex/copilot cursor logs, claw-code/t3code replay harnesses. Unblocks AIO's deferred Task 16/24 and gives reconnect + replay + time-travel debugging.
2. **Lazy tool loading + context-attribution telemetry** — codex/hermes/Actual-Claude tool_search, copilot/CodePilot/hermes breakdown, oh-my-codex friction. Direct fix for the per-turn tool-schema tax + a shippable "what's eating my window" panel.
3. **Turn-granular checkpoint via an isolated git index** — four independent impls (t3code/opencode/Actual-Claude/CodePilot). "Undo this agent turn" without touching the user's git.
4. **De-island loop mode: a guide-driven state machine + verify/evidence gate** — storybloq FSM, hermes verify-on-stop, claw-code green contract, oh-my-opencode-slim /loop criteria. Makes "done" mean verified and gives deterministic crash/compaction resume.
5. **OS-level sandbox + credential broker + content-trust gates** — codex seatbelt/seccomp + credential broker, nanoclaw egress lockdown, openclaw/rtk/hermes skill scanners. A hardened run mode + a real safety gate on cloned-repo skills/config.
6. **Token-reduction at the tool boundary + cheap-model delegation** — rtk DSL, oh-my-codex sparkshell, oh-my-opencode-slim smartfetch, hermes/mempalace secondary-model. Compress noisy CLI output and offload read-heavy subtasks before they reach the coordinator.

---

## STATUS / WHERE I AM (2026-07-12)

**Investigation is COMPLETE.** All 23 project directories were deep-mined by dedicated agents in this pass (the coverage table above is the audit trail; raw per-project reports in `_scratch/fable_pass2/`). This file is the full synthesis.

Two small optional follow-ups a future pass could do (low value, not blocking):
- openclaw `src/cron/isolated-agent/run.ts` (1769 lines) full isolated-session lifecycle — only skimmed.
- Actual Claude `services/mcp/officialRegistry.ts` + `services/analytics/growthbook.ts` — unopened; nothing in listings suggested a step-change.

**Next step is NOT more investigation — it's drawing up the actual implementation plan** from the Top 25 / six strategic bets. That's a design task (James's call on priority), best done fresh rather than as a continuation of this mining run.


---
---

# APPENDICES — all prior findings preserved

> These appendices preserve every earlier round of findings so nothing is lost. Pass 2 above (the coverage-table + per-project sections) is the newest and most thorough sweep and re-captures most of the material below; the appendices keep the earlier passes' exact wording, thematic organisation, "not-worth-it" lists, and the completed-file item lists that pass 2 condensed or referenced rather than repeated.

## Appendix A — Prior fable pass 1 (Rounds 1–3), recovered in full

> **Provenance.** Rounds 1–2 are recovered verbatim from git (the staged copy of the earlier `fable_todo.md`). Round 3 was recovered verbatim from the harness session transcript (`~/.claude/projects/.../c2a1909b-*.jsonl`, the session that authored it on 2026-07-11). Together they reconstitute the original ~654-line pass-1 document exactly. Almost every item is independently re-captured (usually with more detail) in the pass-2 per-project sections above.

# AI Orchestrator — Improvement Backlog (fable pass)

> **What this is.** A discovery catalogue of concrete, file-cited techniques worth *stealing* from the sibling projects in `/Users/suas/work/orchestrat0r/` to improve AI Orchestrator (AIO). It is a **notes-for-a-plan**, not a plan — each item records *where it lives*, *what it is*, *why AIO would want it*, and a rough effort. James will draw up the real plan from this.
>
> **Method.** Twelve parallel deep-dive investigations, one per project cluster, each briefed on AIO's existing capabilities so they filtered out things AIO already does as well. Every reference path below was read by an investigator (codex and copilot-sdk/Actual-Claude were each further fanned into sub-dives). Paths are relative to each sibling repo root unless noted.
>
> **Relationship to prior passes.** Three earlier passes exist and are `_completed`: `copilot_todo_completed.md` (GUI/settings), `docs/codex_todo_completed.md` (53 items), `docs/claude_todo_completed.md` (18 items, t3code+opencode). Where an item here overlaps one of those, it's tagged **↺ prior:** with the reference — usually because this pass found the *concrete implementation to copy* for a concept a prior pass raised abstractly. New items carry no such tag.
>
> **This is a backlog, not a claim AIO lacks everything below.** AIO is a very mature ~975-main-file Electron 40 + Angular 21 app. Many items are "adopt this specific hardened detail," not "you're missing this feature."

**Effort legend:** S = a file or a few functions · M = a subsystem-sized change · L = a large/architectural change.
**Tag legend:** `[project]` source · **Adapter** = improves an AIO provider adapter that drives a CLI · **Engine** = improves AIO's own core · **↺ prior:** overlaps an earlier pass.

---

## Top 20 highest-leverage picks

Curated across all projects, weighted by value-per-effort and by how many independent projects converged on the same idea.

1. **Canonical provider-event union with a lossless `raw` escape hatch + dual native/canonical NDJSON logging** — `[t3code]` `packages/contracts/src/providerRuntime.ts:248`, `apps/server/src/provider/Layers/EventNdjsonLogger.ts:31`. Directly unblocks AIO's own deferred *ProviderOutputEvent lossiness* (Wave 2 Task 16) and *fixture-replay* (Task 24). **(L)**
2. **Two-layer retry: connect-retry vs mid-stream-replay** — `[codex]` `codex-client/src/retry.rs:23` + `core/src/responses_retry.rs:22`; mirrored in `[Actual Claude]` `services/api/withRetry.ts`. A streaming client must distinguish "never connected" (blind retry) from "stream died after partial output" (replay history). **(M)**
3. **Microcompaction — evict old tool-result bodies, keep structure + cache prefix** — `[Actual Claude]` `services/compact/microCompact.ts:253`, `[opencode]` `session/compaction.ts:243`, `[codex]` `compact_token_budget.rs`. Cheaper than full summarization; three projects do it. **(M)**
4. **"Summary/index is a ranking signal, never a gate" + verbatim floor** — `[mempalace]` `searcher.py:1108`; backed by their own benchmark (raw 96.6% R@5 vs compressed 84%). Antidote to the classic RAG failure where a lossy layer hides a correct hit. **(M)**
5. **LongMemEval-style retrieval eval harness** — `[mempalace]` `benchmarks/longmemeval_bench.py`. AIO has a rich memory stack but no way to *prove* a ranking change helped. Biggest methodology gap. **(M)**
6. **Self-orchestration: expose AIO-as-MCP-server to its own child agents** (spawn/steer/monitor siblings, with recursion + rate guards) — `[jean]` `src-tauri/src/jean_mcp_core.rs:130`. Turns any agent into a first-class orchestrator. **(L)**
7. **rtk TOML output-compression DSL + "never-worse" guard** — `[rtk]` `src/core/toml_filter.rs`, `src/core/guard.rs:6`. Data-only per-command output shrinking (git/test/build/docker logs) before context; guaranteed never to inflate. **(M)**
8. **Verify-on-stop gate backed by a passive evidence ledger** — `[hermes]` `agent/verification_stop.py:245`. Mechanically enforces AIO's own "never claim done without verification" rule, with doc-only-edit suppression to avoid false fires. **(M)**
9. **Rate-limit window headers → primary/secondary/credits + sleep-until-reset** — `[Actual Claude]` `services/claudeAiLimits.ts:29`, `[codex]` `codex-api/src/rate_limits.rs:57`. Accurate "5h window 80% used, resets at X / weekly at Y%" UI and reset-aware backoff. **(S/M)**
10. **Provider Doctor: parallel probes + one-click repairs bound to findings + a live 1-turn probe** — `[CodePilot]` `src/lib/provider-doctor.ts`. ↺ prior: codex_todo #18 raised the concept; this is the implementation. **(M)**
11. **Copilot granular, session-scoped permissions** (approve-for-session scoped to command-IDs / MCP-tool / writes / directory; reject-with-feedback) — `[copilot-sdk]` `nodejs/src/generated/rpc.ts:8040`. Far past allow/deny. **(M)**
12. **Sandbox-then-escalate loop + Seatbelt/landlock/seccomp recipes AIO can ship verbatim** — `[codex]` `core/src/tools/orchestrator.rs:286`, `sandboxing/src/seatbelt_base_policy.sbpl`. Run *any* spawned CLI in an OS jail; escalate on denial with consent. **(M–L)**
13. **Container egress lockdown (Docker `--internal` net, forced proxy hop, fail-closed)** — `[nanoclaw]` `src/egress-lockdown.ts:62`. Kernel-enforced "secrets never leave the box" as an opt-in hardened run mode alongside worktrees. **(M)**
14. **Blocking-tool SIGKILL to make a batch CLI behave interactively** (surface `ExitPlanMode`/`AskUserQuestion` instead of deadlocking) — `[jean]` `src-tauri/src/chat/claude.rs:1469`. **Adapter.** **(M)**
15. **Ticket → headless agent pipeline with ref-counted shared context files** — `[jean]` `src-tauri/src/projects/github_issues.rs:467`; auto-fix plan→approve→yolo loop `src-tauri/src/auto_fix/scheduler.rs:179`. AIO's loop mode is an "island"; this is real issue-driven autonomy. **(M/L)**
16. **AI-authored generative-UI widgets via a code-fence (not a tool) in a sandboxed iframe** — `[CodePilot]` `src/lib/widget-sanitizer.ts:87`, `widget-guidelines.ts:49`. Works on any CLI/router (Copilot/Cursor can't register tools). High demo value. **(L)**
17. **Provenance gate + recall-trace logging that feeds RLM** — `[OB1]` `schemas/agent-memory/schema.sql:90` (DB CHECK: can't act on unconfirmed memory) and `:181` (which retrieved memories were used vs ignored). Turns AIO's RLM into a measurable loop. **(M)**
18. **Save-as-Skill nudge from a complexity heuristic** (≥8 steps & ≥3 distinct tools → offer to author the SKILL.md) — `[CodePilot]` `src/lib/skill-nudge.ts:37`. Zero-config skill capture. **(S)**
19. **pi runtime-TS extension API with live `registerProvider`** (drop a `.ts` file, add a provider/tool/command with no rebuild, via jiti) — `[pi]` `packages/coding-agent/src/core/extensions/loader.ts:213`. Gold-standard self-extension surface. **(L)**
20. **ASAR-integrity re-patch + native-module sync recipe** — `[CodexDesktop-Rebuild]` `scripts/build-from-upstream.js:255`, `scripts/sync-native-modules.js`. Fixes AIO's better-sqlite3 cross-platform packaging pain and the "modified asar won't launch" trap. **(M)**

---

## Cross-project convergence (strong signals)

When several independent projects land on the same technique, it's a high-confidence buy:

- **Microcompaction / evict-old-tool-output** — Actual Claude, opencode, codex. (Full summarization is the fallback, not the default.)
- **Subdirectory-scoped instruction injection via tool-result append (cache-preserving)** — opencode `session/instruction.ts:179`, hermes `agent/subdirectory_hints.py:76`. Both credit the "append to the read output, not the system prompt" trick to keep the prompt cache hot.
- **Two-layer / reset-aware retry** — codex (transport vs stream), Actual Claude (foreground vs background + heartbeat), openclaw (terminal vs transient cooldown), opencode (header-aware). Everyone splits retry classes.
- **Rate-limit *window* modelling** — codex and Actual Claude both parse primary+secondary utilization windows with reset timestamps.
- **Verbatim-over-summarized for recall** — mempalace proves it with a benchmark; Actual Claude/opencode/codex all keep recent turns verbatim and only summarize the head.
- **Least-privilege subagent inheritance** — opencode `agent/subagent-permissions.ts`, oh-my-opencode-slim deny-by-default personas. Nested agents should inherit denies, not allows.
- **Structured completion signal + nudge-to-continue** — copilot-sdk (`session.idle` vs `task_complete`), hermes (verify-on-stop), jean (auto-fix synthetic "plan approved"), oh-my-codex run-loop. Two-level "mechanically stopped" vs "semantically done."
- **Idempotent marker-based context-file injection** — oh-my-codex `AGENTS.md` managed-block markers, CodePilot memory vault promotion markers, storybloq dedup markers.

---

## 1. Provider-adapter fidelity (driving Claude / Codex / Copilot precisely)

The exact wire formats, on-disk stores, and control knobs AIO's adapters must match to drive these CLIs losslessly. **Mostly Adapter-side.**

- **`[Actual Claude]` Claude session/transcript JSONL format + resume semantics** — `utils/sessionStorage.ts:198,1039`. JSONL at `~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl`; messages are a `parentUuid` linked list; `logicalParentUuid` marks compact boundaries; subagent transcripts at `<sessionId>/subagents/agent-<id>.jsonl`; metadata re-appended at EOF so `--resume` (reads ~64KB tail) sees it. Needed to read/resume/render Claude sessions. **(S read / M write-match)**
- **`[Actual Claude]` Claude OAuth token store + refresh flow** — `utils/auth.ts:1194`, `services/oauth/client.ts:146`, `constants/oauth.ts:85`. Keychain or `~/.claude/.credentials.json` (0600) `{claudeAiOauth:{accessToken,refreshToken,expiresAt,scopes,subscriptionType,rateLimitTier}}`; refresh POST `platform.claude.com/v1/oauth/token`, PKCE S256, 5-min buffer; **mtime-watch cache invalidation** so a stale token isn't held while the CLI rewrites the file. Lets AIO reuse the user's Max/Pro session with no separate login. **(S read / M share-safely)**
- **`[Actual Claude]` `--print --output-format=stream-json` event contract** — `utils/messages/systemInit.ts:53`, `cli/print.ts:594`. `system/init` line carries `session_id, model, tools[], mcp_servers[], slash_commands[], agents[], skills[], permissionMode, betas[], version`; terminal `result` carries `duration_ms, num_turns, stop_reason, total_cost_usd, usage, modelUsage, permission_denials[]`. stream-json **requires `--verbose`**; the Agent tool emits as legacy `Task`. Exact target for AIO's Claude stream parser + accounting. **(M)**
- **`[codex]` `codex exec --json` JSONL protocol (8 `ThreadEvent` types + `ThreadItem` union)** — `exec/src/exec_events.rs:9`. `thread.started`(resume handle)/`turn.started`/`turn.completed`(usage)/`turn.failed`/`item.started|updated|completed`/`error`; items: `agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `web_search`, `todo_list`, etc. Port to TS discriminated unions. **(S)**
- **`[codex]` item lifecycle / id-reconciliation state machine** — `exec/src/event_processor_with_jsonl_output.rs:314`. `agent_message`/`reasoning` are `item.completed`-only; synthetic `item_N` ids map from raw uuids; unfinished items force-completed at `turn.completed`; `todo_list` synthesized from plan updates; token usage only surfaced on `turn.completed.usage`. Replicate or AIO mis-pairs/double-counts. **(M)**
- **`[codex]` `--output-last-message <file>` deterministic final-answer capture** — `event_processor_with_jsonl_output.rs:374`. Spawn flag + file read beats scraping stdout for "which `agent_message` was final." **(S)**
- **`[codex]` rollout files AIO can tail for full history** — `rollout/src/recorder.rs:750`, `protocol/src/protocol.rs:3325`. `~/.codex/sessions/YYYY/MM/DD/rollout-…-<threadUuid>.jsonl(.zst)`; first line `session_meta` with `forked_from_id`/`parent_thread_id`/`git{...}`; `rollout/src/policy.rs` says what's durable (don't expect exec deltas). A more complete side-channel than stdout. **(S)**
- **`[codex]` config.toml control knobs for headless runs** — `config/src/config_toml.rs:154`. `approval_policy=never` + `sandbox_mode=workspace-write`, `model_reasoning_effort`, `model_auto_compact_token_limit`, and `notify=["<aio-hook>"]` to receive lifecycle events out-of-band. Set any key via `-c dotted.key=value` or the MCP `config` map. **(S)**
- **`[jean]` blocking-tool SIGKILL in headless mode** — `src-tauri/src/chat/claude.rs:1469`. In `--print`, `AskUserQuestion`/`ExitPlanMode` hang forever; jean emits the tool block + synthetic `chat:done`, then `SIGKILL`s and returns the partial so the UI shows the plan/question. The trick that makes a batch CLI interactive. **(M)**
- **`[jean]` bind interactive/PTY resume IDs via session-file snapshot-diff** — `src-tauri/src/chat/native_history.rs:169`. Snapshot native session files before spawn, diff after to find the one new id, refuse to guess if >1 appeared. Solves the fragile "PTY CLI doesn't print its resume id" problem. **(M)**
- **`[jean]` hidden provider-switch handoff injection** — `src-tauri/src/chat/handoff.rs`. On backend/profile change, prepend a bounded `<jean_provider_switch_handoff>` transcript invisibly so the new CLI inherits context. Complements AIO failover. **(M)**
- **`[jean]` per-backend plan/build/yolo → native sandbox/approval mapping** — `chat/claude.rs:492`, `chat/codex.rs:550`, `chat/cursor.rs:1087`. One concept → Claude `--permission-mode` (+`--disallowedTools ExitPlanMode` so build can't re-loop into plan), Codex per-turn `sandboxPolicy.writableRoots`, Cursor `--mode/--sandbox`. Subtle correctness fixes. **(M)**
- **`[jean]` tolerant multi-path JSON field extraction** — `chat/grok.rs:126`, `chat/cursor.rs:166`. `first_string(v, [["session_id"],["sessionId"],["id"],["session","id"]])`; usage falls back `input_tokens`→`inputTokens`. Absorbs cross-version schema drift for near-zero code. **(S)**
- **`[jean]` streaming delta coalescer (30ms window)** — `src-tauri/src/chat/coalesce.rs`. Batches 50–200/sec Codex deltas into one flush per 30ms; must flush before non-chunk events. Cuts IPC/WebSocket cost (matters for AIO mobile-gateway). **(S)**
- **`[t3code]` per-instance capability probe cache keyed by binary+HOME** — `apps/server/src/provider/Drivers/ClaudeDriver.ts:153`. TTL cache keyed on binary path + resolved HOME so two Claude instances with different HOMEs never cross-contaminate auth/account probes. **(S)**
- **`[jean]` Codex app-server: persistent JSON-RPC with steer/interrupt** — `src-tauri/src/chat/codex.rs:427`. One persistent `codex app-server`; `thread/start|resume`, `turn/start`, cancel via `turn/interrupt` (not SIGKILL), mid-turn `turn/steer` with `expectedTurnId`. Lower latency + mid-turn redirection. **(L)**

---

## 2. Engine core — retry, failover, streaming, timeouts

Provider-agnostic robustness for AIO's own request layer. **Engine.**

- **`[codex]` two-layer retry (transport vs stream), separate budgets** — `codex-client/src/retry.rs:23`, `core/src/responses_retry.rs:22`. `request_max_retries=4` (connect) vs `stream_max_retries=5` (mid-stream replay from history). The single most important engine pattern here. **(M)** — ↺ prior: claude_todo #18/codex_todo #19 raised error taxonomy; this adds the retry-loop split.
- **`[codex]` SSE parser state machine with per-event idle timeout + typed terminal errors** — `codex-api/src/sse/responses.rs:491,326`. `timeout(idle_timeout=300s, stream.next())` per event distinguishes "idle hang" from "closed early"; maps `response.failed` → `ContextWindowExceeded|QuotaExceeded|ServerOverloaded|Retryable{delay}|InvalidRequest`; injects rate-limit/model headers as synthetic pre-stream events. **(M)**
- **`[codex]` backoff formula (exp + ±10% jitter, base 200ms)** — `codex-client/src/retry.rs:38`, `core/src/util.rs:85`. Drop-in TS port; jitter avoids thundering-herd when many AIO windows retry together. **(S)**
- **`[codex]` Retry-After from *body* not just headers** — `sse/responses.rs:598`. OpenAI often puts the wait in the message string ("try again in 1.5s"). **Gap it flags:** the transport layer doesn't read the `Retry-After` header at all — AIO should honor both header and body. **(S)**
- **`[codex]` retry config caps + the deliberate `retry_429:false` at transport** — `model-provider-info/src/lib.rs:26,241`. 429s routed through the rate-limit-aware path, not blind backoff. Config-shape reference. **(S)**
- **`[codex]` pause-aware operation timeout (don't count elicitation wait time)** — `rmcp-client/src/rmcp_client.rs:186`. A per-call timeout that *pauses its countdown* while blocked on a human approval, via a watch channel. Fixes "timer fires while waiting on the user." **(M)**
- **`[Actual Claude]` production retry engine: heartbeat-during-backoff, 529 cascade, model fallback** — `services/api/withRetry.ts:52,433`. `500ms·2^(n-1)`+25% jitter cap 32s; foreground-only 529 retry; 3 consecutive 529s → Opus→fallback model; **unattended mode chunks long sleeps into 30s heartbeats emitting `{subtype:"api_retry"}`** so an orchestrator doesn't kill an idle-looking child. Exactly AIO's situation driving long CLIs. **(M)**
- **`[hermes]` centralized API-error taxonomy → recovery-action pipeline** — `agent/error_classifier.py:24,515`. One priority-ordered classifier maps any failure to retry / rotate-credential / fall-back-provider / **compress-context** / abort. **(M)** — ↺ prior: codex_todo #19, claude_todo #18.
- **`[CodePilot]` error classifier with code-first ordered taxonomy + reclassification** — `src/lib/error-classifier.ts:195`. ~20 ordered patterns over `message+stderr+cause`; re-scans stderr after a crash match to reclassify session-state errors so users aren't wrongly told to check their API key; `shouldReportToSentry` is a pure predicate. Data-driven drop-in across 5 CLIs. **(S)**
- **`[CodePilot]` native timeout controller: phase-anchored reason codes + `guardStream`** — `src/lib/native-timeout.ts:174`. Distinct `connect`/`first-token`/`tool-execution`(per-toolCallId)/`total-run` budgets; the fired reason comes from the budget (never regex-inferred); `guardStream` races `it.next()` against a rejection so an abort-swallowing tool can't wedge the stream forever. **(M)**
- **`[openclaw]` terminal-vs-transient failure cooldown in a background queue** — `src/commitments/runtime.ts:177,298`. Terminal errors (missing key, unknown model, `invalid_grant`) drop that agent's queued work + open a 15-min cooldown; transient errors restore the batch to the front *in order*. Applies to failover and any AIO background job (GRPO, memory writes). **(S)**
- **`[hermes]` bounded read of streaming error bodies** — `agent/bounded_response.py`. On a non-OK *streaming* response, read the error body under both a byte cap and a wall-clock deadline (accounting for `iter_bytes()` blocking) so a stalled proxy can't hang/balloon the agent. **(S)**
- **`[opencode]` header-aware retry with structured retryable classification** — `session/retry.ts:35,68,176`. Honors `retry-after-ms`/`retry-after` (secs or HTTP-date) before exp backoff; always retries 5xx even if the SDK says non-retryable; never retries context-overflow. **(S)**

---

## 3. Context & compaction

**Engine.** AIO's compaction is already mature (↺ prior: claude_todo "Already strong" notes `context-compactor.ts`, `microcompact.ts`), so these are *specific upgrades*.

- **`[Actual Claude]` auto-compaction thresholds + microcompaction (tool-result eviction)** — `services/compact/autoCompact.ts:30`, `microCompact.ts:253`, `prompt.ts:24`. Auto-compact at `effectiveWindow−13k` (`effectiveWindow=ctx−min(maxOutput,20k)`), hard block at `ctx−3k`, circuit-breaker after 3 failures; microcompact replaces old tool-result bodies with `"[Old tool result content cleared]"` for a Read/Bash/Grep/Glob/Web/Edit/Write whitelist, clears >2000-token images, preserves the cache prefix via `cache_edits`; fixed 8-section summary prompt. **(M/L)**
- **`[opencode]` turn-aware compaction: token-budgeted tail + tool-output pruning + overflow media-strip + auto-continue** — `session/compaction.ts:105,243,310`. Preserves last N *turns* up to a token budget (splitting a turn mid-way), summarizes the head, blanks stale tool outputs beyond a protected window, strips media on overflow, and auto-replays the last real user message so work continues. **(M)**
- **`[codex]` `BodyAfterPrefix` compaction budget scope** — `core/src/session/context_window.rs:24`. Measure tokens added *after* the cached prefix (`active − prefill_baseline`), not total, so a big static system prompt doesn't trigger premature compaction and the prefix stays cache-hot. Default auto-compact = 90% of window. **(M)**
- **`[codex]` "manual/inline" compaction that skips model summarization** — `core/src/compact_token_budget.rs:25`. A cheap "install a fresh window" reset that still emits the same `ContextCompaction` item + runs pre/post hooks, so one lifecycle covers both summarizing and non-summarizing resets. **(S)**
- **`[hermes]` compaction prompt-engineering: Resolved/Pending tracking + "Historical" reference-only headings** — `agent/context_compressor.py:38,1696`. Renames "Next Steps/Remaining Work" to "## Historical Remaining Work" and frames prior turns as source material so the model doesn't re-execute a summary as fresh instructions; protects head+tail by token budget. Cheap fix for a real failure mode. **(M)**
- **`[opencode]` + `[hermes]` JIT subdirectory-instruction injection via tool-result append** — opencode `session/instruction.ts:179` + `tool/read.ts:300`; hermes `agent/subdirectory_hints.py:76`. On file read, walk up to the nearest not-yet-loaded `AGENTS.md`/`CLAUDE.md`/`.cursorrules` and append it once as a `<system-reminder>` in the read output — keeps monorepo-local conventions out of the base prompt *and* preserves the prompt cache. **(S/M)**
- **`[hermes]` Anthropic prompt-cache layout as pure functions** — `agent/prompt_caching.py`. Documented "system_and_3" layout (4 `cache_control` breakpoints: system + last 3 non-system msgs), handling native-Anthropic vs OpenAI-shaped tool messages; claimed ~75% input-token cut. Drop-in if AIO's caching is ad-hoc. **(S)**
- **`[opencode]` truncate-to-file with delegate-to-subagent hint** — `tool/truncate.ts:85`. Oversized tool output written to a scratch dir + replaced with a preview + a hint telling the model to `grep`/`Read` the file (or delegate to an explore subagent to save context); 7-day expiry. **(S)** — ↺ prior: codex_todo #32 (output compression + raw tee).
- **`[mempalace]` token-budgeted JIT wake-up stack (L0 identity + L1 essential-story always-on)** — `mempalace/layers.py`. 4-tier hard budget: L0 identity ~100 tok always, L1 auto-generated essential story ~500–800 tok, L2/L3 on demand; wake-up ~600–900 tok leaves 95% of context free. A compact deterministic-cost session-priming header. **(S/M)**

---

## 4. Memory & retrieval

**Engine.** AIO has episodic/procedural/semantic memory + RLM; these sharpen *retrieval quality, governance, and evaluation*.

- **`[mempalace]` summary-is-a-ranking-signal-never-a-gate + ordinal rank-boost** — `mempalace/searcher.py:1108`. Verbatim search is the unconditional floor; the compressed index only *boosts* by ordinal rank buckets `[0.40,0.25,0.15,0.08,0.04]` (ordinal beats absolute distance on narrative text), capped by a distance threshold. **(M)**
- **`[mempalace]` reproducible LongMemEval retrieval eval harness** — `benchmarks/longmemeval_bench.py`. Fresh ephemeral store per question, Recall@k / NDCG@k at session+turn granularity, per-type breakdown, swappable embeddings, self-contained metrics. The regression harness AIO lacks. **(M)**
- **`[mempalace]` hybrid BM25+vector rerank with *absolute* vector similarity** — `searcher.py:75`. `0.6·vec_sim + 0.4·bm25`; BM25 min-max normalized within the candidate set; vector sim absolute so adding/removing a candidate can't reshuffle order; over-fetch `n×3`. **(S/M)**
- **`[mempalace]` chunk-boundary repair via keyword-best-chunk + ±1 neighbor hydration** — `searcher.py:288,1222`. When a source is boosted, re-scan its chunks by keyword overlap, return the best + neighbors stitched in order, scoped by parent id, capped 10k chars. Fixes "answer is in the next chunk" with no re-chunking. **(M)**
- **`[mempalace]` corruption-proof BM25 fallback over SQLite FTS5** — `searcher.py:483`. If the vector index is diverged/unloadable, run BM25 directly over Chroma's FTS5 index with graded fallbacks. AIO is better-sqlite3 — FTS5 is native. **(M)** — ↺ prior: codex_todo #31 (FTS session search).
- **`[OB1]` provenance + DB-enforced "can-use-as-instruction" gate** — `schemas/agent-memory/schema.sql:22,90`. Every memory carries `provenance_status`, `review_status`, `confidence`, `can_use_as_instruction`/`can_use_as_evidence`; a CHECK constraint makes it *physically impossible* to mark a memory actionable unless `user_confirmed`/`imported`. Prevents acting on self-generated/hallucinated memory. **(M/L)**
- **`[OB1]` recall traces as an audit + RLM reward feed** — `schemas/agent-memory/schema.sql:181`. Logs each recall's query, ranked candidates with scores, and whether each was returned/used/ignored (+reason). Exactly the labeled signal AIO's RLM needs to become a trainable loop. **(M)**
- **`[OB1]` tunable recency-decay blend with pre-blend threshold guard** — `schemas/recency-boosted-match-thoughts/schema.sql`. `score = sim·(1−w) + exp(−age/half_life)·w`, but the relevance threshold gates on *raw* cosine before the blend so recency can't surface irrelevant-but-recent items; `w=0` = backward-compatible. **(S)**
- **`[CodePilot]` "memory vault": markdown three-tier memory + auto-extraction + check-in promotion + decay-ranked MCP retrieval** — `src/lib/assistant-workspace.ts`, `memory-extractor.ts:80`, `checkin-processor.ts:113`, `memory-search-mcp.ts:19`. Episodic daily → promoted long-term → identity profile; a cheap model auto-extracts durable facts every 3 turns (skipping turns where the agent already wrote memory); a daily check-in promotes only stable facts; retrieval is via an always-registered MCP tool with 30-day half-life decay — **not stuffed into the prompt** (only identity is always-on). **(L; pieces are S–M)**
- **`[hermes]` Honcho dialectic user-modeling as a swappable MemoryProvider** — `plugins/memory/honcho/__init__.py` (+ 7 sibling backends). Cross-session "who is this user" theory-of-mind memory (distinct from task/episodic), behind a clean provider interface with 8 interchangeable backends. Genuine gap for AIO. **(M)**
- **`[storybloq]` git-aware session recap = structured diff since last snapshot** — `src/core/snapshot.ts:252`. Snapshot captures project state + git HEAD SHA; next session computes a semantic diff (tickets/blockers/phases/lessons) and detects whether the snapshot is `behind`/`diverged` from current HEAD → surfaces "what changed since you last worked here" and catches stale checkpoints. **(M)**
- **`[storybloq]` field-level structured-JSON merge for cross-agent memory** — `src/core/merge-driver.ts`. A git merge driver does per-record three-way merge: independent fields both land; a diverged field becomes a structured `_conflicts` block (valid JSON, no text markers) that write-blocks until resolved. Beats last-writer-wins for cross-tool sharing. **(L)**
- **`[storybloq]` reinforcement-count ranking + supersede chains for procedural memory** — `src/core/lessons.ts`. Lessons rank by a `reinforcements` counter (re-observed → ×N), not recency; `supersedes` retires stale ones. Promotes repeatedly-validated knowledge over one-offs. **(S)**
- **`[mempalace]` (evidence) verbatim raw *beat* summarized on recall** — `benchmarks/README.md` (raw 96.6% vs `aaak` 84.2% vs `rooms` 89.4% R@5). Design principle for AIO's compaction: keep verbatim as the retrieval floor, treat compaction strictly as a pointer index. **(S — principle)**

---

## 5. Orchestration, loops & autonomy

**Engine.** AIO's loop mode is (per project memory) an "island" reusing none of the app's context/memory/feedback subsystems — this section is the richest vein for fixing that.

### Self-orchestration & agent-initiated fan-out
- **`[jean]` self-orchestration MCP server (agent drives the app)** — `src-tauri/src/jean_mcp_core.rs:130,290`, `chat/jean_mcp.rs:19`. Installs *its own* MCP server (`create_worktree`, `create_session`, `send_chat_message` fire-and-forget, `get_session_status`, `get_worktree_diff`) into each child CLI's config, with a Unix-socket + auth token + `JEAN_MCP_DEPTH` recursion guard + per-tool rate limiting. **(L)**
- **`[opencode]` background/resumable subagents with completion notify-and-inject** — `tool/task.ts:47,202,303`. Task tool can run a subagent in the background (returns immediately; result injected later as a synthetic `<task>` message), resume by `task_id`, and its prompt *forbids polling/sleeping* while it runs. **(M)**
- **`[opencode]` subagent least-privilege permission derivation** — `agent/subagent-permissions.ts:14`. A spawned subagent inherits only the parent's *deny* + `external_directory` rules (not allows), and auto-denies `todowrite`/`task` unless explicitly granted → no privilege escalation / infinite nesting. **(S)**
- **`[hermes]` iteration budget with refund + independent subagent budgets** — `agent/iteration_budget.py`. Parent capped at 90; each subagent gets its own 50; `execute_code` iterations refunded so programmatic calls don't starve the parent. **(S)**

### Autonomous loops & completion discipline
- **`[hermes]` verify-on-stop guard + passive evidence ledger** — `agent/verification_stop.py:245`, `verification_evidence.py`. Records which verify commands actually ran/passed; if the model tries to finish right after a code edit with no fresh evidence, injects a follow-up naming the detected verify commands; suppresses on doc/markdown-only edits. Mechanically enforces AIO's own completion standard. **(M)**
- **`[hermes]` background review fork — post-turn self-improvement off the main context** — `agent/background_review.py`. A daemon thread forks the agent on a conversation snapshot, asks "save/update any skill or memory?", inherits live creds so it hits the same prefix cache, runs under a memory/skill-only whitelist; main context + cache never mutated. **(M)**
- **`[copilot-sdk]` `session.idle` vs `task_complete` + autopilot completion nudge** — `docs/features/agent-loop.md:1403`. Two-level signal: mechanical loop-end vs semantic done (persisted, carries `summary`); if the model didn't call `task_complete`, inject a synthetic "you haven't marked complete… keep working" message with premature-completion guards. **(S/M)**
- **`[oh-my-codex]` generic outcome-classified run loop** — `src/runtime/run-loop.ts:56`, `run-outcome.ts`. Reusable `runUntilTerminal(step,{maxIterations})` that normalizes each iteration into a typed `RunOutcome`, detects terminal states, returns full history. A clean testable loop core for AIO's island loop. **(S)**
- **`[jean]` autonomous auto-fix loop: plan → auto-approve → yolo** — `src-tauri/src/auto_fix/scheduler.rs:179,533`. 10s tick lists open issues (label filters), worktree per issue up to `max_parallel`, headless plan run; a 2s watcher polls for `waitingForInputType=="plan"`, auto-approves, flips to yolo with a synthetic approval message; self-heals; **auto-disables the project on quota/auth errors**; `AtomicU8` idle-gate makes disabled ticks near-free. **(L)**

### Cheap pre-routing (avoid over-orchestration)
- **`[oh-my-codex]` advisory 3-lane prompt-triage router** — `src/hooks/triage-heuristic.ts:236`, `keyword-registry.ts:8`. Pure synchronous classifier sorts a prompt into PASS/LIGHT(single-agent)/HEAVY(autopilot) via ordered regex, errs toward the safer HEAVY path. Auto-picks "one CLI vs full debate/supervisor tree" with no model call. **(S)**
- **`[oh-my-codex]` task-size gate with escape-hatch prefixes** — `src/hooks/task-size-detector.ts:153`. Small/medium/large from word count + regex; honors `quick:`/`simple:`/`just:` overrides; `isHeavyMode()` suppresses ralph/team/swarm on one-file edits. One-file guard against spinning supervisor trees on a typo. **(S)**
- **`[oh-my-opencode-slim]` auto-delegation as a prompt-embedded routing table (no classifier)** — `src/agents/orchestrator.ts:30`. Per-persona `Lane / Permissions / Stats / Delegate when / Don't delegate when / Rule of thumb` blocks with quantified relative cost/speed/quality ("explorer 2× faster, ½ cost") the routing model reasons over. **(S)**

### Proactive assistant behaviours (openclaw's differentiated cluster)
- **`[openclaw]` commitments engine — inferred proactive follow-ups** — `src/commitments/extraction.ts:212`, `runtime.ts:124`, `store.ts:440`. A hidden post-turn classifier extracts *implicit* future check-ins (`event_check_in`/`deadline_check`/`care_check_in`/`open_loop`) with confidence + ISO due-window + stable `dedupeKey`; deduped, 72h-expired, rate-limited, surfaced later via heartbeat; care check-ins need higher confidence + gentle phrasing; explicit "remind me" excluded (that's cron). The most differentiated subsystem found. **(L)**
- **`[openclaw]` heartbeat: wake-and-decide-whether-to-interrupt** — `src/auto-reply/heartbeat.ts:14`. A periodic agent turn reads a workspace `HEARTBEAT.md`; reports via a tool whose **default is silence** — only `notify=true` interrupts the user; empty file skips the API call. Exactly the "should I bother the user" discipline AIO's loop lacks. **(M)**
- **`[openclaw]` TaskFlow: durable flows that wait on external events and resume** — `src/tasks/task-flow-*.ts`. Flows persist `stateJson` + a `waitJson` blocker (`{kind:"reply",channel,threadKey}`), move to `waiting`, and resume when an outside reply/task completes. "Pause a multi-step flow on a human/event, then resume." **(L)**
- **`[jean]` `ScheduleWakeup` — an agent schedules its own delayed follow-up prompt** — `src-tauri/src/chat/wakeup.rs`. Self-paced re-entry for long-horizon tasks. **(S)**

### CI / review / PR feedback loops (agent-orchestrator's specialty)
- **`[agent-orchestrator]` multi-condition PR feedback reducer with persistent capped dedup** — `backend/internal/lifecycle/reactions.go:134,606`. One PR can trip failing-CI + unresolved-review + merge-conflict at once; queues one nudge per condition, self-dedups on a content signature, caps attempts, persists dedup state so a restart doesn't re-nudge; Send→memory→persist order degrades to one extra nudge, never a lost one. **(M)**
- **`[agent-orchestrator]` CI-failure → agent with fetched, sanitized log tails** — `observe/scm/observer.go:865` → `reactions.go:170`. Lazily fetches the failing check's log *tail* (reusing stored tails if the CI fingerprint is unchanged), injects "CI failing on PR #… push a fix" + the sanitized output into the agent's pane. The missing last mile of a CI→agent loop. **(M)**
- **`[agent-orchestrator]` semantic-hash observation diffing + lifecycle-ack cursor** — `observer.go:1009,1297,352`. Three semantic hashes per PR (metadata/CI/review); reacts only on real change; holds changed hashes at their local value until lifecycle succeeds so a crash re-delivers (hash = acknowledgement cursor). Crash-safe redelivery without a queue. **(M)**
- **`[agent-orchestrator]` authoritative agent activity-state via installed CLI hooks** — `adapters/agent/activitystate/activitystate.go`, `hooksjson/hooksjson.go`. ~30 adapters install session-start/prompt-submit/stop/permission hooks into each CLI's own config; callbacks report `active|idle|waiting_input|exited`; `waiting_input` is sticky; installer merges into matcher groups preserving user hooks, atomically. Authoritative vs transcript-inference. **(L, high value)**
- **`[agent-orchestrator]` internal AI reviewer reusing the worker's own worktree, one reused pane per worker** — `review/review.go:119,153`, `launcher.go:47`. Reviewer runs in the *worker's* worktree (a fresh one lacks the PR changes), reuses one stable pane per worker, serializes triggers, batches PRs, supersedes stale runs per (PR, head SHA), records verdict via CLI stdin not files. Cleaner than AIO's ping-pong for a live-PR reviewer. **(M)** — ↺ prior: pingpong review exists.
- **`[agent-orchestrator]` tracker issue intake → auto-spawn one worker per issue** — `observe/trackerintake/observer.go:115`. Opt-in sweep of GitHub/Linear for open issues matching an assignee filter; one worker per issue with a generated prompt; dedups by canonical id; per-project failure backoff; truncates the body to the prompt budget. **(M)**
- **`[agent-orchestrator]` branch-namespace PR attribution + stacked-PR conflict suppression** — `observer.go:793`, `reactions.go:286`. A session owns `ao/<session>/…`; longest-prefix match attributes stacked PRs to it; merge-conflict nudges fire only on the bottom of a stack. **(M)**
- **`[agent-orchestrator]` liveness reaper reports facts, never verdicts** — `observe/reaper/reaper.go`. A prober emits a *probe-failure fact*; the lifecycle manager decides what it means, so a transient error can't false-kill a session. Small discipline, prevents a nasty false-termination class. **(S)**
- **`[t3code]` `ProviderSessionReaper` — idle-session GC that respects active turns** — `apps/server/src/provider/Layers/ProviderSessionReaper.ts:36`. Stops sessions idle >30min but skips any thread with an `activeTurnId`. Drop-in for AIO's accumulating idle CLI subprocesses. **(S)**
- **`[nanoclaw]` heartbeat-file liveness + host-sweep supervision (not wall-clock timeouts)** — `src/host-sweep.ts:83`. 60s sweep judges liveness from `/workspace/.heartbeat` mtime; kill ceiling `max(30min, declared Bash timeout)` **extends** when the agent declared a long command, so long compiles aren't killed; grace window for fresh containers; backoff + dead-letter at 5 tries. Fixes "killed my legitimate long build." **(M)**

### Structured output & multi-agent
- **`[opencode]` structured output via a forced synthetic tool** — `session/prompt.ts:1565`. Inject a `StructuredOutput` tool whose schema = the requested schema, set `toolChoice:required`, error if the model finishes without calling it. Provider-agnostic schema-valid results without native JSON mode. **(S)**
- **`[hermes]` trajectory compressor for training-data generation** — `trajectory_compressor.py`, `batch_runner.py`. Post-processes completed JSONL trajectories to a token budget while preserving training signal (protect first + last N turns, compress the middle into one synthetic summary). AIO does GRPO but has no trajectory pipeline. **(M)**

---

## 6. Sandboxing & security

**Engine + Adapter.** AIO has secret-detection/redaction/path-validation but no OS-level jail or container mode. codex ships copy-pasteable recipes.

- **`[codex]` sandbox-denial detection heuristic (stderr keyword + exit-code sniff)** — `sandboxing/src/denial.rs:6`. Classifies a non-zero exit as sandbox-denial vs normal failure (7 keywords, fast-reject 2/126/127, `128+SIGSYS` on Linux). Portable TS table; lets AIO offer escalation vs report failure for *any* jailed CLI. **(S)**
- **`[codex]` sandbox-then-escalate orchestration loop** — `core/src/tools/orchestrator.rs:286`, `sandboxing.rs:370`. Run sandboxed → on `Denied`, decide from approval policy + per-tool `escalate_on_failure` whether to prompt and re-run unsandboxed. The core control-flow AIO's engine should adopt. **(M)** — ↺ prior: codex_todo #24 (hardened worker isolation).
- **`[codex]` ready-made macOS Seatbelt jail (ship these files verbatim)** — `sandboxing/src/seatbelt_base_policy.sbpl`, `seatbelt_network_policy.sbpl`, `restricted_read_only_platform_defaults.sbpl`; composition at `seatbelt.rs:623`. `deny default` + curated allowlist with hard-won PTY/Python/PyTorch carve-outs; pass writable roots as `-D<KEY>=<path>` params (avoids string-injecting paths); hardcoded absolute `sandbox-exec`. **(S copy / M wire)**
- **`[codex]` Linux seccomp network filter (restricted vs proxy-routed) + bubblewrap fs-jail mount ordering** — `linux-sandbox/src/landlock.rs:169,351`, `bwrap.rs:264`. Two seccomp modes (deny all sockets except `AF_UNIX` / allow only inet-to-local-proxy), keeping `recvfrom` for clippy's socketpair IPC; the order-sensitive bwrap recipe (protected subpaths re-bound *after* the writable root). **(M)**
- **`[codex]` Starlark-style exec-policy: prefix rules → Allow/Prompt/Forbidden, most-restrictive-wins** — `execpolicy/src/{decision,rule,policy}.rs`. Rules keyed on argv[0] match a leading token sequence (with per-token alternatives); `Evaluation` takes the max (most restrictive) across matches; self-validating `match`/`not_match` examples. Adopt the model in TS (no need to embed Starlark). **(M)** — ↺ prior: permission-manager.ts already opencode-inspired.
- **`[codex]` unmatched-command decision matrix + "restricted sandbox ⇒ don't prompt"** — `core/src/exec_policy.rs:634`. Decides Allow/Prompt/Forbidden from safelist/dangerous × approval-policy × sandbox-kind; the central UX insight is that a non-dangerous unmatched command in a restricted sandbox runs silently rather than nagging. Stops prompting on every `ls`. **(M)**
- **`[codex]` escalating exec-policy amendments ("always allow this prefix") + banned-prefix guard** — `core/src/exec_policy.rs:806`. On a prompt, propose a `prefix_rule` the user can accept → persisted to `.rules`, hot-swapped via `ArcSwap`; a `BANNED_PREFIX_SUGGESTIONS` list *refuses* to ever blanket-allow `bash`/`sudo`/`python`/`node -e`. The "don't ask again" flow done safely. **(M)**
- **`[codex]` protected workspace-metadata carve-outs (`.git`/`.agents`/`.codex` stay RO inside writable roots)** — `protocol/src/permissions.rs:23,1593`. Even in a writable workspace, these are injected read-only (resolving `.git`-as-file-pointer for worktrees/submodules, and protecting `.codex` before it exists). Must-have when giving an agent repo write access. **(S concept / M full)**
- **`[codex]` permission-profile intersect/merge algebra (grants can only narrow)** — `sandboxing/src/policy_transforms.rs:125`. Merge unions, intersect clamps a grant to what was requested (never widens, retains denies). The security-sound way to layer session-defaults + per-turn request + user grant. **(L)**
- **`[nanoclaw]` container egress lockdown (Docker `--internal` net + forced proxy hop, fail-closed)** — `src/egress-lockdown.ts:62`, `container-runner.ts:454`. Agents attach only to an internal net; sole reachable host is the credential gateway; non-root/no `NET_ADMIN` so routing can't be undone; spawn aborts if the net can't be established. Kernel-enforced secret containment. **(M)**
- **`[nanoclaw]` external mount allowlist with symlink resolution + denylist + RO fallback** — `src/modules/mount-security/index.ts:280`. Allowlist stored *outside* the project root (agent can't edit its own policy); `realpathSync` before checks (defeats symlink escape); rejects `..`/absolute/`:` (Docker `-v` injection); denylists `.ssh/.aws/.env/id_rsa`; RO unless both sides opt into RW; missing allowlist fails closed. Liftable module. **(S/M)**
- **`[nanoclaw]` cheap container hardening AIO would add on top** — `container-runner.ts:438`. nanoclaw omits `--cap-drop`, `--security-opt=no-new-privileges`, seccomp, `--pids-limit`, RO rootfs — near-zero-cost wins; `--label <install-slug>` lets orphan cleanup reap only its own containers. **(S)**
- **`[openclaw]` node-host exec authorization policy** — `src/node-host/exec-policy.ts:54`, `invoke.ts:227`. Closed decision (`deny`/`approval-required`/`allowlist-miss`); blocks `sh -c`/`cmd.exe /c` unless approved; durable `allow-once`/`allow-always`; `sanitizeEnv` blocks PATH-override injection; redacts approvals in snapshots. Stronger than allow/deny for AIO's remote-node exec. **(M)**
- **`[openclaw]` security self-audit ("doctor" for your own exposure)** — `src/security/audit.deep.runtime.ts` + `audit-gateway-exposure`/`audit-plugins-trust`/`audit-channel-dm-policy`. Scans the app's *own* config for gateway-exposed-without-auth, untrusted plugins, DM/allowlist gaps. AIO has redaction but no "audit my current config." **(M/L — start with gateway-exposure + plugin-trust)**
- **`[agent-orchestrator]` control-char sanitization before PTY injection** — `reactions.go:180` + `domain.SanitizeControlChars`. PR titles/comments/CI output are attacker-influenced and get pasted into a live terminal; sanitize escape chars on the inject path (dedup signature computed on raw bytes). A distinct vector from secret-redaction. **(S)**
- **`[agent-orchestrator]` tmux literal message injection (`send-keys -l` + chunked UTF-8, separate Enter)** — `adapters/runtime/tmux/commands.go:54`. `-l` stops tmux interpreting a word like "Enter" as a key; chunk on UTF-8 boundaries; submit as a distinct `send-keys Enter`. The exact bugs AIO hits injecting into a running PTY. **(S)**
- **`[CodePilot]` auto-redacted diagnostics: HMR-surviving console ring buffer + dual value+key sanitizer** — `src/lib/runtime-log.ts:40`, `api/doctor/export/route.ts:23`. 200-entry ring buffer on `globalThis`; `scrubMessage` redacts `sk-`/`Bearer`/hex + rewrites `$HOME`→`~`; export deep-walks redacting by both value-shape *and* key-name with a vendor-host allowlist. Safe-to-paste "copy diagnostics." **(S)**
- **`[CodePilot]` safe tool-batch parallelization + bash risk tiers** — `src/lib/parallel-safety.ts:234`, `bash-validator.ts:31`. Default-serial, opt-in-parallel (singleton→serial, path-overlap→serial, non-read-only→serial); bash classified danger/caution/safe (`rm -rf`, `sudo`, `git push --force`, `curl|bash`). Latency win + auto-approve policy input. **(S/M)**

---

## 7. Token & cost reduction

**Engine.** AIO tracks tokens/cost heavily but has no generic output compressor. rtk is the key target.

- **`[rtk]` TOML output-compression DSL (8-stage pipeline, ~90 filters, data-only)** — `src/core/toml_filter.rs`, `src/filters/*.toml`. `strip_ansi → regex replace → match_output short-circuit → strip/keep lines → truncate width → head/tail → max_lines → on_empty`, first-match-wins across project/user/built-in. Adding a tool's compression is a TOML file with inline tests. **(M)** — ↺ prior: codex_todo #32.
- **`[rtk]` "never-worse" output guard** — `src/core/guard.rs:6`. Compare compressed vs raw by estimated tokens (`len/4`); emit raw if the filter made it bigger. One function that makes *any* AIO compaction/summarization step strictly non-harmful. **(S)**
- **`[rtk]` transparent command-rewrite hook (interception model)** — `src/hooks/rewrite_cmd.rs:18`, `init.rs`. A `PreToolUse` hook shells to `rtk rewrite "<cmd>"` returning an optimized equivalent + a permission verdict (exit 0/1/2/3); refuses to rewrite commands with shell substitution/redirects. AIO already has hooks + drives these CLIs. **(M, S if just the pattern)**
- **`[rtk]` compressed grep/read primitives** — `src/cmds/system/search.rs`, `read.rs`, `src/core/filter.rs:37`. `rtk grep` preserves `file:line:content` but groups by file + caps; `rtk read` strips comments/boilerplate by detected language; shared cap constants in `truncate.rs`. **(M)**
- **`[rtk]` "discover" — mine session history to quantify token-saving opportunities** — `src/discover/mod.rs`. Classifies commands from session logs, buckets by rtk-equivalent, computes weighted savings-rate to prioritize which filters to build. Pairs with AIO's usage tracking. **(M)**
- **`[codex]` + `[copilot-sdk]` token-usage schema that breaks out cached-input + reasoning-output** — codex `core/src/client.rs:1992`, copilot-sdk `assistant.usage` in `session-events.ts:3889`. `{input, output, cached_input, reasoning_output, total}` (+ `cost`, `providerCallId`, `quotaSnapshots`, `parentToolCallId` for sub-agent attribution). The two fields most cost models forget. **(S)**

---

## 8. Permissions & approval UX

- **`[copilot-sdk]` granular session-scoped permission union** — `nodejs/src/generated/rpc.ts:8040`, `session.ts:499`. `approve-once` / `approve-for-session{commands[ids], read, write, mcp{server,tool}, memory}` / `approve-for-location` / `approve-permanently` / `reject{feedback, forceReject}` / `resolvedByHook` short-circuit. Far past allow/deny. **(M)** — ↺ prior: codex_todo #48 (unify approval policy).
- **`[opencode]` last-match-wins wildcard permission engine + "approve-always auto-clears matching pending"** — `permission/evaluate.ts:28`, `index.ts:67`. On an "always" reply, append the rule then auto-resolve every other pending request the new rule now permits. **(M)** — ↺ prior: permission-manager.ts already opencode-inspired; the auto-clear behaviour is the new bit.
- **`[opencode]` bash-command "arity" prefix extraction for stable permission rules** — `permission/arity.ts:1` + the generated `ARITY` table. Reduces `git checkout main` → `git checkout`, ignoring flags, via a curated ~150-tool dictionary (the copy-pasteable hard part). **(S)**
- **`[CodePilot]` phone permission broker (mid-stream request → IM inline buttons → answer routed back)** — `src/lib/bridge/permission-broker.ts:134,380`. Forwards a mid-stream `permission_request` as Allow/Allow-Session/Deny buttons (`perm:<action>:<permId>`); binds permId→chat+message; atomic check-and-set defeats double-taps; resolves via the *same* registry the desktop UI uses. Real "approve a tool call from your phone." **(M)**
- **`[t3code]` structured user-input requests (beyond yes/no)** — `packages/contracts/src/providerRuntime.ts:441`; adapter `CursorAcpExtension.ts`. A canonical channel for a provider to ask a structured multiple-choice question mid-turn, typed answers routed back. Cursor already emits these. **(M)**
- **`[openclaw]` per-conversation runtime control commands** — `src/auto-reply/send-policy.ts:23`, `group-activation.ts:20`. Inline `/send allow|deny|inherit` and `/activation mention|always` toggle per-conversation whether the assistant may send unprompted / activates on every message. Cheap "quiet/active" UX. **(S)**

---

## 9. UI / UX & product surfaces

- **`[CodePilot]` generative-UI widgets via a `show-widget` code-fence + sandboxed iframe** — `src/lib/widget-guidelines.ts:49`, `widget-sanitizer.ts:87`, `inline-html-csp.ts:38`, `widget-css-bridge.ts:11`. Model emits a markdown fence (streams as text → works on any CLI), rendered into a `sandbox="allow-scripts"` iframe via two-phase `widget:update`(innerHTML)→`widget:finalize`(re-insert scripts); CSP `connect-src 'none'` blocks exfiltration; app theme tokens injected with a MutationObserver. **(L; M for a minimal port)**
- **`[CodePilot]` Dashboard MCP — pin generated widgets into a living, refreshable dashboard** — `src/lib/dashboard-mcp.ts:42`, `dashboard-store.ts`. 5 MCP tools (`pin/list/refresh/update/remove`) persist a widget with a NL `dataContract` + typed `dataSource` (glob/mcp_tool/cli); `refresh` re-reads the source and regenerates HTML preserving design; read tools auto-approve, mutating tools need approval (split into two MCP servers). **(M, depends on widgets)**
- **`[CodePilot]` file-state checkpoint rewind that preserves pre-session uncommitted edits** — `src/lib/file-checkpoint.ts:41`, `tools/write.ts:31`. Per-user-turn snapshot stack (max 20) of each touched file's bytes; rewind restores the earliest snapshot per file (or deletes newly-created files); **never `git checkout`**, so the user's own dirty tree survives. Message-granular undo vs AIO's whole-tree worktree isolation. **(M)** — ↺ prior: git-checkpoint-store shadow mode exists.
- **`[CodePilot]` markdown → channel-agnostic IR → per-channel renderer with render-first chunking** — `src/lib/bridge/markdown/ir.ts:45`, `render.ts:48`, `telegram.ts:299`. One parse → IR of text + offset-span styles/links; each channel supplies a marker map + escaper; chunking renders to HTML and *re-splits if the rendered HTML overflows* the platform limit so markup never spans a boundary unclosed. Robust for richer phone/IM output. **(M)**
- **`[Actual Claude]` native-ts dependency-free perf ports** — `native-ts/file-index/index.ts` (fzf-v2-style fuzzy file ranker: boundary/camel/consecutive bonuses, gap penalties, 1.05× test-path penalty, 4ms time-sliced yielding), `color-diff/index.ts` (lazy-load highlight.js + `diff` to dodge a ~50MB/190-grammar startup hit), `yoga-layout/index.ts` (single-pass flexbox subset, no WASM). Drop-in file-picker ranker + Electron perf patterns. **(S–M each)**
- **`[oh-my-codex]` tmux sidecar HUD — push monitoring OUT of the model's context** — `src/sidecar/index.ts`, `tmux.ts`, `render.ts`. Renders live team/run status into a separate tmux pane (or `--json` snapshot) on an interval, keeping status formatting/notification tokens off the model's context. **(S/M)**
- **`[CodePilot]` skills.sh marketplace: streamed install + lock-file "installed" reconciliation** — `src/app/api/skills/marketplace/{search,install}/route.ts`, `src/lib/skills-lock.ts`. Search proxies `skills.sh/api/search`; install shells `npx skills add … -g` piping stdout to the browser as an SSE live log; `~/.agents/.skill-lock.json` stamps `isInstalled`. Discover→one-command-install onboarding. **(M)**

---

## 10. Packaging & distribution (AIO's better-sqlite3 / Electron pain)

**↺ prior:** claude_todo #9 raised auto-update/distribution; these are the concrete recipes.

- **`[CodexDesktop-Rebuild]` ASAR integrity hash re-patching after modifying app.asar** — `scripts/build-from-upstream.js:255`. Modern Electron validates an embedded ASAR header SHA256 at runtime; any post-build asar change → fatal launch error. Recompute + rewrite: macOS `plutil -replace ElectronAsarIntegrity` in Info.plist, Windows byte-patch the exe. Essential if AIO repacks after native-module fixups. **(M)**
- **`[CodexDesktop-Rebuild]` native-module cross-platform sync driven by upstream list + electron-rebuild** — `scripts/sync-native-modules.js`. Only unbundleable native modules ship in `node_modules/`; pipeline `prepare-src → electron-rebuild → sync-native-modules → forge make`; sync prefers the freshly-rebuilt `.node`, falls back to pure-JS, skips platform-only modules. Blueprint for right-arch better-sqlite3. **(M)**
- **`[CodexDesktop-Rebuild]` ASAR unpack glob for native binaries + Electron Fuses** — `forge.config.js:18,81`. Copy-ready `{**/*.node,**/node-pty/build/Release/spawn-helper,**/node-pty/prebuilds/*/spawn-helper}` + a fuse set; when shipping a pre-patched asar, set `EnableEmbeddedAsarIntegrityValidation:false` + `OnlyLoadAppFromAsar:false` and avoid `plugin-auto-unpack-natives`. **(S)**
- **`[CodexDesktop-Rebuild]` macOS signing/notarization env-gating + ad-hoc re-sign fallback** — `forge.config.js:42`, `build-from-upstream.js:159`. Env-gated `osxSign/osxNotarize` (unsigned local vs signed CI, skippable); the standard strip-signature → remove-quarantine → `codesign --sign - --force --deep` cure for a modified `.app`. (Their CI wires no signing secrets — a gap to fill, not copy.) **(S / M for CI secrets)**

---

## 11. Extensibility (plugins, skills, catalogs, sync)

- **`[pi]` runtime-TS extension API with live `registerProvider`** — `packages/coding-agent/src/core/extensions/loader.ts:213`. Plain `.ts` files loaded via jiti (no build step); each a `(pi) => {}` factory that can `registerTool/registerProvider/registerCommand/registerShortcut/registerFlag/registerMessageRenderer` + subscribe to lifecycle; bundled deps exposed via `virtualModules` so it works inside a compiled binary. Live provider registration is the standout. **(L)** — ↺ prior: plugin sandboxing (claude_todo #14).
- **`[pi]` spec-compliant skills loader (collision + gitignore + symlink dedup + XML prompt)** — `packages/coding-agent/src/core/skills.ts:387,173,335`. Frontmatter validation, `.gitignore`-aware discovery, symlink real-path dedup, name-collision diagnostics (winner/loser paths), `disable-model-invocation`, `<available_skills>` XML that points the model at the file to `read`. Hardened reference for AIO's loader. **(M)**
- **`[oh-my-codex]` marker-based idempotent context-file injection with user-policy preservation** — `src/utils/agents-md.ts` (`upsertManagedAgentsBlock`, `preserveUserOmxPolicyBlocks`). Upsert an AIO-managed block between HTML-comment markers while re-inserting the user's hand-authored policy blocks so regeneration never clobbers edits. The safe way to inject AIO guidance into each CLI's `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`. **(S/M)**
- **`[oh-my-codex]` declarative keyword→skill trigger registry** — `src/hooks/keyword-registry.ts:8`. Flat table mapping natural phrases + `$`-commands ("keep going", `$ultragoal`) → skill + priority + one-line guidance. Keys workflows off conversational phrasing, not just slash commands. **(S)**
- **`[pi]` self-extension procedure encoded as a skill** — `.pi/skills/add-llm-provider.md`. The exact ordered multi-file checklist for adding a provider to pi itself, shipped as a Skill so the agent self-extends reliably. Turn AIO's own "add a provider/adapter/skill" procedures into first-class verified skills. **(S)**
- **`[CodePilot]` Save-as-Skill nudge from a complexity heuristic** — `src/lib/skill-nudge.ts:37`, `agent-loop.ts:318`. Track step count + a `distinctTools` Set; `≥8 steps AND ≥3 distinct tools` → `skill_nudge` + a one-click "Save as Skill" that re-sends a canned author-the-SKILL.md prompt. **(S)**
- **`[opencode]` models.dev schema-driven catalog (tiered cost + modalities)** — `packages/core/src/models-dev.ts:46`. Zod-validated catalog with per-model context/limits, input/output modalities, `interleaved` reasoning, and cost incl. context-tier pricing (over-200k) + cache read/write rates; disk-cached with a file lock. More accurate than hardcoded tables. **(M)** — ↺ prior: claude_todo #16 (model-capability catalog).
- **`[opencode]` per-model/provider quirk + reasoning-effort transform layer** — `packages/opencode/src/provider/transform.ts`. Maps each model family to its reasoning-effort variants, injects provider-specific cache control, strips empty/invalid content per provider, remaps `providerOptions` keys, lowers JSON tool schemas to each provider's constraints. Expensive knowledge to rediscover; valuable even as a reference table. **(L; S as reference)**
- **`[Actual Claude]` settings + team-memory delta sync (`view=hashes`, server-wins, secret-guard)** — `services/settingsSync/index.ts`, `services/teamMemorySync/*`. Flat `{entries:{path:content}}` + checksum, incremental upload of only changed keys; team memory keyed per-repo, `view=hashes` returns per-entry checksums so only differing keys push; a secret scanner blocks uploading files with secrets; debounced FS-watch; caller-owned `SyncState` (no globals). Liftable if AIO syncs memory/settings across machines. **(M)**
- **`[Actual Claude]` org policy-limits: ETag-cached, fail-open managed policy** — `services/policyLimits/index.ts:55`. Hourly `unref`'d poll sending a SHA-256 checksum as `If-None-Match` (200/304/404), cached 0600, **fails open** (unknown=allowed) except a HIPAA/essential deny-list that fails closed. Pattern for AIO fleet feature-gates. **(M)**

---

## 12. Cross-surface architecture

**Engine.** Bigger structural bets — how state flows across main/renderer/mobile/remote.

- **`[t3code]` canonical provider-event union with a `raw` escape hatch** — `packages/contracts/src/providerRuntime.ts:148,248,967`. One tagged union (~48 event structs: `session.*`/`thread.*`/`turn.*`/`item.*`/`content.delta`/`tool.*`…) every adapter emits, each carrying `provider`, ids, and optional `raw:{source,method,payload}` preserving the native message. Makes the canonical event a *superset* — directly fixes AIO's own "ProviderOutputEvent is lossier than OutputMessage" (Wave 2 Task 16). **(L)**
- **`[t3code]` dual native/canonical NDJSON event logging = free fixture replay** — `apps/server/src/provider/Layers/EventNdjsonLogger.ts:31`. Per-thread rotating NDJSON sinks for `native` + `canonical` streams, best-effort. Capturing `raw` on every canonical event + a native stream *is* the capture side of AIO's deferred replay harness (Task 24). **(M)** — ↺ prior: claude_todo #4 (fixture-replay); `[claw-code]` `src/parity_audit.py` + `rust/mock_parity_scenarios.json` is a second working shape (surface-snapshot diff + named scenario replay).
- **`[t3code]` pure native→canonical event mapper functions** — `apps/server/src/provider/acp/AcpCoreRuntimeEvents.ts:79`. Normalization as small pure builders (native in, canonical out) with mapping tables, trivially unit-testable — isolates the lossy translation seam AIO loses info at today. **(S)**
- **`[t3code]` shared ACP (Agent Client Protocol) layer powering Cursor + Grok + OpenCode** — `packages/effect-acp/src/*`, `apps/server/src/provider/acp/*`. Multiple CLIs that speak ACP share one JSON-RPC-over-stdio client + session runtime + permission model; provider-specific bits are thin extensions. Any ACP-speaking CLI collapses into one transport + a small file. **(L)**
- **`[t3code]` server-authoritative event sourcing (decider / projector / read-model)** — `apps/server/src/orchestration/{decider,projector}.ts`, `Layers/ProviderRuntimeIngestion.ts`. Provider streams fold into a persisted event log; clients render *projections*, never raw streams, so reconnects/partial streams just re-read the projection. **(L)** — ↺ prior: codex_todo #3 (event sourcing as default mutation path).
- **`[t3code]` `ProviderDriver` SPI as a plain value (not a Context service)** — `apps/server/src/provider/ProviderDriver.ts:119`, `builtInDrivers.ts:47`. A driver = a record `{configSchema, defaultConfig, create()}`; deliberately not a singleton so many instances of one CLI coexist with zero shared mutable state. Adding a provider = one record + append to an array. **(M)**
- **`[t3code]` `makeManagedServerProvider` — reusable status-snapshot state machine** — `apps/server/src/provider/makeManagedServerProvider.ts:20`. Per instance: pending snapshot, settings-driven refresh, 60s poll, PubSub change stream, semaphore-guarded apply, and an `enrichmentGeneration` counter that discards stale async enrichment so a slow probe can't overwrite a newer snapshot. **(M)**
- **`[t3code]` `ProviderSessionDirectory` + versioned resume cursor for restart survival** — `apps/server/src/provider/Services/ProviderSessionDirectory.ts:17`, `Drivers/CursorAdapter.ts:173`. Persisted `threadId → {provider, instanceId, resumeCursor}` lets the server rebind a thread to a provider session after restart; resume payloads are `schemaVersion`-guarded. **(M)**
- **`[t3code]` unified token-usage snapshot schema across providers** — `packages/contracts/src/providerRuntime.ts:307`. One `ThreadTokenUsageSnapshot` (used/input/cached/output/reasoning, `maxTokens`, `toolUses`, `durationMs`, `compactsAutomatically`, per-turn `last*`) regardless of CLI. Ready-made target for AIO's usage reconciliation + a context-window meter. **(S)**
- **`[jean]` unified command dispatch + drop-in transport + backend-driven cache invalidation** — `src-tauri/src/http_server/dispatch.rs:83`, `src/lib/transport.ts`. One ~390-arm command registry serves desktop IPC + mobile HTTP/WS + the MCP server; a transport shim runs the same UI native or remote; every mutation emits `cache:invalidate` keys so the desktop UI updates live even when a phone or an MCP agent mutates state. Keeps all AIO surfaces in sync for free. **(M)**
- **`[agent-orchestrator]` CDC poller: durable `change_log` tail → in-process broadcast** — `backend/internal/cdc/poller.go`, `broadcast.go`. 100ms poll of an append-only `change_log` fans new rows (in seq order) to SSE subscribers; on restart `SeekToHead` (no re-broadcast); durable catch-up is the client's job via its own offset. Replayable, restart-safe, multi-client streaming for mobile-gateway/remote nodes. **(M)**
- **`[copilot-sdk]` CAPI/LLM-inference request interception** — `nodejs/src/copilotRequestHandler.ts:1`. Intercept/mutate/forward the runtime's actual model HTTP/WS traffic — rewrite URL/headers per request, forward upstream, or fully synthesize a response with no backend. A clean seam for per-request cost/observability, secret-redaction, routing/mocking without patching the CLI. **(M-L)**
- **`[copilot-sdk]` steering vs queueing (immediate vs enqueue, steering falls back to queue on turn end)** — `docs/features/steering-and-queueing.md`, `session.ts:237`. `send({mode:"immediate"})` injects into the current turn (best-effort, falls back to queue); `"enqueue"` FIFOs full turns; pending steering jumps to front. Mid-run course-correction model AIO can mirror across providers. **(S passthrough / M generalize)**
- **`[copilot-sdk]` FFI in-process runtime host** — `nodejs/src/ffiRuntimeHost.ts:1`. Loads a native `runtime.node` via `koffi` and pumps LSP-framed JSON-RPC across the C ABI instead of spawning over stdio/TCP — a pure transport swap reusing `vscode-jsonrpc` framing. Lower latency, no port/stdio plumbing. **(L)**
- **`[copilot-sdk]` BYOK on-demand bearer-token provider** — `nodejs/src/client.ts:188`, `session.ts:863`. Non-serializable `bearerTokenProvider` callbacks are stripped before crossing the wire (→ `hasBearerTokenProvider:true`); the runtime requests a token via `providerToken.getToken{providerName}` routed back to the callback — no secret ever crosses the wire or persists. Clean multi-provider BYOK design. **(M)**
- **`[opencode]` LSP diagnostics baked into the edit tool's return** — `tool/edit.ts:197`, `lsp/diagnostic.ts:20`. After every edit/write, pull LSP diagnostics and append errors to the tool result as `LSP errors detected, please fix:` — closes the write→typecheck loop *inside one tool turn* so the model self-corrects. **(S)** — ↺ prior: codex_todo #33 (LSP diagnostic baselines); Actual Claude `services/lsp/passiveFeedback.ts` is a second reference.
- **`[opencode]` multi-strategy fuzzy edit-replacer cascade** — `tool/edit.ts:682` (replacers `:244`, over-match guard `:731`). 9 ordered replace strategies (exact → line-trimmed → block-anchor w/ Levenshtein → whitespace/indentation/escape-normalized → context-aware → multi-occurrence) + a guard refusing matches disproportionately larger than `oldString`. Turns "oldString not found" retries into applies. Relevant if AIO gains any first-party edit path. **(M)**

---

## Per-project source index

Quick "where to look" map. File counts exclude `node_modules`.

| Project | What it is | Lang | Richest steal areas |
|---|---|---|---|
| **agent-orchestrator** | Parallel-coding-agent orchestrator w/ CI/review feedback loops | Go backend + React | §5 CI/PR feedback loops, activity-state hooks, §12 CDC poller, §6 PTY sanitization |
| **jean** | Tauri desktop for Claude/Codex/Cursor/OpenCode | Rust + React | §5 self-orchestration MCP + auto-fix, §1 adapter tricks (SIGKILL, resume-diff, handoff), GitHub/Linear, §12 unified dispatch |
| **CodePilot** | Multi-model desktop client, phone control, learns workflow | TS | §9 generative UI + dashboard, §4 memory vault, §8 phone permissions, §2 error/timeout, Provider Doctor |
| **opencode** | Provider-agnostic coding agent (client/server) | TS | §3 compaction, §11 models.dev + transform, §8 permissions/arity, §5 subagents, §12 edit-replacer/LSP |
| **codex** | OpenAI Codex CLI | Rust | §1 exec protocol/rollout, §6 sandbox/exec-policy, §2 retry/SSE, §3 compaction budgets, MCP tool schema |
| **hermes-agent** | Nous Research agent framework + desktop | Python + TS | §5 verify-on-stop, background-review fork, programmatic tool-calling, §2 error taxonomy, §3 cache layout |
| **t3code** | Minimal web GUI multiplexing coding CLIs | TS (Effect) | §12 canonical event union + `raw`, event sourcing, ACP layer, ProviderDriver SPI, reaper |
| **openclaw** | Multi-channel personal-assistant gateway | TS | §5 commitments engine, heartbeat, TaskFlow, §6 node-host exec-policy + security self-audit |
| **oh-my-codex** | Codex enhancement suite | Rust + TS | §5 triage router + task-size gate, §11 marker injection + keyword registry, §9 tmux sidecar |
| **pi** | Self-extensible coding agent harness | TS | §11 runtime-TS extensions (registerProvider), skills loader, self-extension-as-skill |
| **claw-code** | Python Claude-Code reimplementation | Python | §12 parity-audit + fixture-replay harness (Task 24 shape) |
| **mempalace-reference** | Local-first AI memory (LongMemEval) | Python | §4 retrieval ranking, eval harness, hybrid BM25+vector, chunk hydration |
| **OB1 (Open Brain)** | Shared-memory DB + open protocol | SQL/Postgres | §4 provenance gate, recall traces→RLM, recency decay |
| **storybloq** | Cross-session context persistence | TS | §4 git-aware recap, field-level JSON merge, reinforcement ranking |
| **nanoclaw** | Agents in containers | TS | §6 egress lockdown, mount allowlist, §5 heartbeat liveness |
| **oh-my-opencode-slim** | Opencode multi-agent suite | TS | §5 prompt-embedded routing, cost presets, model fallback chains, deny-by-default personas |
| **copilot-sdk** | GitHub Copilot CLI SDK | TS (+ multi) | §8 granular permissions, §12 CAPI interception/FFI/BYOK, steering, §5 completion signal |
| **Actual Claude** | Real Claude Code internals | TS | §1 session/OAuth/stream-json, §2 retry engine, §3 microcompaction, §11 policy/settings sync, §9 native-ts perf |
| **CodexDesktop-Rebuild** | Electron build for Codex Desktop | JS/config | §10 ASAR integrity, native-module sync, fuses, signing |

**Not separately mined:** `claude-code` (official CC — docs only; internals covered by *Actual Claude*), `codex-plugin-cc` (1 file), `online-orchestrator` (no source), `mempalace`/`worktrees`/`userdata` support dirs.

---

## Suggested next step

This is deliberately broad. To turn it into a plan, a reasonable slicing:

- **Quick wins (S, high-confidence):** never-worse guard (§7), error classifier (§2), save-as-skill nudge (§11), liveness-reaper-reports-facts (§5), token-usage schema w/ cached+reasoning (§7), tolerant JSON field extraction (§1), control-char PTY sanitization (§6), rate-limit header parsing (§1/§9), redacted diagnostics (§6).
- **Adapter-fidelity sprint:** items in §1 + §7 token schema — makes AIO drive Claude/Codex/Copilot losslessly (also unblocks §12 canonical-event work).
- **Loop-mode de-islanding:** §5 (verify-on-stop, run-loop, completion signal, heartbeat notify-gating, ticket→agent) wired to AIO's existing context/memory subsystems.
- **Retrieval-quality + eval:** §4 (summary-as-signal, hybrid rerank, chunk hydration) gated behind the mempalace eval harness so changes are measurable.
- **Hardened run mode:** §6 sandbox recipes + nanoclaw egress lockdown as an opt-in tier alongside worktrees.
- **Bigger bets:** §12 canonical event union + event sourcing; §11 pi-style runtime extensions; §9 generative UI.

---
---

# Round 2 — additional finds (deeper pass)

> A second, deeper sweep. Each investigator was given the Round-1 "already captured" list per project and told to mine *unexplored* subsystems (Actual Claude's ~40 slash-commands, opencode's tool suite/server/plugins, codex's apply-patch/agent-jobs/auth, the smaller projects' CLIs/protocols, and both desktop apps' supporting mechanics). ~100 NEW items below; none duplicate Round 1. Same tags/effort legend. New themed sub-sections (A–H) so they slot alongside §1–§12.

## Round 2 top picks

1. **`code_mode` — model writes a JS/TS script that calls tools programmatically** (nested calls route back through the normal approval/permission pipeline) — **converged independently in two projects**: `[codex]` `core/src/tools/code_mode/execute_spec.rs` (V8 host process) and `[opencode]` `tool/code-mode.ts:186`. Collapses N tool round-trips into one turn; kills per-tool schema token cost. **(L)**
2. **`tool_search` — BM25 lazy tool-loading / deferred schemas** — `[codex]` `core/src/tools/handlers/tool_search.rs:74`. The canonical fix for "too many MCP tools blow the context window" (this is literally the mechanism the harness AIO runs inside uses). **(M)**
3. **apply_patch: 5-level fuzzy hunk-match cascade + grammar + EOF-sentinel apply** — `[codex]` `apply-patch/src/seek_sequence.rs:12`, `lib.rs:716`. A portable first-party patch applier that lands model diffs `git apply` rejects — AIO has none. **(M)**
4. **Seq-numbered per-session replay ring buffer for gap-free reconnect** — `[jean]` `src-tauri/src/http_server/mod.rs:167,255`; `[opencode]` event-fence header `server/shared/fence.ts`; `[online-orchestrator]` push+pull DOM re-scrape fallback. Exactly-once catch-up keyed off a client cursor — AIO's mobile/remote gateways silently drop streamed events on flaky links. **(M)**
5. **Speculative execution of the predicted next prompt via copy-on-write overlay** — `[Actual Claude]` `services/PromptSuggestion/speculation.ts:402`. Turns "user is reading" idle time into completed work, with overlay isolation + a boundary classifier + `timeSavedMs` accounting. **(L)**
6. **`guardian` — LLM-as-judge auto-approval gate (fail-closed + circuit breaker + prompt-injection trust boundary)** — `[codex]` `core/src/guardian/mod.rs`. Auto-approve safe agent actions with no human, with anti-runaway/anti-injection guards. **(L)**
7. **Backend-compat tool-schema sanitizer + reactive strip-on-400 retry** — `[hermes]` `tools/schema_sanitizer.py:46`. One Pydantic-nullable/`$ref`-sibling shape Claude tolerates hard-400s a llama.cpp/Fireworks route; sanitize-per-provider + strip-and-retry turns a fatal 400 into a working call. **(M)**
8. **Cross-model advisory transcript rewrite** (feed one agent's history to a model that didn't produce it, without orphan tool-calls / "must end with user") — `[hermes]` `agent/moa_loop.py:436`. Makes AIO's heterogeneous cross-CLI debate/review actually send. **(M)**
9. **Shadow-git snapshots seeded via object-DB alternates** (instant per-turn checkpoints on huge repos, invisible to user's `.git`) — `[opencode]` `snapshot/index.ts:200`. **(L)**
10. **Content-addressed dedup everywhere** — `[OB1]` SHA-256 normalized-content fingerprint w/ partial-unique index → idempotent capture that *merges* metadata (`schemas/enhanced-thoughts/schema.sql:393`); `[OB1]` evidence-accumulation (`support_count++` instead of duplicate). Replaying an ingest/webhook produces zero dupes. **(S/M)**
11. **`unified_exec` persistent PTY + reusable symmetric HeadTailBuffer** (keep 50% head + 50% tail, drop middle) — `[codex]` `core/src/unified_exec/mod.rs`, `head_tail_buffer.rs:11`. Drive REPLs/installers without re-spawn; the buffer is a drop-in output-truncation util. **(M)**
12. **Atomic-rename binary writes to dodge macOS code-sign inode taint** — `[jean]` `src-tauri/src/platform/process.rs:329`. In-place overwrite of a managed CLI binary → next launch SIGKILL'd with no obvious cause. Easy-to-miss correctness fix for AIO's CLI auto-update. **(S)**

## Round 2 convergence signals

- **Model-writes-code-to-call-tools (`code_mode`)** — codex *and* opencode, independently. Strongest signal in this batch.
- **BM25/lazy tool-loading + capability-gated tool exposure** — codex `tool_search` + `ModelInfo`/`ToolExposure`; opencode `Permission.visibleTools`.
- **Cursor/seq-based minimal reconnect** — jean replay ring buffer, opencode event-fence header, online-orchestrator re-scrape-on-pull. Three takes on "re-derive what you missed, don't replay everything."
- **Missed-run grace + fire-once-and-fast-forward for schedules** — hermes `cron/jobs.py` and CodePilot `task-scheduler.ts` (Round 1) both solve laptop-sleep backlog the same way.
- **Content-hash dedup as the write-path invariant** — OB1 (fingerprint + evidence accumulation) and Actual Claude (VCR request hashing, file-history `sha256(path)@v`).
- **Progress-signal liveness over wall-clock timeouts** — hermes stuck-vs-slow heartbeat, nanoclaw heartbeat-file sweep (R1), agent-orchestrator reaper-facts (R1).
- **Redact/gate before content leaves to a model** — storybloq secrets-gate, OB1 PII tiering, agent-orchestrator control-char sanitize (R1).

---

## A. Reconnect & streaming durability

- **`[jean]` seq-numbered per-session WS replay ring buffer** — `src-tauri/src/http_server/mod.rs:167,255,96`. Global monotonic `seq`; per-`session_id` VecDeque (cap 2000) + per-`terminal_id` 3 MiB byte-budget buffer; client sends `{replay, last_seq}` → gets only `seq>last_seq`; self-evicts on `chat:done`. Exactly-once catch-up for AIO's gateways. **(M)**
- **`[opencode]` event-sequence "fence" header for cheap incremental reconnect** — `server/shared/fence.ts`, middleware `.../middleware/fence.ts:9`. Every response carries `x-opencode-sync: {aggregateId: seq}`; client echoes its last-seen map, server diffs and ships only advanced aggregates. Minimal catch-up without full-state resend. **(M)**
- **`[online-orchestrator]` idempotent push+pull with DOM re-scrape fallback** — `content-scripts/chatgpt.js:30`, `background/service-worker.js:97`. Content script both pushes `RESPONSE_READY` and answers pull `GET_RESPONSE` by re-scraping live state if the push was missed. "Re-derive current state on reconnect instead of trusting you saw every event" — applies to AIO's `INSTANCE_OUTPUT` backbone. **(M)**
- **`[online-orchestrator]` resumable fan-out persisted across window/worker death** — `sidepanel/sidepanel.js:62,249`. In-flight per-provider progress written to storage on every change; on reload it detects the waiting flag and re-enters the collection loop instead of losing the run. For AIO surviving renderer reloads / reattaching to running sessions. **(M)**

## B. Provider-adapter fidelity & compatibility

- **`[hermes]` backend-compat tool-schema sanitizer + strip-on-400 retry** — `tools/schema_sanitizer.py:46,364,441`. Deep-walk rewrites nullable/`anyOf`-null/`$ref`-sibling/empty-object shapes strict backends reject; a reactive layer strips `pattern`/`format`/slash-`enum` only after a real 400, then retries. **(M)**
- **`[hermes]` cross-model advisory transcript rewrite** — `agent/moa_loop.py:436,401,388`. Flattens a conversation to plain user/assistant text (`tool_calls`→`[called tool: …]`, tool results head+tail-folded, synthetic trailing user turn) so a *different* advisor model accepts it with no orphan-tool 400s. **(M)**
- **`[codex]` data-driven `ModelInfo` capability struct + per-turn tool-gating pipeline** — `protocol/src/openai_models.rs:353`, `models-manager/src/model_info.rs:71`, `core/src/tools/spec_plan.rs`. Every per-model behavior is a flag fetched from `/models` with a conservative fallback; tools assembled per turn by `provider.caps ∧ model flags ∧ config.features` with a `ToolExposure` (Direct/DirectModelOnly/Deferred/Hidden) primitive. Replaces name-string branching. **(M)**
- **`[codex]` `ReasoningEffort::Custom(String)` escape hatch + thread-id prompt-cache warming** — `protocol/src/openai_models.rs:40`, `core/src/client.rs:469`. `Custom` + `FromStr` so a server can advertise an unknown effort without breaking the client; `prompt_cache_key` defaults to stable `thread_id` and a turn-equality check reuses the streaming session to keep the prefix cache warm. **(S)**
- **`[codex]` app-server v2 protocol (richer than the 2-tool MCP surface)** — `app-server-protocol/src/protocol/v2/{thread,turn,item,review}.rs`. `turn/steer`, `turn/interrupt`, `thread/fork` at a turn, paginated turns/items with cursors, `thread/settings/update` mid-thread, structured delta event stream, server-driven `requestApproval`/`requestUserInput`. **Adapter** upgrade for AIO driving Codex (many methods `#[experimental]`; stable core already exceeds MCP). **(L)**
- **`[codex]` ChatGPT OAuth PKCE loopback + API-key minting + identity-scoped auth** — `login/src/server.rs:151,1111`, `auth/storage.rs:39`, `auth/manager.rs:2506`, `model-provider/src/auth.rs:131`. `auth.json` schema (0600), RFC-8693 token-exchange to mint an api-key, JWT-`exp` proactive refresh, refuses to emit headers if on-disk account changed. **Adapter**: read `auth.json` to know plan/account, or authenticate AIO's own Codex sessions. **(M)**
- **`[online-orchestrator]` version-resilient multi-selector web-UI adapter arrays** — `content-scripts/{chatgpt,claude,gemini}.js:62`. Each field (`input`/`sendButton`/`responseContainer`/`streamingIndicator`) is an *ordered array* of candidate CSS selectors; `findElement` returns the first match, so a provider UI change needs one array edit and old selectors stay as fallbacks. A path to **web-subscription-backed providers** (ChatGPT Plus / Gemini) where no CLI/API exists. **(M)**
- **`[online-orchestrator]` API-free completion detection (output-stability + negative stop-button)** — `content-scripts/chatgpt.js:236,135`. Finalizes only when scraped text is unchanged for 3×1s polls AND the stop button is absent, + a 120s hard timeout. Reusable "turn is quiescent" heuristic where structured end-of-turn markers are missing/unreliable. **(S)**
- **`[opencode]` shell-aware bash tool *description*** — `tool/shell/prompt.ts:63,43,27`. The bash tool's doc is generated for the detected shell (bash/pwsh/PS5.1/cmd), injecting correct chaining (`&&` vs `; if ($?){}`), quoting, call-operator notes. Stops models emitting `&&` on Windows PowerShell. **(M)**
- **`[hermes]` fail-closed provider/model drift guard for scheduled jobs** — `cron/scheduler.py:2953`, `cron/jobs.py:985`. A job created with an *unpinned* model snapshots what the default resolves to; at fire time, if the default changed, it skips with **no paid call** + "pin to proceed" alert. Money-safety for AIO automations across config changes. **(M)**
- **`[CodePilot]` model auto-enable curation (blacklist + enable-source gate)** — `catalog-recommend.ts:40,78`. When a provider exposes 100+ models, regex-veto image/embed/audio/preview/deprecated from the chat picker; refresh apply is gated by `enable_source` so user-toggled rows are never touched. Stops a new router dumping non-chat models into pickers. **(S)**
- **`[agent-orchestrator]` cheap bounded auth-status probe classifier across CLIs** — `adapters/agent/authprobe/authprobe.go:28,69`. Runs `auth status`/`login status`/`providers list` (3s timeout each) and classifies stdout/stderr into authorized/unauthorized/unknown by substring/compacted-JSON, treating unsupported commands as unknown. Fast/cheap failover + setup pre-flight without a real API call. **(S)**
- **`[pi]` fuzzy model resolver (alias-preference, glob scoping, `:thinking-level` suffix)** — `core/model-resolver.ts:124,269,192`. Exact→alias-over-dated→glob-scoped quick-cycle set; parses trailing `:high` even when the model id contains colons (OpenRouter `model:exacto`). Cleaner than exact-ID selection per CLI. **(M)**
- **`[pi]` OAuth-gateway custom provider via `streamSimple`** — `examples/extensions/custom-provider-gitlab-duo/index.ts:183`. Register a provider whose `streamSimple` runs PKCE login, exchanges for a short-lived token (25-min TTL cache), then reuses the *built-in* Anthropic/OpenAI streaming code against a proxy URL+headers — no wire-protocol reimplementation. Template for corporate/SSO-gated proxy providers. **(M)**
- **`[OB1]` return MCP auth failure as a JSON-RPC error inside HTTP 200** — `server/index.ts:519,603`. Strict CLIs (Codex, Claude Code) treat a bare 4xx as a transport fault and tear the connection down; wrapping the error (`code -32001`) in a 200, plus accepting `?key=` and synthesizing a missing `Accept: text/event-stream`, keeps them alive. AIO owns an MCP server — direct robustness win. **(S)**

## C. Tool execution & editing

- **`[codex]` apply_patch 5-level fuzzy hunk-match cascade** — `apply-patch/src/seek_sequence.rs:12`. exact → trailing-ws-insensitive → both-trim → Unicode-normalized (typographic dashes/quotes/nbsp→ASCII), EOF-anchored search when the hunk targets file end; panic-guards. **(M)**
- **`[codex]` apply_patch envelope grammar + EOF-sentinel apply algorithm** — `core/src/tools/handlers/apply_patch.lark`, `apply-patch/src/lib.rs:716,806`. Context lines advance a cursor; additions insert before trailing blank; retries without the "final newline" sentinel on miss; replacements applied descending so indices don't shift. Pairs with the cascade. **(M)**
- **`[codex]` + `[opencode]` `code_mode`** — codex `core/src/tools/code_mode/execute_spec.rs` (isolated V8 host process, `tool_mode: Direct|CodeMode|CodeModeOnly`); opencode `tool/code-mode.ts:186` (`execute` tool, MCP tools as namespaced callables, per-tool timeouts reset on progress). Model writes a script chaining many tool calls in one turn; nested calls still hit approval/permission. **(L)**
- **`[codex]` `tool_search` BM25 deferred tool loading** — `core/src/tools/handlers/tool_search.rs:74` (the `bm25` crate). Tools indexed over descriptions; `tool_search(query,limit)` loads only matching schemas (`defer_loading`), MCP namespaces re-coalesced, handler cached until the tool set changes. **(M)**
- **`[codex]` `unified_exec` persistent PTY + HeadTailBuffer** — `core/src/unified_exec/mod.rs`, `head_tail_buffer.rs:11`. `exec_command` opens a PTY reused across calls by `process_id`; `write_stdin` with a clamped "yield time"; symmetric 50/50 head/tail output cap with `... N bytes omitted ...`; sandbox-then-escalate integrated. **(M)**
- **`[pi]` retargetable tool "operations" backends** — `examples/extensions/{gondolin,sandbox}/index.ts`, factories in `core/tools/*`. Each tool = pure logic + a swappable `operations` object (`readFile`/`exec`/`glob`/`stat`); pass different ops to run the *same* tool local / in-worktree / on a remote node / in a QEMU micro-VM (write-through host mount, path translation), output byte-identical. Unifies AIO's separately-wired execution substrates + adds true OS/FS isolation. **(M)**
- **`[opencode]` read tool: fuzzy "did you mean?" + hard byte-cap streaming** — `tool/read.ts:73,145,190`. Lists 3 similar siblings on not-found; 50KB byte cap + 2000-char/line truncation stopping the stream early with exact `offset=N to continue` hints; binary sniff on a 4KB sample. Kills the "guessed a wrong path, gave up" loop and deterministic paging. **(S)**
- **`[opencode]` webfetch Cloudflare-challenge honest-UA retry + format-negotiated Accept** — `tool/webfetch.ts:82,56`. On a 403 `cf-mitigated: challenge`, retry once with an honest `opencode` UA (bots sometimes waved through where spoofed ones are blocked); q-weighted Accept per format; 5MB cap; HTML→markdown. Recovers blocked fetches before escalating to browser-gateway. **(S)**
- **`[opencode]` project-aware auto-format after every edit/write** — `format/index.ts`, `formatter.ts:70`, `tool/write.ts:65`. Picks a formatter by extension but only runs it if the tool is a declared project dependency (prettier/biome up-tree) or `which`-found (gofmt/ruff); caches the decision. Keeps diffs clean, stops the model wasting turns on whitespace, no surprise reformats. **(M)**
- **`[opencode]` project-wide post-write diagnostics (not just the edited file)** — `tool/write.ts:78` (`MAX_PROJECT_DIAGNOSTICS_FILES`). After a write, pull LSP diagnostics for the edited file *and* downstream files (broken imports/signatures) and append "please fix", capped. Catches ripple breakage the edited-file-only version (§12) misses. **(S)**
- **`[Actual Claude]` passive LSP diagnostics auto-injected as attachments (dedup + caps)** — `services/lsp/passiveFeedback.ts:161`, `LSPDiagnosticRegistry.ts:136,256`. Subscribes to `publishDiagnostics` on every server; delivers as next-turn attachments deduped within-batch AND across-turns (LRU 500 keyed by URI+hash), capped 10/file & 30 total, error-first. The dedup/volume layer is the hard part. **(M)**
- **`[codex]` turn-diff tracker — net per-turn diff without re-reading disk** — `core/src/turn_diff_tracker.rs:50`. Accumulates the net unified diff of a turn purely from committed apply_patch deltas (lazy baseline, rename tracking, per-path render cache); invalidates rather than showing a wrong diff on a non-exact delta; 100ms timeout fallback. Live "what changed this turn" with no `git diff` shell-out. **(M)**
- **`[Actual Claude]` rigorous read-only bash classifier (declarative allowlist + parser-differential defenses)** — `tools/BashTool/readOnlyValidation.ts:1246,128,1328`. Command→safe-flags/arg-types table; rejects any token containing `$` (parser keeps `$VAR` literal while bash expands it — documented RCE differential for `rg --pre`), rejects brace-expansion obfuscation, xargs-target rules; per-exclusion security annotations. Auto-approve safe commands for read-only subagents. **(M)**
- **`[Actual Claude]` wrapper-command unwrap specs (`timeout`/`nohup`/`xargs`/`time`/`srun`)** — `utils/bash/specs/index.ts` + `specs/*.ts`. A registry of `CommandSpec`s so the permission layer strips the wrapper and evaluates the *inner* command's safety. Closes the "prefix a wrapper to bypass the allowlist" gap. **(M)**
- **`[opencode]` `@file` + `` !`shell` `` interpolation in slash-commands/prompts** — `session/prompt.ts:1397,160`, `config/markdown.ts:5`. Custom commands support `$ARGUMENTS`/`$1..$N`, `@path` (embed file), `` !`cmd` `` (inline shell stdout), resolved before the prompt hits the model. Makes reusable commands dynamic without hand-assembling prompts. **(M)**
- **`[opencode]` per-external-directory permission gate** — `tool/external-directory.ts:14`. Any read/write/glob/grep outside the worktree triggers a distinct `external_directory` ask scoped to the parent-dir glob, with `always` remembering that directory. Guards accidental writes to `~`/sibling repos. **(S)**

## D. Context, compaction & memory

- **`[Actual Claude]` speculative execution of the predicted next prompt (CoW overlay)** — `services/PromptSuggestion/speculation.ts:402,528,461`. Forks an agent on the *predicted* next prompt into a per-run copy-on-write overlay dir, stopping at the first real-write/permission/unknown-tool boundary; on accept copies the overlay back and injects pre-computed messages instantly; pipelines the next suggestion; logs `timeSavedMs`. Latency-hiding + safe throwaway execution. **(L)**
- **`[Actual Claude]` background memory consolidation ("auto-dream") with cheap-first gating** — `services/autoDream/autoDream.ts:125,224`. On stop-hook: cheapest gate first (one stat for hours-since), then session-count scan, then a lock; only then forks a read-only agent to distill recent sessions into long-term memory files. Automatic consolidation with backpressure so it never fires per-turn. **(M)**
- **`[pi]` non-destructive per-turn context rewriting (`context` event)** — `core/extensions/types.ts:1187,1194,1080`. Before *each* LLM call an extension gets the exact outgoing `messages[]` and can return a filtered/rewritten array affecting only that request; persisted session untouched; system-prompt replacements chain. Request-scoped shaping orthogonal to destructive compaction. **(S/M)**
- **`[pi]` context-overflow auto-recovery with model-switch guard** — `core/agent-session.ts:1900`. On overflow error, drop the error msg, compact, retry the same turn once — but skip if the failing assistant msg came from a *different* model than the currently selected one (so failing over to a bigger-context CLI doesn't trigger spurious compaction). **(M)**
- **`[CodePilot]` pairing-safe microcompact (keeps tool name + excerpt)** — `context-pruner.ts:42`. Replaces old `tool-result` bodies with `[Pruned <toolName> result: <200-char excerpt>...]`, keeping the marker paired with its `tool_use` to avoid `AI_MissingToolResultsError` and stop the model hallucinating fake tool calls after a generic `[truncated]`. Bug-driven refinements for AIO's compaction. **(S/M)**
- **`[hermes]` per-turn aggregate output budget with stdin spill-to-disk** — `tools/tool_result_storage.py:203,100`. Sums all tool results in a turn; if over ~200K chars, spills the largest to disk (preview + path) — writing via **stdin** not the command string to dodge Linux's 128KB `MAX_ARG_STRLEN` argv cap. A pre-compaction guard (a turn can overflow *before* compaction runs). **(M)**
- **`[codex]` `world_state` — diffable typed state via JSON merge-patch** — `core/src/context/world_state/mod.rs:180`, `environment.rs:16`. Model-visible env state split into typed sections, each with `render_diff(previous)` emitting only changes; cross-turn transitions are RFC-7386 merge-patches (null=delete) with a history-scan fallback for forked sessions. Keeps an evolving context header fresh cheaply. **(M)**
- **`[oh-my-opencode-slim]` cheap secondary-model extraction gate on tool output** — `tools/smartfetch/secondary-model.ts:131,75,299`. A heuristic routes fetched content through a cheap small-model (with fallback chain, all tools disabled) that answers a task-specific extraction prompt, keeping the raw blob out of the main agent's context; degrades to raw on failure. Pre-filters payloads at the source vs compacting after. **(M)**
- **`[pi]` session-tree navigation with auto-summary of the abandoned branch** — `core/compaction/branch-summarization.ts:102`, `slash-commands.ts` (`tree`/`fork`/`clone`). Session is a tree; jumping nodes walks to the common ancestor, budgets the abandoned branch newest-first, emits a structured Goal/Constraints/Progress/Decisions/Next summary + cumulative read/modified-file tracking, injected as a `branch_summary`. Branch-and-explore with zero context loss for AIO's debate flows. **(L)**
- **`[OB1]` SHA-256 normalized-content fingerprint → idempotent capture** — `schemas/enhanced-thoughts/schema.sql:393,422`. Normalize (lowercase/trim/collapse-ws) → SHA-256 into a partial-unique-index column; `ON CONFLICT DO UPDATE` merges metadata instead of inserting a duplicate. Replaying an ingest/webhook retry = zero dupes, at DB level. **(S)**
- **`[OB1]` evidence-accumulation dedup (corroborate, don't duplicate)** — `schemas/smart-ingest/schema.sql:120`, `schemas/typed-reasoning-edges/schema.sql`. Near-dup re-ingest pushes a `{source,excerpt}` onto `metadata.evidence[]` (SHA-256-deduped) and bumps edge `support_count` + `GREATEST(confidence)`; reconciliation vocabulary `add|skip|append_evidence|create_revision`. Gives a "how well-attested" ranking signal + multi-source citations for one fact. **(M)**
- **`[OB1]` write-time PII/sensitivity auto-tiering + default read-time exclusion** — `integrations/consolidation-workers/_shared/config.ts:138`, `helpers.ts:415,536`; read-side `p_exclude_restricted BOOLEAN DEFAULT true`. Regex-scan at ingest (SSN/card/`sk-`/`ghp_`/`AKIA`/health) → `standard|personal|restricted`, escalate-only override merge, retrieval/stats drop `restricted` by default. Governance beyond generic redaction for a memory store ingesting raw transcripts. **(M)**
- **`[OB1]` append-only, deliberately un-FK'd audit log with per-session attribution** — `schemas/thought-audit/schema.sql` (GRANT SELECT,INSERT only), `author-session-id.sql`. Every capture/update/delete writes a row tagged `source` (`codex-cli`…) + opaque `author_session_id`; `thought_id` intentionally not an FK so audit survives deletes; delete rows stash `previous_content` for recovery. Multi-writer forensics for AIO's shared memory. **(S)**
- **`[OB1]` two-phase hybrid keyword search (tsvector GIN → trigram ILIKE fallback) with quality-blended rank** — `schemas/enhanced-thoughts/schema.sql:66`, `text-search-trgm/schema.sql`. Phase-1 `websearch_to_tsquery`; only if under-full, Phase-2 `ILIKE` made fast by a pg_trgm GIN index; rank fuses text relevance + `importance` + `quality_score`. Complements embedding search on exact-token/rare-identifier queries (error codes, fn names). **(M)** (AIO is SQLite → the FTS5 analog from Round 1 §4 applies.)
- **`[pi]` durable extension state via custom session entries + rehydrate-by-replay** — `core/extensions/types.ts:1281,1258`, `plan-mode/index.ts:116`. Persist arbitrary JSON as `custom` session entries (excluded from LLM context, survive resume); on `session_start` read the snapshot AND replay messages from a marker forward to rebuild derived state (which plan steps done). Session-native alternative to side-channel state files. **(M)**
- **`[Actual Claude]` Haiku-generated one-line tool-batch labels** — `services/toolUseSummary/toolUseSummaryGenerator.ts:15,45`. After a tool batch, send truncated inputs/outputs + intent to Haiku with a prompt tuned for ~30-char past-tense labels ("Fixed NPE in UserService"); non-blocking, fails silent. Compact activity labels for AIO's instance cards/timeline/mobile. **(S)**

## E. Orchestration & autonomy

- **`[codex]` `multi_agents_v2` — sub-agent spawn fabric + delegation-policy prompt** — `core/src/tools/handlers/multi_agents_spec.rs`, `.../multi_agents_v2/spawn.rs:40`. Canonical task-path hierarchy (`/root/task1/task_3`), `fork_turns=none|all|N`, per-child model/effort/tier overrides, and a mailbox (`send_message`/`followup_task`/`wait_agent`/`interrupt_agent`/`resume_agent`); the spawn description is a large reusable "when to delegate" policy. Mature design for AIO's island loop/debate. **(L)**
- **`[codex]` `spawn_agents_on_csv` — batch fan-out over a CSV with template + export** — `core/src/tools/handlers/agent_jobs/spawn_agents_on_csv.rs:69`. Each row → a job; `instruction` templated with `{column}`; bounded worker pool, state-DB dedup + `max_runtime` cap, results exported to an output CSV. "Run this prompt over N inputs in parallel and collect a table." **(M)**
- **`[codex]` `guardian` — LLM-as-judge auto-approval gate** — `core/src/guardian/mod.rs`, `review.rs:168`, `policy_template.md`. A read-only, no-network reviewer LLM judges the exact planned action → strict JSON `{risk_level,user_authorization,outcome,rationale}`; fails **closed** on timeout/malformed (90s cap); circuit-breaker after 3 consecutive / 10-per-turn denials; trust boundary = only user/dev msgs + AGENTS.md (tool outputs can't widen scope). **(L)**
- **`[oh-my-opencode-slim]` poll-free job board + `session.idle`-as-completion** — `utils/background-job-board.ts:478`, `hooks/task-session-manager/index.ts:595,693`, `orchestrator.ts:208`. Coordinator never polls; a synthetic "Background Job Board" reminder is unshifted into its next prompt; a child's `session.idle` auto-marks completed; a hard rule blocks the final response until all terminal jobs reconcile. Removes polling latency/token churn from supervisor trees. **(L)**
- **`[oh-my-opencode-slim]` reusable/recoverable subagent sessions by alias + read-context dedup** — `utils/background-job-board.ts:389,400,424,548`. Completed specialists kept warm and re-addressable by alias (`exp-1`); timed-out-but-running marked recoverable; the board records which files each subagent already read and surfaces it to the parent. Re-target instead of re-spawn; attack redundant re-reading. **(M)**
- **`[oh-my-opencode-slim]` per-lane thrash/convergence signals** — `utils/background-job-board.ts:470,217`. Each job accumulates `totalErrors`/`timeoutCount` (reset on success); a threshold flags a lane that's thrashing vs progressing — a cheap "this agent is stuck" signal distinct from a clean terminal state, to wire into failover. **(S)**
- **`[oh-my-opencode-slim]` council synthesis with confidence + mandatory per-councillor attribution** — `agents/council.ts:27,48,132`, `council-schema.ts:186`. The synthesizer must review each councillor by name, resolve contradictions ("don't average — pick the best and improve"), degrade when only some respond, and emit `unanimous|majority|split` confidence + a who-played-which-seat footer. A caller/router can act on the confidence to decide auto-apply. **(M)**
- **`[hermes]` stuck-vs-slow subagent detection via progress signals (no blanket timeout)** — `tools/delegate_tool.py:1786,614`. A 30s heartbeat watches whether `api_call_count` OR `current_tool` advanced; stale cycles count against tight-when-idle (~450s) vs loose-when-in-tool (~1200s) ceilings; once stale it just stops refreshing the parent's activity timestamp and lets the existing watchdog reap it. Doesn't kill legitimately-slow deep work. **(M)**
- **`[oh-my-opencode-slim]` session-archaeology reflection loop (`/reflect --sessions`)** — `hooks/reflect/index.ts:17`, `docs/adr/001-*.md`. Mines past session logs → cached structured per-session JSON (goal/success/frictions/confidence) → hierarchical session→weekly→monthly aggregation → recommends the *smallest* new skill/command/config change ("create nothing" is valid). Turns AIO's run history into concrete automation proposals. **(M)**
- **`[nanoclaw]` fan-out router with silent "accumulate" mode** — `router.ts:296,329,383,403`. One inbound message evaluated independently per wired agent; each wiring has an `engage_mode` (`pattern`/`mention`/`mention-sticky`); a non-engaging agent with `accumulate` policy still gets the message written to its session with `trigger=0` (silent context) and the access gate runs before accumulation. Several agents share a channel with independent triggers while retaining history. **(M)**
- **`[online-orchestrator]` fan-out → LLM-as-merger synthesis with partial-result tolerance** — `background/service-worker.js:170`, `sidepanel/sidepanel.js:524,381`. One prompt to N providers via `Promise.all`, proceeds on all-received OR timeout keeping whatever arrived, then a one-click "merge" builds a cross-model synthesize-and-flag-disagreements prompt fed to one provider. Template for AIO taking several agents' outputs → one merge/critique pass. **(M)**
- **`[storybloq]` branch-affinity contamination guard** — `autonomous/branch-affinity.ts:38,76,154`. Parses ticket IDs out of the git branch (`story/T-183-slug`); if the agent tries a *different* item it blocks ("would contaminate this branch") and emits a handover; protected branches exempt. Stops one agent committing an unrelated ticket onto another's branch. **(M)**
- **`[storybloq]` commit-reachability "is this actually finished" gate** — `autonomous/orphan-detector.ts:110,80,94`. A targeted session is done only when every target item is complete AND every recorded commit hash is a git ancestor of HEAD; fails closed on any malformed event/unreachable commit; 60-min lease avoids racing live sessions. Catches "marked done but the commit was lost to a reset/rebase." **(M)**
- **`[storybloq]` compaction-surviving resume marker in the always-read rules dir** — `autonomous/resume-marker.ts:23,19,65`. Writes `.claude/rules/autonomous-resume.md` (auto-loaded every turn) telling the model an autonomous session is live and to run `/story` first; all interpolated values pass a newline-stripping length-capped sanitizer (anti-injection); best-effort. Resume anchor that survives context compaction by piggybacking the client's guaranteed-read file. **(S)**

## F. Security & governance

- **`[storybloq]` secrets-gate: redact the diff BEFORE it fans out to reviewers** — `autonomous/lens-harness/secrets-gate.ts:28,116,82`. Runs `detect-secrets` on changed files, rewrites the unified-diff artifact so secret lines become `[REDACTED -- potential secret]` (preserving the diff marker for anchoring) before any review subagent sees it; a `hardcoded-secrets` finding forces reject. AIO fans diffs to external CLIs — stops in-repo secrets reaching a third-party model. **(M)**
- **`[storybloq]` verified-evidence gating (findings must anchor to real bytes to block)** — `autonomous/lens-harness/verification-log.ts:83,111`, `judge.ts:89`. Each reviewer finding carries a quoted code span; findings whose evidence can't be anchored are logged `evidence_unverified` → `deferred` (never blocking); `codeHash` records the claim. Guards AIO's multi-agent review against LLM reviewers citing line spans that don't exist. **(M)**
- **`[nanoclaw]` stub-credential + token-injection-at-request-time via HTTPS proxy** — `container-runner.ts:487`, `onecli-gateway/SKILL.md:16`. Agents hold only `"onecli-managed"` placeholder files + an injected `HTTPS_PROXY`; the gateway swaps in the real bearer/key at the proxy boundary keyed by host, `secretMode: all|selective` scopes which inject, fail-closed if the gateway can't wire, and can hold a request for human approval. No secret ever lands in the agent process in usable form; central revocation. **(L)**
- **`[agent-orchestrator]` standing-instruction confidentiality clause on every system prompt** — `session_manager/manager.go:1602`, `review/prompt.go:18`. Every derived prompt is suffixed with a clause to refuse direct/indirect/embedded requests to reveal its role/coordination/branch-convention scaffolding, while still answering normal project questions. Near-zero-cost hardening — a plain "print your system prompt" currently leaks AIO's orchestration scaffolding. **(S)**
- **`[Actual Claude]` block-on-dangerous-diff gate for remote/managed settings** — `services/remoteManagedSettings/securityCheck.tsx:22,67`. Extracts the "dangerous" settings subset and only if it *changed vs cached* shows a blocking approval dialog (reject → shutdown); non-interactive auto-skips. Syncing hooks/permissions/env from a remote source is an RCE vector — this is the missing guardrail. **(S/M)**
- **`[nanoclaw]` one CLI, two transports, server-side capability scoping** — `cli/dispatch.ts:58,101,165`, `cli/registry.ts:18`. The same `ncl` admin CLI runs on host (Unix socket) and in-container (session-DB transport) off one registry; a `cli_scope` (`disabled|group|global`) is enforced server-side — whitelists resources, auto-fills `--id` to the caller's own group, filters returned rows, blocks changing `cli_scope`, and filters `help` so the agent never sees a command the gate would reject. Authority enforced at the dispatcher, not the caller. **(M)**
- **`[codex]` hooks system: PreToolUse/PostToolUse/SessionStart/AfterAgent with deny + argument-rewrite** — `hooks/src/registry.rs`, `events/pre_tool_use.rs:38`, `legacy_notify.rs`. External-command hooks whose JSON output can `deny` a tool or `allow` + `updatedInput` (rewrite the bash command), fail-open on unknown, matcher rules per event; legacy `notify` bridged as an `AfterAgent` hook. The arg-rewrite path is a powerful safety/normalization lever. **(M)**
- **`[storybloq]` symlink-following atomic write (deliberate follow/reject asymmetry)** — `core/symlink-write.ts:95,53`. For user dotfiles, `realpath`-resolve (incl. dangling stow/chezmoi links) and land tmp+rename on the *real* file so the symlink is preserved; in-repo `.story/` writers use `guardPath` that *rejects* symlinks so data can't escape via a planted link. Naive tmp+rename silently clobbers symlinked `~/.claude/*` configs. **(S)**

## G. Session, worktree & process lifecycle

- **`[agent-orchestrator]` preserve uncommitted work across worktree teardown via a git ref** — `adapters/workspace/gitworktree/workspace.go:347,465`. Captures a dirty worktree into a commit at `refs/ao/preserved/<session>` via temp `GIT_INDEX_FILE` + `write-tree` + `commit-tree` (no working-tree/stash-stack touch, honors `.gitignore`); restore replays with `cherry-pick --no-commit`, keeps the ref on conflict, deletes only on clean apply. Crash-safe round-trip through destroy/recreate for AIO failover/restart. **(M)**
- **`[agent-orchestrator]` recompute-don't-persist system prompts on restore** — `session_manager/manager.go:1524,732`. System prompts are never persisted; `Restore` recomputes from current store state so a restored worker points at the *now-active* orchestrator, not a dead one; role/coordination text goes in the system prompt (promptless spawns land at an empty input box). Keeps the supervisor tree coherent after restart/reparent. **(S/M)**
- **`[agent-orchestrator]` multi-repo "workspace project" (many repos, one shared branch, atomic rollback)** — `adapters/workspace/gitworktree/workspace.go:152,635`. Materializes a session spanning a root repo + child repos at relative paths sharing one branch (auto-suffix `-2/-3` until free everywhere); on partial failure force-destroys created worktrees in reverse. Polyrepo/monorepo-of-repos tasks (frontend+backend+infra in one coordinated session). **(M/L)**
- **`[jean]` detached process-group spawn (`set -m`) so a Node-wrapper CLI's native child is reapable** — `chat/detached.rs:56`, `platform/process.rs:272`. `sh -c "set -m; nohup <cli> … & echo $!"` forces its own pgid so `kill(-pid, SIGKILL)` reaps the whole tree — critical for Node-shim CLIs (Codex) that `exec` a native binary. Killing the Node wrapper by PID otherwise orphans the model process. **(S)**
- **`[jean]` atomic-rename binary writes (dodge macOS code-sign inode taint + Windows locks)** — `platform/process.rs:329`. Writes a `.tmp` (new inode) then `rename()`s over target so the old inode stays valid for running processes, avoiding the kernel code-signing "taint" that SIGKILLs every subsequent exec of an in-place-modified binary; Windows renames the locked file to `.old` first. For AIO's managed-CLI auto-update. **(S)**
- **`[jean]` serialized worktree create/teardown with transient-race retries** — `projects/git.rs:1267,1259,1426,1395`. A global mutex serializes `git worktree add` (mutates `.git/config`), prunes stale entries each attempt, retries on `config.lock`; teardown retries `remove_dir_all` on `DirectoryNotEmpty`/`PermissionDenied`/Windows `ERROR_SHARING_VIOLATION` (dev servers keep writing during removal). Tight error classification, not blind retry. **(M)**
- **`[Actual Claude]` cross-process lock where file mtime *is* the timestamp** — `services/autoDream/consolidationLock.ts:29`. One lock file: its mtime = last-run-at (one stat to read), its body = holder PID; staleness = mtime>1h OR PID not running (reuse guard); failure rewinds mtime via `utimes` to re-open the time-gate. Dependency-free atomic lock + "only one instance does X per interval" primitive. **(S)**
- **`[Actual Claude]` startup credential prefetch (fire keychain reads parallel to module init)** — `utils/secureStorage/keychainPrefetch.ts:69,96`. Launches both `security find-generic-password` subprocesses non-blocking at the top of startup so ~65ms of keychain I/O overlaps import eval; later `await` is near-free; times out without poisoning the cache. Pure startup-latency win for AIO's credential/settings bootstrap. **(S)**
- **`[CodePilot]` one-shot session-lock settler with ownership-gated status writes** — `session-lock-settle.ts:47`. Both the completion path and a Stop/abort watchdog call one settler that runs side-effects at most once, clears the renewal interval, and writes runtime status only if `releaseLock()` reports it *still owned* the lock (lockId-scoped). A stale release after a newer same-session request took over becomes a no-op. Stops a late old turn resurrecting a newer turn's state across desktop+mobile. **(S/M)**
- **`[Actual Claude]` per-message `/rewind` file checkpoints (content-addressed, hardlink resume)** — `utils/fileHistory.ts:86,347,725,922`. Before each edit, copy the file to `~/.claude/file-history/<session>/<sha256(path)>@vN` (keyed by messageId, cap 100); `/rewind` restores the FS to any prior turn (deletes files that didn't exist, stat+size+mtime short-circuit before content compare); resume hardlinks old backups into the new session dir. Finer than git, survives resume. **(M)**
- **`[opencode]` shadow-git snapshots with object-DB alternates seeding** — `snapshot/index.ts:200,218,334`. A per-worktree checkpoint store in a *separate* GIT_DIR under app data (never touches user `.git`), seeded from the real repo via `objects/info/alternates` + copied index so `git add --all` reuses existing blob hashes ("minutes→instant" on chromium-scale); `feature.manyFiles`, `index.version=4`, 2MB large-file exclude, batched revert, hourly gc. Instant "revert everything since message N" without polluting history. **(L)**
- **`[nanoclaw]` DB-sourced per-group container config with `on_wake` restart-race guard** — `db/container-configs.ts`, `container-config.ts`, `modules/self-mod/apply.ts`. Runtime config (provider/model/packages/MCP/mounts/scope) lives in a DB table, materialized to JSON only at spawn; an agent's self-service reconfig request → single approval → rebuild → `on_wake` message → kill+respawn, where the `on_wake` column guarantees only the fresh container's first poll consumes it (a dying container in SIGTERM grace can't steal it). DB as source of truth + safe live reconfig. **(M)**

## H. Infra, UI, ops & misc

- **`[nanoclaw]` clidash — zero-frontend read-only ops dashboard derived from any `--json` CLI** — `.claude/skills/add-clidash/.../server.js:80`, `app.js:665`, `parsers.js:24`. Derives tabs by parsing a CLI's `help`, builds tables as the union of keys across `<cli> <resource> list --json`, adds `enrich` (id→label cross-ref), status badges, summary bars, log tails, glob-allowlisted file viewer — all from one JSON config; `execFile` (never shell), GET-only, allowlist-validated. Point it at an AIO admin CLI/MCP tool for an instant ops panel with zero Angular work. **(M)**
- **`[Actual Claude]` VCR record/replay for LLM calls with path/UUID dehydration** — `services/vcr.ts:88,291,349`. Hashes the *dehydrated* request (cwd→`[CWD]`, config-home, durations, Windows-path variants normalized) to a fixture; replays from disk or records; CI errors "re-run with VCR_RECORD=1" on a miss; replayed msgs get fresh UUIDs, cached cost still counted. Deterministic zero-token tests for AIO's agent/debate/verifier suites (cross-platform normalization solved). **(M)**
- **`[Actual Claude]` host AIO's own MCP tools to a child CLI with NO socket** — `services/mcp/InProcessTransport.ts:57`, `SdkControlTransport.ts:60,109`. (1) A linked transport pair (`send`→`onmessage` via `queueMicrotask`); (2) a control-message bridge wrapping JSONRPC in stdout control frames tagged `server_name`+`request_id` to multiplex several in-process MCP servers over the child's existing stdio. Removes the localhost socket AIO's `mcp__orchestrator__*` currently needs. **(M)**
- **`[jean]` single-thread round-robin sweep poller with condvar wake + in-flight guards** — `background_tasks/mod.rs:488,546,106,282`. One thread blocks on a condvar that state changes notify (instant reaction, cheap idle); non-active worktrees swept round-robin (one per tick) for PR and git separately (N worktrees = one API call/tick); long jobs guarded by `AtomicBool::swap`; gated on window focus. Bounds outbound polling across many instances vs thundering per-instance timers. **(M)**
- **`[hermes]` + `[CodePilot]` missed-run catch-up grace + backlog collapse for schedules** — hermes `cron/jobs.py:651,1752`; CodePilot `task-scheduler.ts` (R1). Grace = half the period clamped 120s–2h (daily missed <2h catches up, 5-min fast-forwards); a job stale by >1 period fires once now and jumps `next_run` to the next future occurrence (no burst-fire, no perpetual defer). Exactly the policy for a laptop that sleeps. **(M)**
- **`[jean]` inject the orchestrator's assembled context into a raw interactive CLI terminal** — `chat/context_instructions.rs:353,295`. Assembles a markdown blob (global+project prompts, linked GitHub/Linear/saved-context files) to a file, passed via each CLI's native flag: Claude `--append-system-prompt-file`, Codex `--config base_instructions=<toml-escaped>`. Bridges AIO's context/memory into user-driven terminal sessions that start context-blind. **(M)**
- **`[codex]` AGENTS.md discovery: root-marker walk-up, root-first merge, byte budget** — `core/src/agents_md.rs:155,89`. Walk up to a `.git` root, collect every `AGENTS.md` root→cwd, reverse to broad→specific, prefer `AGENTS.override.md`, enforce a total `project_doc_max_bytes` (truncate per file), inject a `REPLACEMENT_NOTICE` on mid-session change; injected as input items not merged into the system prompt. Robust project-instruction discovery with an anti-runaway cap. **(S)**
- **`[nanoclaw]` one narrow ChannelAdapter interface with per-platform-instance namespacing** — `channels/adapter.ts:114`, `chat-sdk-bridge.ts:131,232,397`. ~10-method interface; the bridge maps the Chat SDK's four dispatch paths onto one `onInbound` and supports N instances of one platform (three Slack apps) by keying webhook route + SQLite state on an `instance` name; outbound paragraph→line→char splitting to each platform's cap; index-encoded button callbacks for Telegram's 64-byte limit. Add many notify/control surfaces (multiple bots per project) behind one contract. **(M)**
- **`[hermes]` auxiliary-VLM fallback so text-only models can "see" screenshots** — `tools/computer_use/vision_routing.py:1`. If the acting model supports vision AND the provider accepts multimodal tool-results, pass through; else route the screenshot through a dedicated `auxiliary.vision` model that pre-analyses it to text (fails closed to aux). Turns a fatal "No endpoints support image input" into one cheap extra call — relevant to AIO's browser-gateway screenshots across text-only CLIs. **(M)**
- **`[hermes]` background co-work desktop control with per-run agent cursor** — `tools/computer_use/backend.py:155`, `computer_use/__init__.py`. Focus-without-raise (SkyLight private SPIs) + pid-scoped event posting so the agent drives apps without stealing the user's cursor/keyboard/Space; each run gets a distinct-colored virtual "agent cursor" overlay for attribution. Makes OS-level desktop control usable on a machine the human is also using — AIO has browser-gateway but no desktop control. **(L)**
- **`[opencode]` deterministic session-hash A/B provider selection** — `tool/websearch.ts:30`. With no override, pick the backend by `checksum(sessionID) % 2` — stable per session, evenly split, env-overridable. Zero-infra A/B or load-balance between equivalent providers/models for AIO's failover/experimentation. **(S)**
- **`[CodePilot]` refuse to fabricate a context window; show untrusted used-tokens only** — `agent-loop.ts:718`, `context-pruner.ts`. When the runtime doesn't report a model context window, leave `context_window` absent rather than laundering a static-catalog guess into a field the UI treats as authoritative; trusted (runtime) vs untrusted (catalog) source priority. Avoids a "200K" guess rendered as a trusted capacity bar across heterogeneous CLIs. **(S)**
- **`[CodePilot]` outbound delivery reliability (HTML→plain fallback, partial-continue, safe offset watermark)** — `bridge/delivery-layer.ts:224,273`. Classifies send failures, retries only retryable honoring `retry_after`, re-sends as plain text on an HTML parse error; multi-chunk sends continue past a failed chunk then notify "N/M parts failed"; inbound separates `fetchOffset` from `committedOffset` (advance the durable watermark only after full handling). For AIO's mobile-gateway egress + at-least-once inbound. **(M)**
- **`[opencode]` coalescing debounced sync queue for live session sharing** — `share/share-next.ts:120,99`. Updates written into a Map keyed by stable identity (`part/{messageID}/{id}`) so repeated updates to one entity collapse to one, flushed on a 1s debounce in a forked scope. Right pattern if AIO adds "share this run as a live web view" / remote-observer streaming (avoids per-token transport hammering). **(M)**
- **`[pi]` runtime resource discovery + markdown slash-commands with bash-style arg substitution** — `examples/extensions/dynamic-resources/index.ts:7`, `core/prompt-templates.ts:69`. Extensions inject skills/prompts/themes by returning paths from a `resources_discover` event (re-fired on `/reload`, no restart); `.md` prompts become slash commands supporting `$1`, `$@`, `${N:-default}`, `${@:N:L}` + frontmatter `argument-hint`. Hot-reload for AIO skills + code-free parameterized commands. **(M)**
- **`[agent-orchestrator]` point at a SKILL.md, don't inline the CLI catalog** — `session_manager/manager.go:1559`. Every system prompt appends a short pointer to read an absolute-path `SKILL.md` + `commands/*.md` for the full CLI catalog instead of inlining flags/examples. Converts a per-turn catalog dump into read-on-demand — token-cost win on long sessions where AIO injects its own tooling instructions. **(S)**

---

## Round 2 per-project tally

Actual Claude 13 · opencode 13 · codex 16 · agent-orchestrator + CodePilot ~11 · hermes + jean ~14 · pi 8 · OB1 6 · nanoclaw 6 · storybloq 6 · oh-my-opencode-slim 6 · online-orchestrator 5. (~104 new items; overlaps with Round 1 dropped.) Combined with Round 1 the doc now catalogues ~230 distinct steal-worthy items across all 19 substantive sibling projects.

Two more minor leads noted but not expanded (both S if wanted): jean's 3-tier adaptive NDJSON tail cadence (5/50/250ms, `chat/tail.rs:38`) and hermes' slice-polling heartbeat during blocking user-clarify waits (`clarify_gateway.py:169`).
Two more minor leads noted but not expanded (both S if wanted): jean's 3-tier adaptive NDJSON tail cadence (5/50/250ms, `chat/tail.rs:38`) and hermes' slice-polling heartbeat during blocking user-clarify waits (`clarify_gateway.py:169`).

---
---

# Round 3 — additional finds (deepest pass)

> A third sweep aimed at the projects that never got a *deep* pass — copilot-sdk (its whole `docs/features` set + SDK internals), t3code's Effect orchestration internals, openclaw's core runtime (17k files), hermes' tool/provider layer — plus the remaining unmined corners of mempalace/oh-my-codex/rtk and the fresh Actual-Claude/codex surface (doctor, output-styles, marketplace, TUI, otel, review). ~82 NEW items; none duplicate Rounds 1–2. New themed sub-sections (I–O). Same tags/effort legend.

## Round 3 top picks

1. **Progressive/lazy tool disclosure gated on context-%** — **converged again**: `[hermes]` `tools/tool_search.py:1` (strip deferrable tools past ~10% of window, replace with `tool_search`/`describe`/`call` bridge, rebuilt every assembly) + `[codex]` `tool_search` (R2). The definitive fix for "MCP + plugins + adapters blow every prompt." **(M)**
2. **Live context-window breakdown by source/category** — **converged three ways**: `[copilot-sdk]` `session.metadata.getContextAttribution`/`getContextHeaviestMessages` (`rpc.ts:17663`), `[hermes]` `agent/context_breakdown.py` (shares the compactor's own math), `[t3code]` `ContextWindowMeter` (window-fill vs lifetime + per-provider auto-compact flag). Precise "what's eating the window" for AIO's compaction triggers + a shippable transparency panel. **(S/M)**
3. **Pluggable ContextEngine interface** — **converged**: `[hermes]` `agent/context_engine.py` (ABC lifecycle) + `[openclaw]` `src/context-engine/host-compat.ts` (per-op capability negotiation + `thread_bootstrap` vs `per_turn` projection). Decouples compaction so persistent-thread (Codex app-server) vs stateless CLIs get correct handling, and lets AIO A/B strategies. **(L)**
3b. **Fleet-mode: SQLite todos + deps DAG as durable shared coordination** — `[copilot-sdk]` `docs/features/fleet-mode.md`, `session.plan.readSqlTodosWithDependencies`. Parallel sub-agents claim ready todos via a dependency-satisfaction query; survives restart, queryable for progress UI. Directly de-islands AIO's supervisor trees. **(M)**
4. **Model-emitted tool-call repair grammar** (salvage prose/Harmony/XML-ish tool calls into native `toolUse`, tolerant of split streaming) — `[openclaw]` `packages/tool-call-repair/*`. Recovers turns Codex/Gemini/local models would otherwise fail or loop on. **(M)**
5. **Assistant-emitted markdown action directives** (`::git-stage`, `::git-create-pr`, `::code-comment` stripped from text → one-click buttons + jump-to-file review rows) — `[codex]` `tui/src/git_action_directives.rs:55`. A provider-agnostic side-channel to turn any CLI's text into structured UI, no bespoke tool protocol. **(M)**
6. **Content-level skill/config safety gates** (AIO loads skills/plugins/MCP/CLAUDE.md from cloned repos with no content gate): `[openclaw]` skill security scanner (prompt-injection + code-exfil heuristics, `src/skills/security/scanner.ts:163`); `[rtk]` trust-before-load hash-pinned config that **skips, not warns** (`src/hooks/trust.rs:97`); `[rtk]` hook-integrity SHA-256 sidecar (`src/hooks/integrity.rs`); `[Actual Claude]` unreachable/shadowed permission-rule linter (`utils/permissions/shadowedRuleDetection.ts:60`). **(S–M each)**
7. **Summarize-on-overflow shell wrapper via a loopback local model** — `[oh-my-codex]` `crates/omx-sparkshell/src/main.rs:108`. Runs the real command, and only past a line threshold redacts+truncates and POSTs to a local model for `summary/failures/warnings`; raw under threshold, raw on failure. Attacks the biggest token sink (cargo/pytest/npm output) before it reaches the coordinator. **(M)**
8. **Bitemporal knowledge graph with `as_of` queries + interval invalidation** — `[mempalace]` `knowledge_graph.py:106,330`. Facts are `valid_from/valid_to` triples; supersede sets `valid_to` (row retained); point-in-time recall + audit trail with no destructive edits. For AIO's staleness-prone semantic/procedural memory. **(M)**
9. **Addressable system-prompt sections + per-turn transform callback** — `[copilot-sdk]` `nodejs/src/types.ts:889`, `session.ts:1154`. Named sections (`identity`/`safety`/`custom_instructions`/`environment_context`…) each `replace`/`append`/`preserve` or transformed live per prompt build. Clean seam for injecting memory/RLM/codemem without clobbering guardrails. **(M)**
10. **Event-sourced orchestration engine with deterministic replay** — **converged**: `[oh-my-codex]` `crates/omx-runtime-core/src/engine.rs:103` (command→event, exclusive-lock persist, compact, compat views) + `[t3code]` event provenance (R1/R3). Crash-safe recovery + time-travel debugging of a stuck swarm, one state source for main+renderer. **(L)**
11. **Reasoning-effort reconciliation per model family** — **converged**: `[openclaw]` `packages/agent-core/src/reasoning.ts` ("off"→"low" where a family can't disable), `[hermes]` LM Studio `allowed_options` clamp, `[hermes]` reasoning stale-timeout floor. Stops "off means broken / high isn't supported / watchdog kills the think" across heterogeneous providers. **(S)**
12. **Two-tier feature-flag reads + fail-open remote killswitch** — `[Actual Claude]` `services/analytics/growthbook.ts:734`, `sinkKillswitch.ts`. `getFeatureValue_CACHED_MAY_BE_STALE` (hot path, no network) vs `_BLOCKS_ON_INIT`, plus a remote JSON killswitch per subsystem. Dark-launch or instantly kill loop-mode/RLM/debate in the field. **(M)**

## Round 3 convergence signals

- **Lazy tool loading** (hermes bridge + codex tool_search) and **context-attribution telemetry** (copilot + hermes + t3code) — both hit by 3 independent projects; strongest R3 signals.
- **Pluggable context/compaction engine** — hermes + openclaw, same shape (capability-negotiated, projection-mode-aware).
- **Event-sourced replayable coordination** — oh-my-codex engine + t3code OrchestrationEventStore + copilot fleet SQLite DAG. Three takes on "durable, queryable, restart-safe multi-agent state."
- **Turn-granular checkpoint via isolated git index** — now **four** independent implementations: t3code CheckpointStore, opencode shadow-git (R2), CodePilot file-checkpoint (R1), Actual Claude `/rewind` (R2). Overwhelming signal AIO should build this.
- **Reasoning-effort per-family reconciliation** — openclaw + hermes(×2) + pi resolver (R2).
- **Content-hash trust/integrity gates on attacker-controllable inputs** — rtk trust + rtk hook-integrity + openclaw skill-scanner + Actual Claude dangerous-diff (R2).
- **Local/cheap-model output compression at the tool boundary** — oh-my-codex sparkshell + hermes web_extract + oh-my-opencode-slim secondary-model (R2) + rtk filters (R1).

---

## I. Context window: transparency, tool-load & prompt shaping

- **`[hermes]` progressive tool disclosure (tool_search bridge)** — `tools/tool_search.py:1,163`. Past ~10% window, deferrable tools are replaced by `tool_search`/`tool_describe`/`tool_call`; catalog rebuilt statelessly every assembly (never session-cached → avoids silent tool-dropout); bridge calls route through normal guardrails. **(M)**
- **`[copilot-sdk]` per-source context attribution + heaviest-message introspection** — `rpc.ts:17663`. Nested (parentId) token breakdown per source (skills/sub-agents/MCP/tools/system) + heaviest individual messages + a re-tokenize-against-model call for accurate resume estimates. **(M)**
- **`[hermes]` live context-window breakdown by category** — `agent/context_breakdown.py:18`. Next-request tokens split across system tiers/tool schemas/rules/skills/MCP/subagents/memory/conversation using the *same char/4 heuristic as the compactor* so panel and compactor agree; per-category color vars. **(S)**
- **`[t3code]` context-window telemetry split (window-fill vs lifetime + auto-compact flag)** — `apps/web/src/lib/contextWindow.ts:50`. Distinguishes `usedTokens` (current window) from `totalProcessedTokens` (cumulative) and surfaces a per-provider `compactsAutomatically` boolean that changes UI copy. Small data-model fix so compaction is legible. **(S)**
- **`[Actual Claude]` `/doctor` context-budget audit** — `utils/doctorContextWarnings.ts:41`. One health command flags oversized CLAUDE.md (>40k chars), agent-description bloat, MCP-tool schema bloat (25k via `countMcpToolTokens`), version-lock + env + parse warnings. Quantifies per-source prompt inflation. **(M)**
- **`[copilot-sdk]` addressable system-prompt sections + `systemMessage.transform`** — `nodejs/src/types.ts:889`, `session.ts:1154`. Named sections each `replace/remove/append/prepend/preserve`, plus a per-turn round-trip so the host rewrites each rendered section dynamically. **(M)**
- **`[copilot-sdk]` `defaultAgent.excludedTools` — hide heavy tools from the orchestrator to force delegation** — `docs/features/custom-agents.md:766`. Tools stay executable but invisible to the main agent; only named sub-agents can call them. Context hygiene for supervisor agents. **(S)**
- **`[hermes]` + `[openclaw]` pluggable ContextEngine** — hermes `agent/context_engine.py` (ABC: should_compress/compress/on_session_start/update_from_response, session-boundary only); openclaw `src/context-engine/host-compat.ts:74` (per-op `requiredCapabilities`, host advertises support, `contextProjection: thread_bootstrap|per_turn`, `promptAuthority` for honest overflow prechecks, `delegate.ts` reuses stock compaction). **(L)**
- **`[copilot-sdk]` manual/focused compaction + truncate-to-event + `summarizeForHandoff` RPCs** — `rpc.ts:17747`. On-demand compaction with focus instructions returning `tokensFreed`/summary; truncate to an event id; cancel in-flight; markdown handoff summary; infinite-session `backgroundCompactionThreshold`/`bufferExhaustionThreshold` ratios. Trigger focused compaction before a debate/verify step. **(M)**
- **`[codex]` materialize oversized objective/pastes/images to files with a reference stub** — `tui/src/goal_files.rs:33`. Past `MAX_THREAD_GOAL_OBJECTIVE_CHARS`, spill to `$CODEX_HOME/attachments/<uuid>` and replace inline text with "read the file at <path>"; round-trip to re-expand for editing. Prevents bloat up-front vs compacting after. **(M)**
- **`[mempalace]` prompt-contamination mitigation ladder for embed-search queries** — `query_sanitizer.py:41,105`. When a query >~200 chars (agent leaked its system prompt into the search string), recover intent: last `?`-sentence → last meaningful tail → 250-char truncation + quote stripping. Documents the failure: a 2000-char prompt collapses recall ~90%→~1%. Guard in front of every AIO embed-search. **(S)**
- **`[hermes]` `@`-reference expansion with token budget + secret-path firewall** — `agent/context_references.py:19,181`. `@file:"path":10-20`/`@folder:`/`@git:`/`@url:`/`@diff`/`@staged` inlined with token counting; refuse >50% window, warn >25%; hard-block any path under `.ssh/.aws/.gnupg/.kube/.docker/gh` + OAuth files before read. **(M)**

## J. Provider / model layer & reliability

- **`[openclaw]` transient-vs-fatal retry classifier (walks `cause` chains)** — `src/provider-runtime/operation-retry.ts:146,184`. Retries only 5xx/`ECONNRESET`/`ETIMEDOUT`/timeout-named (incl. nested `error.cause`); *refuses* 400/401/403/404 + "invalid api key/model not found/validation"; per-stage defaults (create=no-retry). Stops retrying a 401 that just wastes quota and delays failover. **(S)**
- **`[hermes]` cross-session rate-limit breaker with account-vs-model discrimination** — `agent/nous_rate_guard.py:71,192`. First 429 writes reset-time to a shared file every process checks before firing (kills 3×3=9-call amplification); distinguishes account-RPH exhaustion (trip shared breaker) from a single-model 429 (don't block sibling models). **(S)**
- **`[openclaw]` model-emitted tool-call repair grammar** — `packages/tool-call-repair/src/grammar.ts:139`, `promote.ts:173`. Detects prose/Harmony/`[tool]\n{json}`/XML-ish/`[END_TOOL_REQUEST]` tool calls and promotes to native `toolUse`, tolerant of payloads split across streaming parts. **(M)**
- **`[hermes]` + `[opencode]` models.dev offline-first capability + cost DB** — hermes `agent/models_dev.py` (bundled snapshot → disk cache → network → 60-min bg refresh; 4000+ models: context/output/$/M/reasoning/vision/PDF/cutoff/deprecation). Auto-populates AIO's model config/cost/capability gating without hardcoding. **(M)** — ↺ opencode R1.
- **`[openclaw]` + `[hermes]` reasoning-effort reconciliation** — openclaw `packages/agent-core/src/reasoning.ts:24` ("off"→"low" for Fable-5-on-bedrock, true "off" for Sonnet-5, per-model `thinkingLevelMap`); hermes LM Studio `resolve_lmstudio_effort` (clamp to advertised `allowed_options`) + `reasoning_timeouts.py` (per-model stale-timeout **floor** so the watchdog can't kill a long think + correct guidance vs the wrong "use execute_code" advice). **(S)**
- **`[copilot-sdk]` auto-mode-switch: degrade to autopilot on rate limit** — `types.ts:1142`, `session.ts:981`. On an eligible rate-limit error, ask the host `AutoModeSwitchRequest{errorCode,retryAfterSeconds}` → `yes/yes_always/no` flips interactive→autopilot so work continues through the limit window unattended. **Adapter/engine.** **(S)**
- **`[copilot-sdk]` MCP-initiated sampling (reverse inference) round-trip** — `session-events.ts:7013`, `rpc.ts:6408`. An MCP server asks the *host* to run inference (`CreateMessageRequest`), correlated by `requestId`, serviced via `respondToSampling`. **Adapter**: AIO must service these or sampling-using MCP servers hang (and could route them to any AIO model). **(M)**
- **`[copilot-sdk]` cloud-session first-prompt race (silent prompt drop)** — `docs/features/cloud-sessions.md:187`. `createSession` resolves before the remote worker connects; an early `send` throws internally but the wrapper swallows it and returns a `messageId` — prompt vanishes. Fix: await the initial `session.start` with `producer==="copilot-agent"`. **Adapter** correctness bug to guard. **(S)**
- **`[copilot-sdk]` AI-credits session budget with resume-safe "exhausted" interrupt** — `docs/features/session-limits.md`. `maxAiCredits` soft cap → `session_limits_exhausted.requested` pauses for a user decision; `session.usage_checkpoint` records durable `totalNanoAiu` surviving resume. Hard, resume-safe per-session spend guard vs silent overrun. **(M)**
- **`[Actual Claude]` two-tier feature-flag reads + per-sink killswitch** — `services/analytics/growthbook.ts:734`, `sinkKillswitch.ts:18`. `CACHED_MAY_BE_STALE` (memory-first, no hot-path network) vs `BLOCKS_ON_INIT`; exposure-dedup; env overrides; remote JSON killswitch per sink, fail-open on malformed. Dark-launch/kill risky AIO subsystems. **(M)**
- **`[hermes]` (lead) multi-key `credential_pool` rotation within one provider on 429** — `agent/credential_pool.py`. If AIO doesn't already rotate multiple keys per provider before failing over, worth a look. **(S)**

## K. Tools, editing & output shaping

- **`[oh-my-codex]` summarize-on-overflow shell wrapper via loopback local model** — `crates/omx-sparkshell/src/main.rs:108`, `codex_bridge.rs:59`. Runs the real command; past a line threshold, redact + head/tail + POST to a loopback local model for `summary/failures/warnings`; raw under threshold / on failure; caches output hashes; `--since-last` emits only changed line-ranges. **(M)**
- **`[hermes]` in-tool web-result shaping (cheap-model summary, base64→link, full-text spill)** — `tools/web_tools.py:450,480,516`. `web_extract` runs content through a cheap model for excerpts; inline base64 images (token bombs) rewritten to links; full text spilled to a store with a reference footer. Reusable for any high-volume tool. **(M)**
- **`[hermes]` zero-dep docx/xlsx/ipynb extraction in read_file** — `tools/read_extract.py:18`. Renders notebooks/DOCX/XLSX to text by unzipping OOXML/JSON with the stdlib (per-sheet 5000-row/256-col caps), graceful fallback. Lets agents inspect real user docs without heavy parsers. **(S)**
- **`[rtk]` group-by-category collapse for lint/compile output** — `src/cmds/rust/cargo_cmd.rs:1060`, `js/tsc_cmd.rs:44`, `go/golangci_cmd.rs`. Bucket diagnostics by rule/code (clippy lint name, `TSxxxx` counts), emit "N errors across M files" + per-rule counts + representative locations, spill the tail to tee. Reusable wherever AIO surfaces build/lint logs. **(S)**
- **`[rtk]` lossless compaction: tee full output off-band + retrieval breadcrumb** — `src/core/tee.rs:186`. On truncation, write raw full output to a rotating tee dir and append `[full output: ~/path]` or `[see remaining: tail -n +{N} ~/path]`; default mode tees only on failures. Compact in-band, keep a byte-exact copy + the exact command to drill back down. **(M)**
- **`[t3code]` browser automation exposed to the agent as capability-annotated MCP tools** — `apps/server/src/mcp/toolkits/preview/tools.ts:1`, `PreviewAutomationBroker.ts`. `preview_click/type/navigate/snapshot/...` each `Tool.Readonly/Destructive/Idempotent`; a broker fans calls to a browser host via Queue+Deferred with typed failures. The annotations let AIO's approval layer auto-gate destructive browser actions like it gates shell/file writes. **(L)**
- **`[copilot-sdk]` `SessionFsProvider` — fully virtualizable agent filesystem + per-session SQLite** — `nodejs/src/sessionFsProvider.ts:34`. Intercept every agent file op (+ per-session SQLite queries) via a throw-based provider (ENOENT auto-mapped). Route agent I/O through worktree overlays / remote-node FS / an audited sandbox transparently. **(M)**
- **`[t3code]` TextGeneration — coding CLIs as cheap "utility LLMs"** — `apps/server/src/textGeneration/TextGeneration.ts:1`, `TextGenerationPolicy.ts`. Reuse the already-running CLIs to generate commit messages / PR title+body / branch names / thread titles from staged-diff context, following a `conventional_commits/repo_conventions/custom` policy. One typed service for low-stakes generation with no separate key. **(M)**
- **`[codex]` assistant-emitted markdown action directives** — `tui/src/git_action_directives.rs:55`. `::git-stage`/`::git-create-pr`/`::code-comment` embedded in the reply, stripped from visible text, parsed into one-click git actions + clickable `file:line` review rows. Provider-agnostic structured UI from any CLI's text. **(M)**
- **`[copilot-sdk]` agent-invocable Canvas panels** — `nodejs/src/canvas.ts:45`, `session.ts:800`. Extensions declare canvases (id + JSON-schema'd actions); the model opens/closes them and calls actions via `invoke_canvas_action`, routed in-process (handler closures stripped before the declaration crosses the wire). Protocol for the agent to drive rich interactive Electron surfaces beyond text. **(L)**
- **`[copilot-sdk]` PreToolUse arg-rewrite/suppress/skipPermission + PostToolUseFailure retry hook** — `docs/hooks/pre-tool-use.md:139`. `onPreToolUse` returns `modifiedArgs` (inject default timeouts / clamp paths), `additionalContext` (per-tool prompt injection), `suppressOutput` (keep noisy results out of context); `skipPermission:true`; a failure-only `onPostToolUseFailure` for retry guidance. **(S)**
- **`[openclaw]` declarative tool-availability signals that explain *why* a tool is hidden** — `src/tools/availability.ts:83`, `planner.ts:40`. Each tool carries `allOf`/`anyOf` over `auth`/`config`/`env`/`plugin-enabled` signals; the planner evaluates into typed diagnostics ("auth-missing: openai"), hides unavailable tools *with a reason*, throws only when a *visible* tool lacks an executor. One testable model that also produces "enable X to get this tool" UI. **(M)**
- **`[openclaw]` link understanding: auto-expand URLs in inbound messages via SSRF-guarded fetch + CLI processors** — `src/link-understanding/runner.ts:208`. Detect URLs, fetch through the guarded fetch (bounded body), pipe through configurable CLI processors, scope policy per channel, fallback to raw. Saves a tool call when a user pastes a link. **(M)**

## L. Memory & retrieval

- **`[mempalace]` bitemporal knowledge graph (`as_of` queries + interval invalidation)** — `knowledge_graph.py:106,330,57`. `valid_from/valid_to` triples; supersede sets `valid_to` (row retained); date-only normalized to day-bounds in SQL; inverted intervals rejected. Point-in-time recall + audit for staleness-prone facts. **(M)**
- **`[openclaw]` three-phase light/deep/REM "dreaming" memory consolidation** — `src/memory-host-sdk/dreaming.ts:37`. Cron-run: light (frequent, cheap 0.9-sim dedupe), deep (promote by recall-count + recency half-life + min-score, health-triggered recovery auto-writes only >0.97), REM (weekly cross-memory pattern extraction); each phase its own model tier. Tunable consolidation vs unbounded append. **(L)**
- **`[mempalace]` offline fact-checker (contradiction / stale-fact / name-confusion vs stored memory)** — `fact_checker.py:55,182,96`. Parses "X is Y's Z" claims and cross-checks the KG: `relationship_mismatch`, `stale_fact` (`valid_to` past), `similar_name` (Levenshtein ≤2 to a *different* entity). Run agent output/commit messages through it before acting. **(M)**
- **`[mempalace]` Hebbian potentiation + Ebbinghaus decay + Cepeda spacing salience score** — `dynamics.py:110,163`. Co-access bumps strength (cap 5.0); decay `old*exp(-days/stability)` floored 0.05; stability grows only on *spaced* (≥1h) reinforcement, not bursts. Self-contained frequency/recency salience booster for ranking memories/chunks. **(M)**
- **`[mempalace]` resume-safe message-granular ingest (deterministic IDs + strict-`<` cursor)** — `sweeper.py:193,183,147`. Deterministic drawer ID (rerun = no-op upsert); per-session cursor = `max(timestamp)`; skip `timestamp < cursor` (strict, so same-max-timestamp messages aren't lost after a partial-crash). Crash-safe dedup-free incremental session→memory ingest with no separate bookmark. **(S/M)**
- **`[openclaw]` auto-capture durable user corrections into skill proposals** — `src/skills/research/signals.ts:9`, `autocapture.ts:208`. Scans *user* messages for prospective ("from now on…") + reactive ("that's not what I asked") corrections, routes to the best-matching skill by weighted token overlap, files a create/update proposal — runs even on failed turns (corrections there matter most); signal-hash dedup + keyed async queue. Closes AIO's skill-learning loop. **(M)**
- **`[openclaw]` portable trajectory support-bundle (session JSONL + runtime trace, redacted)** — `src/trajectory/export.ts:37`. Joins transcript + runtime trace (system prompt, tool defs, events), multi-layer redaction, bounded output. "What did this instance actually send the model" repro for debugging failover/debate or feeding a replay harness. **(M)**

## M. Orchestration, coordination & autonomy

- **`[copilot-sdk]` fleet-mode SQLite todos + deps DAG** — `docs/features/fleet-mode.md`, `rpc.ts:16612`. Parallel workers coordinate via a session-owned `todos(status)` + `todo_deps` table; a dependency-satisfaction query picks dispatchable work; DAG exposed for progress UI, refreshed on `todos_changed`. Durable, queryable, restart-safe. **(M)**
- **`[oh-my-codex]` event-sourced orchestration engine with deterministic replay + compat views** — `crates/omx-runtime-core/src/engine.rs:103,288,232`. All swarm state (lease/backlog/mailbox) mutates via `process(command)→event`; `load()` replays; `persist()` exclusive-locks `snapshot+events`; `compact()` drops terminal dispatches; `write_compatibility_view()` fans to per-section JSON. Crash-safe + time-travel debugging. **(L)**
- **`[oh-my-codex]` forgery-resistant consensus gate backed by an execution tracker** — `src/ralplan/consensus-gate.ts:696`. A plan can't advance unless `.omx/state/subagent-tracking.json` proves two distinct native subagent threads (architect then critic) actually ran + approved (session/thread ids resolve, distinct, correctly ordered, `completed_at` set); a claimed-but-unproven approval is rejected. Grounds AIO's debate/verify verdicts in evidence, not self-report. **(M)**
- **`[hermes]` tool-call loop guardrail (no-progress / repeated-failure halt)** — `agent/tool_guardrails.py:225,77`. Pure per-turn controller keyed by `(tool, sha256(args))` + result hash returns `allow|warn|block|halt`: block an exact call that already failed identically, warn/halt on N identical results ("no progress"), hard-halt after N same-tool failures. Side-effect-free breaker for any turn loop. **(M)**
- **`[hermes]` async delegation that re-enters as a fresh idle turn** — `tools/async_delegation.py:16,265`. `delegate_task(background=true)` returns immediately; on completion pushes an event drained into a NEW user turn only when the agent is idle (never spliced between tool result and assistant msg → preserves role alternation + prompt cache); payload is self-contained. **(M)**
- **`[oh-my-codex]` pane-liveness classifier that blocks premature shutdown** — `crates/omx-sparkshell/src/main.rs:701`. Classifies current pane/worker output into `busy_processing`(→"wait, do not shutdown")/`waiting_for_input`/`auth_error` with confidence, cross-checks `heartbeat.json` (>120s = `stale_heartbeat`). "Busy vs genuinely idle" guard distinct from post-run outcome classification. **(S)**
- **`[openclaw]` process-liveness-scoped runtime quarantine store (first-failure-wins, no TTL)** — `src/context-engine/quarantine-health.ts:28`. On subsystem failure, record keyed by `(engineId, processId)` with `pick:"earliest"` so health points at the *root cause* not the cascade; no TTL (expiry owned by process liveness); persists across sibling processes so a supervisor sees failures elsewhere. **(S)**
- **`[codex]` steering input-queue state machine** — `tui/src/chatwidget/input_queue.rs:22`. Separates messages that successfully *steer* an in-flight turn (`pending_steers`) from those *rejected* (retried first next turn); `submit_pending_steers_after_interrupt` resubmits queued steers as one fresh turn on interrupt. Correct "type while the agent works" semantics. **(M)**
- **`[t3code]` DrainableWorker: transactional queue worker with deterministic `drain()`** — `packages/shared/src/DrainableWorker.ts:1`. Tracks outstanding items in a `TxRef` so `drain` retries until the queue is empty *and* the in-flight item finished — replaces `sleep`-based test sync. Kills flaky timing-dependent tests on any AIO background consumer. **(S)**
- **`[codex]` git/GitHub status probes over a workspace-executor abstraction** — `tui/src/branch_summary.rs:1`. Branch/PR/added-deleted lookups talk only to a `WorkspaceCommandExecutor` (never `tokio::process`), so identical logic runs embedded or *remote*; every failure degrades to an absent field. Makes status/PR features work uniformly across local + remote-node instances. **(M)**
- **`[copilot-sdk]` cursor-based resumable event log with long-poll + expiry** — `rpc.ts:17811,4331`. Read from an opaque cursor with optional long-poll (`waitMs`≤30s); `tail()` snapshots the current tail to subscribe forward without replaying history; `cursorStatus:"expired"` signals compacted-away history; `registerInterest` gates production by demand. Robust reconnect for a crashed renderer/restarted main. **(M)**
- **`[codex]` recent guardian-denial ring for re-review** — `tui/src/auto_review_denials.rs:14`. Bounded 10-entry dedup ring of guardian denials (command/patch/network/MCP), each with a human summary, that the user can `take(id)` back to re-review/override. Lightweight "last N auto-denied things, click to reconsider" recovery surface. **(S)**
- **`[codex]` staged, core-confirmed transcript rollback (divergence-safe rewind)** — `tui/src/app_backtrack.rs:1`. Esc primes + captures `base_id`; second Esc opens overlay; Enter *requests* rollback and sets `pending_rollback`; only on core's confirm does it trim local transcript; invalidates if the thread changed underneath. The "stage → authoritative confirm → trim" protocol AIO's multi-instance/remote rewind needs. **(M)**

## N. Security & governance

- **`[openclaw]` skill security scanner (prompt-injection + code-exfil heuristics)** — `src/skills/security/scanner.ts:163`. Flags dangerous code (`child_process` exec, `eval`, obfuscated hex/base64, `readFile`+network = exfil, `process.env`+network within 8 lines = cred harvest) AND injection in skill *prose* ("ignore previous instructions", pipe-to-shell installs); comment-strip pass avoids false positives; mtime/size cache. Pre-install/pre-run gate AIO's skill/plugin/MCP loader lacks. **(M)**
- **`[rtk]` trust-before-load for attacker-controllable project config (skip, not warn)** — `src/hooks/trust.rs:97`. `.rtk/filters.toml` honored only if its SHA-256 matches a user-approved entry keyed by canonical path; untrusted/changed = skipped (not warned); errors fail-secure to `Untrusted`; the env override refuses unless real CI is detected. For AIO auto-loading skills/CLAUDE.md from cloned repos. **(M)**
- **`[rtk]` hook integrity: SHA-256 sidecar + read-only speed-bump + runtime tamper gate** — `src/hooks/integrity.rs:78,142,279`. Install writes the hook's hash in `sha256sum -c` format, chmod `0444`; every run recomputes and hard-exits on mismatch; malformed stored hashes rejected. ~50 lines closing a silent command-injection vector in AIO's PreToolUse rewriters. **(S)**
- **`[rtk]` permission-verdict→exit-code contract with "default must ask" invariant** — `src/hooks/rewrite_cmd.rs:7,145`. 0=allow / 1=passthrough / 2=deny / 3=ask, with `PermissionVerdict::Default→3` (never 0, regression-tested) so a no-explicit-rule command is never auto-approved just because it's rewritable. Testable least-privilege state machine. **(S)**
- **`[Actual Claude]` unreachable/shadowed permission-rule detection** — `utils/permissions/shadowedRuleDetection.ts:60`. Statically finds allow/ask/deny rules that can never fire because a broader rule shadows them, reports `{reason, shadowedBy, fix}`, aware that shared (project/policy) vs personal (user/local) sources and sandbox auto-allow change reachability. A linter for AIO's layered permission rules. **(M)**
- **`[openclaw]` SSRF-guarded fetch with DNS pinning + redirect header stripping** — `src/infra/net/fetch-guard.ts:1`, `packages/net-policy/src/ip.ts`. Resolve once + pin the dispatcher to that IP (defeats TOCTOU re-resolve to an internal host), private-IP/allowlist checks, per-redirect re-validation + cross-origin header stripping, per-call audit tag. One primitive for AIO's browser-gateway/webfetch/web-search/link-understanding. **(M)**
- **`[Actual Claude]` declarative marketplace reconcile with non-blocking background install** — `utils/plugins/reconciler.ts:44`, `services/plugins/PluginInstallationManager.ts`. Settings = declared intent, `known_marketplaces.json` = materialized state; compute `{missing, sourceChanged, upToDate}`, install the delta additively in the background with per-item `pending/installing/installed/failed` status, never blocking boot. Robust team-shared plugin/skill distribution. **(M)**
- **`[Actual Claude]` output-styles: markdown-driven system-prompt personalities** — `outputStyles/loadOutputStylesDir.ts:26`. `.claude/output-styles/*.md` (project > user + plugin), each body a swappable persona; frontmatter `keep-coding-instructions` decides whether to retain or replace the default coding scaffolding. User-installable voice/behavior profiles per project. **(S)**

## O. Infra, UX, perf & ops

- **`[t3code]` diff rendering: Web Worker pool + content-addressed patch cache** — `apps/web/src/components/DiffWorkerPoolProvider.tsx:1`, `lib/diffRendering.ts:18`. Syntax-highlight parsing in a worker pool sized `clamp(2..6, cores/2)` with a shared AST LRU (240) + `tokenizeMaxLineLength` guard; cache keys = two differently-seeded FNV-1a hashes + length. Offloads big diffs off the Electron UI thread, memoized by content not turn-id. **(M)**
- **`[t3code]` per-workspace fuzzy file index with idle-TTL eviction** — `apps/server/src/workspace/WorkspaceSearchIndex.ts:1` (`LayerMap`). Each cwd gets its own native file-finder index, lazily built, 25k cap, 15s scan timeout, **15-min idle TTL auto-destroy**. The right shape for any per-instance resource AIO holds (LSP servers, watchers, indexes). **(M)**
- **`[t3code]` user-customizable keybindings with a parsed `when`-expression AST** — `packages/contracts/src/keybindings.ts:60`, `apps/server/src/keybindings.ts:89`. VS Code-style `{key, command, when?}`; `when` parses to a depth-limited `identifier|not|and|or` AST; commands a closed set + a `script.<id>.run` pattern; server does shortcut-context conflict detection. Drop-in for user-remappable keys + contextual activation. **(M)**
- **`[t3code]` declarative source-control provider discovery (gh/glab/az/bitbucket)** — `apps/server/src/sourceControl/SourceControlProviderDiscovery.ts:1`. Each forge is a spec (`cli` with `executable/versionArgs/authArgs/parseAuth` or `api` with `probeAuth`); registry probes availability+auth, refines unknown remotes, caches per-cwd (5s TTL). Reusable "is gh/glab installed+authed?" pattern for AIO's PR/commit flows. **(M)**
- **`[t3code]` hidden-git-ref checkpoint timeline with a CheckpointReactor** — `apps/server/src/checkpointing/CheckpointStore.ts:1`, `orchestration/Layers/CheckpointReactor.ts`. Per-turn snapshots to hidden refs via an isolated temp git index (no touching the user's staging/commit log); reactor auto-captures on turn completion + diffs vs previous turn. **↺ converges with opencode shadow-git (R2) + CodePilot file-checkpoint (R1) + Actual Claude `/rewind` (R2) — four independent implementations.** **(L)**
- **`[t3code]` event-sourcing provenance: causation/correlation + inferred actor kind** — `apps/server/src/persistence/Layers/OrchestrationEventStore.ts:33,70`. Every event carries `causationEventId`, `correlationId`, and an `actorKind` inferred from the commandId prefix (`provider:`/`server:`→else `client`). Makes "who caused this in response to what" auditable across AIO's interleaved agent/server/user events, cheap on any append-only log. **(S)**
- **`[t3code]` `ServerConfig` as one derived-paths + observability service** — `apps/server/src/config.ts:26`. One `Context.Service` derives *every* state path (db/worktrees/attachments/logs/trace/secrets/ids) from one `baseDir` + folds in log level, OTLP URLs, trace batching, runtime mode. Clean seam for AIO's per-instance state dirs + trivial test isolation. **(S)**
- **`[codex]` fine-grained model-timing metrics with tag validation** — `otel/src/events/session_telemetry.rs:1`, `metrics/validation.rs:5`. Separates TTFT vs TBT at engine + service layers, inference-time vs API overhead, SSE/WS event counts, tool-call + startup timers; `validate_metric_name`/`validate_tags` reject bad chars before emission (no cardinality poisoning). Diagnose *which* CLI/model is slow and *where*. **(M)**
- **`[oh-my-codex]` fingerprint-gated notification dedupe (not just time cooldown)** — `src/notifications/idle-cooldown.ts:131`, `lifecycle-dedupe.ts:60`. Idle pings suppressed unless a *content fingerprint* changes (`stableSerialize` + 5s window); `tmuxTailFingerprint` stops re-seeing identical pane history. Ping the user only when something actually changed. **(S)**
- **`[copilot-sdk]` capability-gated elicitation UI (confirm/select/input, form + url modes)** — `nodejs/src/session.ts:208,1030`, `types.ts:673`. When the host advertises `capabilities.ui.elicitation`, the runtime drives host dialogs mid-turn via `session.ui.confirm/select/input` (JSON-Schema based), incl. a `url` mode redirecting to a browser (OAuth-style). Structured mid-run confirmations/choices from AIO's UI. **(M)**
- **`[hermes]` coding-posture as a single resolved `RuntimeMode` seam** — `agent/coding_context.py:1`. "Code workspace?" decided once into an immutable `RuntimeMode`/`ContextProfile` that every consumer (system prompt, toolset, delegation, model/memory hints) reads instead of re-probing git/config; git snapshot baked into the stable prompt tier once (cache-safe); `/coding` flips apply next session to protect the cache. **(M)**
- **`[t3code]` provider-quirk ACP extensions with Deferred-keyed out-of-band completion** — `apps/server/src/provider/acp/{XAiAcpExtension,CursorAcpExtension}.ts`. Vendor methods (Cursor `create_plan`/`ask_question`, xAI `ask_user_question`) normalized to canonical types; xAI sends a *separate* `promptComplete` notification correlated via a `Deferred` keyed by `promptId` (128-entry bound). The pattern for any CLI that decouples "done" from the response envelope. **(M)**

---

## Round 3 per-project tally

copilot-sdk 14 · hermes 14 · t3code 13 · Actual Claude + codex 13 · openclaw 12 · mempalace + oh-my-codex + rtk 16. (~82 new items; overlaps dropped.) **Grand total across Rounds 1–3: ~315 distinct steal-worthy items, every substantial sibling project deep-mined.**

Confirmed-not-worth-it (saves future passes): Actual Claude `/ctx_viz`, `/teleport`, `/summary` are disabled stubs; `/thinkback` is a "Year in Review" novelty; `/stickers` opens a StickerMule URL; codex `collaboration_modes.rs` is preset cycling only.

---

## Where the three rounds point (meta-summary)

The strongest signals — techniques ≥3 independent projects converged on, or that directly unblock AIO's own recorded gaps — cluster into a handful of bets:

1. **Make the canonical provider event lossless + event-sourced** (t3code `raw` union + NDJSON, codex/copilot cursor logs, oh-my-codex replay engine) — unblocks AIO's deferred Task 16/24 and gives reconnect + replay + time-travel debugging.
2. **Lazy tool loading + context-attribution telemetry** (codex/hermes tool_search, copilot/hermes/t3code breakdown) — the direct fix for AIO's per-turn tool-schema tax, with a shippable "what's eating my window" panel.
3. **Turn-granular checkpoint via an isolated git index** (four independent impls) — "undo this agent turn" without touching the user's git.
4. **A pluggable ContextEngine + a verify/evidence gate** (hermes/openclaw engine, hermes verify-on-stop, storybloq/oh-my-codex evidence gates) — de-islands loop mode and makes "done" mean verified.
5. **OS-level sandbox + content-trust gates** (codex seatbelt/seccomp recipes, nanoclaw egress, rtk/openclaw trust + skill scanner) — a hardened run mode + a real safety gate on cloned-repo skills/config.
6. **Token-reduction at the tool boundary** (rtk DSL, oh-my-codex sparkshell, hermes/oh-my-opencode-slim secondary-model) — compress noisy CLI output before it ever reaches the coordinator.## Appendix B — Earlier `_completed` passes (full item catalogue)

> These are prior investigation passes that were closed with the `_completed` suffix. Their full text lives in the referenced files (do not edit those — they are closed). Every item is enumerated here by title so all prior findings are catalogued in one place. Many are already reflected in AIO's current code and in the pass-2 sections above.

### B1. `docs/codex_todo_completed.md` — 71 items (full sibling scan, 3 passes)

**P0 — Structural:** 1 Finish extracting oversized coordinators and adapters · 2 Move startup wiring into the existing bootstrap registry · 3 Promote event sourcing to the default mutation path · 4 Add provider instance routing and canonical event logs.
**P1 — Provider/Tooling/Contract:** 5 Centralize provider request transformation and model option handling · 6 Add parser-backed shell permission extraction · 7 Introduce a shared keyed coalescing worker · 8 Add schema and API drift harnesses beyond generated IPC checks · 9 Add custom lint rules for local hot-path footguns · 10 Create a provider parity checklist and bind tests to it.
**P1 — Runtime Isolation & Agent UX:** 11 Add per-workspace scoped service state with disposal · 12 Make LSP a first-class agent tool surface · 13 Strengthen compaction summaries with a fixed anchored template · 14 Improve remote node access and pairing runbooks.
**P2 — Product/Maintenance:** 15 Add a durable session todo model · 16 Reduce renderer feature size through registries and facades · 17 Build a public contract artifact for advanced integrations.
**P1 — Additional Findings (full sibling scan):** 18 Provider Doctor with structured diagnostics and repair actions · 19 Standardize a runtime error taxonomy · 20 Deterministic provider and agent parity harness · 21 Expose a local app-server/control-plane API · 22 Trace bundles and replayable session transcripts · 23 Strengthen remote supervision and channel delivery semantics · 24 Optional hardened worker isolation for high-risk agents · 25 Harden plugin boundaries and package ownership · 26 Isolated hook/plugin runner semantics · 27 Single-source command/action/agent registry · 28 Cost-aware specialist delegation profiles and session reuse · 29 Project-level workflow state, handovers, and lessons · 30 Governed operational memory with provenance and review · 31 FTS and artifact-aware session search · 32 Command and tool output compression with raw-output tee · 33 IDE/LSP diagnostic baselines before edits · 34 Multi-lens review orchestration · 35 Selector/adapter resilience checks for browser and web UIs · 36 Native IPC, remote WebSocket, and app-server parity gates · 37 Frontend state performance guardrails · 38 Cross-platform policy helpers and lint checks · 39 Supply-chain and dependency drift guardrails · 40 Skill and prompt lifecycle curation.
**P2 — Second-Pass Operational Hardening:** 41 Session corruption fuzzing and repair observability · 42 Resource budget scheduler across instances/workers/providers · 43 Explicit, user-visible supervision recovery policies · 44 Checkpoint safety preview and restore transaction model · 45 Artifact attribution into a lineage graph · 46 Automation idempotency keys and catch-up ledgers · 47 MCP config diff, dry-run, and rollback · 48 Unify approval policy across shell/browser/MCP/files/channels · 49 Browser profile lifecycle and credential isolation · 50 Resumable, conflict-aware remote directory sync · 51 Centralize redaction as a reusable data-safety pipeline · 52 Learning and prompt-enhancement governance · 53 Retention, privacy, and storage quota controls · 54 Code index freshness and stale-result warnings · 55 Release readiness matrix by subsystem · 56 Operator incident timeline · 57 Provider and channel cost/budget enforcement · 58 Native CLI profile sandbox tests · 59 Import/export portability for memory/workflows/settings · 60 Accessibility and keyboard regression gates for the operator UI.
**P2 — Third-Pass Reliability/Distribution/Edge-Case:** 61 Transaction-backed migration framework for every durable store · 62 Previewable, typed, secret-safe settings import/export · 63 Harden webhooks as a public ingress surface · 64 Webhook adapter templates and payload mappers · 65 Worker-node output replay and acknowledgment semantics · 66 Worker service update rollback with health gates · 67 Remote worker token rotation and revocation drills · 68 Watchdog stall forensics and escalation policies · 69 Standardize bounded queues and lane policies · 70 Harden the local tool runner protocol and module trust boundary · 71 Install-method-aware, reversible CLI update actions.

### B2. `docs/claude_todo_completed.md` — 18 items (t3code + opencode comparison)

**P0 — Architecture:** 1 Unify & flatten the CLI adapter + provider layer · 2 Make the renderer↔main boundary a schema-first typed RPC · 3 Code-generate provider protocol bindings from pinned upstream schemas.
**P1 — Reliability & correctness:** 4 CLI subprocess fixture-replay (cassettes) — unblocks the deferred Task 24 · 5 Ship a reusable scripted/mock provider adapter for offline orchestration tests · 6 Cache SQLite prepared statements on the hot path · 7 Add metrics + complete OTel span coverage · 8 Crash capture & renderer crash recovery · 9 Auto-update & release/distribution pipeline.
**P1 — Guardrails, CI & testing:** 10 Harden secret passing to spawned helpers · 11 Ship a custom oxlint plugin for project invariants · 12 Close the CI coverage gaps · 13 End-to-end testing of the running app (Playwright) · 14 Sandbox plugins the way tools are already sandboxed.
**P2 — Developer experience & code health:** 15 Pin the toolchain + a deterministic, multi-instance dev-runner · 16 Ship a comprehensive, committed model-capability catalog · 17 Deterministic test synchronization (drainable workers) · 18 Consolidate the error taxonomy.

### B3. Archived earlier todos (`docs/_archive/`, for reference)

- `copilot_todo.md` (553 lines) — GUI/settings-focused pass.
- `claude1_todo.md` (467 lines) + `claude1_progress.md` (250) — first Claude-comparison backlog (31-item backlog referenced in project memory) and its progress log.
- `claude2_todo.md` (376 lines) — second Claude-comparison backlog.
- `tokens_todo.md` (85 lines) — token/cost-reduction focused pass.
- `docs/still_todo_1_completed.md` (33 lines) — residual items pass.

These predate the fable passes and are largely superseded, but are catalogued here so no prior finding is orphaned.
