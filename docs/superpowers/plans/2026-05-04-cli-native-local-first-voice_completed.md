# CLI-Native Local-First Voice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not commit unless the user explicitly asks.

**Goal:** Make AI Orchestrator's voice layer provider-driven and local-first instead of hard-wired to OpenAI, while preserving the existing full voice conversation flow.

**Architecture:** The main process owns voice provider discovery, provider status, credentials, transcription-session minting, and TTS execution. The renderer owns microphone capture, live transcript UI, barge-in, routing final transcripts to the active session, and playback. OpenAI remains an optional cloud provider; local macOS TTS becomes the preferred TTS provider when available; CLI-native and local STT providers are surfaced honestly as provider statuses until a stable streaming audio API is available.

**Tech Stack:** Electron 40 main process, Angular 21 renderer, TypeScript 5.9, Zod IPC schemas, Vitest.

---

## Evidence From Parent `orchestrat0r`

- `openclaw/src/realtime-transcription/provider-types.ts` has the best provider seam: provider sessions expose `connect()`, `sendAudio(Buffer)`, `close()`, and callbacks for partial/final/error.
- `openclaw/src/realtime-transcription/websocket-session.ts` shows how streaming STT providers should be implemented: long-lived sessions with bounded audio queues, reconnect limits, and ready/open state.
- `Actual Claude/services/voiceStreamSTT.ts` proves Claude has a cloud STT stream, but it is private/OAuth-backed and STT-only, not a stable public CLI audio API.
- `codex/codex-rs/app-server-protocol/src/protocol/common.rs` exposes experimental `thread/realtime/*` JSON-RPC methods, and `codex-rs/core/src/realtime_conversation.rs` defaults to `gpt-realtime-1.5`; this is useful for Codex-native sessions but not a generic local voice layer.
- Local machine evidence: `/usr/bin/say` and `/usr/bin/afconvert` exist, so local TTS can ship now. `whisper`/`whisper-cli` are not installed, so local STT must be detected as unavailable rather than silently falling back to cloud.

## File Structure

- Create `src/main/services/voice/providers/types.ts`: provider IDs, capability/status types, STT and TTS provider interfaces.
- Create `src/main/services/voice/providers/macos-say-tts-provider.ts`: macOS `say` + `afconvert` local TTS implementation.
- Modify `packages/contracts/src/schemas/voice.schemas.ts`: provider status schemas and provider-aware voice payloads/results.
- Modify `src/shared/types/voice.types.ts`: shared provider and new error code types.
- Modify `src/main/services/voice/voice-service.ts`: provider registry, provider selection, local TTS default, OpenAI fallback.
- Modify `src/main/services/voice/index.ts`: export provider types needed by tests.
- Modify `src/main/ipc/handlers/voice-handlers.ts`: pass `providerId` through IPC validation.
- Modify `src/preload/domains/voice.preload.ts`: expose provider-aware payloads to renderer.
- Modify `src/renderer/app/core/services/ipc/voice-ipc.service.ts`: typed provider-aware IPC calls.
- Modify `src/renderer/app/core/voice/voice-conversation.store.ts`: track active providers, surface provider unavailable errors, and use active STT/TTS providers.
- Modify `src/renderer/app/features/instance-detail/input-panel.component.ts/html/scss`: pass session provider and show voice provider/privacy summary.
- Modify tests under `src/main/services/voice/` and `src/renderer/app/core/voice/`.

## Task 1: Contract Shape

**Files:**
- Modify: `packages/contracts/src/schemas/voice.schemas.ts`
- Modify: `src/shared/types/voice.types.ts`

- [ ] **Step 1: Add failing schema/type expectations**

Add provider-aware assertions to `src/main/services/voice/voice-service.spec.ts` before implementation:

