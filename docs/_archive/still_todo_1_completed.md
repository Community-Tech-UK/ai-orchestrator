# Wave 2 — Complete

Snapshot date: 2026-04-21.

This file is no longer an active TODO list. It is retained as the closure note for the Wave 2 follow-up work.

## Verified Exit Criteria

- [x] `BaseProvider` no longer extends `EventEmitter`.
- [x] `event-normalizer.ts`, `ProviderEventMapper`, and the deprecated legacy provider-event bridge are gone.
- [x] The legacy `INSTANCE_OUTPUT` / `onInstanceOutput` IPC path is gone; renderer output flows through `PROVIDER_RUNTIME_EVENT`.

## What Closed The Gap

- `InstanceCommunicationManager` emits normalized provider runtime envelopes directly from adapter activity.
- `InstanceManager` now publishes output exclusively through `provider:normalized-event`; the redundant in-process `instance:output` fan-out was removed.
- Main-process consumers that previously depended on the old stream now consume normalized envelopes:
  - renderer IPC forwarding in `src/main/index.ts`
  - observation ingestion in `src/main/observation/observation-ingestor.ts`
  - channel routing in `src/main/channels/channel-message-router.ts`
  - plugin hooks in `src/main/plugins/plugin-manager.ts`
- Renderer event facades synthesize legacy `InstanceOutputEvent` shapes from `PROVIDER_RUNTIME_EVENT` without relying on deleted preload channels.
- Anthropic API provider now participates in the normalized provider runtime contract via `ProviderName = 'anthropic-api'`.

## Verification Run On 2026-04-21

- [x] `npx tsc --noEmit`
- [x] `npx tsc --noEmit -p tsconfig.spec.json`
- [x] `npm run lint`
- [x] `npm run test`
- [x] `npm run rebuild:native`

Wave 2 follow-up work is complete.
