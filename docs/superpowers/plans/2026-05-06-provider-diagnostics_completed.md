# Provider Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface provider request IDs, stop reasons, quota/rate-limit details, and prompt/context weight without adding a new provider-runtime event kind.

**Architecture:** Extend existing provider runtime `context`, `error`, and `complete` events with optional diagnostics fields. Adapters fill what they know, `ProviderQuotaService` remains the quota owner, OTel gets matching attributes, and the instance detail diagnostics panel renders the normalized fields.

**Tech Stack:** TypeScript, Zod contracts, provider adapters, OTel setup, Angular renderer, Vitest.

---

## File Map

- Modify `packages/contracts/src/schemas/provider-runtime-events.schemas.ts`.
- Modify `packages/contracts/src/types/provider-runtime-events.ts`.
- Modify `src/shared/types/instance.types.ts`, `src/renderer/app/core/state/instance/instance.types.ts`, and legacy SDK provider types.
- Modify provider adapters where fields are available:
  - `src/main/providers/adapter-runtime-event-bridge.ts`
  - `src/main/instance/instance-communication.ts`
  - API provider files such as `src/main/providers/anthropic-api-provider.ts` if present.
- Modify `src/main/observability/otel-spans.ts` and event ingestion code that attaches provider runtime attributes.
- Modify renderer diagnostics panel in instance detail.
- Tests:
  - `packages/contracts/src/schemas/__tests__/provider-runtime-events.schemas.spec.ts`
  - `src/main/providers/adapter-runtime-event-bridge.spec.ts`
  - `src/main/instance/instance-communication.spec.ts`
  - `src/main/providers/anthropic-api-provider.spec.ts`
  - `src/main/observability/__tests__/otel-spans.spec.ts`
  - `src/renderer/app/features/instance-detail/provider-diagnostics-panel.component.spec.ts`

## Tasks

### Task 1: Contract Extensions

- [x] **Step 1: Write failing schema tests**

Assert existing event kinds accept new optional fields:

```ts
ProviderRuntimeEventSchema.parse({
  kind: 'error',
  message: 'Rate limited',
  requestId: 'req_123',
  rateLimit: { remaining: 0, resetAt: Date.now() + 60_000 },
});

ProviderRuntimeEventSchema.parse({
  kind: 'complete',
  tokensUsed: 100,
  stopReason: 'end_turn',
  quota: { exhausted: false },
});
```

Also assert `kind: 'api_diagnostics'` is rejected.

- [x] **Step 2: Extend schemas**

Add reusable objects:

```ts
const ProviderRateLimitSchema = z.object({
  limit: z.number().optional(),
  remaining: z.number().optional(),
  resetAt: z.number().int().nonnegative().optional(),
});

const ProviderQuotaDiagnosticsSchema = z.object({
  exhausted: z.boolean().optional(),
  resetAt: z.number().int().nonnegative().optional(),
  message: z.string().optional(),
});
```

Add `requestId`, `stopReason`, `rateLimit`, `quota` to `ProviderErrorEventSchema` and `ProviderCompleteEventSchema`. Add `inputTokens`, `outputTokens`, `source`, and `promptWeight` to `ProviderContextEventSchema`.

### Task 2: Adapter Population

- [x] **Step 1: Find sources**

Run:

```bash
rg -n "requestId|request-id|x-request|stopReason|stop_reason|rateLimit|rate-limit|quota|contextUsage|tokensUsed" src/main
```

- [x] **Step 2: Add parser tests per provider**

For each adapter with available fields, add tests proving parsed runtime events include the diagnostics fields. Providers that cannot expose fields should leave them undefined.

- [x] **Step 3: Populate fields**

Map provider-specific names to normalized fields. Redact secrets. Do not persist raw headers.

### Task 3: OTel and Renderer

- [x] **Step 1: Add OTel attributes**

Where provider runtime events are observed, attach:

- `ai.provider.request_id`;
- `ai.provider.stop_reason`;
- `ai.provider.rate_limit.remaining`;
- `ai.provider.quota.exhausted`.

- [x] **Step 2: Render diagnostics**

In the instance detail diagnostics surface, show request ID, stop reason, quota/rate-limit, and context percent. Hide absent fields.

### Task 4: Verification

```bash
npx vitest run packages/contracts/src/schemas/__tests__/provider-runtime-events.schemas.spec.ts <adapter-diagnostics-specs> <renderer-diagnostics-specs>
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
```

Manual check: live external API smoke was not run because it depends on user credentials and would spend provider quota. The deterministic Anthropic API provider regression exercises the same stop/complete path with `_request_id`, `stop_reason`, and usage tokens, and the renderer regression verifies those normalized diagnostics render without raw headers.

## Completion Validation

- [x] Added additive optional diagnostics to existing `context`, `error`, and `complete` runtime events; no `api_diagnostics` event kind was introduced.
- [x] Added bridge and direct instance-communication tests proving context diagnostics are preserved.
- [x] Added Anthropic API provider tests proving `_request_id`, `stop_reason`, and token counts emit via `complete`.
- [x] Added renderer diagnostics panel tests proving request ID, stop reason, quota, rate limit, context percent, token in/out, and prompt weight render while absent fields stay hidden.
- [x] Added OTel span tests for `ai.provider.request_id`, `ai.provider.stop_reason`, `ai.provider.rate_limit.remaining`, and `ai.provider.quota.exhausted`.
- [x] Fresh verification passed:
  - `npx vitest run packages/contracts/src/schemas/__tests__/provider-runtime-events.schemas.spec.ts src/main/providers/adapter-runtime-event-bridge.spec.ts src/main/observability/__tests__/otel-spans.spec.ts src/renderer/app/features/instance-detail/provider-diagnostics-panel.component.spec.ts src/main/providers/anthropic-api-provider.spec.ts src/main/instance/instance-communication.spec.ts`
  - `npx tsc --noEmit`
  - `npx tsc --noEmit -p tsconfig.spec.json`
  - `npm run lint`
  - `npm run build`