```ts
expect(service.getStatus()).toMatchObject({
  activeTtsProviderId: 'local-macos-say',
  activeTranscriptionProviderId: undefined,
});
expect(service.getStatus().providers).toEqual(expect.arrayContaining([
  expect.objectContaining({
    id: 'local-macos-say',
    source: 'local',
    capabilities: ['tts'],
    privacy: 'local',
    available: true,
  }),
]));
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run src/main/services/voice/voice-service.spec.ts
```

Expected: FAIL because provider fields do not exist.

- [ ] **Step 3: Add provider schemas and shared types**

Add these exported schema shapes:

```ts
export const VoiceProviderSourceSchema = z.enum(['local', 'cli-native', 'cloud']);
export const VoiceProviderCapabilitySchema = z.enum(['stt', 'tts', 'full-duplex']);
export const VoiceProviderPrivacySchema = z.enum(['local', 'provider-cloud']);

export const VoiceProviderStatusSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  source: VoiceProviderSourceSchema,
  capabilities: z.array(VoiceProviderCapabilitySchema).min(1),
  available: z.boolean(),
  configured: z.boolean(),
  active: z.boolean(),
  privacy: VoiceProviderPrivacySchema,
  reason: z.string().optional(),
  requiresSetup: z.string().optional(),
});
```

Extend status and payload/result schemas:

```ts
VoiceStatusSchema.extend({
  activeTranscriptionProviderId: z.string().optional(),
  activeTtsProviderId: z.string().optional(),
  providers: z.array(VoiceProviderStatusSchema),
  unavailableReason: z.string().optional(),
});

providerId: z.string().trim().min(1).max(128).optional()
```

Add shared TS types and error codes:

```ts
export type VoiceProviderSource = 'local' | 'cli-native' | 'cloud';
export type VoiceProviderCapability = 'stt' | 'tts' | 'full-duplex';
export type VoiceProviderPrivacy = 'local' | 'provider-cloud';
export type VoiceErrorCode = ... | 'voice-provider-unavailable' | 'local-voice-unavailable';
```

- [ ] **Step 4: Verify GREEN for schema compilation**

Run:

```bash
npx vitest run src/main/services/voice/voice-service.spec.ts
```

Expected: still fail on service behavior, not type/schema errors.

## Task 2: Local macOS TTS Provider

**Files:**
- Create: `src/main/services/voice/providers/types.ts`
- Create: `src/main/services/voice/providers/macos-say-tts-provider.ts`
- Modify: `src/main/services/voice/voice-service.spec.ts`

- [ ] **Step 1: Add failing local TTS test**

Use injected fake provider dependencies so the test is deterministic:

```ts
const localTts = {
  isAvailable: vi.fn(() => true),
  synthesize: vi.fn(async () => ({
    requestId: 'tts-local',
    audioBase64: 'UklGRg==',
    mimeType: 'audio/wav',
    format: 'wav' as const,
    providerId: 'local-macos-say',
    local: true,
  })),
  cancel: vi.fn(() => true),
};
const service = new VoiceService({ localTts });

await expect(service.synthesizeSpeech({
  requestId: 'tts-local',
  input: 'hello',
  model: 'gpt-4o-mini-tts',
  voice: 'alloy',
  format: 'wav',
})).resolves.toMatchObject({
  providerId: 'local-macos-say',
  local: true,
});
expect(localTts.synthesize).toHaveBeenCalled();
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run src/main/services/voice/voice-service.spec.ts
```

Expected: FAIL because `VoiceService` has no injectable local TTS provider.

- [ ] **Step 3: Implement provider interfaces**

`types.ts`:

```ts
import type { VoiceProviderStatus, VoiceTtsResult } from '@contracts/schemas/voice';
import type { VoiceTtsInput } from '../voice-service';

export type VoiceTtsProviderId = 'local-macos-say' | 'openai-tts';
export type VoiceTranscriptionProviderId = 'openai-realtime';

export interface VoiceTranscriptionProvider {
  readonly id: VoiceTranscriptionProviderId;
  getStatus(): VoiceProviderStatus;
  createSession(input: CreateVoiceTranscriptionSessionInput): Promise<VoiceTranscriptionSession>;
  closeSession(sessionId: string): boolean;
}

export interface VoiceTtsProvider {
  readonly id: VoiceTtsProviderId;
  getStatus(): VoiceProviderStatus;
  synthesize(input: VoiceTtsInput): Promise<VoiceTtsResult>;
  cancel(requestId: string): boolean;
}
```

