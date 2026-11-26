# Skill Observability + Design Skills — Implementation Plan

Date: 2026-07-23
Status: IMPLEMENTED — all phases code-complete and gate-verified 2026-07-23; real-UI checks deferred to [2026-07-23-skill-observability-and-design-skills_livetest.md](./2026-07-23-skill-observability-and-design-skills_livetest.md)
Spec: [2026-07-23-skill-observability-and-design-skills_spec_completed.md](./2026-07-23-skill-observability-and-design-skills_spec_planned.md)

Implements the spec's approved options (D1a, D2a, D3a, D4a, D5a, D6a — James approved all recommendations 2026-07-23, review `2026-07-23-skill-observability-design-skills`).

Ordering rationale: observability (P1–P3) landed **before** any new skill (P5), so the design skills are born watched.

---

## Phase 0 — Groundwork ✅

- [x] 0.1 Migration `053_skill_attribution` in `rlm-migrations-051-055.ts`: `skill_activations` (incl. `followed_by_error` correlation flag) + `skill_controls`, with `down` SQL. Tests: applies, idempotent re-run, rollback.
- [x] 0.2 `SkillAttributionService` (`src/main/skills/skill-attribution-service.ts`): singleton, lazy RLM binding, fail-soft throughout, control cache with write-through, `getEffectiveMode` encodes the D1a default (builtin → enabled, other → suggest-only), `markErrorForInstance` correlation hook. 10 unit tests against in-memory sqlite.
- [x] 0.3 Contracts: `SKILLS_ACTIVATIONS_RECENT/HEALTH_SUMMARY/LIST_CONTROLS/SET_CONTROL/ACTIVATION_DELTA` channels; payload schemas in `provider.schemas.ts`; `SkillActivationDeltaEventSchema` in `observability.schemas.ts` + renderer-event-validation registration. No new alias subpaths needed.

## Phase 1 — Attribution on the live path ✅

- [x] 1.1 Recording at the injection seam: `unified-controller.ts` `fetchSkills` records each skill actually loaded (name, source, instanceId/sessionId, turnKey = retrieve taskId, matchedBy/trigger/score, tokens from new `loadedDetails`, autoSelected). As-built deviation from the plan text: recorded in `fetchSkills` rather than `instance-context` because detection metadata does not survive into the context-builder return shape; `retrieve()` already carries instance/session identity there. Tokens are post-budget (`loadSkillsWithBudget`), pre-whole-payload-trim.
- [x] 1.2 Explicit loads recorded in the `SKILLS_LOAD` IPC handler (`matched_by: 'explicit'`); loads of a `disabled` skill are refused with `SKILL_DISABLED`.
- [x] 1.3 Delta push: service emits `activation`; `skill-attribution-handlers.ts` forwards to renderer via `windowManager.sendToRenderer` (registered in `ipc-main-handler.ts`).
- [x] 1.4 Kill-switch enforced at selection time: `detectRelevantSkills` drops `disabled`, marks `suggest-only` (`suggestOnly: true`); `loadSkillsWithBudget` and `fetchSkills` never inject suggest-only skills. Manifest/`registerSkill` skills are treated as explicit user opt-ins (default enabled) so existing `skills.json` behavior is unchanged.
- [x] 1.5 D2a trigger tightening: `triggerMatchesText` in `skill.types.ts` (word boundaries for phrase triggers, substring for `/slash`), used by `matchTrigger`; `triggerMinConfidence` gate (default 0.05 = trigger must be ≥5% of message text) applied to non-slash trigger matches in `detectRelevantSkills` — kills the incidental-substring-in-long-prompt hazard.
- [x] 1.6 D6a builtin trigger edits: `android-release` "play api"→"play developer api"; `new-app-setup` "data safety"/"content rating"→"play data safety form"/"play content rating questionnaire"; `human-public-writing` "public facing"→"public facing copy"/"public facing email".

## Phase 2 — Live surfacing ✅

- [x] 2.1 `skill.store.ts`: `activations`/`controls` signals, `initObservability()` delta subscription (wired in `app.component.ts` startup), `activationsForInstance`, `setSkillControl`.
- [x] 2.2 Toast on auto-activation via existing `toast.service`, 5-minute per-skill+instance cooldown; explicit loads don't toast.
- [x] 2.3 Badge + popover extracted into `session-skills-badge.component.ts` (OnPush, signals), embedded in `instance-header.component.html`: per-skill trigger/score/token rows + Disable/Enable toggle.
- [x] 2.4 5 store tests (`skill.store.spec.ts`).

## Phase 3 — Health view + lint ✅

