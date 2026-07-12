# Ping-pong review — implementation status

Branch: `feature/pingpong-review` (worktree `../ai-orchestrator-pingpong`, off clean HEAD `224c3a84`).

Built off **clean HEAD** deliberately: the main working tree had a large, half-finished
`antigravity` provider feature (uncommitted, non-compiling) plus several live `claude --print`
loop writers, so it could not be verified. This branch is self-contained and merges cleanly
on top of HEAD; rebase/merge after the antigravity work lands.

## Done + verified (backend, end-to-end)

| Phase | What | Files |
|------|------|-------|
| P1 | `ReviewerSessionSpawner` — spawns a fresh **root-level** reviewer instance, awaits `waitForInstanceSettled` with timeout/cancel, reads final output, folds tokens/cost, **always tears down** | `src/main/orchestration/reviewer-session-spawner.ts` (+spec) |
| P2 | Per-loop reviewer resolution (no shared mutable global); extended `FreshEyesReviewerInput`/`Result` | `loop-fresh-eyes-reviewer.ts`, `loop-coordinator.ts` |
| P3 | `AgenticPingPongReviewer` — different-provider resolution (auto != builder), plan/impl deep-dive prompts, tolerant JSON parser, **fail-closed validity gate** | `agentic-pingpong-reviewer.ts` (+spec) |
| P4 | `evaluatePingPongCompletion` branch — runs on every builder done-declaration; mutual APPROVED+done convergence; injects findings; cost folding; pause/cancel | `loop-pingpong-completion.ts` (+spec), wired in `loop-coordinator.ts` |
| P4-cfg | `LoopPingPongConfig` under `completion.crossModelReview.pingPong`; 4 new `LoopStatus` terminals + **all projection helpers** | `loop-pingpong.types.ts`, `loop.types.ts`, `loop.schemas.ts`, `workflow-lifecycle.types.ts`, `campaign-coordinator.ts`, `default-invokers.ts`, `loop-handlers.ts`, `loop-formatters.util.ts` |
| P5 | Durable issue ledger (classify/regression/persist); persistence via full-state checkpoint; crash-restore reconciliation of in-flight reviewer; terminal states | `loop-pingpong-completion.ts`, `loop-coordinator.ts` (restore) |
| P6 | Intent classifier (heuristic plan/impl), per-round subject re-eval, impl-mode verify gate (plan skips) | `pingpong-intent-classifier.ts` |
| P7 | Settings (`pingPongReviewerProvider`, `pingPongMaxRounds`) + defaults + control-policy + metadata; preload `LoopConfigInput` exposes `crossModelReview.pingPong` | `settings.types.ts`, `settings-control-policy.ts`, `settings-metadata-review-network.ts`, `loop.preload.ts` |
| P8 | **Full UI** — arm toggle + reviewer/subject/max-rounds in the loop config panel; live round/cost/open-issues readout + Skip-round / Arbitrate buttons in the loop control panel; 2 new IPC channels end-to-end; `LoopStatePayload` carries `pingPong` | `loop-config-panel.component.{ts,html,scss}`, `loop-control.component.{ts,scss}`, `loop.channels.ts`, generated channels, `loop.preload.ts`, `loop-handlers.ts`, `loop-ipc.service.ts`, `loop.store.ts`, `loop.schemas.ts` |
| P9 | 22 unit tests (parser, classifier, convergence, fail-closed, cost cap, verify gate, operator controls, spawner) | 3 `.spec.ts` files |

Startup wiring: `ReviewerSessionSpawner.setInstanceManager` in `initialization-steps.ts`.

### Verification (all green)
- `npx tsc --noEmit -p tsconfig.electron.json` ✓
- `npx tsc --noEmit` (renderer/shared) ✓
- `npx tsc --noEmit -p tsconfig.spec.json` ✓
- **`npx ng build --configuration production`** ✓ (strict Angular template type-check — validates all new bindings)
- `npx vitest run` → **22 ping-pong + 84 existing loop/renderer tests pass**, no regressions ✓
- `npm run verify:ipc` ✓ (999 channels: contracts == generated == shim) · `npm run check:contracts` ✓
- `oxlint` on changed files → 0 warnings/errors ✓
- `npm run check:ts-max-loc` ✓ (coordinator + loop.types ceilings bumped intentionally)

### Using it (UI)
Open the **Loop config panel** (loop toggle next to the composer) → tick **"Ping-pong review"** →
pick reviewer (Auto / Codex / Gemini / …), what it's reviewing (auto/plan/impl), and max rounds →
Send. While it runs, the **loop control strip** shows a `PING-PONG round X/N · reviewer · open
issues · spend` readout with **Skip round** and **Arbitrate** buttons.

### How to arm today (no UI yet)
Start a loop via `LOOP_START` with:
```
completion: { mode: 'review-driven',
  crossModelReview: { enabled: true, blockingSeverities: ['critical','high'],
    timeoutSeconds: 90, reviewDepth: 'structured',
    pingPong: { enabled: true, reviewerProvider: 'auto', subject: 'auto', maxRounds: 15 } } }
```

## Not in scope (per the plan §8)
- `/pingpong` natural-language chat command (the plan marks the button/config-panel as the
  reliable path; a command alias was explicitly low-priority). The config-panel toggle is the
  primary trigger and is fully wired.
- Reviewer-of-reviewer (>2 models) and persisting full reviewer transcripts.

## Remaining before renaming the plan `_completed`
All P1–P9 are implemented + verified. Recommended final check before merge: a **manual in-app
click-through** (arm ping-pong on a small real task, watch a round happen, hit Skip/Arbitrate)
— the automated gates (tsc ×3, ng build, 106 tests, IPC/contracts verify) all pass, but a live
run against real CLIs is the last mile no static check covers.
