# Audit Fixes Plan — 2026-07-01

Source: AI task-completion audit (runbook: `~/work/ai-task-completion-audit-runbook.md`)
run against range `8c07eee8..aed5b75c` (loop engine overhaul, 424 files) plus
codebase-wide checks.

Audit verdict was **PASS** — Gate 0 fully green (tsc ×2, lint, LOC ratchet,
11,032/11,032 tests), no Critical or High findings survived verification.
This plan addresses the Medium/Low follow-ups the audit surfaced.

**Do not commit this file until every item below is implemented and verified;
then rename with `_completed` per repo convention.**

---

## Fix 1: echarts moderate XSS advisory (GHSA-fgmj-fm8m-jvvx)

- **What**: Bump `echarts` from 6.0.0 to `^6.1.0` in `package.json` + lockfile.
- **Why**: `npm audit --omit=dev` reports 1 moderate XSS in echarts <6.1.0.
  Pre-existing (not introduced by the audited range), but it's the only open
  advisory in production deps.
- **How**: `npm install echarts@^6.1.0` (minor bump, inside current `^6.0.0`
  range; `ngx-echarts@21` peer allows `>=5.0.0`). Re-run `npm audit --omit=dev`
  → expect 0 vulnerabilities.
- **What could break**: chart rendering regressions from an echarts minor.
  Low risk; no API removals in 6.1 minors.
- **Verification**: `npm run test:quiet -- <chart/dashboard specs>`, then
  launch the app and eyeball any echarts surface (usage/stats charts).
  Note: `npm install` re-triggers `postinstall` native rebuild — harmless, but
  confirm `npm run dev` still boots (verify-native-abi guard runs in prestart).

## Fix 2: Type honesty in `src/main/cli/adapters/gemini-json.ts`

- **What**: Replace `type GeminiStreamEvent = Record<string, any> & { 15 × ?: any }`
  with `unknown`-typed fields plus narrow type guards at the access sites
  (`event.content`, `event.type`, `event.usageMetadata`, …), or a proper
  discriminated union of the Gemini CLI event shapes actually handled.
- **Why**: Gate 5.2 (type/contract honesty). This is a parsing boundary for
  external NDJSON; `any` disables checking exactly where typos/shape drift are
  most likely. 15 of the 19 `any` additions in the audited range live here.
- **How**:
  1. Read the full file and every consumer of `GeminiStreamEvent` first.
  2. Type each field as `unknown` (or the concrete shape where the handler
     already assumes one, e.g. `usageMetadata?: { promptTokenCount?: number; … }`).
  3. Add explicit guards (`typeof`, `Array.isArray`, `in`) where fields are read.
- **What could break**: tsc may surface latent unsafe accesses — that's the
  point; fix them rather than casting back.
- **Verification**: `npx tsc --noEmit` (both configs);
  `npm run test:quiet -- src/main/cli/adapters/` — and add spec cases for
  malformed/partial Gemini payloads (missing fields, wrong types) asserting
  the parser degrades gracefully instead of throwing.

## Fix 3: Remove `as any` casts in `src/main/providers/anthropic-api-provider.ts`

- **What**: Three casts:
  - L262 & L491: `system: this.session.systemPrompt as any`
  - L444: `(MODEL_PRICING as any)[modelId]`
- **Why**: Gate 5.2. The systemPrompt cast papers over the SDK's
  `string | TextBlockParam[]` union; the pricing cast hides unknown model IDs
  from the type system.
- **How**:
  1. Type `session.systemPrompt` to match the Anthropic SDK's accepted union
     (consult the `claude-api` skill / SDK types — do not guess from memory),
     so the cast disappears. If `sanitizeProviderText` erases the type, give it
     a proper generic signature instead of widening.
  2. Pricing: `const pricing = MODEL_PRICING[modelId as keyof typeof MODEL_PRICING] ?? { input: 3.0, output: 15.0 };`
     — or better, a typed `getPricing(modelId: string): Pricing` helper with the
     fallback inside.
  3. Add unit tests for `sanitizeProviderText` (agent recommendation):
     circular references, lone surrogates, type preservation of the
     string-vs-blocks system prompt.
- **What could break**: request payload shape must remain byte-identical —
  cover with a spec asserting the built request for both string and block
  system prompts.
- **Verification**: `npx tsc --noEmit`, targeted provider specs, then a live
  smoke: send one message through the Anthropic API provider path.

## Fix 4: Harden `packages/sdk/src/provider-adapter-worker-bridge.ts` lifecycle

- **What** (two small hardenings; the reviewer's "Critical leak" claim was
  verified and downgraded — abnormal teardown kills the whole worker thread,
  so subscriptions cannot outlive a plugin reload):
  1. In `getOrCreateAdapter` (L351–379): if `validateWorkerProviderAdapter`
     throws *after* `factory()` created the adapter, the adapter (potentially a
     live child process) is never terminated. Wrap in try/catch:
     on validation failure `await adapter.terminate(true).catch(() => undefined)`
     then rethrow.
  2. Add a `disposeAll()` on the worker-side host that unsubscribes and
     terminates every entry in `instances`, wired to the worker's graceful
     shutdown path (the `process.exit(0)` handler in `plugin-worker-host.ts`
     ~L676 side). Defense-in-depth so graceful shutdown doesn't rely solely on
     `worker.terminate()`.