- [x] 3.1 `skill-health-panel.component.ts` on the Skills page side panel: per-skill activations, tokens, last-used, On/Suggest/Off mode buttons, outlier flags ("precedes an error N/M times" at ≥5 activations and ≥50% error share; "fires very often" at ≥50).
- [x] 3.2 Correlation: `followed_by_error` flag set by `markErrorForInstance` (10-min window) on `instance:state-changed` → `failed`/`error` (subscribed in the attribution handlers with InstanceManager passed as `instanceEvents`); `precededErrors` in the health summary. UI labels it correlation-not-causation. Tests cover flagging and window bounds.
- [x] 3.3 Skill lint in `skill-diagnostics-service.ts`: `over-broad-trigger` (single word <6 chars, slash exempt), `weak-description` (<40 chars), `oversized-core` (>16k chars), on top of the existing duplicate-name/duplicate-trigger/tool-mismatch checks. Tests added.
- [x] 3.4 Doctor tab renders `skillDiagnostics` generically, so new codes surface with no UI change. One-click disable lives in the health panel and badge popover (not the doctor tab).

## Phase 4 — Registry gate fix + dedupe + dead code ✅

- [x] 4.1 `skill-registry.ts` no longer rejects trigger-less skills — Anthropic-format skills register as embedding-only. `skill-diagnostics-service` no longer flags trigger-less frontmatter as invalid.
- [x] 4.2 Non-declared, non-builtin skills default to suggest-only (test proves a `~/.claude/skills` bundle is detected `suggestOnly: true` and refused by the budget loader). Registry spec proves trigger-less discovery + invalid-name rejection + word-boundary matching.
- [x] 4.3 D4a dedupe: builtin `human-public-writing` body replaced with the richer global body (v2.0.0), builtin triggers kept. The global file is untouched (still serves native Claude sessions); content is now identical.
- [x] 4.4 D3a: deleted `skill-matcher.ts` + `trigger-matcher.ts` (zero callers), removed bootstrap warm-up, barrel exports, and singleton-reset entries; `SkillAttributionService` registered in singleton-reset instead. No spec files referenced them.

## Phase 5 — Design skills ✅

- [x] 5.1 Builtin `visual-redesign` skill (`src/main/skills/builtin/visual-redesign/SKILL.md`): VibeCurb-derived (MIT attribution in body), sacred/slop separation, gold.css load-last + framework variants, layer-ordered surgery, functionality-first post-op gate. Conservative triggers: `/visual-redesign`, "redesign this ui", "redesign the ui", "visual overhaul", "make this look designed", "make this ui look designed".
- [x] 5.2 `design-drift-analyzer` review agent (`review-agents/index.ts`): severity scoring, presentation-file patterns only, forbidden fonts/copy/visual/motion lists with quantified thresholds; glassmorphism explicitly marked "AIO addition (not from VibeCurb)". Spec tests assert registration, scoring, checklist content, and the attribution marker.
- [x] 5.3 Forbidden lists folded into builtin `ui-audit` as a "Design-drift signals" section — no third general design skill created.
- [x] 5.4 Both ship under the observability layer (builtin → attribution rows, toast, badge, health view from first activation). First-week watch item: `visual-redesign` activation rate in the health view.

---

## Verification (as run)

Per-phase and final: `npx tsc --noEmit` ✅, `npx tsc --noEmit -p tsconfig.spec.json` ✅, `npm run lint` ✅, `npm run check:ts-max-loc` ✅ for all files in this work's scope. Targeted specs (all green): skill-attribution-service (10), skills-loader (+5 control/gate tests), unified-controller (+1 attribution test), skill.types (+3 boundary tests), skill-registry (3, new), skill-diagnostics (+1 lint test), review-agents (+3), skill.store (5, new), builtin skill specs. Full-suite run: see status note in the completion summary.

Note on concurrent writers: during this work three unrelated loop agents were editing this repo (browser-gateway/channels scope). One transient tsc error and one max-loc violation (`channel-message-router.ts`) observed during gate runs belong to that in-flight work, not this plan's scope.

## Deferred live checks

Real-UI verification (toast, badge popover, health panel, doctor lint display, migration on real DB, end-to-end kill-switch behaviour in a live session) requires a rebuilt app and is recorded in [2026-07-23-skill-observability-and-design-skills_livetest.md](./2026-07-23-skill-observability-and-design-skills_livetest.md). Deferral reason: the running AIO instance predates this code, and concurrent loop agents were actively mutating the tree, making an in-loop dev-app launch non-deterministic.

## Risks (as-built)

- Attribution writes are synchronous sqlite inserts on the retrieve path, fail-soft and micro-fast (WAL); never awaited into `sendInput` beyond the existing retrieve flow.
- `matchTrigger` word-boundary change also affects IPC `SKILLS_MATCH` (Skills page match button) — intended; slash semantics preserved.
- D1a exposure of ~17 global skills is safe by construction: suggest-only default enforced at both detection and budget-load layers, verified by tests.
