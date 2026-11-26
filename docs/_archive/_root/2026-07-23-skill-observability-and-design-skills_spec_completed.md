# Skill Observability, Cleanup, and Design Skills — Spec

Date: 2026-07-23
Status: COMPLETED 2026-07-23 — approved by James (review `2026-07-23-skill-observability-design-skills`, overall APPROVED; decisions D1a, D2a, D3a, D4a, D5a, D6a). All phases implemented and gate-verified (full suite 15,405/15,407; the single failure is the pre-existing environment-dependent heap-snapshot spec, which passes in isolation). Real-UI checks deferred per Live-Test Deferral rules to [2026-07-23-skill-observability-and-design-skills_livetest.md](./2026-07-23-skill-observability-and-design-skills_livetest.md).
Implementation plan: [2026-07-23-skill-observability-and-design-skills_plan_completed.md](./2026-07-23-skill-observability-and-design-skills_plan_completed.md)

As-built deviations from §3: attribution is recorded in `UnifiedMemoryController.fetchSkills` (not `instance-context`) because detection metadata does not survive into the context-builder return shape — same injection semantics, per-skill tokens post-budget; `skill_activations` gained a `followed_by_error` column for error correlation instead of a separate marks table; manifest/`registerSkill` skills default to enabled (explicit user opt-in), narrowing the suggest-only default to registry-discovered non-builtin skills exactly as D1a intended.

Driving requirement: *a bad skill must never quietly degrade sessions without us noticing.* Every design choice below is judged against making skill use **visible and reversible**.

---

## 1. Phase 0 findings (investigated 2026-07-23)

Verification labels: **[V]** = verified first-hand by reading the executing code path this session; **[A]** = agent-reported with file:line citations, spot-checked where load-bearing.

### 1.1 Headline defect: the global skill catalog is invisible to AIO

**[V]** `SkillRegistry.loadSkillMetadata` rejects any skill whose parsed `triggers` array is empty (`src/main/skills/skill-registry.ts:166-170`, "legacy contract"). Frontmatter parsing (`src/main/skills/skill-spec.ts:86-153`) only populates triggers from a `triggers:` array or legacy singular `trigger:` field. All 16 skills in `~/.agents/skills`, their `~/.claude/skills` copies, and the project's `.claude/skills/doc-review-artifact` use the Anthropic-native format (`name:` + `description:` only). Result: **only the 16 builtin skills** (`src/main/skills/builtin/`) are loadable through AIO's registry. The 17 global/project skills never reach the Skills UI, trigger matching, or embedding detection. They are dropped with only a `logger.warn` per skill.