- [ ] **Step 4: Implement macOS `say` provider**

Use `spawn` with argument arrays only; never shell interpolation. The provider must report unavailable unless `platform === 'darwin'` and both `/usr/bin/say` and `/usr/bin/afconvert` exist. Generate AIFF via `/usr/bin/say`, convert to browser-compatible WAV via `/usr/bin/afconvert -f WAVE -d LEI16@24000`, read the WAV, return base64, and delete the temp directory in `finally`. Track active child processes by request ID and kill them on `cancel(requestId)` and provider teardown.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npx vitest run src/main/services/voice/voice-service.spec.ts
```

Expected: local TTS test passes and existing OpenAI tests still pass when they request `providerId: 'openai-tts'`.

## Task 3: Provider Registry and Selection

**Files:**
- Modify: `src/main/services/voice/voice-service.ts`
- Modify: `src/main/services/voice/index.ts`
- Modify: `src/main/services/voice/voice-service.spec.ts`

- [ ] **Step 1: Add failing status tests**

Assert no cloud fallback is implied when STT is missing:

```ts
const service = new VoiceService({ localTts });
const status = service.getStatus();
expect(status.available).toBe(false);
expect(status.unavailableReason).toContain('speech-to-text');
expect(status.activeTtsProviderId).toBe('local-macos-say');
expect(status.activeTranscriptionProviderId).toBeUndefined();
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run src/main/services/voice/voice-service.spec.ts
```

Expected: FAIL because status still means “has OpenAI key”.

- [ ] **Step 3: Implement provider interfaces and registry**

Provider statuses:

```ts
local-macos-say: local TTS, active when available.
openai-realtime: cloud STT, active only when OpenAI key exists.
openai-tts: cloud TTS, fallback only when local TTS unavailable and OpenAI key exists.
local-whisper: local STT, shown unavailable unless a supported streaming engine is configured.
claude-voice-stream: cli-native/cloud STT, shown unavailable because no stable public noninteractive audio CLI API is available.
codex-realtime: cli-native/cloud full-duplex, shown unavailable for generic sessions because its JSON-RPC realtime API is experimental and Codex-session-specific.
```

Selection rules:

```ts
activeTtsProviderId = local-macos-say if available else openai-tts if key exists else undefined;
activeTranscriptionProviderId = openai-realtime if key exists else undefined;
available = Boolean(activeTtsProviderId && activeTranscriptionProviderId);
```

This means the current shippable state is local-first for TTS only. Full voice still requires either OpenAI realtime STT or a future local/CLI-native streaming STT adapter; the UI must say that plainly instead of implying full local voice is already available.

- [ ] **Step 4: Preserve OpenAI STT/TTS behavior behind providers**

`createTranscriptionSession({ providerId })` must route through the selected `VoiceTranscriptionProvider`. The OpenAI provider can keep the existing REST minting code initially, but it must sit behind the STT provider interface. Any unavailable provider must throw `VoiceServiceError('voice-provider-unavailable', ...)`.

`synthesizeSpeech({ providerId })` must route to local macOS TTS or OpenAI TTS explicitly. Existing OpenAI error sanitization stays unchanged. The renderer should let each provider choose the result MIME type; do not force OpenAI TTS to WAV if MP3 is lower-latency for cloud playback.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npx vitest run src/main/services/voice/voice-service.spec.ts
```

Expected: all main voice service tests pass.

## Task 4: IPC and Renderer Integration

