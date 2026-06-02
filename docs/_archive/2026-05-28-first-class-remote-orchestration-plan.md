# First-Class Remote Orchestration — Spec

**Status:** SPEC / plan. UNTRACKED — do not commit until implemented + verified (repo rule).
**Date:** 2026-05-28 · **Re-scoped:** 2026-05-30
**Owner:** James

> **2026-05-30 re-scope (read first).** Since this spec was written, the loop-completion work it depended on has **landed** (`docs/plans/loopfixex_completed.md`, LF-1…LF-8, 289 loop tests green). That changes Pieces B's footprint:
> - **Piece A (node-targeted child spawn)** — still fully open. Unchanged. Highest leverage.
> - **Piece B (verified convergent loop)** — its core "don't stop on self-reported markers; require a real verify-green signal" is **already implemented** as the merged verify-before-stop + ledger gating + `declared-complete` intent in `loop-completion-detector.ts`/`loop-coordinator.ts`. Piece B is therefore **re-scoped** to the genuinely-missing tier-2 pieces (see the revised Piece B below): the `evidence-resolver.ts` spine, the convergent fix→verify→review **cycle**, review-quality (diversity/dedup/diff-scope), and remote-node/cross-model reviewer diversity. It **layers on**, and must not regress, the shipped LF-7 model.
> - **Piece C (remote terminal)** — unchanged; still partly done, headless-unverifiable.
>
> **Completion-authority architecture (decided 2026-05-30).** One **evidence-precedence resolver** owns "is the loop done", evaluating a fixed ladder: **(1) runtime truth** (runtime-death) → **(2) external ground-truth** (verify build/test/lint green · SCM/CI · empty unresolved-review-thread fingerprint) → **(3) structured in-band intent** (`declared-complete`, LF-7) → **(4) forensic markers** (DONE.txt/rename/regex, corroboration only). Tier 2 is the *only* authority for an **autonomous** terminal. The agent is **forbidden from self-declaring** a terminal state (tiers 3–4 are candidates/corroboration, never sufficient alone). `completed-needs-review` (LF-7) is the **human-escalation terminal used only when no tier-2 authority exists** — i.e. it is "no external truth available, ask the operator", **not** "the agent self-declared without verify". This reconciles LF-7, this Piece B, and `claude2_todo` #1 into one model with zero rework of shipped code.
**Relationship:** Supersedes the terminal-first framing in `2026-05-28-thin-client-remote-backend-plan.md`. That doc's decision (Path A — extend the existing worker-node model, Mac = control surface, Windows worker = execution) still holds; this spec is the concrete feature work on top of it. Worker `windows-pc` is now connected to the coordinator (verified).

## Goal — two user stories (+ one escape hatch)

1. **Remote delegation:** "Go onto my other PC and fire up an Android Studio instance and test XXX and YYYY." → an orchestrator instance delegates a task to a child that runs on a chosen remote machine (the `windows-pc` worker).
2. **Convergent autonomy:** "Keep doing a review with fresh eyes and fix any issues, until there are no issues." → an autonomous loop that actually converges on a *real* signal.
3. **Escape hatch:** a remote terminal on the worker for ad-hoc human work (clone repos, poke around).

## Diagnosis — why this doesn't work today (grounded)

Stories 1 and 2 share **one weak primitive**: *an instance delegating a task to a fresh child and acting on a trustworthy result.* It has two holes.

### Hole 1 — agent child-spawn is local-only
- `SpawnChildCommand` (`src/main/orchestration/orchestration-protocol.ts:47`) and `SpawnChildPayloadSchema` (`packages/contracts/src/schemas/orchestration.schemas.ts`) carry `task/name/agentId/model/provider` — **no node/target field**.
- `createChildInstance` (`src/main/instance/instance-manager.ts:1948`, wired into orchestration deps at `:248`) never sets a node.
- Yet the **remote execution path is fully built and driven entirely by `config.forceNodeId`**: `instance-lifecycle.ts:284` → returns `{ type:'remote', nodeId }` → `createRuntimeAdapter` → `RemoteCliAdapter` → `instance.spawn` over the worker WebSocket.
- **Conclusion:** remote children are *one unplumbed field* away. The infra exists; the agent just can't ask for it.

