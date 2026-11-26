# Auxiliary-Routing Offload Plan — keep grunt work off the frontier model

**Status:** DRAFT / untracked (unfinished plan — do not commit until implemented & verified)
**Date:** 2026-06-19 · **Revision:** rev17 (Part A is an implementation handoff)
**Origin:** James — "even with a frontier foreground model, things like file retrieval and
other grunt work should be routed to a local model, not burn frontier tokens."

rev3 changes: real settings migration for missing slots; HyDE timeout-layering resolved by slot
policy (not tuning); strictly-local speced as real work; Part B slot defaults + fallback semantics
grounded in current code; Part A broken into executable tasks with exact tests.
rev4 fixes (review): corrected `parseDefaultSlots()` desc (no tier-map builder) + checklist count
(9); migration now key-based not count-based; dropped unused `query` threading in `callLLM`;
added `HydeExpectedFallbackError` so the D2 fallback logs at debug not error (Task A3b); clarified
D2 blocks the frontier ladder, not all cloud aux endpoints; tightened `subQueryExecution` fallback
to the `subQuery()` returns-error-string convention.
rev5 (cross-model review): added the Remote-preference coverage matrix (current vs post-plan) that
answers the founding question per-path; surfaced that HyDE + every `subQuery()` path have no
remote-worker preference today (cloud-first, localhost-only `generateCompletion` ladder); surfaced
the `cheap-first` exception to remote preference; fixed Task A1 checklist site numbers (5/6/7) and
disambiguated the `EMPTY_FALLBACK_SLOTS` prose-vs-JSON note.
rev6 (review): `HYDE_PROMPTS['mixed']` bracket access (Record + `noPropertyAccessFromIndexSignature`
would fail `.mixed`); added `provider:'auto'` to the `retrievalHypothesis` default for shape parity with
every wired slot; A2 migration now uses a pure `mergeMissingDefaultSlots()` helper in
`auxiliary-llm-utils.ts` instead of exporting/importing `parseDefaultSlots` from the service module
(keeps settings-manager off the service dependency); reworded reusable checklist item 8 to "update the
expected slot count" (Part B adds more slots, so "seven→eight" is Part-A-only).
rev7 (review): added the streaming sub-query (`LLM_SUBQUERY_STREAM` → `subQueryStreaming`) to the
coverage matrix + excluded list (renderer pass-through; no streaming aux path); flagged the
`loop-semantic-progress` behavior change from reusing `loopScoring` (`allowFrontierFallback:false` →
neutral when aux is enabled-but-unhealthy); disambiguated Strictly-local into B1 (coordinator localhost
only) vs B2 (any self-hosted incl. worker-node/LAN) and required enforcing `localOnly` on the explicit
`endpointId+model` branch (`:326-333`), not just auto resolution; added exact default slot configs for
`branchScoring` and `subQueryExecution` (with `subQueryExecution` defaulting `enabled:false`).
rev8 (fresh-eyes verification pass — all anchors checked against source): corrected drifted line numbers
`EMPTY_FALLBACK_SLOTS` `:119`→`:123` (`:119` is the adjacent `JSON_FALLBACK_TEXT`), sub-query error
return `llm-service.ts:265`→`:271`, `branchScoring` fallback `default-invokers.ts:896`→`:894`,
`'[Sub-query failed]'` sentinel `context-manager.ts:233`→`:235`; Task A1 test note now calls out renaming
the literal `'…all seven slots'` `it()` title (`:28`), not just the `ALL_SLOTS` array; A4 test example
source `'local'`→`'localhost'` with a note the real check is `decision.source !== 'fallback'`. Verified
accurate (no change): all 9 checklist symbols, the `generate()`/`buildFallback` source+allowFrontierFallback
contract, the HyDE ladder (`:319-361`, Haiku `:377`, `callLLM` `:308`, call site `:292`), cheap-first
ordering `:389-394`, `ollamaHost` `:796`, and the `llm-ipc-handler` `:88`/`:178` call sites.
rev9 (review): **reverted rev8's A4 `'local'`→`'localhost'` change — it was wrong.**
`AuxiliaryLlmDecision.source` is `'local' | 'cheap-cloud' | 'fallback'` (`auxiliary-llm.types.ts:122`),
not an endpoint source; mock must use `'local'`. Also: A3b now suppresses **both** the error log and the
`this.emit('error', …)` event (`hyde-service.ts:175-177`) on the expected-fallback path (was log-only);
A2 gains a constructor-level integration test (invokes via `settings-manager.ts:97`, harness from
`settings-cache.spec.ts:3`) on top of the pure-helper unit test; coverage-matrix claim narrowed from
"every non-foreground LLM call" + added excluded rows for the two frontier-SDK paths (`hook-prompt.ts:54`,
`context-editing-fallback.ts:302`); Part B retitled "convert specific call sites" (NOT `subQuery()`
globally — excluded paths share it); pinned the exact `subQueryExecution` fallback string
(`"Unable to process sub-query: no auxiliary model available"`); fixed Strictly-local B2 — `endpoint.source`
has no `cheap-cloud`, so B2 reuses a `isPrivateOrLocalhostUrl(baseUrl)` predicate (`auxiliary-llm-handlers.ts:72`)
for `manual` endpoints rather than the unimplementable `source !== <cheap-cloud>`.
rev10 (review): added a service-level empty-fallback test for `retrievalHypothesis` in
`auxiliary-llm-service.spec.ts` (mirrors compression/memoryDistillation `:337-356`) — the types spec
alone doesn't exercise `EMPTY_FALLBACK_SLOTS`; **corrected the `subQueryExecution` fallback** — today's
no-provider path returns `generateLocal()`'s `'[LLM unavailable …]'` (`llm-service.ts:874`), NOT the
`:271` exception string (throw-only), so the deterministic aux fallback now reuses that local-unavailable
text for true parity; fixed Strictly-local's stale "checklist sites 5/8" → real slot-config-field touch
points (`localOnly` is a field, not a new slot); dropped the "Tune at implementation" hedge from Part B's
slot configs.
rev11 (fresh-eyes source verification — all anchors re-checked against current source):
**corrected rev10's "`:271` exception string (throw-only)"** — `llm-service.ts:271` is a `return` inside
`subQuery()`'s catch, **not** a throw; it (and `context-manager.ts:235`) are catch paths reached only when
`generateCompletion`/`subQuery` *throws*, distinct from the no-provider fallthrough (which returns
`generateLocal()`'s text). Noted `generateLocal` definition is `:864` (the `:412`/`:874` already-cited
anchors are the fallthrough call site and the literal). Disambiguated the hook-executor exclusion's
score-shaped fallback to **`auxiliary-llm-service.ts:119`** (`JSON_FALLBACK_TEXT`), not `hook-executor.ts:119`
(a comment line), and fixed its fail-open anchor (catch `:645` / `approved:true` return `:651-654`). Fixed
Strictly-local resolver drift: `resolveEndpointForSlot` `:320`→`:321`, explicit `endpointId+model` branch
`:326-333`→`:326-334`. Task A3 now (a) adds the missing `getAuxiliaryLlmService` import (hyde-service has
no aux reference today; getter at `:697`) and (b) widens the `callDirectProviders` move range `:319-361`→
`:317-361` so the `const config = getConfig()` line moves with the providers instead of being orphaned.
Verified accurate (no change): the 9-site checklist symbols/lines, `AuxiliaryLlmDecision.source`/endpoint
`source` enums (`:122`/`:74`), `generate()` returning `{text, decision}` with `source`/`allowFrontierFallback`/
`endpointId`, the cheap-first ordering (cheapCloud→local→autoWorker→localhost, with configured worker
Ollama endpoints possibly in the `local` bucket) `:389-394`, all
`DEFAULT_SETTINGS` slot defaults, the `'…all seven slots'` spec title `:28`, and the
`compression`/`memoryDistillation` empty-fallback test bodies `:337-356`.
rev12 (review+fix): corrected Part B's fallback-control-flow prose. A3 pattern means:
non-fallback aux result → use it; fallback with `decision.allowFrontierFallback:true` → call the preserved
old frontier/direct path; deterministic local fallback only when frontier fallback is disallowed (or when the
preserved old path reaches its existing fallback). This matters because `branchScoring` and
`subQueryExecution` default `allowFrontierFallback:true`, and `subQueryExecution` defaults `enabled:false`
(see Part B's *Exact default slot configs* block), so a naive "any `decision.source==='fallback'` →
deterministic fallback" would change default behavior immediately. Also tightened the `cheap-first` note:
auto-discovered workers are
third, but a configured worker-node Ollama endpoint can appear in the `local` bucket.
rev13 (review): verified rev12's control-flow fix against source (`generateLocal` `:874`, `branchScoring`
catch `:894`, cheap-first ordering `:389-394`) — all correct. Fixed two residuals: (a) rev12's changelog
cited drift-prone plan-internal anchors `:337`/`:343`/`:340` for the `allowFrontierFallback:true`/
`enabled:false` defaults (actually the config block at the doc's lines 348/354/351) — replaced with a named
reference to Part B's *Exact default slot configs* block; (b) Part B step 1 omitted the `text.trim()`
non-empty guard that A3's `callLLM` snippet applies, so an empty non-fallback aux result would be consumed
instead of escalating — added the guard with its `branchScoring` rationale. Also confirmed HyDE's outer
`generationTimeout` default is `3000` (`hyde-service.constants.ts:11`), so A1's `timeoutMs:2500 < 3000`
layering and D2's `→4000` override are both grounded.
rev14 (review+fix): corrected Task A4's mock examples to match the actual aux service return shape
(`generate()` returns `{ text, decision }`, with `source`/`allowFrontierFallback` inside `decision` —
`auxiliary-llm-service.ts:270`, `:302-311`, fallback builder `:595-608`). Also corrected the adjacent
"any non-fallback source counts" wording: A3 succeeds only when `decision.source !== 'fallback'` **and**
`text.trim()` is non-empty.
rev15 (fresh-eyes verification — no changes): re-checked rev14's A4 mocks against source and confirmed all
three typecheck. `AuxiliaryLlmDecision` (`auxiliary-llm.types.ts:117-134`) has **optional** `endpointId?`/
`model?` (`:120-121`), so the mocks omitting them are valid; `AuxiliaryLlmProvider` (`:37-42`) is
`ollama | openai-compatible | anthropic | openai | local-fallback`, so mock (a)'s `provider:'ollama'` and
(b)/(c)'s `provider:'local-fallback'` are both real members. `buildFallback` (`:595-608`) emits exactly
`{ text:'' (retrievalHypothesis ∈ EMPTY_FALLBACK_SLOTS), decision:{ slot, provider:'local-fallback',
source:'fallback', reason, allowFrontierFallback } }`, matching mocks (b)/(c). rev14 anchors `:270`/
`:302-311`/`:595-608` all confirmed. No other content changed since rev13; no fixes required.
rev16 (review+fix): made A2's constructor-level migration test implementable against the existing
`settings-cache.spec.ts` ElectronStore mock. The harness currently creates an inline `set: vi.fn(...)`
inside the mocked constructor (`:7-13`), so there is no direct "store.set" spy to inspect. The plan now tells
the implementer to hoist/expose a `mockStoreSet` (or equivalent) and reset it in `beforeEach` before asserting
"first constructor writes once, second constructor does not write `auxiliaryLlmSlotsJson` again."
rev17 (review+fix): clarified A2 migration tests must seed the seven current-format/default slot configs with
only `retrievalHypothesis` omitted, not pre-tier/pre-timeout legacy configs. This isolates
`migrateAuxiliaryMissingSlots()` because existing one-shot aux migrations can otherwise write
`auxiliaryLlmSlotsJson` first.

---

## Scope & non-goals

**In scope:** move LLM *grunt work* off the frontier model onto `auxiliary-llm-service.ts`.
**Not in scope:** foreground chat model (untouched); base vector/index retrieval (already non-LLM);
`answer-agent.ts:330` (user-facing answer generation — stays frontier); subagent-for-edits (Part C).

---

## Remote-preference coverage — current vs post-plan

Founding question: *is the remote PC preferred over local for local-LLM grunt work?* Per-path audit
of the non-foreground **helper / grunt-work** LLM calls considered for offloading. Direct frontier
**SDK** calls that are part of the main message loop (prompt hooks, context-editing) are **not** routing
candidates — they're listed as excluded rows at the bottom so the audit stays honest, not "every call":

| Call path | Current routing | Remote-worker preferred today? | After this plan |
|---|---|---|---|
| Aux slots already wired (compression, memoryDistillation, webExtract, titleGeneration, routingClassification, approvalScoring, loopScoring) | aux service | ✅ in `local-first`; ❌ in `cheap-first` (note 2) | unchanged |
| **HyDE hypothetical** (`hyde-service.ts:319-361`) | private ladder: **cloud Anthropic Haiku → OpenAI → localhost Ollama** | ❌ cloud-first; Ollama is localhost-only, never the worker node | **Part A** → aux service → ✅ (`local-first`) |
| subQuery: recursive sub-query (`context-manager.ts:220`) | `LLMService.generateCompletion` (`llm-service.ts:353-411`): **Anthropic → localhost Ollama → OpenAI** | ❌ cloud-first; localhost-only | **Part B (opt-in)** → aux → ✅ |
| subQuery: branch scoring (`default-invokers.ts:879`) | same `generateCompletion` ladder | ❌ | **Part B** → aux → ✅ |
| subQuery: loop progress (`loop-semantic-progress.ts:125`) | same ladder | ❌ | **Part B** → aux (`loopScoring`) → ✅ |
| subQuery: hook approval (`hook-executor.ts:622`) | same ladder | ❌ | excluded (stays) |
| subQuery: answer generation (`answer-agent.ts:330`, user-facing) | same ladder | ❌ | excluded (stays frontier) |
| streaming sub-query (`llm-ipc-handler.ts:178` → `subQueryStreaming` → `generateCompletionStreaming`, `llm-service.ts:421`) | same cloud/localhost ladder (streaming variant) | ❌ | excluded (renderer-driven pass-through; streaming has no aux-service path — see Part B excluded) |
| prompt hooks (`hooks/executor/hook-prompt.ts:54`) | direct `anthropic.messages.create` (Haiku) — frontier SDK, not `subQuery`/aux | n/a (cloud SDK) | **excluded** — security gate in the tool-call path, not grunt work; offloading is a separate decision (cf. D4 hook approval) |
| context-editing fallback (`memory/context-editing-fallback.ts:302`) | direct `client.beta.messages.create` — frontier SDK | n/a (cloud SDK) | **excluded** — part of the main message loop, foreground-adjacent, not a helper call |

**Note 1 — HyDE and every `subQuery()` path have zero remote-worker preference today.** They are
cloud-first when an API key is set, and their only "local" option is **localhost** Ollama
(`config.ollamaHost`, `llm-service.ts:796`) — which never targets the remote GPU node. Only the
already-wired aux slots honor remote-first. So the honest answer to the founding question *today* is:
**no, except the seven wired aux slots, and only in `local-first` mode.** Part A closes HyDE; Part B
(opt-in) closes the `subQuery` grunt-work paths.

**Note 2 — `cheap-first` is the exception to remote preference.** In `routingMode:'cheap-first'` the aux
router orders cheap-cloud → configured local/Ollama → auto-discovered worker-node → localhost
(`auxiliary-llm-service.ts:389-394`). A persisted worker-node Ollama endpoint can appear in the configured
local/Ollama bucket, but the key point holds: **remote is not guaranteed first** in `cheap-first`. The
"remote preferred" guarantee holds only in the default `local-first` mode. Forcing remote/local regardless
of routing mode is D1=B/`localOnly`.

---

## DECISIONS (locked unless James overrides)

| # | Decision | Default (recommended) | Override cost |
|---|---|---|---|
| D1 | "routed locally" meaning | **(A)** local *model*, host by availability (router already prefers remote GPU box, falls back to localhost) | (B) strictly-local = real per-slot `localOnly` policy (see §Strictly-local) |
| D2 | HyDE fallback policy | `retrievalHypothesis` slot `allowFrontierFallback:false`, `timeoutMs:2500` → hot path is **aux → direct-embed**, no cloud ladder | preserve cloud HyDE: `allowFrontierFallback:true`, aux `timeoutMs:2000`, HyDE outer→4000 |
| D3 | Part B initial scope | Part A only first; then `loop-semantic-progress` (safe) | also take `branchScoring` / `subQueryExecution` now |
| D4 | Hook approval | leave alone this pass (fail-open footgun) | dedicated `hookApproval` slot later |
| D5 | Part C edit delegation | leave edits inline | lower `delegation-policy` threshold for multi-file batches |

**D2 behavior change to confirm:** installs with no local aux model that currently get cloud-Haiku
HyDE will instead direct-embed (HyDE effectively off — cheaper; HyDE is an optimization, not correctness).

**D2 scope clarification:** `allowFrontierFallback:false` blocks HyDE's own *frontier ladder* (the direct
Haiku/GPT calls in `callDirectProviders`). It does **not** force the aux endpoint itself to be local —
under `routingMode:'cheap-first'` the router may still pick a cheap-*cloud* aux endpoint
(`auxiliary-llm-service.ts:373`). "No frontier tokens" ≠ "no cloud". Truly-local requires D1=B/`localOnly`.