**Files:**
- Modify: `src/main/ipc/handlers/voice-handlers.ts`
- Modify: `src/preload/domains/voice.preload.ts`
- Modify: `src/renderer/app/core/services/ipc/voice-ipc.service.ts`
- Modify: `src/renderer/app/core/voice/voice-conversation.store.ts`
- Modify: `src/renderer/app/features/instance-detail/input-panel.component.ts`
- Modify: `src/renderer/app/features/instance-detail/input-panel.component.html`
- Modify: `src/renderer/app/features/instance-detail/input-panel.component.scss`
- Modify: `src/renderer/app/core/voice/voice-conversation.store.spec.ts`

- [ ] **Step 1: Add failing renderer store expectations**

Extend the harness status:

```ts
activeTranscriptionProviderId: 'openai-realtime',
activeTtsProviderId: 'local-macos-say',
providers: [],
```

Assert:

```ts
expect(harness.voiceIpc.createTranscriptionSession).toHaveBeenCalledWith({
  model: 'gpt-4o-transcribe',
  providerId: 'openai-realtime',
});
expect(harness.voiceIpc.synthesizeSpeech).toHaveBeenCalledWith(expect.objectContaining({
  providerId: 'local-macos-say',
  format: 'wav',
}));
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run src/renderer/app/core/voice/voice-conversation.store.spec.ts
```

Expected: FAIL because provider IDs are not passed.

- [ ] **Step 3: Thread provider IDs through IPC**

Pass `providerId` from IPC payloads into main service calls, and expose it in preload/renderer service method types.

- [ ] **Step 4: Update renderer store behavior**

Store these signals:

```ts
readonly activeTranscriptionProviderId = signal<string | null>(null);
readonly activeTtsProviderId = signal<string | null>(null);
readonly voiceProviders = signal<VoiceProviderStatus[]>([]);
readonly providerSummary = computed(() => ...);
```

On `start()`, use `status.unavailableReason` instead of a hardcoded OpenAI key message. Use active STT provider for transcription and active TTS provider for speech. Request `wav` only for local macOS TTS; keep OpenAI TTS on `mp3` unless explicitly changed later.

- [ ] **Step 5: Update input panel**

Pass `provider: this.provider()` in the voice context. Show a small status badge such as `Local TTS` or `Cloud STT/TTS` using the store summary. Keep the OpenAI key inline action only for `missing-api-key`.

- [ ] **Step 6: Verify GREEN**

Run:

```bash
npx vitest run src/renderer/app/core/voice/voice-conversation.store.spec.ts
```

Expected: all renderer voice store tests pass.

## Task 5: Full Verification

**Files:**
- No code changes unless verification fails.

- [ ] **Step 1: Run focused voice tests**

```bash
npx vitest run src/main/services/voice/voice-service.spec.ts src/renderer/app/core/voice/voice-conversation.store.spec.ts src/renderer/app/core/voice/realtime-transcription.service.spec.ts src/renderer/app/core/voice/voice-playback.service.spec.ts src/renderer/app/core/voice/speech-text.spec.ts
```

- [ ] **Step 2: Run type checks**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
```

- [ ] **Step 3: Run lint**

```bash
npm run lint
```

- [ ] **Step 4: Run full tests**

```bash
npm run test
```

- [ ] **Step 5: Run build**

```bash
npm run build
```

## Completion Checklist

- [ ] Provider status makes local/cloud/CLI-native capabilities visible and honest.
- [ ] Local macOS TTS works without OpenAI.
- [ ] Existing OpenAI STT remains available only as an explicitly reported cloud provider.
- [ ] OpenAI TTS remains available only as fallback or explicit provider.
- [ ] STT and TTS are both abstracted behind provider interfaces.
- [ ] Renderer no longer hardcodes “OpenAI voice” as the architecture.
- [ ] UI surfaces provider/privacy status compactly.
- [ ] Tests prove status selection, local TTS routing, OpenAI fallback behavior, and renderer provider propagation.
- [ ] Full project verification has been run and any failures are reported accurately.
