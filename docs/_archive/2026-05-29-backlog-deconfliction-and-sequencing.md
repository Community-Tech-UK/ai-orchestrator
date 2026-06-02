# Backlog Deconfliction & Sequencing Map

> **Status:** Coordination artifact (untracked — do not commit per AGENTS.md). Not a plan to implement; a map so the in-flight work and the two backlogs don't collide.
> **Date:** 2026-05-29 → **Refreshed 2026-05-30** (this version supersedes the 05-29 "everything in-flight" snapshot; much has since landed).
> **Author:** Claude. Refreshed after a full re-read of every untracked doc + verification against the actual tree (file:line / test runs), because the 05-29 map described work that is now committed/staged and omitted the 05-30 mobile work.
> **Inputs re-read in full (2026-05-30):** claude1_todo, claude2_todo, claude1_progress, the docs/plans/ set (offload-architecture, loop-intelligence [superseded], loopfixex_completed, first-class-remote-orchestration [re-scoped], thin-client-replatform-followup, provider-model-auto-update [re-scoped], mobile-control-app-plan, bigchange_claude_launch_modes), plus live git status + tree verification.

## 1. TL;DR (what changed since 05-29)
- **Half the "plans" are now DONE, not pending.** Re-classified below. The dominant risk is no longer cross-document direction conflict — it's a fresh worker **re-implementing already-shipped work**.
- **The loop lane is closed.** `loopfixex_completed.md` (LF-1…LF-8) is implemented + verified (29 spec files / 289 loop tests green) and renamed `_completed`. `loop-intelligence-improvements` is SUPERSEDED. Loop-completion authority is **resolved** (§4.1) — one evidence-precedence ladder.
- **provider-auto-update Phase 1 shipped** (semver + latest-version detection + live pill). Only Phase 2 (auto-apply) + Phase 3 (model-catalog freshness, partly built) remain.
- **Remote orchestration Piece A is ~80% plumbed** (the `node` field + `forceNodeId` resolution landed); Piece B is **re-scoped** to the evidence-resolver spine + convergence cycle (the verified-loop core already shipped via loopfixex).
- **Mobile control app** (05-30) is IMPLEMENTED (Phases 0–3 + push), staged, pending real-device test. It was not in the 05-29 map.
- Hygiene done: deleted two `.fuse_hidden*` orphan copies of loopfixex in `docs/plans/`.