### Hole 2 — "done" is an opinion, not a fact *(largely closed 2026-05-30 — see re-scope note; the residue is the evidence-resolver spine + convergence cycle, now the body of Piece B)*
- **Loop termination** (`src/main/orchestration/loop-completion-detector.ts`) fires on self-reported markers: `DONE.txt`, `<promise>DONE</promise>`, "TASK COMPLETE", a `*_Completed.md` rename, or a plan checklist. A real verify command (build/test/lint) is **optional** — if absent, the loop just pauses. Fresh-eyes review in the loop is **off by default** (`src/shared/types/loop.types.ts`).
- **Review** (`src/main/orchestration/cross-model-review-service.ts`) spawns reviewers but feeds them all **identical context**, runs **zero execution** (pure text opinion — no build/test/lint), truncates payload (~32k chars in `review-prompts.ts`), and has **no issue→fix→re-review cycle** (concerns go to the user or a debate that never re-runs the task).
- **Conclusion:** "no issues" = "an LLM said it looks fine," so "review and fix until clean" has nothing real to converge on.

---

## Piece A — Node-targeted child spawn (unblocks Story 1) — CODE-COMPLETE; needs live verification (2026-05-30)

> **2026-05-30 status (re-verified by reading the real files — an earlier pass checked the wrong file and undercounted):** Piece A is **essentially implemented**. All four change-sites below are done:
> 1. `SpawnChildPayloadSchema.node?: string` — present (`orchestration.schemas.ts:19`).
> 2. Prompt surfacing — `orchestration-protocol.prompts.ts` documents `node?` in the spawn_child table (`:97`), **injects a live connected-nodes snapshot** via `formatConnectedNodesSnapshot` (`:13-37,:106`), and gives explicit guidance ("set `node` to the worker's name… for heavy builds, Android/Gradle, browser/Playwright" `:108`; empty-case handled `:18`).
> 3. Orchestration parse — `instance-orchestration.ts` passes `node` through.
> 4. `createChildInstance` → `resolveChildNodeId(command, parent)` → `forceNodeId` (`instance-manager.ts:2178,2190,2215-2228`). **Capability-tag resolution is also built** (`resolveWorkerNodeTarget` in `worker-node-registry.ts:179-201` matches `gpu`/`browser`/`docker`/platform/CLI tags, ranked by free capacity); exact id/name wins; clear error on no match.
>
> **What genuinely remains is verification only (both require a live worker — cannot be done headless):** (a) confirm `report_result` / structured-result harvesting round-trips over `RemoteCliAdapter` (the output stream does; check the structured path); (b) end-to-end demo on `windows-pc` (Android build/test). Treat the "Change sites" and "Design" below as the spec that has already been satisfied; the work item is the live E2E.

**Design.** Add an optional target to `spawn_child`. An instance can say:
```
:::ORCHESTRATOR_COMMAND:::
{"action":"spawn_child","task":"Build the app and run instrumented tests; report failures","node":"windows-pc","provider":"claude"}
:::END_COMMAND:::
```
- `node` resolves as: exact connected node id/name → target it; else a **capability tag** (e.g. `android`, `gpu`, `browser`) → pick a connected node advertising it (reuse worker capabilities + the existing `autoOffload*` settings); else return a clear error to the parent listing available nodes/capabilities.
- Remote child runs the real CLI on the worker (existing `RemoteCliAdapter`), streams output back, and reports via the existing structured-result path (`report_result` → `child-result-storage` → parent summary). **Verify** `report_result` round-trips over `RemoteCliAdapter` (see open questions).

**Change sites (precise):**
1. `packages/contracts/src/schemas/orchestration.schemas.ts` — add `node?: string` to `SpawnChildPayloadSchema`.
2. `src/main/orchestration/orchestration-protocol.ts` — add `node?: string` to `SpawnChildCommand` (`:47`); document it in `generateOrchestrationPrompt` (commands table `:266` + guidance: "long builds / Android / GPU → run on a worker"); inject a live snapshot of connected nodes + capabilities into the prompt; (optional) validate in `isValidCommand`.
3. `src/main/instance/instance-orchestration.ts` — include `node` in the `SpawnChildPayloadSchema` parse (`:177`) and pass it through (the full `command` already flows to `createChildInstance` at `:260`); enforce limits/disconnected-node errors via `notifyError`.
4. `src/main/instance/instance-manager.ts:1948` `createChildInstance` — set `forceNodeId = resolve(command.node)` on the `CreateInstanceConfig` it builds. Existing `resolveExecutionLocation` (`instance-lifecycle.ts:1363`) does the rest.