Caveat: spawned `claude` CLIs still read `~/.claude/skills` **natively** (the CLI's own skill feature, independent of AIO). So global skills do reach Claude sessions — through a channel AIO cannot currently see, control, or attribute. AIO does not pass any skill paths via env (**[A]** `src/main/security/env-filter.ts` allowlist).

### 1.2 The live activation path (what actually runs)

**[V]** Per-turn, `instance-context.ts:522-555` calls `UnifiedMemoryController.retrieve` with `types` always including `'skills'` (even for messages under `unifiedMemoryContextMinChars`). `unified-controller.ts:427,757-770` → `SkillsLoader.detectRelevantSkills` (`src/main/memory/skills-loader.ts:247-332`):

1. **Trigger pass**: `skillRegistry.matchTrigger(userMessage)` — a bare `normalizedText.includes(trigger)` substring test (`skill-registry.ts:230-244`). **No minimum-score gate, no word boundaries** on this path. Any registered skill whose trigger string appears anywhere in the message is selected.
2. **Embedding pass**: cosine similarity of message vs skill description, threshold 0.65 (`skills-loader.ts:289`), skipping names already matched.
3. Sort by similarity then priority; cap at 3 (`maxResults`).

Selected skills are loaded via `loadSkillsWithBudget` and injected into the message context as an **"Activated Skill Instructions:"** block with app-injected-context guidance (**[V]** `instance-context.ts:585-604`). Injection is silent: no UI surface, no event consumer, no record.

Explicit invocation exists separately via `SKILLS_LOAD` IPC and the Skills page (`src/main/ipc/orchestration-ipc-handler.ts:1095-1314`, `src/renderer/app/core/state/skill.store.ts`).

### 1.3 The existing "controls" are dead code

**[V]** `SkillMatcher` (`src/main/skills/skill-matcher.ts`) holds the only per-skill control surface — `blocklist`, `suggestOnly`, `minConfidence: 0.75` (`:148-150,178-185`) — but `matchSkills()`/`processMessage()` have **no callers anywhere** in main code. Bootstrap merely instantiates the singleton (`infrastructure-bootstrap.ts:34-39`). Nothing registers skills into its internal `TriggerMatcher`. It is orphaned infrastructure; the live path (§1.2) has **zero per-skill controls, no blocklist, no kill-switch, no settings keys** (**[V]** no skill entries in `settings.types.ts`; per repo convention, orphan primitives are surfaced as decisions, not silently wired or deleted — see decision D3).

### 1.4 No usage/activation tracking exists

**[V]** Confirmed by direct grep (`skill.*(usage|activat|applied|fired|attribution|telemetry)` over `src/main`, `src/shared`, `packages/contracts`): hits are only auto-activate config merging (`claude-md-loader.ts:702-705`) and a registry memory stat. `src/main/persistence` has zero skill references. Events are emitted (`skills:detected` at `skills-loader.ts:325`, `skill:loaded`, etc. — **[A]** full list in plan) but **nothing consumes them**. `skillCount` is computed per retrieval (`instance-context.ts:553`) and discarded.

### 1.5 Inventory summary

**[A]** (full tables in the plan appendix; counts verified by directory listing)

- **Builtin (16, loadable)**: release/test/review workflow skills, all ≤4k chars, all slash-command-first triggers. Clean.
- **Global (16, NOT AIO-loadable)**: `~/.agents/skills` and `~/.claude/skills` have drifted apart (formerly symlinked; a stale `~/.claude/skills.symlink.bak` remains). `ui-ux-pro-max` exists only in `~/.claude/skills` and is ~44.8k chars (~11k tokens). `repo-health-audit` and `task-completion-gate` exist only in `~/.agents/skills`.
- **Project (1, NOT AIO-loadable)**: `.claude/skills/doc-review-artifact`.

Quality flags:

- **Duplicate name, different bodies**: `human-public-writing` exists as a 2.2k-char builtin AND a 6.9k-char global. AGENTS.md tells agents to use "the global" skill; AIO's engine can only ever load the builtin. Real behavior/documentation mismatch.
- **Design-cluster overlap** (latent in AIO, live in native Claude sessions): `ai-design-workflow` (13.7k, Recraft asset-gen + critique) vs `ui-ux-pro-max` (44.8k, "everything UI/UX") vs `css-style-system` (1.4k, tokens/architecture). `ui-ux-pro-max`'s scope swallows the other two's descriptions. No `frontend-design` skill exists in any scanned directory (a similarly-named Claude Code *plugin* skill exists but is outside AIO's engine).
- **Over-broad builtin triggers** (dangerous because substring matching, §1.2): `new-app-setup` fires on "data safety" and "content rating"; `android-release` on "play api"; builtin `human-public-writing` on "public facing" (e.g. "this endpoint is public facing").
- **Overlapping "done-ness" trio**: builtin `verify-implementation` vs global `task-completion-gate` vs `repo-health-audit` (the latter two deliberately cross-scoped; the builtin sits outside that split).
- **Oversized cores** (>8k chars): `ui-ux-pro-max` (44.8k), `ai-design-workflow` (13.7k), `security-best-practices` (8.6k).
- **Live trigger collisions among builtins**: none found.

### 1.6 Seams for attribution (where observability can attach)

**[A]**, spot-checked:

- **Emission seam**: `skills:detected` (`skills-loader.ts:325`) carries query + results + timing but has no instance/session identity; `fetchSkills` (`unified-controller.ts:757`) and the injection site (`instance-context.ts:542-555`) have `instanceId`/`sessionId` and final injected token counts. **The injection site is the correct attribution seam** — it knows what was actually injected, not merely detected.
- **Persistence**: RLM sqlite migrations live in ordered arrays (`src/main/persistence/rlm/rlm-migrations-*.ts`, concatenated in `rlm-schema.ts:25-33`), fail-soft. Recent model: `051_instruction_file_trust`.
- **Outcome correlation targets** (all already persisted): `provider_event_captures` (per-instance provider events, keyed instance_id + created_at), conversation-ledger messages (per-turn tokens/phase), `ReactionEvent` (`session.errored`/`session.exited`), loop `evidence_records` (loopId + verify state).
- **Surfacing**: main-process `notification-service` → `NOTIFICATION_DELTA` → `notification-center.store` (persistent) and `toast.service` (ephemeral, 2.2s). IPC convention is the 6-step channel/schema/handler/preload/facade/store pattern (worked example: `SKILLS_DISCOVER`).

### 1.7 Review-agent architecture (for design-drift)

**[A]** Review agents are plain `ReviewAgentConfig` objects (`src/shared/types/review-agent.types.ts:45-65`) in `src/main/agents/review-agents/index.ts`; adding one = export a config + append to `builtInReviewAgents` (line 304). `REVIEW_LIST_AGENTS`/`REVIEW_START_SESSION` IPC pick it up automatically; callers choose agents per session via `agentIds`. No other registration needed.

### 1.8 VibeCurb source material (MIT, github.com/Yu-369/VibeCurb, cloned to /tmp/vibecurb)

License confirmed MIT (© 2026 Yu-369) — content reusable with attribution. Five skills; the two we need:

- **visual-redesign**: complete non-destructive pipeline — sacred list (state/effects/handlers/conditional rendering/refs/keys — never touch) vs slop list (classNames/inline styles/tokens/spacing — upgrade aggressively); `gold.css` single-stylesheet load-**last** override (removal = full revert; framework variants for Tailwind config, CSS-in-JS global style, MUI/Chakra theme provider); 5-phase pipeline (Audit → Extraction → Prescription → Surgery in strict layer order → Post-Op); 6-table quantified post-op checklist where **functionality failures force a revert of the last surgery layer before any visual check proceeds**.
- **design-drift material** (from awwwards-hero/awwwards-motion/imagegen-frontend): forbidden display fonts (Inter/Roboto/Open Sans/Poppins/Arial/Helvetica as headings; Geist explicitly allowed); 5-term copy-cliché list (Elevate/Seamless/Unleash/Next-Gen/Revolutionize — deliberately short) + no em-dashes + no meta-labels; forbidden visuals (AI purple/blue gradients, mesh/translucent blobs, generic card grids, pure #000/#FFF backgrounds, stock-photo energy); quantified PASS/FAIL: ≤3 hues, heading letter-spacing −0.03/−0.05em, heading line-height <1.1, entry sequence <800ms, stagger 80–150ms, hover ≤150ms, `transform`/`opacity`-only animation, no CSS keyword easings, 60fps target, `prefers-reduced-motion` mandatory, 44px touch targets, 768px collapse.
- **Attribution caveat**: glassmorphic cards are **not** on VibeCurb's forbidden list (they appear once, positively). If we ban them it is our own rule and must not be attributed to VibeCurb.

---

## 2. Decisions for James (answer by number)

Each has a recommendation; the plan implements the recommended option unless you pick otherwise.

**D1. What to do about the 17 invisible global/project skills?**
- (a) **Recommended**: make `triggers:` optional. Trigger-less skills become *visible* in the Skills UI and *embedding-only* candidates, but default to **suggest-only** (surfaced as a suggestion chip/toast, never auto-injected) until individually enabled. Nothing new auto-injects the day this ships.
- (b) Leave them invisible to AIO (native Claude CLI reads them anyway) and only instrument builtins.
- (c) Auto-inject them like builtins once visible (not recommended — `ui-ux-pro-max` alone is ~11k tokens and would fire on almost any UI-adjacent message).

**D2. Tighten live trigger matching?** **Recommended yes**: word-boundary matching plus a minimum-confidence gate on the trigger pass of `detectRelevantSkills`, and per-skill match stats surfaced in the health view. Slash-command triggers (`/ui-audit`) keep exact-prefix semantics.

**D3. The orphaned `SkillMatcher`?**
- (a) **Recommended**: absorb — move its useful concepts (blocklist, suggest-only, min-confidence) into the live path as the new per-skill controls (§4), then delete the orphan class and its unwired `TriggerMatcher` registration surface.
- (b) Keep as-is (dead code with a misleading control surface).

**D4. `human-public-writing` duplicate?** **Recommended**: keep the global (richer) body as the single source; shrink the builtin to a thin loader-compatible wrapper (frontmatter + triggers + pointer) once D1(a) lands, or delete the builtin and add triggers to the global copy. Either way one body, one name.

**D5. Design skills (Phase 5 scope)?** **Recommended**:
- New builtin `visual-redesign` skill from VibeCurb content, conservative triggers (`/visual-redesign`, "redesign this ui", "make this look designed", "visual overhaul") — never fires on backend/logic phrasing.
- New `design-drift` **review agent** (not a skill) in `review-agents/`, carrying the forbidden lists + quantified PASS/FAIL checklist.
- Fold the forbidden lists into builtin `ui-audit` as a short "design-drift signals" section rather than creating a third overlapping design skill.
- No new general design skill; the existing global design cluster stays as-is (AIO-side dedupe becomes relevant only after D1).

**D6. Over-broad builtin triggers** ("data safety", "content rating", "play api", "public facing")? **Recommended**: tighten now (cheap, mechanical) — e.g. `new-app-setup` → "play console data safety", `human-public-writing` drops "public facing" in favor of "public facing copy"/"public facing email".

---

## 3. Observability design (Phases 2–4 of the prompt)

### 3.1 Data model (new RLM migration)

Table `skill_activations`: `id`, `skill_name`, `skill_source` (builtin|global|project), `instance_id`, `session_id`, `turn_key` (conversation-ledger message correlation), `matched_by` (trigger|embedding|explicit), `matched_trigger` (nullable), `match_score`, `tokens_injected`, `auto_selected` (0|1), `created_at`. Indexes on `(skill_name, created_at)` and `(instance_id, created_at)`. Fail-soft writes (never block message send). Recorded at the **injection seam** (`instance-context`), not at detection, so records reflect reality after budget trimming.

Table `skill_controls`: `skill_name` PK, `mode` (enabled|suggest-only|disabled), `updated_at`, `reason`. Honoured inside `detectRelevantSkills`/`loadSkillsWithBudget` — the kill-switch is enforced at selection time in the one live path.

### 3.2 Events + IPC

New typed event on actual injection (name, instance, trigger, score, tokens). New channels (following the 6-step convention): `skills:activations-recent`, `skills:health-summary`, `skills:set-control`, plus a delta push event for live badge/toast updates. Zod schemas in contracts; handlers in `orchestration-ipc-handler.ts`; preload domain; facade; `skill.store.ts` signals.

### 3.3 Live surfacing

- **Toast** on auto-activation via the existing `toast.service`/notification path: "Skill *visual-redesign* activated — matched 'redesign this'". Deduped per skill+instance per cooldown.
- **Badge** in `instance-header.component.ts`: count of skills active this session; popover lists each with matched trigger, score, token cost, and a per-skill disable toggle (writes `skill_controls`, effective next turn).

### 3.4 Skill health view

Extends the Skills page: per skill — total activations, activation rate (share of turns), tokens injected (sum/avg), last used, mode toggle. Correlation signals (v1 = time-window join, clearly labelled as correlation not causation): activations within N minutes preceding `session.errored` reactions, provider error events, or loop stall evidence; outlier flags ("fires on 78% of turns"). **Skill lint** at discovery: over-broad trigger (short/common substring), missing description, oversized core, trigger collision, tool-capability mismatch (existing `skill-tool-capability-check.ts`), duplicate name across sources — shown as warnings with one-click disable.

### 3.5 Kill-switch behaviour

`disabled` skills: never selected, never injected, never suggested; still listed (greyed) in UI with their history. `suggest-only`: surfaced as a suggestion, injected only on explicit user/UI action. Controls persist in sqlite, survive restart, apply to all instances. Default for newly discovered non-builtin skills: `suggest-only` (per D1a).

---

## 4. Non-goals

- Observing **native** CLI skill usage (Claude Code reading `~/.claude/skills` itself) — AIO attributes only its own injections. Noted in the health view so absence of data isn't read as absence of use.
- Automatic disabling based on correlation signals — v1 surfaces outliers; a human flips the switch.
- Consolidating/deleting the global skill directories or the `~/.agents` vs `~/.claude` drift (surfaced as findings; separate cleanup).
- Porting VibeCurb's CLI machinery, or its pixel-perfect/imagegen skills (flagged as future candidates).

## 5. Verification

Canonical checklist (tsc, spec tsc, lint, ts-max-loc, test:quiet) plus targeted tests for: migration, attribution write on injection, kill-switch enforcement in `detectRelevantSkills`, lint rules, IPC schema round-trips, store signals. Real-UI dev-app check of toast + badge + health view (store seeding if providers unavailable). Anything genuinely needing a rebuilt app defers to a `_livetest.md` per repo rules.
