# Idempotent automation creation + duplicate consolidation

Status: **completed** — Phase 1 & Phase 2 implemented & verified 2026-07-22
Owner: James
Created: 2026-07-19

## Problem

Agents repeatedly call `create_automation` for what is conceptually the *same*
recurring check, each time with a slightly reworded name (e.g. "Realer Minecraft
server hourly …", "Realer Minecraft hourly server …", "Realer Minecraft Server
Hourly…"). The `realer` workspace accumulated ~10 near-identical hourly
health-check automations.

Confirmed root cause: **creation has no dedupe.** `create_automation`
(`src/main/automations/automation-tool-impl.ts:120`) →
`createAutomationWithScheduling` (`automation-create-service.ts:37`) →
`AutomationStore.create` (`automation-store.ts:63`) is a plain `INSERT` with a
fresh id on every call. The only idempotency in the subsystem is at the **run**
level (`findIdempotentRun`, `automation-store.ts:795`), which dedupes
catch-up/retry *fires of one automation* — not creation. Names are irrelevant;
nothing keys on them.

## Key insight (why this dissolves the "subfolder" question)

One automation is *already* a running tally: `AutomationRunRow`
(`automation-store-records.ts:35`) gives every automation a stream of runs, each
with `output_summary` / `status` / `finished_at`, plus `unread_run_count` and
`consecutive_failures` rolled up on the automation. 240 hourly runs hang off one
`automation_id`, each separately navigable by timestamp.

So the ten shells are ten tallies-of-one instead of one tally-of-ten. The fix is
a **funnel** (idempotent create), not organisation (a subfolder). The automation
is the tally; the runs are the per-hour drill-down. Both are preserved from a
single automation, with no folder and no mega-bucket.

## Design decisions (agreed 2026-07-19)

1. **Guard on the agent create path only**, not `store.create`. UI/IPC creation
   is deliberate and must stay unguarded (silently merging a human's second
   automation would be surprising). The MCP/orchestrator `create_automation`
   path is the sole source of the accidental pile-up.
2. **Match key = strict/exact** to start: `workspace_id` + schedule
   (`type` + `expression` + `timezone`, or `runAt`) + exact `prompt` + `provider`.
   More fields in the key = fewer false merges. Loosen to semantic-prompt match
   only if agents keep varying the text.
3. **On match: reuse.** Return the existing automation's summary (existing id) so
   the agent gets a normal success. Do not insert a second shell, do not fire —
   the existing schedule already recurs. Every future hourly check funnels into
   the one automation → the tally assembles itself.
4. **Consolidation of the existing ten is a separate, conservative phase**
   (Phase 2), gated behind an inventory of every `automation_id` reference.

## Phase 1 — Idempotent create guard (stops the bleeding) — DONE 2026-07-19

As-built: implemented as a pure module
`src/main/automations/automation-equivalence.ts`
(`automationEquivalenceKey` + `findEquivalentAutomation`) rather than a store
method, to keep `automation-store.ts` off its LOC ratchet ceiling. The guard in
`automation-tool-impl.ts` `createAutomation` calls
`findEquivalentAutomation(await store.list(), input)` before
`createWithScheduling`; on a hit it returns the existing automation's summary
with `reused: true` and does not insert. `reused?: boolean` added to
`CreateAutomationResult`. Verified the runtime path: the
`ORCHESTRATOR_COMMAND create_automation` an agent emits routes through this exact
function (`orchestrator-tools-step.ts:535` → tool definition
`orchestrator-automation-tools.ts:335`). UI/IPC `store.create` path is
deliberately unguarded. Match is against `active` automations regardless of
`enabled`, so a temporarily/auto-disabled duplicate is still reused; its real
(possibly `false`) enabled state is returned honestly.

Tests: `automation-equivalence.spec.ts` (17 cases: name-ignored, prompt-trim,
field distinctions, JSON collision-safety, inactive/webhook exclusion,
workspace normalization, earliest-created + id tie-break) and 3 added
`automation-tool-impl.spec.ts` cases (reuse on reworded name; distinct on
differing prompt; distinct on differing provider). Gates green: `tsc`,
`tsc -p tsconfig.spec.json`, `lint`, `check:ts-max-loc`, and
`test:quiet src/main/automations` (140 passing).

Files:
- `automation-store.ts`: add `findEquivalentActiveAutomation(input)` — SELECT
  active automations in the same `workspace_id`, compare normalized
  schedule + prompt + provider; return the earliest-created match or `null`.
  Only consider `active = 1` and schedule-kind triggers (ignore already-fired
  one-time and webhook automations).
- `automation-tool-impl.ts` `createAutomation`: after building `input` and
  before `deps.createWithScheduling(input)`, call the lookup (via a new
  `deps.findEquivalent` injected fn, mirroring the existing dependency-injection
  style). On a hit, return the existing automation's summary with a
  `reused: true` flag and skip creation.
- Wire the production `findEquivalent` where `createAutomationToolImplementations`
  is constructed (same place `createWithScheduling` is wired).
- Extend the tool result type in `mcp/orchestrator-automation-tools` with an
  optional `reused?: boolean` so the agent (and logs) can tell reuse from create.

Tests (`automation-tool-impl.spec.ts`, `automation-store.spec.ts`):
- Same workspace + schedule + prompt + provider → second create returns the
  first id, `reused: true`, and the store still has exactly one automation.
- Differing prompt / schedule / provider / workspace → a genuine second
  automation is created (no false merge).
- UI/IPC `store.create` path is unaffected (still inserts unconditionally).

Acceptance: agent-initiated re-creation of an identical check is a no-op that
returns the existing automation; the run history accumulates under it.

## Phase 2 — One-off consolidation of the existing duplicates — DONE 2026-07-22

As-built: migration **`052_dedupe_identical_automations`** (SQL in
`src/main/persistence/rlm/automation-dedupe-schema.ts`, wired into
`RLM_MIGRATIONS_051_055`). The open risks below were resolved by tightening the
match and by *skipping* anything the merge could not prove safe, rather than by
assuming.

Key resolutions (differences from the sketch):

- **Grouping is on the full persisted config**, not just the Phase-1 key. The
  group key is `(workspace_id, schedule_type, schedule_json, trigger_json,
  action_json)`. Because `action_json` also carries `provider`, `systemAction`,
  `model`, `yoloMode`, etc., only `name`/`description` — the fields agents
  actually reword — are ignored. This eliminates the "per-automation state
  outside the key" risk entirely: any divergence in those fields makes the rows
  a different group and they are never merged. (E.g. two `oneTime` provider-limit
  resume automations differ in `systemAction.loopRunId` → never grouped.)
- **Candidates are `active = 1` schedule-triggered only.** Fired one-time
  (`active = 0`) and webhook automations are left alone.
- **Attachment assumption not relied on — attachment-bearing automations are
  skipped outright.** Attachments aren't in any equivalence key, so an identical
  prompt does not imply identical attachments; skipping removes the risk of
  silently dropping a file. (On the real DB none of the duplicate candidates had
  attachments anyway.)
- **In-flight runs protected.** Any automation with a `running`/`pending` run is
  skipped, so no active run is repointed/deleted; it merges on a later launch.
- **Soft webhook reference honoured.** Automations listed in a
  `webhook_routes.allowed_automation_ids_json` allowlist are skipped (that
  reference is not an FK the migration can rewrite). Confirmed these four tables
  (`automation_runs`, `automation_attachments`, `automation_thread_destinations`,
  `webhook_routes`) are the *only* references to an automation id.
- **State folded into the keeper** before losers are deleted: `enabled` → max
  (stay live if any member was), `last_fired_at` → max, `next_fire_at` → keeper's
  own else the latest loser's (never adopt an ancient tick → no catch-up storm),
  `updated_at` → max.
- **Unique-index collisions handled.** `automation_runs` has UNIQUE
  `(automation_id, scheduled_at) WHERE trigger IN ('scheduled','catchUp')` and
  UNIQUE `(automation_id, trigger, idempotency_key) WHERE idempotency_key IS NOT
  NULL`. Identical crons fire on the same aligned tick, so repointing collides.
  Before repointing, colliding loser runs are dropped: a keeper's own run always
  wins its tick; between loser runs the more informative status wins
  (`failed > succeeded > cancelled > skipped`, then earliest `created_at`/`id`).
  Dropped rows are redundant extra executions of the same prompt in the same
  tick — exactly the duplication being removed. Losers' thread destinations are
  dropped (keeper's config is the survivor).
- `down` is a documented no-op (a merge cannot be reversed).

Tests: `automation-dedupe-migration.spec.ts` (14 cases) drives the real
`runMigrations` runner — collapse onto earliest keeper; run repointing with zero
orphans; same-tick collision drop; most-informative-run retention; idempotency
collision drop; state folding + null `last_fired_at` preservation; distinct
automations untouched (prompt/provider/workspace/schedule/systemAction); skip of
inactive/webhook/attachment/in-flight/webhook-allowlisted; and no-op on a clean
DB. Verified additionally by applying the raw migration SQL to a **copy of the
live rlm.db**: 11→11 automations, 71→71 runs, 0 orphans (no byte-identical
duplicates currently exist, so it is a safe no-op there).

Gates green: `tsc`, `tsc -p tsconfig.spec.json`, `lint`, `check:ts-max-loc`, and
`test:quiet src/main/persistence src/main/automations` (173 passing).

## Out of scope

- Semantic (fuzzy) prompt matching — deferred until exact proves insufficient.
- Any subfolder / visual-grouping UI — the funnel removes the need; revisit only
  if genuinely-distinct automations still crowd a workspace.

## Verification (per phase)

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run check:ts-max-loc
npm run test:quiet -- src/main/automations
```