## 2. Current tree state (verified 2026-05-30)
- **Staged (22 files)** — a partial commit in progress spanning mobile-gateway (`src/main/mobile-gateway/*`, `apps/mobile/*`, mobile settings/types), loop/instance (`instance-manager.ts`, `instance-output.store.ts`, `instance-state.service.ts`), `base-cli-adapter.ts`, `command-manager.ts`, `index.ts`. Treat all of these as **claimed/landing — do not touch until committed.**
- **Untracked docs** — the eight planning docs (this file, claude1/2_todo, claude1_progress, offload, loop-intelligence, provider-auto-update, mobile, remote, thin-client, launch-modes). Keep untracked per AGENTS.md.
- **Untracked code** — `apps/mobile/src/app/{core,features}/*`, `src/main/commands/command-interpolation.{ts,spec.ts}` (claude1 #22, done-uncommitted), `src/main/mobile-gateway/mobile-apns-sender.{ts,spec.ts}`.

## 3. Re-classification: DONE vs OPEN (the important table)

### ✅ Done / shipped — do NOT re-implement
- **Loop intelligence + termination + UX** — loopfixex LF-1…LF-8 (context discipline, semantic progress, cost cap $10, RPI ledger, branch-select, cross-loop memory, operator-accept + completion budget, loop visual model). 289 loop tests green.
- **provider-auto-update Phase 1** — `cli/semver.ts`, `cli/cli-latest-version.ts`, poll-service `updateAvailable` wired, `providers/models-dev-service.ts` + `shared/data/model-pricing.ts` exist.
- **claude1 fast-wins** — #5 exact cost (core), #6 block-memoized markdown, #7 transcript cap, #8 runtime_lost surfacing, #17 teardown escalation, #19 trust controls, #22 command interpolation, #25 store no-op guards (per `claude1_progress.md`, code-verified).
- **Main-thread offload Phases 1, 2, 4** — conversation-ledger worker (`conversation-ledger-worker-*.ts`), code-search off-thread (`index-worker-gateway.ts` / `code-retrieval-service.ts`), bounded ledger reads. (Per `main-thread-offload-status` memory + tree.)
- **Mobile control app** — gateway + phone app Phases 0–3 + APNs push. Pending: real-device Tailscale test only.
- **Remote Piece A** — code-complete: `node` field, prompt surfacing + live node snapshot (`orchestration-protocol.prompts.ts`), `resolveChildNodeId`/`forceNodeId`, **and** capability-tag resolution (`worker-node-registry.ts:179-201`). Only **live verification** remains (see OPEN).

### 🟡 Genuinely OPEN — safe to sequence (re-check the diff before starting)
- **Remote Piece A — live verification only** (the code is done): confirm `report_result` round-trips over `RemoteCliAdapter`, then an end-to-end demo on `windows-pc`. **Needs a live worker — not headless.** No further implementation expected.
- **Remote Piece B re-scoped** (M) — NEW `evidence-resolver.ts` spine (= claude2 #1) + convergence fix→verify→review cycle + review quality (diversity/dedup/diff-scope/thread-fingerprint) + reviewer node/model diversity. **Owns the loop-completion files now — single owner.**
- **provider-auto-update Phase 3-A** (S–M) = **claude1 #9** — wire existing `models-dev-service.ts` into the model picker. Phase 2 (auto-apply) + Phase 3-B (catalog sync) follow.
- **Main-thread offload Phases 3/5/6** (M, needs packaged rebuild — partly headless-blocked) — enricher offload, startup learning loads, session save.
- **launch-modes** (M) — Interactive vs Orchestrated Claude. Phases 0–1 are independent; **Phase 2 is gated on remote Piece C** (terminal host) and needs a live machine.
- **claude1 M-features** — #10 durable resumable streams, #11 multi-provider compare UI, #12 magic prompts, #13 LSP post-edit feedback, #14 session sharing, #15 checkpoint timeline UI, #18 glob per-agent perms, #21 config interpolation, #26 phase/role routing, #27 repo-map injection, #28 permission verbs, #29 diff/plan UX, #30 MCP marketplace, #31 session search.
- **claude2 net-new layer** — ⚠️ **verify each item's "Today" premise before scoping.** claude2_todo's gap descriptions predate recent landings; spot-checks already found #3's premise stale (hooks executor dir exists) and the loop items (#1 folded into the shipped evidence model). Read the cited files first; the BSD-grep/wrong-file false-negative is easy to hit here. Items: #2 sandbox teeth (credential-proxy/OS-enforce/egress), #3 executable hooks (**premise likely STALE — re-verify first**: `src/main/hooks/hook-engine.ts` + `src/main/hooks/executor/{hook-command,hook-prompt,hook-script}.ts` + `enhanced-hook-executor.ts` + `webhooks/webhook-server.ts` already exist, so command/prompt/script/http hook *execution* is at least partly built, contradicting claude2 #3's "hooks can only warn/block" premise; the genuinely-missing slice is probably the synchronous PreToolUse allow/deny/modify + `updatedInput` interception — scope against the existing executor dir, don't rebuild), #13 tool-output compression, #14 verbatim memory tier, #15 durable handovers, #17/#18 role libraries + depth guard, #19 toolset registry, #20 safety critic, #21 lease+mailbox, #22 MCP self-orchestration verbs, #23–#30 UX (panel zone, attention dashboard, setup center, themes, model picker, split-screen, output styles), #31 web-build E2E + scripted mock, #32 policy engine, #33 idempotency journal, #34 compaction canary, #35 channel SDK.

### ⛔ Deferred / do-not-start
- **thin-client replatform** — correctly deferred; trigger conditions unmet.
- **Remote Piece C / launch-modes Phase 2 / any node-pty / packaged-rebuild / native ABI** — cannot be built or verified headless.
- The **architectural rocks** (claude1 #1 thin-client event API, #2 typed RPC codegen, #3 adapter unification, #16 utilityProcess CLI-parse offload, #20 mock-adapter+E2E, #23 plugin sandboxing) — multi-week, need a design pass + operator decision; do not start autonomously.

## 4. The genuine cross-document conflicts (resolved)

### 4.1 Loop-completion authority — RESOLVED: one evidence-precedence ladder
Four docs touched the completion path (loopfixex LF-7 [merged], remote Piece B, claude2 #1, loop-intelligence P0-B). **Decision (2026-05-30):** a single resolver evaluates a fixed ladder — **(1) runtime truth → (2) external ground-truth** (verify green · SCM/CI · empty unresolved-review-thread fingerprint) **→ (3) structured in-band intent** (`declared-complete`) **→ (4) forensic markers** (corroboration only). Tier 2 is the only authority for an *autonomous* terminal; the agent may never self-declare. `completed-needs-review` is the **human-escalation terminal used only when no tier-2 authority exists**. This makes LF-7 (shipped), Piece B, and claude2 #1 one consistent model with **zero rework of merged code**. Implementation home: **remote Piece B's `evidence-resolver.ts`** (build once). loop-intelligence P0-B = superseded.

### 4.2 models.dev — build once, owner is provider-auto-update
Appears in provider-auto-update Ph3, claude1 #9, claude2 #12. `models-dev-service.ts` + `model-pricing.ts` already exist (the fetch is built). **Resolution unchanged:** provider-auto-update owns it; the open slice is "wire into the picker" (= claude1 #9 Phase 3-A). Strike #9/#12 from any fresh worker's list as separate items.

### 4.3 (corrected) claude1 #16 ≠ main-thread-offload
The 05-29 map conflated them. **They are different offloads:** offload-architecture moves **SQLite/CPU** (ledger, code-search, enrichers) to worker threads — *done for Phases 1/2/4*. claude1 #16 moves **CLI subprocess spawn + stdout JSONL parse** off main via `utilityProcess` — *still OPEN, untouched* (`KeyedCoalescingWorker` exists but unused for it). Don't assume #16 is covered by the offload plan.

## 5. Collision-free lanes for a fresh worker (highest leverage first; re-check the diff)
1. **provider-auto-update Phase 3-A / claude1 #9** — wire `models-dev-service.ts` into the picker. Mostly renderer + one IPC; the backend fetch exists. Low collision. **Top pick.**
2. **Remote Piece A** — code is done (incl. prompt surfacing, node snapshot, capability-tag resolution); the only remaining step is a live `windows-pc` E2E + `report_result` round-trip check, which needs the worker. Not a headless lane.
3. **claude2 #17 role-prompt library** → new `prompts/roles/*.md` (drop-in, additive). Router independently testable; dispatch wiring defers to shared orchestration.
4. **claude1 #15 checkpoint timeline UI** over existing `git-checkpoint-store` (backend done) — renderer-side; check transcript-module collision.
5. **claude2 #31 web-build E2E + scripted mock adapter** — net-new `test/e2e/`, `scripted-cli-adapter.ts`, `test/parity/`. Unlocks deterministic testing. (The deeper recorded-fixture half waits on adapter feed hooks.)
- **AVOID:** anything in the 22 staged files (§2); the loop-completion files (remote Piece B owns them); remote Piece C / launch-modes Phase 2 / native-rebuild (headless-impossible); the rocks (§3 deferred).

## 6. Recommended global sequence
1. **Commit the staged set** (mobile + loop/instance + command) so the tree settles; verify mobile on a real device over Tailscale.
2. In parallel (non-colliding): **Piece B** owner builds the `evidence-resolver.ts` spine + convergence cycle (owns loop-completion files); **provider** owner does Phase 3-A picker merge then Phase 2 auto-apply; a **fresh worker** takes lane #5 (E2E/mock) to de-risk everyone; **offload** owner does Phase 3/5/6 (deferred — needs packaged rebuild).
3. **Then the orchestrator-defining features**: claude1 #26 phase/role routing, #11 + best-of-n compare, #27 repo-map injection.
4. **Then the rocks** (#1/#2/#3/#16/#20/#23) — multi-week, design-pass + operator decision; not autonomous.
5. **Security/correctness rocks** (claude2 #2 sandbox teeth, #20 safety critic) — operator-gated.

## 7. Hard constraints (repo rules + memory)
- Never commit unfinished plans; keep planning docs untracked; `_completed` rename only when implemented+verified (loopfixex now satisfies this).
- No packaged-rebuild / node-pty / live-worker verification possible headless — defer anything needing it.
- Worker DB ownership: one writer per SQLite file; new DB access routes through the owning worker.
- `@contracts/...` subpath additions need the 3-place alias sync (AGENTS.md); extending an existing schema does not.
- Tests mock better-sqlite3 with a wasm driver — never add pre/post-test native rebuilds.