**Acceptance:** From a parent instance on the Mac, `spawn_child {task, node:"windows-pc"}` spawns on the worker, runs, and the parent harvests the structured result. Demonstrated with an Android build/test task on `windows-pc`.

**Effort:** S–M. Highest leverage / smallest change.

---

## Piece B — Verified, convergent loop (fixes Story 2) — RE-SCOPED 2026-05-30

> **Already shipped (do NOT rebuild):** "termination requires a real green verify signal; self-report markers are candidate not final" is **done** — `loop-completion-detector.ts` already makes only verify-backed/`all-green` signals `sufficient`, gates on a ledger, and treats DONE.txt/rename/regex as corroboration. The cost cap, context discipline, semantic-progress signal, branch-and-select, operator-accept, and the completion-attempt budget all shipped (loopfixex LF-1…LF-8). So Piece B is **no longer "build the verified loop"** — it is **"add the tier-2 evidence spine + the convergence cycle + review quality on top of the shipped model"**.

**Design (the genuinely-missing pieces).**
1. **Evidence-precedence resolver (the spine, net-new).** Add `src/main/orchestration/evidence-resolver.ts` implementing the ladder in the re-scope note above (runtime → external ground-truth → in-band intent → forensic). It consumes the *existing* completion signals as ranked evidence rather than independent gates, and is consumed by `loop-coordinator.ts` (completion decision) and `cross-model-review-service.ts`. It owns the rule "agent may not self-declare terminal"; `declared-complete` + passing verify = stop, no verify authority = `completed-needs-review` (LF-7's existing terminal). This is also `claude2_todo` #1 — build it **once, here**.
2. **Convergence cycle (net-new behavior).** verify → if red, feed the **actual failed-job/test logs** back as the next fix task → re-run; if green, run fresh-eyes review → if blocking findings, feed them as fix tasks → re-run. Stop only when **(verify green AND no blocking findings)** or a cap (the cap-reason reporting already exists via `describeCapReason`). Today the loop verifies but does not *re-inject failures as structured fix tasks* — that loop-closing is the work.
3. **Fresh-eyes with clean context + node/model diversity (extend existing).** `loop-fresh-eyes-reviewer.ts` already spawns an independent reviewer; the additions are **clean context** (only diff + goal, not parent transcript), a **different model**, and optionally a **different node** (composes with Piece A — reviewer runs on `windows-pc`).
4. **Review quality (extend existing).** In `cross-model-review-service.ts`/`review-prompts.ts`/`reviewer-pool.ts`: per-reviewer **prompt diversity** (different angles); **dedup + severity aggregation** ("3/3 found X"); **diff-scoping** to avoid the ~32k truncation. Plus the **unresolved-review-thread fingerprint** (converge only when it empties) and a bounded `detecting` buffer with `evidenceHash` so unchanged weak evidence can't reset counters (from `claude2_todo` #1 / agent-orchestrator).

**Change sites:**
- `src/main/orchestration/evidence-resolver.ts` — **NEW**; the precedence spine (= `claude2_todo` #1's home).
- `src/main/orchestration/loop-coordinator.ts` — consume the resolver for the completion decision; implement the fix→verify→review **re-injection cycle**. (Do not regress the merged LF-7 accept/budget/`completed-needs-review` paths.)
- `src/main/orchestration/loop-fresh-eyes-reviewer.ts` — clean context + node/model diversity.
- `src/main/orchestration/cross-model-review-service.ts`, `review-prompts.ts`, `reviewer-pool.ts` — prompt diversity, dedup, severity ranking, diff-scoping, review-thread fingerprint.
- `src/shared/types/loop.types.ts` — only any *new* fields the cycle/resolver need (most config already exists from loopfixex).

**Acceptance:** On a repo with a seeded failing test/bug, "review with fresh eyes and fix until no issues" **converges**: finds the bug, fixes it, re-verifies (tests pass), re-reviews clean, stops — and does **not** stop while tests are red or a blocking finding remains. The resolver never lets a self-declared terminal through without a tier-2 authority; with no verify command the run lands `completed-needs-review`, not a silent stop. Hitting a cap reports the reason. **Existing 289 loop tests stay green.**

**Effort:** M (down from L — the loop scaffolding, cost caps, and completion plumbing already exist; this is the evidence spine + cycle + review quality). The review-quality items are independently shippable increments.

---

## Piece C — Remote terminal (escape hatch; lower priority)

**Status:** protocol vocabulary already added (`worker-node-rpc.ts` `terminal.*`; `nodeId` on `TerminalSpawnOptions`) — tasks #2–#8 remain.

**Design / remaining work:**
- Zod schemas + validation for `terminal.*`.
- Worker-agent **node-pty** host + `terminal.*` handlers; emit `terminal.output` (batched) / `terminal.exit`. Lazy-import node-pty; `chmod 0o755` spawn-helper on mac/Linux (ConPTY on Windows, no helper); sandbox initial cwd to allowed dirs.
- Coordinator routing: `rpc-event-router.ts` `terminal.output/exit` → registry events; a terminal session manager mirroring `RemoteCliAdapter`.
- IPC + preload terminal domain; renderer real `TerminalSession` (replace stub) + wire `terminal-drawer` to a node target via the node-picker.
- **node-pty delivery:** the worker runs as the **node bundle** today (verified: only `dist/worker-agent/index.js` built, no SEA), so this is the easy path — mark node-pty `external`, ship it in an adjacent `node_modules` (prebuilt), no SEA fight.
- E2E on `windows-pc`.

**Acceptance:** Open a terminal on `windows-pc` from the Mac; interactive prompts work (`gh auth login`, git credential prompt); `git clone`/`npm i`/build run there; the Mac stays idle.

**Effort:** M (partly done).

---

## How the pieces compose

- In **B**, the verify step (`npm test`, `./gradlew connectedAndroidTest`) and the fresh-eyes reviewer are **A's remote children on `windows-pc`** — heavy build/test runs on the 9950X3D while the loop is driven from the Mac.
- **C** is the human escape hatch on the same worker for ad-hoc work.
- Net: an instance can autonomously "build + test on the Windows box, review with fresh eyes, fix, repeat until green and clean" — your two stories become one capability.

## Phasing

1. **Phase 1 — Piece A** (S–M): node-targeted spawn. Unblocks Story 1 immediately; verify live on `windows-pc`.
2. **Phase 2 — Piece B** (M, re-scoped): evidence-precedence resolver + convergence cycle + review quality on top of the already-shipped verified loop. Works locally too, but composes with A for remote verify.
3. **Phase 3 — Piece C** (M, partly done): remote terminal (tasks #2–#8).

## Verification strategy

- Per change: `npx tsc --noEmit` + `npx tsc --noEmit -p tsconfig.electron.json`, `npm run lint`, relevant `vitest`.
- A: live remote child on `windows-pc` + result-harvest check.
- B: fixture repo with a seeded failing test → convergence + non-premature-stop tests.
- C: live terminal on `windows-pc`.

## Risks / open questions

- **A:** capability-vs-nodeId resolution semantics; **confirm `report_result` / structured-result harvesting round-trips over `RemoteCliAdapter`** (the output stream does; the structured-result path needs checking); remote children cannot themselves spawn children (fine — nesting is off by default); per-parent/total instance limits + disconnected-node handling.
- **B:** defining "blocking" severity + cap policy; preventing infinite fix loops (cap + existing no-progress detection — but that detection is jittery today, so tune it); cost of repeated fresh-eyes children (use cheaper models/nodes).
- **C:** node-pty native delivery on the worker (node-layout); `wss`/TLS when off-LAN (later).

## Out of scope (deferred)

- Thin-client re-platform (rejected). Headless backend mode. Tailscale/tunnel (LAN for now). Browser/PWA client.