---

## Reusable "add an auxiliary slot" checklist (9 sites)

For a new slot `X` (every exhaustive use must be updated or typecheck/runtime breaks):

1. `shared/types/auxiliary-llm.types.ts:9-16` — add `X` to `AuxiliaryLlmSlot` union.
2. `shared/types/auxiliary-llm.types.ts:27-35` — add `X` to `DEFAULT_SLOT_TIERS`.
3. `shared/types/settings.types.ts` — `DEFAULT_SETTINGS.auxiliaryLlmSlotsJson` must include `X`.
   (`parseDefaultSlots()` at `auxiliary-llm-service.ts:146` just `JSON.parse`s this constant — there is
   **no** separate builder/tier-map path to touch.)
4. `core/config/settings-control-policy.ts:83` — add `X: auxiliarySlotSchema.optional()` to
   `auxiliarySlotMapSchema` (it is `.strict()` **and** `satisfies Record<AuxiliaryLlmSlot,…>`).
5. `rlm/auxiliary-llm-service.ts:123` `EMPTY_FALLBACK_SLOTS` (the `Set`; `JSON_FALLBACK_TEXT` is the
   adjacent `:119`) — add `X` if it returns prose, not JSON.
6. `ipc/handlers/auxiliary-llm-handlers.ts:26` `SLOT_TEST_PROMPTS` — add an entry (exhaustive Record).
7. `renderer/.../auxiliary-models-settings-tab.component.ts:36` `SLOTS` (+ `WIRED_SLOTS` `:53` iff consumed).
8. `shared/types/__tests__/auxiliary-llm.types.spec.ts:5` — extend `ALL_SLOTS` and update the expected
   slot count assertion (this is a *reusable* checklist; Part B adds `branchScoring`/`subQueryExecution`,
   so don't hard-code "seven"→"eight" here — Task A1 names the concrete count for its own pass).
9. **Migration** (new, see Task A2) — merge missing default slots into persisted JSON so existing
   installs can edit the new slot in the UI.

---

## PART A — Route HyDE through the auxiliary service  *(IMPLEMENTATION HANDOFF)*

**Goal:** HyDE hypothetical generation stops bypassing aux routing (currently Anthropic Haiku first,
`hyde-service.ts:377`) and instead uses the configured local/remote-GPU aux model, with direct-embed
as the terminal fallback. Net effect honors `routingMode`, the remote box, and intent.

### Task A1 — Add the `retrievalHypothesis` slot
Run checklist sites 1–9 with these defaults:
```
retrievalHypothesis: {
  enabled: true, provider: 'auto', tier: 'quick',   // provider:'auto' to match every existing default slot (settings.types.ts:560)
  maxInputTokens: 4096, maxOutputTokens: 300,   // 300 = current maxHypotheticalTokens
  temperature: 0.3, timeoutMs: 2500,            // < HyDE outer 3000 (D2)
  requireJson: false, allowFrontierFallback: false,  // D2: no cloud ladder in hot path
}
```
- Checklist site 5 (`EMPTY_FALLBACK_SLOTS`): add `retrievalHypothesis`. Rationale: the slot returns a
  free-text hypothetical *document*, so its fallback must be `''` (empty), **not** the score-shaped
  `JSON_FALLBACK_TEXT`. This pairs with `requireJson:false` in the slot config above — set both, or a
  JSON-mode fallback string leaks into the embedder. (This is the "prose, not JSON" case in checklist item 5.)
- Checklist site 6 (`SLOT_TEST_PROMPTS`): `{ system: HYDE_PROMPTS['mixed'], user: 'Search query: "how is retry/backoff implemented?"' }`.
  Use bracket access — `HYDE_PROMPTS` is typed `Record<string, string>` (`hyde-service.constants.ts:20`) and
  the repo has `noPropertyAccessFromIndexSignature` enabled (`tsconfig.json:19`), so `HYDE_PROMPTS.mixed`
  fails typecheck.
- Checklist site 7 (`SLOTS` **and** `WIRED_SLOTS`): add `retrievalHypothesis` to both (HyDE consumes it).
- **Test (two specs):**
  1. `auxiliary-llm.types.spec.ts` — extend `ALL_SLOTS` (`:5`) to eight and rename the
     `'auxiliaryLlmSlotsJson contains all seven slots'` test title (`:28`) to "eight" (the literal count
     word lives in the `it(...)` name, not just the array); assert `retrievalHypothesis` present with
     `allowFrontierFallback:false`, `tier:'quick'`.
  2. `auxiliary-llm-service.spec.ts` — add an **empty-fallback** test mirroring the existing
     `'compression fallback returns empty string'` / `'memoryDistillation fallback returns empty string'`
     cases (`:337-356`): `configure(baseSettings({ auxiliaryLlmEnabled: false }))`, then
     `generate('retrievalHypothesis', 'sys', 'user')` → assert `text === ''` and `decision.source === 'fallback'`.
     This is what actually verifies the `EMPTY_FALLBACK_SLOTS` membership at runtime — the types spec only
     checks default settings, not the fallback shape.

### Task A2 — Settings migration: merge missing default slots
- `rlm/auxiliary-llm-utils.ts`: add a **pure** `mergeMissingDefaultSlots(raw: string): string | null`,
  mirroring the existing `backfillSlotTiers`/`raiseSlotOutputBudget` helpers already in this file (and
  already imported by settings-manager). Keep settings migration dependency-light — do **not** import
  `parseDefaultSlots` from `auxiliary-llm-service.ts`; that would pull the whole service module into
  settings-manager. `parseDefaultSlots()` is only `JSON.parse(DEFAULT_SETTINGS.auxiliaryLlmSlotsJson)`
  (`auxiliary-llm-service.ts:146`), so the helper reproduces it locally:
  - parse `raw` (on parse error → return `null`; runtime defaults cover it);
  - `const defaults = JSON.parse(DEFAULT_SETTINGS.auxiliaryLlmSlotsJson)` (import `DEFAULT_SETTINGS` from
    `shared/types/settings.types` — this module already imports `DEFAULT_SLOT_TIERS` from shared types);
  - `const merged = { ...defaults, ...parsed }` (parsed wins);
  - return `JSON.stringify(merged)` **iff a default key is missing** from `parsed`
    (`Object.keys(defaults).some((k) => !(k in parsed))`), else `null`. Key-based, **not** count-based —
    a `keys.length` comparison can miss odd persisted shapes (an extra junk key masking a missing default).
- `core/config/settings-manager.ts`: add `private migrateAuxiliaryMissingSlots()` that reads
  `auxiliaryLlmSlotsJson`, calls `mergeMissingDefaultSlots(raw)`, and writes back only when it returns
  non-null. Import the helper from `../../rlm/auxiliary-llm-utils` (settings-manager already imports
  `backfillSlotTiers`/`raiseSlotOutputBudget` from there).
  - **Keyless/idempotent** — no one-shot migration key, so future slot additions self-heal. Writes only
    when a slot was actually added (no churn).
- Invoke it in the migration sequence (~`:129`, after `migrateTitleGenerationBudget()`).
- **Test (two levels):**
  1. *Unit* — `mergeMissingDefaultSlots` directly (pure, no harness; same style as existing
     `auxiliary-llm-utils` helper tests): seed the seven current-format default slots with
     `retrievalHypothesis` omitted, assert `retrievalHypothesis` is now present and equals the default; call
     again on the merged output, assert it returns `null` (idempotent).
  2. *Constructor-level integration* — that `SettingsManager` actually **invokes** the migration on
     construction (`settings-manager.ts:97` runs the migration sequence) and writes exactly once. Use the
     existing in-memory ElectronStore harness from `settings-cache.spec.ts:3`, but expose the mocked setter:
     hoist a shared `mockStoreSet = vi.fn((k, v) => { ...same store mutation... })`, have the ElectronStore
     mock return `set: mockStoreSet`, and reset it in `beforeEach` after clearing `store`. Seed
     `store.auxiliaryLlmSlotsJson` with the seven current-format default slot configs with
     `retrievalHypothesis` omitted (tiers present, current timeout/budget/fallback defaults), then
     `new SettingsManager()`, assert the persisted JSON now contains `retrievalHypothesis`, and assert one
     `mockStoreSet` call wrote `auxiliaryLlmSlotsJson`.
     Clear `mockStoreSet`, construct a second `SettingsManager`, and assert there is no second
     `set('auxiliaryLlmSlotsJson', …)` call — proves it's invoked and idempotent end-to-end, not just the
     pure helper. (The current harness's inline `set: vi.fn(...)` at `settings-cache.spec.ts:7-13` is not
     directly inspectable without this small test-harness exposure.)

### Task A3 — Rewrite `HyDEService.callLLM()` (`hyde-service.ts:308-362`)
Keep the **current signature** `callLLM(systemPrompt, userPrompt)` — call site `:292` is unchanged.
Do **not** thread `query` (it would be unused churn / lint noise; the deterministic template is not wired).
```ts
private async callLLM(systemPrompt: string, userPrompt: string): Promise<string> {
  const { text, decision } = await getAuxiliaryLlmService()
    .generate('retrievalHypothesis', systemPrompt, userPrompt);
  if (decision.source !== 'fallback' && text.trim()) return text;
  if (decision.allowFrontierFallback) return this.callDirectProviders(systemPrompt, userPrompt);
  throw new HydeExpectedFallbackError();   // expected → embed() direct-embeds (logged at debug, see A3b)
}
```
- Add `import { getAuxiliaryLlmService } from './auxiliary-llm-service';` — hyde-service does **not**
  currently reference the aux service (verified: no `AuxiliaryLlm*` import today). The getter is exported
  at `auxiliary-llm-service.ts:697`.
- Rename the existing Anthropic/OpenAI/Ollama ladder body into `private callDirectProviders(...)`
  (verbatim move of the current `callLLM` body — `:317-361`: the `getConfig()` fetch through the three
  provider attempts and the final throw, so the `const config` at `:317` moves **with** the providers and
  isn't orphaned in the new `callLLM`). No internal change.
- **Do NOT** wire `fallbackHypothetical` — terminal fallback stays direct-embed (`embed()` catch `:180`).
- With D2 defaults (`allowFrontierFallback:false`) `callDirectProviders` is unreachable in the hot
  path but kept for the D2-override branch.

### Task A3b — Don't log the expected fallback as an error
`embed()`'s catch logs `logger.error('Failed to generate hypothetical document', …)` (`:173-174`).
Under D2, "aux unavailable + frontier disallowed → direct-embed" is **expected**, not an error.
- Add `class HydeExpectedFallbackError extends Error {}`.
- The `embed()` catch does **two** things — `logger.error(...)` (`:174`) **and** `this.emit('error', …)`
  (`:175-177`). Both must be skipped for the expected path, or `'error'` listeners still fire for an
  intended fallback:
  ```ts
  } catch (error) {
    if (error instanceof HydeExpectedFallbackError) {
      logger.debug('HyDE fell back to direct embedding');               // no error log, no emit
    } else {
      logger.error('Failed to generate hypothetical document', error instanceof Error ? error : undefined, { query });
      if (this.listenerCount('error') > 0) this.emit('error', { query, error });
    }
    // existing direct-embed return (:180-188) unchanged
  }
  ```
- Genuine generation/network errors still log at `error` **and** emit `'error'`.
- **Test:** spy on `logger.error` and attach an `'error'` listener; assert the disallowed-fallback path
  triggers **neither**, while a genuine provider error triggers **both**.

### Task A4 — Tests for HyDE routing
- `hyde-service` spec (new or extend): mock `getAuxiliaryLlmService`:
  - (a) aux returns
    `{ text:'<doc>', decision:{ slot:'retrievalHypothesis', provider:'ollama', source:'local', reason:'test', allowFrontierFallback:false } }`
    → `callLLM` returns `<doc>`; no direct-provider call.
    (`AuxiliaryLlmDecision.source` is `'local' | 'cheap-cloud' | 'fallback'` (`auxiliary-llm.types.ts:122`) —
    a **decision** source, distinct from the *endpoint's* `source` (`'manual' | 'localhost' | 'worker-node'`,
    `:74`). `callLLM` checks both `decision.source !== 'fallback'` **and** `text.trim()`, so the successful
    mock must use a real non-fallback decision-source value and non-empty text.)
  - (b) aux returns
    `{ text:'', decision:{ slot:'retrievalHypothesis', provider:'local-fallback', source:'fallback', reason:'test', allowFrontierFallback:true } }`
    → `callDirectProviders` invoked.
  - (c) aux returns
    `{ text:'', decision:{ slot:'retrievalHypothesis', provider:'local-fallback', source:'fallback', reason:'test', allowFrontierFallback:false } }`
    → `callLLM` throws →
    `embed()` returns `hydeUsed:false` direct embedding.
- `hyde-service-fallback.spec.ts:69` — existing assertions hold; **update setup** to mock the aux
  service returning a non-frontier fallback so the test reaches the catch. No expectation rewrites.

### Task A5 — Verify
- `npx tsc --noEmit` + `-p tsconfig.spec.json` (exhaustive Record sites catch a missed slot).
- `npm run lint` + `npm run check:ts-max-loc`.
- `npm run test -- auxiliary-llm.types hyde settings-manager`.
- Manual: aux Ollama configured + Anthropic key present → run a semantic search → confirm
  `decision.source === 'local'` and `decision.endpointId` points at the aux endpoint (not the Haiku
  ladder). Then `routingMode:'off'` → HyDE behaves as today (regression).

### Part A acceptance criteria
- HyDE never calls cloud Haiku when a healthy aux model exists (D2 defaults).
- Existing installs can edit the new slot in Settings (migration applied).
- `routingMode:'off'` reproduces current HyDE behavior exactly.
- All quality gates green.

---

## PART B — Convert specific grunt-work call sites off frontier  *(grounded spec; gated on D3)*

**Scope is per-call-site, NOT `LLMService.subQuery()` globally.** `subQuery()` is shared — the *excluded*
paths (`answer-agent.ts:330`, `hook-executor.ts:622`, `llm-ipc-handler.ts:88`) call it too, so changing
`subQuery()` itself would violate the exclusions. Each conversion below edits **only** the named call site
to route through `getAuxiliaryLlmService().generate(slot, …)` (A3 pattern), leaving `subQuery()` intact.

`subQuery()` routes through `LLMService.generateCompletion` (`llm-service.ts:353-411`): cloud Anthropic
first (if key set) → **localhost-only** Ollama (`:796`) → OpenAI. It has **no aux routing and no
remote-worker preference** — so none of these paths currently use the remote GPU box. Converting the
named sites to the aux service is what gives them remote-first placement (see coverage matrix above).

| Site | Slot (new) | tier | requireJson | allowFrontierFallback | Terminal deterministic fallback (after preserved frontier path is unavailable/disallowed) |
|---|---|---|---|---|---|
| `orchestration/loop-semantic-progress.ts:125` | reuse `loopScoring` | quick | (as slot) | (as slot) | existing `NEUTRAL_SEMANTIC_RESULT` |
| `orchestration/default-invokers.ts:879` | `branchScoring` | quick | true | true | `{}` (empty score map, = catch `:894`) |
| `rlm/context-manager.ts:220` | `subQueryExecution` | quality | false | true (preserves today) | **reuse the current local-unavailable text.** Today's *no-provider* path does **not** return the `:271` catch-path error string — `generateCompletion` falls through to `generateLocal()` (call site `llm-service.ts:412`; definition `:864`), which (for a non-summary prompt) returns `'[LLM unavailable - unable to process query. Please configure an LLM provider (Anthropic, OpenAI, or Ollama) for intelligent responses.]'` (`:874`). For parity, emit that exact text when `decision.source==='fallback'` and frontier is disallowed — ideally extract `generateLocal`'s literal to a shared const and reuse it. The `:271` string (`subQuery()`'s own catch-path **return**) and the `'[Sub-query failed]'` sentinel (`context-manager.ts:235`, also a catch) are reached only when `generateCompletion`/`subQuery` **throws** — not the no-provider fallthrough, which returns `generateLocal()`'s text without throwing. |

#### Exact default slot configs (checklist site 3 — `DEFAULT_SETTINGS.auxiliaryLlmSlotsJson`)
These are the concrete defaults to ship (not placeholders) — they mirror the existing wired slots'
budgets/timeouts, so they're directly implementable when D3 promotes Part B:
```
branchScoring: {
  enabled: true, provider: 'auto', tier: 'quick',
  maxInputTokens: 16000, maxOutputTokens: 512,        // candidate summaries sliced to 1500 ea; JSON score map out
  temperature: 0, timeoutMs: 30000,                   // deterministic scoring, like routing/approval/loopScoring
  requireJson: true, allowFrontierFallback: true,     // preserves today's cloud-first escalation
}
subQueryExecution: {
  enabled: false, provider: 'auto', tier: 'quality',  // OPT-IN: load-bearing for retrieval quality (see caveat)
  maxInputTokens: 64000, maxOutputTokens: 2048,        // recursive sub-query context can be large
  temperature: 0.2, timeoutMs: 45000,                 // quality slot; 45s tolerates cold local-model load
  requireJson: false, allowFrontierFallback: true,    // preserves today's behavior
}
```
- **Fallback policy, not `EMPTY_FALLBACK_SLOTS`:** neither is a "prose → `''`" slot, so do **not** add them
  to `EMPTY_FALLBACK_SLOTS` (checklist site 5). Follow the real A3 control flow at each call site:
  1. aux success (`decision.source !== 'fallback'` **and** `text.trim()` non-empty, matching the A3
     `callLLM` snippet) →
     consume `text`. The non-empty guard matters: an empty non-fallback result (e.g. a blank
     `branchScoring` JSON) must fall through to step 2/3, not be consumed (it would `JSON.parse('')`-throw
     straight to `{}` and skip frontier escalation);
  2. aux fallback with `decision.allowFrontierFallback === true` → call the preserved old
     `llm.subQuery(...)` path for that site (this is required for default behavior, especially because
     `subQueryExecution` ships `enabled:false`);
  3. only when frontier fallback is disallowed, or when the preserved old path reaches its existing fallback,
     use the terminal deterministic value from the table (`branchScoring` → `{}`;
     `subQueryExecution` → `generateLocal()`'s local-unavailable text, `llm-service.ts:874`).

- Convert via the A3 ladder pattern. Each new slot runs the full 9-site checklist + A2 migration covers it.
- **`subQueryExecution` caveat:** load-bearing for retrieval *quality*; default it **disabled/opt-in**
  (`enabled:false` above) and A/B before trusting a weak local model. Offload point is the `subQuery()`
  call at `context-manager.ts:220` (the `onSubQueryRequest` callback is indirection).
- **`loop-semantic-progress` behavior change (confirm, like D2):** reusing `loopScoring` inherits its
  default `allowFrontierFallback:false` (`settings.types.ts:566`). So with aux **enabled but no healthy
  aux endpoint**, loop progress goes **neutral** (`NEUTRAL_SEMANTIC_RESULT`) instead of today's cloud
  ladder (`loop-semantic-progress.ts:125`). This is the intended "no frontier tokens for grunt work"
  outcome (loop scoring is an advisory heuristic, not correctness), but it *is* a behavior change — flag
  it for James, or set the slot `allowFrontierFallback:true` to preserve the cloud escalation.
- **Start order (D3):** `loop-semantic-progress` (safe, has neutral fallback) → `branchScoring` →
  `subQueryExecution` (opt-in). One site at a time, verify each.
- Tests per site mirror A4 and must prove the control flow: aux-success / fallback-allowed escalation to the
  preserved old path / deterministic fallback only when fallback is disallowed.

### Excluded this pass
- `answer-agent.ts:330` — user-facing answer generation, stays frontier.
- `hooks/hook-executor.ts:622` — fail-**open** today (catch at `:645`, returns `approved:true` at
  `:651-654`); the aux service's generic fallback is score-shaped (`JSON_FALLBACK_TEXT` =
  `{"score":0,"confidence":0,"reason":"No auxiliary model available"}`, **`auxiliary-llm-service.ts:119`**)
  with no `"approved"` key — so naive routing silently flips approve→deny: the parser regex requires an
  `"approved"` key (`hook-executor.ts:632`) and won't match, then the keyword check (`:643`) reads `false`.
  Needs a dedicated `hookApproval` slot + explicit fail-open/closed decision (D4). Skip for now.
- `ipc/llm-ipc-handler.ts:88` (`LLM_SUBQUERY`) and `:178` (`LLM_SUBQUERY_STREAM` → `subQueryStreaming` →
  `generateCompletionStreaming`, `llm-service.ts:421`) — renderer-driven pass-throughs, leave. The
  streaming ladder has no aux-service equivalent (aux `generate()` is non-streaming), so routing it would
  mean building streaming support into the aux service first — out of scope for this pass.

---

## Strictly-local (only if D1=B)
Not a config flag today. **First disambiguate what "strictly-local" means** — the two readings differ by
which `endpoint.source` values survive:
- **(B1) This coordinator machine's localhost only** → keep only `source === 'localhost'`; drops the
  remote GPU `worker-node` **and** any manual private-LAN endpoint. This is the *most* restrictive reading
  and conflicts with the founding goal of preferring the remote GPU box — usually **not** what's wanted.
- **(B2) Any non-cloud / self-hosted host** → keep `localhost` **and** `worker-node` **and** manual
  private-LAN endpoints; drop only cheap-*cloud*. This matches "no frontier/cloud tokens" while still
  using the remote box. Recommended reading if D1=B is chosen.

Implement one of:
- **Per-slot `localOnly: boolean`** on `AuxiliaryLlmSlotConfig` (`auxiliary-llm.types.ts:79`) enforced in
  `resolveEndpointForSlot` (`auxiliary-llm-service.ts:321`). Filter to the chosen set — but note
  `endpoint.source` is only `'manual' | 'localhost' | 'worker-node'` (`auxiliary-llm.types.ts:74`);
  `'cheap-cloud'` is a **decision** source, **not** an endpoint source, so you **cannot** filter on it:
  - **B1:** keep `source === 'localhost'`.
  - **B2:** keep `source === 'localhost'` or `'worker-node'`, **plus** `manual` endpoints whose `baseUrl`
    is private/LAN — `manual` covers both cloud and self-hosted, so it must be disambiguated by URL, not
    by the `source` enum. Reuse `isPrivateOrLocalhostUrl(baseUrl)` (`auxiliary-llm-handlers.ts:72`) — extract
    it to a shared util (e.g. `auxiliary-llm-utils.ts`) and call it from both the handler and the resolver.
  Touch points — this is a slot-config **field**, not a new slot, so the "add a slot" checklist does **not**
  apply. The real sites: `AuxiliaryLlmSlotConfig` (`auxiliary-llm.types.ts:79`); the per-slot
  `auxiliarySlotSchema` in `settings-control-policy.ts` (~`:75-82`); `DEFAULT_SETTINGS.auxiliaryLlmSlotsJson`
  **only if** the field is non-optional (make it optional → no migration needed); the renderer slot UI
  (toggle); the resolver (`resolveEndpointForSlot`); and tests.
  - **Enforce on the explicit `endpointId + model` branch too** (`:326-334`), not only the auto
    `resolveLocalFirst`/`resolveCheapFirst` paths — otherwise a user-pinned cloud endpoint silently
    bypasses `localOnly`. Reject (return `null` → fall through / fallback) when the pinned endpoint's
    source is outside the allowed set.
- **Or** a local-only resolution branch parallel to `resolveLocalFirst`/`resolveCheapFirst` (still gated
  on the explicit-pin check above).
Recommend D1=A to avoid this entirely.

---

## PART C — Subagent-for-edits  *(memo; gated on D5)*
Current design deliberately keeps small edits inline (`orchestration-protocol.prompts.ts:60-71`).
Lever, if wanted: lower the `delegation-policy.ts` `decideDelegation` (~`:189-217`) threshold so large
multi-file edit *batches* go to a child (cheaper model, isolated context). No change until D5 confirmed.

---

## Open questions → just confirm D1–D5 above
Recommended start: **D1=A, D2=no-cloud, D3=Part A only, D4=leave, D5=leave** → implement Part A
(Tasks A1–A5), fully verifiable in isolation.