- **Why**: Gate 4.6 (resource release on all paths). Severity Low, but the
  validation-failure orphan is a real path: a plugin shipping a non-conforming
  adapter would leak its spawned process per attempt.
- **What could break**: terminate-on-validation-failure calls into plugin code
  that just failed validation — guard with `.catch()`. `disposeAll` must be
  idempotent with per-adapter `terminate`.
- **Verification**: `npm run test:quiet -- src/main/plugins/plugin-worker-host.spec.ts`
  plus new spec cases: (a) factory succeeds + validation throws → terminate
  called; (b) disposeAll unsubscribes and clears the map.

## Fix 5: Runbook artifact-path collision (file outside this repo)

- **What**: `~/work/ai-task-completion-audit-runbook.md` hardcodes
  `/tmp/task.diff` and `/tmp/changed_files.txt` (setup section + Appendix A).
- **Why**: This bit us *during* this audit: a concurrently running consumer of
  the same runbook overwrote `/tmp/task.diff` mid-run (50,195 → 3,473 lines),
  silently corrupting later checks. On this machine multiple agents/loops run
  the runbook simultaneously. (Verified: the in-app loop-audit runtime does
  NOT use these paths — the collision is between runbook consumers.)
- **How**: In both the setup snippet and `task-gate.sh`:
  `WORK=$(mktemp -d "${TMPDIR:-/tmp}/task-gate.XXXXXX")` and reference
  `$WORK/task.diff`, `$WORK/changed_files.txt`; echo `$WORK` at start so the
  verifier can cite artifact paths in its report. Add one sentence to the
  operating principles: "Artifacts live in a per-run temp dir; never share
  fixed paths between concurrent gate runs."
- **What could break**: nothing in-repo; it's a doc. Keep the report template's
  evidence contract unchanged.
- **Verification**: run the amended `task-gate.sh` once end-to-end on this repo.

## Fix 6 (optional, preventative): LOC-ratchet headroom

- **What**: Four files sit within their +50 tolerance and will trip the ratchet
  on the next real change:
  - `input-panel.component.ts` (1719, ceiling 1673)
  - `instance-detail.component.ts` (1550/1523)
  - `output-stream.component.ts` (1266/1219)
  - `src/shared/types/loop.types.ts` (784/780)
- **How**: opportunistic extraction next time each is touched (the
  composer-autocomplete/editing extractions in this range are the model —
  pure-helper modules with their own specs). Don't do a big-bang refactor now.
- **Verification**: `npm run check:ts-max-loc` after each extraction.

## Process notes (no code change)

- **Commit scope labeling**: commits titled "Loop engine overhaul"/"Updated
  loops still" also contained voice/STT, compaction recovery, composer
  autocomplete, and model-catalog work. All intentional (plan docs exist), but
  labels didn't match content — split campaigns or label by content so future
  per-task audits can scope a diff to a task.
- **Not issues** (checked, no action): gitleaks hits are redaction-test
  fixtures; `@Input()` in `composer-autocomplete.ts` is a documented Vitest
  JIT workaround (precedent in `model-menu.component.ts:61-67`);
  `DROP TABLE` is a proper paired `down:` migration; new deps
  (`jsonrepair`, `partial-json`) are real, mature, and imported; the new
  `@sdk/provider-adapter-worker-bridge` alias is correctly wired in all
  required places including `register-aliases.ts`.

---

## Final gate (run after all fixes, in order)

1. `npx tsc --noEmit` and `npx tsc --noEmit -p tsconfig.spec.json`
2. `npm run lint`
3. `npm run check:ts-max-loc`
4. `npm run test:quiet` (full suite — expect ≥ current 11,032 passing + new specs)
5. `npm audit --omit=dev` → 0 vulnerabilities
6. Manual smoke: app boots (`npm run dev`), send one Anthropic-provider
   message, open a chart view, run one Gemini CLI instance turn.
7. Rename this file with `_completed` before committing anything.

---

## Verification record (2026-07-02)

All six fixes verified against the live tree:

1. **echarts**: `^6.1.0` in package.json, 6.1.0 installed; `npm audit --omit=dev` → 0 vulnerabilities.
2. **gemini-json.ts**: `GeminiStreamEvent = Readonly<Record<string, unknown>>`, guard-based access; graceful-degradation spec cases present (`gemini-json.spec.ts`).
3. **anthropic-api-provider.ts**: zero `as any`; `systemPrompt: CacheableSystemPrompt | string`; pricing via typed `getModelRate` (`shared/data/model-pricing`); sanitizer specs in `security/__tests__/surrogate-sanitizer.spec.ts`.
4. **worker-bridge**: validation-failure → `terminate(true)` + rethrow; `disposeAll()` wired; specs cover terminate-on-validation-throw, idempotency, and continue-after-failure (`packages/sdk/src/__tests__/provider-adapter-worker-bridge.spec.ts`).
5. **runbook**: per-run `mktemp -d` in setup + Appendix A, operating principle added; artifact plumbing run end-to-end (two concurrent WORK dirs verified distinct).
6. **LOC headroom** (opportunistic-on-touch): applied to `loop-coordinator.ts` (evidence-tracker extracted to `loop-coordinator-completion-gates.ts`) and `loop.types.ts` (`defaultLoopConfig` → `loop-config-defaults.ts`, 814→725 lines). Untouched components left per plan. `npm run check:ts-max-loc` passes.

Full gate at completion: tsc ×2, `ng lint`, LOC ratchet, full vitest suite green.
