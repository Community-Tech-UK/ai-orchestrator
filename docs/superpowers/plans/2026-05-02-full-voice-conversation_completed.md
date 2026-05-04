# Full Voice Conversation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add full duplex-style voice conversation for active AI sessions: microphone input is transcribed in real time, final user speech is sent or steered into the selected session, assistant turns are spoken back with TTS, and the user can barge in to interrupt speech and steer the running session.

**Architecture:** Phase 1 is a conservative hybrid. The renderer owns microphone capture, local audio level metering, WebRTC connection to an OpenAI Realtime transcription session using an ephemeral client secret, and playback of TTS audio. The main process owns long-lived credentials, creates ephemeral transcription sessions, performs REST TTS requests, and never exposes `OPENAI_API_KEY` to the renderer. Voice state lives in a renderer-side Angular service wired into the existing `InputPanelComponent` send/steer outputs.

**Tech Stack:** Electron 40, Angular 21 zoneless signals, TypeScript 5.9, Zod 4 IPC schemas, native browser media APIs, OpenAI Realtime transcription over WebRTC, OpenAI REST TTS, Vitest.

**Source Spec:** `docs/superpowers/specs/2026-05-02-full-voice-conversation-design.md`

**Commit Policy:** This repository says never commit or push unless the user explicitly asks. Treat the "checkpoint" lines in this plan as verification points only.

---

## Design Decisions To Preserve

- Phase 1 voice is enabled only for an active existing session, not the new-session composer.
- Renderer calls OpenAI only with ephemeral Realtime transcription credentials from main.
- Main process performs REST TTS and returns a bounded buffered audio payload.
- Realtime transcription sessions must not create model responses. Do not call `response.create`. Do not configure tools.
- If an implementation falls back to a general Realtime session shape, explicitly set `create_response: false`, `interrupt_response: false`, `tools: []`, and `tool_choice: 'none'`.
- OpenAI transcription-session creation uses the current `type: "transcription"` and `audio.input.transcription` / `audio.input.turn_detection` shape.
- Use native browser WebRTC APIs in Phase 1; do not add an OpenAI Realtime SDK dependency unless Electron renderer bundling is proven first.
- The app does not stream microphone audio through Electron IPC in Phase 1.
- Temporary API key entry is in memory only. It may be set through authenticated IPC for macOS GUI launches where `OPENAI_API_KEY` is missing, but it must not be persisted in settings, SQLite, localStorage, or logs.
- Assistant speech starts only after a stable turn boundary, not after every output chunk.
- Barge-in must stop current playback, cancel pending TTS, mask trailing interrupted output until the next idle/ready state, and use `steerInput()` when the selected session is active. It may use `sendInput()` only when the session is idle/ready.
- Only one voice session may be active at a time in Phase 1.
- Ephemeral Realtime credential expiry reconnects once with a fresh transcription session and preserves unsent partial transcript state.
- User-edited transcript text detaches from voice-owned partial updates and is not auto-sent.
- Speakable output includes assistant natural language only. Skip user/tool/system/error/thinking output. Strip code fences and common Markdown before TTS.
- OpenAI REST TTS input is capped at 4096 characters in the main process; renderer targets 3500 cleaned characters before making the request.
- Track spoken assistant output with a set plus a high-water mark from voice-session start, not a single scalar message ID.

## Files To Read Before Editing

Read these files completely before modifying related code:

- `docs/superpowers/specs/2026-05-02-full-voice-conversation-design.md`
- `packages/contracts/src/channels/index.ts`
- `packages/contracts/src/channels/instance.channels.ts`
- `packages/contracts/package.json`
- `src/main/register-aliases.ts`
- `src/shared/types/ipc.types.ts`
- `src/shared/types/voice.types.ts` if it exists
- `src/main/ipc/ipc-main-handler.ts`
- `src/main/ipc/handlers/index.ts`
- `src/main/ipc/handlers/provider-handlers.ts`
- `src/main/window-manager.ts`
- `src/preload/preload.ts`
- `src/preload/domains/provider.preload.ts`
- `src/renderer/app/core/services/ipc/electron-ipc.service.ts`
- `src/renderer/app/core/state/instance/instance.store.ts`
- `src/renderer/app/core/state/instance/instance-messaging.store.ts`
- `src/renderer/app/core/state/instance/instance.types.ts`
- `src/renderer/app/features/instance-detail/instance-detail.component.ts`
- `src/renderer/app/features/instance-detail/input-panel.component.ts`
- `src/renderer/app/features/instance-detail/input-panel.component.html`
- `src/renderer/app/features/instance-detail/input-panel.component.scss`
- `src/renderer/index.html`
- `electron-builder.json`
- `build/entitlements.mac.plist`

---

## Task 0: Verify Existing IPC/Auth And Alias Plumbing

**Purpose:** Confirm the feature is being added to the repo's actual IPC/security plumbing and packaged runtime alias resolver before writing voice code.

- [ ] Read `src/main/ipc/ipc-main-handler.ts` and locate `ensureAuthorized`.
- [ ] Read `src/preload/preload.ts` and locate `ipcAuthToken` capture plus `withAuth`.
- [ ] Read `src/main/register-aliases.ts` and locate `exactAliases`.
- [ ] Read `package.json` and verify the script that generates `src/preload/generated/channels.ts`.

Required findings before Task 1:

- `ensureAuthorized` expects an `ipcAuthToken` field on authenticated payloads.
- Preload domains that spend money or mutate credentials must call `withAuth(...)`.
- New `@contracts/schemas/voice` and `@contracts/channels/voice` subpaths require runtime aliases in `src/main/register-aliases.ts`, not just TypeScript path aliases.
- `npm run generate:ipc` exists or the plan must use the repo's actual IPC generation script name discovered from `package.json`.

Checkpoint: record the exact generation command and alias pattern in implementation notes before editing contract files.

---

## Task 1: Add Voice IPC Contracts

**Purpose:** Create a typed IPC surface for voice readiness, ephemeral transcription sessions, in-memory API key configuration, and TTS.

- [ ] Read all existing contract channel and schema files listed above.
- [ ] Add `packages/contracts/src/channels/voice.channels.ts`.

Use these channel names:

```ts
export const VOICE_CHANNELS = {
  VOICE_STATUS_GET: 'voice:status:get',
  VOICE_OPENAI_TEMP_KEY_SET: 'voice:openai-temp-key:set',
  VOICE_OPENAI_TEMP_KEY_CLEAR: 'voice:openai-temp-key:clear',
  VOICE_TRANSCRIPTION_SESSION_CREATE: 'voice:transcription-session:create',
  VOICE_TTS_SYNTHESIZE: 'voice:tts:synthesize',
  VOICE_TTS_CANCEL: 'voice:tts:cancel',
} as const;
```

- [ ] Update `packages/contracts/src/channels/index.ts` so `IPC_CHANNELS` includes `VOICE_CHANNELS`.

Expected shape:

```ts
import { VOICE_CHANNELS } from './voice.channels';

export const IPC_CHANNELS = {
  ...existingChannelGroups,
  ...VOICE_CHANNELS,
} as const;
```

- [ ] Add `packages/contracts/src/schemas/voice.schemas.ts`.

Schema requirements:

```ts
import { z } from 'zod';

export const VoiceKeySourceSchema = z.enum(['environment', 'temporary', 'missing']);

export const VoiceStatusSchema = z.object({
  available: z.boolean(),
  keySource: VoiceKeySourceSchema,
  canConfigureTemporaryKey: z.boolean(),
});

export const VoiceSetTemporaryOpenAiKeyPayloadSchema = z.object({
  apiKey: z.string().trim().min(20),
  ipcAuthToken: z.string().optional(),
});

export const VoiceAuthenticatedPayloadSchema = z.object({
  ipcAuthToken: z.string().optional(),
});

export const VoiceCreateTranscriptionSessionPayloadSchema = z.object({
  model: z.string().default('gpt-4o-transcribe'),
  language: z.string().trim().min(2).max(16).optional(),
  ipcAuthToken: z.string().optional(),
});

export const VoiceTranscriptionSessionSchema = z.object({
  clientSecret: z.string().min(1),
  expiresAt: z.number().optional(),
  model: z.string(),
  sdpUrl: z.string().url().optional(),
});

export const VoiceTtsPayloadSchema = z.object({
  requestId: z.string().trim().min(1).max(128),
  input: z.string().trim().min(1).max(4096),
  model: z.string().default('gpt-4o-mini-tts'),
  voice: z.string().default('alloy'),
  format: z.enum(['mp3', 'wav', 'opus']).default('mp3'),
  ipcAuthToken: z.string().optional(),
});

export const VoiceTtsCancelPayloadSchema = z.object({
  requestId: z.string().trim().min(1).max(128),
  ipcAuthToken: z.string().optional(),
});

export const VoiceTtsResultSchema = z.object({
  requestId: z.string().min(1),
  audioBase64: z.string().min(1),
  mimeType: z.string().min(1),
  format: z.enum(['mp3', 'wav', 'opus']),
});

export type VoiceStatus = z.infer<typeof VoiceStatusSchema>;
export type VoiceTranscriptionSession = z.infer<typeof VoiceTranscriptionSessionSchema>;
export type VoiceTtsResult = z.infer<typeof VoiceTtsResultSchema>;
```

- [ ] Update `packages/contracts/package.json` exports with:

```json
"./channels/voice": {
  "types": "./dist/channels/voice.channels.d.ts",
  "default": "./dist/channels/voice.channels.js"
},
"./schemas/voice": {
  "types": "./dist/schemas/voice.schemas.d.ts",
  "default": "./dist/schemas/voice.schemas.js"
}
```

- [ ] Update `src/main/register-aliases.ts` `exactAliases` with the runtime aliases for:

```ts
['@contracts/channels/voice', path.join(contractsDist, 'channels/voice.channels.js')]
['@contracts/schemas/voice', path.join(contractsDist, 'schemas/voice.schemas.js')]
```

Follow the exact local `exactAliases` style in that file; do not invent a second alias resolver.

- [ ] Run the IPC generation script:

```bash
npm run generate:ipc
```

- [ ] Verify `src/preload/generated/channels.ts` now contains the voice channel constants.
- [ ] Run targeted contract checks:

```bash
npx tsc --noEmit -p packages/contracts/tsconfig.json
npx tsc --noEmit
```

Checkpoint: contracts compile and no long-lived API key type is exposed to renderer.

---

## Task 1.5: Add Shared Voice Types

**Purpose:** Keep renderer, shared tests, and future main-process code aligned on the same voice state names and error codes.

- [ ] Add `src/shared/types/voice.types.ts`.

Expected content:

```ts
export type VoiceConversationPhase =
  | 'off'
  | 'connecting'
  | 'listening'
  | 'transcribing'
  | 'sending'
  | 'waiting-for-session'
  | 'speaking'
  | 'stopping'
  | 'error';

export type VoiceErrorCode =
  | 'missing-api-key'
  | 'temporary-api-key-rejected'
  | 'microphone-denied'
  | 'microphone-unavailable'
  | 'provider-session-failed'
  | 'transcription-failed'
  | 'voice-connection-lost'
  | 'voice-credential-expired'
  | 'speech-synthesis-failed'
  | 'speech-synthesis-cancelled'
  | 'speech-rate-limited'
  | 'session-unavailable'
  | 'cleanup-failed';

export type VoiceKeySource = 'environment' | 'temporary' | 'missing';
```

- [ ] Use `VoiceConversationPhase`, `VoiceErrorCode`, and `VoiceKeySource` in renderer voice services instead of redefining string unions locally.
- [ ] Run:

```bash
npx tsc --noEmit
```

Checkpoint: voice state names match the spec exactly.

---

## Task 2: Add Main-Process Voice Service And IPC Handlers

**Purpose:** Keep credentials and OpenAI REST calls in the main process with authenticated IPC.

- [ ] Read `src/main/ipc/handlers/provider-handlers.ts` and `src/main/ipc/ipc-main-handler.ts` completely before editing.
- [ ] Add `src/main/services/voice/voice-service.ts`.

Implement these public methods:

```ts
export interface CreateVoiceTranscriptionSessionInput {
  model: string;
  language?: string;
}

export interface VoiceTtsInput {
  requestId: string;
  input: string;
  model: string;
  voice: string;
  format: 'mp3' | 'wav' | 'opus';
}

export class VoiceService {
  private temporaryOpenAiApiKey: string | null = null;
  private readonly ttsControllers = new Map<string, AbortController>();

  getStatus(): VoiceStatus {
    const keySource = this.getKeySource();
    return {
      available: keySource !== 'missing',
      keySource,
      canConfigureTemporaryKey: true,
    };
  }

  setTemporaryOpenAiApiKey(apiKey: string): void {
    this.temporaryOpenAiApiKey = apiKey.trim();
  }

  clearTemporaryOpenAiApiKey(): void {
    this.temporaryOpenAiApiKey = null;
  }

  async createTranscriptionSession(
    input: CreateVoiceTranscriptionSessionInput
  ): Promise<VoiceTranscriptionSession> {
    const apiKey = this.requireApiKey();
    const body = {
      type: 'transcription',
      audio: {
        input: {
          noise_reduction: { type: 'near_field' },
          transcription: {
            model: input.model,
            ...(input.language ? { language: input.language } : {}),
          },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
          },
        },
      },
      include: [],
    };

    const response = await fetch('https://api.openai.com/v1/realtime/transcription_sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const json = await this.readJsonResponse(response, 'VOICE_TRANSCRIPTION_SESSION_FAILED');
    return {
      clientSecret: this.extractClientSecret(json),
      expiresAt: typeof json.expires_at === 'number' ? json.expires_at : undefined,
      model: input.model,
      sdpUrl: this.extractSdpUrl(json),
    };
  }

  async synthesizeSpeech(input: VoiceTtsInput): Promise<VoiceTtsResult> {
    if (input.input.length > 4096) {
      throw new Error('VOICE_TTS_INPUT_TOO_LONG');
    }
    const apiKey = this.requireApiKey();
    const controller = new AbortController();
    this.ttsControllers.set(input.requestId, controller);
    try {
      const response = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: input.model,
          voice: input.voice,
          input: input.input,
          response_format: input.format,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        await this.throwOpenAiError(response, 'VOICE_TTS_FAILED');
      }

      const arrayBuffer = await response.arrayBuffer();
      return {
        requestId: input.requestId,
        audioBase64: Buffer.from(arrayBuffer).toString('base64'),
        mimeType: this.mimeTypeForFormat(input.format),
        format: input.format,
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error('VOICE_TTS_CANCELLED');
      }
      throw error;
    } finally {
      this.ttsControllers.delete(input.requestId);
    }
  }

  cancelSpeech(requestId: string): boolean {
    const controller = this.ttsControllers.get(requestId);
    if (!controller) return false;
    controller.abort();
    this.ttsControllers.delete(requestId);
    return true;
  }
}
```

Implementation details:

- [ ] `requireApiKey()` must prefer `process.env.OPENAI_API_KEY` over `temporaryOpenAiApiKey`.
- [ ] Never log the API key, request authorization header, or TTS input in full.
- [ ] `extractClientSecret()` must accept `json.client_secret.value` and `json.client_secret` string shapes, because OpenAI Realtime docs have used both shapes across session endpoints.
- [ ] `extractSdpUrl()` must return a response-provided `session_details.stream_url` only if present; otherwise the renderer uses `https://api.openai.com/v1/realtime/calls`.
- [ ] Add timeouts around OpenAI `fetch` calls using `AbortController`.
- [ ] `synthesizeSpeech()` must remove its request controller in a `finally` block so failed or cancelled requests do not leak memory.
- [ ] `cancelSpeech()` must abort only the matching request id and be safe when the request has already finished.
- [ ] TTS requests must run through a one-at-a-time queue in `VoiceService` to avoid overlapping spend and simplify cancellation. If OpenAI returns 429, map it to a stable rate-limit error for the renderer.
- [ ] Map upstream failures into `IpcResponse` error codes without leaking secrets.

- [ ] Add singleton helpers in `src/main/services/voice/index.ts`:

```ts
let instance: VoiceService | null = null;

export function getVoiceService(): VoiceService {
  instance ??= new VoiceService();
  return instance;
}

export function _resetVoiceServiceForTesting(): void {
  instance = null;
}
```

- [ ] Add `src/main/ipc/handlers/voice-handlers.ts`.

Use the existing `ipcMain.handle` pattern:

```ts
import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  VoiceAuthenticatedPayloadSchema,
  VoiceCreateTranscriptionSessionPayloadSchema,
  VoiceSetTemporaryOpenAiKeyPayloadSchema,
  VoiceTtsCancelPayloadSchema,
  VoiceTtsPayloadSchema,
} from '@contracts/schemas/voice';
import { getVoiceService } from '../../services/voice';

interface RegisterVoiceHandlersDeps {
  ensureAuthorized: (
    event: IpcMainInvokeEvent,
    channel: string,
    payload: unknown
  ) => IpcResponse | null;
}

export function registerVoiceHandlers(deps: RegisterVoiceHandlersDeps): void {
  const voice = getVoiceService();

  ipcMain.handle(IPC_CHANNELS.VOICE_STATUS_GET, async (): Promise<IpcResponse> => ({
    success: true,
    data: voice.getStatus(),
  }));

  ipcMain.handle(
    IPC_CHANNELS.VOICE_OPENAI_TEMP_KEY_SET,
    async (event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      const authError = deps.ensureAuthorized(event, IPC_CHANNELS.VOICE_OPENAI_TEMP_KEY_SET, payload);
      if (authError) return authError;
      const validated = validateIpcPayload(
        VoiceSetTemporaryOpenAiKeyPayloadSchema,
        payload,
        'VOICE_OPENAI_TEMP_KEY_SET'
      );
      voice.setTemporaryOpenAiApiKey(validated.apiKey);
      return { success: true, data: voice.getStatus() };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.VOICE_TRANSCRIPTION_SESSION_CREATE,
    async (event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      const authError = deps.ensureAuthorized(event, IPC_CHANNELS.VOICE_TRANSCRIPTION_SESSION_CREATE, payload);
      if (authError) return authError;
      const validated = validateIpcPayload(
        VoiceCreateTranscriptionSessionPayloadSchema,
        payload,
        'VOICE_TRANSCRIPTION_SESSION_CREATE'
      );
      const session = await voice.createTranscriptionSession({
        model: validated.model,
        language: validated.language,
      });
      return { success: true, data: session };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.VOICE_TTS_SYNTHESIZE,
    async (event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      const authError = deps.ensureAuthorized(event, IPC_CHANNELS.VOICE_TTS_SYNTHESIZE, payload);
      if (authError) return authError;
      const validated = validateIpcPayload(VoiceTtsPayloadSchema, payload, 'VOICE_TTS_SYNTHESIZE');
      const audio = await voice.synthesizeSpeech({
        requestId: validated.requestId,
        input: validated.input,
        model: validated.model,
        voice: validated.voice,
        format: validated.format,
      });
      return { success: true, data: audio };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.VOICE_TTS_CANCEL,
    async (event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      const authError = deps.ensureAuthorized(event, IPC_CHANNELS.VOICE_TTS_CANCEL, payload);
      if (authError) return authError;
      const validated = validateIpcPayload(VoiceTtsCancelPayloadSchema, payload, 'VOICE_TTS_CANCEL');
      return { success: true, data: { cancelled: voice.cancelSpeech(validated.requestId) } };
    }
  );
}
```

- [ ] Include `VOICE_OPENAI_TEMP_KEY_CLEAR` in the handler with auth and `VoiceAuthenticatedPayloadSchema`.
- [ ] Export the handler from `src/main/ipc/handlers/index.ts`.
- [ ] Register it from `src/main/ipc/ipc-main-handler.ts`, passing the existing `ensureAuthorized` dependency.
- [ ] Add tests in `src/main/ipc/handlers/__tests__/voice-handlers.spec.ts` or `src/main/services/voice/__tests__/voice-service.spec.ts`.

Test cases:

- `getStatus()` reports `environment` when `process.env.OPENAI_API_KEY` is set.
- `getStatus()` reports `temporary` when env is absent and temporary key is set.
- Temporary key does not win over env key.
- Temporary key is cleared from memory.
- `createTranscriptionSession()` sends Bearer auth only from main, uses `type: 'transcription'` plus `audio.input.transcription`, and extracts `client_secret.value`.
- `createTranscriptionSession()` includes optional `sdpUrl` only when the OpenAI response provides a stream URL.
- `synthesizeSpeech()` returns base64 audio and the expected MIME type.
- `synthesizeSpeech()` rejects input above 4096 characters before calling OpenAI.
- `cancelSpeech()` aborts the matching in-flight TTS request and does not affect other request ids.
- Aborted TTS fetch maps to `VOICE_TTS_CANCELLED`, not an unhandled rejection.
- OpenAI 429 maps to a stable renderer-visible rate-limit error.
- Non-OK OpenAI responses become controlled errors without echoing the API key.

Run:

```bash
npx vitest run src/main/services/voice src/main/ipc/handlers/__tests__/voice-handlers.spec.ts
npx tsc --noEmit
```

Checkpoint: main process has all credentialed OpenAI calls and no renderer code can read the long-lived key.

---

## Task 3: Add Electron Microphone Permissions, Entitlements, And CSP

**Purpose:** Make microphone access work in dev and packaged macOS builds without opening unnecessary network/media permissions.

- [ ] Read `src/main/window-manager.ts`, `src/renderer/index.html`, `electron-builder.json`, and `build/entitlements.mac.plist` before editing.
- [ ] In `src/main/window-manager.ts`, add a `session.setPermissionRequestHandler` for the main window session.

Behavior:

```ts
session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
  const isMainWindow = this.mainWindow?.webContents.id === webContents.id;
  const wantsAudioOnly =
    permission === 'media' &&
    Array.isArray(details?.mediaTypes) &&
    details.mediaTypes.includes('audio') &&
    !details.mediaTypes.includes('video');
  if (isMainWindow && wantsAudioOnly) {
    callback(true);
    return;
  }
  callback(false);
});
```

If the file already uses `partition` or a non-default session, register on that session instead of `defaultSession`.
Do not grant camera/video permission for voice mode.

- [ ] Update `src/renderer/index.html` CSP.

Required directives:

```html
connect-src 'self' https://api.openai.com wss://api.openai.com;
media-src 'self' blob:;
```

Preserve existing `default-src`, `script-src`, `style-src`, `font-src`, and `img-src`. WebRTC ICE traffic is not handled by normal `fetch`, but keep the OpenAI HTTPS and WebSocket origins explicit because fallback transports or browser internals may use those connection types.

- [ ] Update `electron-builder.json` `mac.extendInfo`:

```json
"NSMicrophoneUsageDescription": "AI Orchestrator uses the microphone only when you enable voice conversation for a session."
```

- [ ] Update `build/entitlements.mac.plist`:

```xml
<key>com.apple.security.device.audio-input</key>
<true/>
```

- [ ] Run:

```bash
npx tsc --noEmit
npm run lint
```

Checkpoint: permission request is scoped to the app window and only media is allowed.

---

## Task 4: Add Preload Voice Domain And Renderer IPC Service

**Purpose:** Give Angular a narrow typed API for voice IPC without exposing raw `ipcRenderer`.

- [ ] Add `src/preload/domains/voice.preload.ts`.

Expected domain:

```ts
import { IpcRenderer } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';

export function createVoiceDomain(
  ipcRenderer: IpcRenderer,
  ch: typeof IPC_CHANNELS,
  withAuth: (payload?: Record<string, unknown>) => Record<string, unknown> & { ipcAuthToken?: string } = (p = {}) => p
) {
  return {
    getVoiceStatus: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.VOICE_STATUS_GET),
    setTemporaryOpenAiVoiceKey: (apiKey: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.VOICE_OPENAI_TEMP_KEY_SET, withAuth({ apiKey })),
    clearTemporaryOpenAiVoiceKey: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.VOICE_OPENAI_TEMP_KEY_CLEAR, withAuth({})),
    createVoiceTranscriptionSession: (payload: { model?: string; language?: string }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.VOICE_TRANSCRIPTION_SESSION_CREATE, withAuth(payload)),
    synthesizeVoiceSpeech: (payload: {
      requestId: string;
      input: string;
      model?: string;
      voice?: string;
      format?: 'mp3' | 'wav' | 'opus';
    }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.VOICE_TTS_SYNTHESIZE, withAuth(payload)),
    cancelVoiceSpeech: (requestId: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.VOICE_TTS_CANCEL, withAuth({ requestId })),
  };
}
```

- [ ] Compose the domain in `src/preload/preload.ts`:

```ts
import { createVoiceDomain } from './domains/voice.preload';

const electronAPI = {
  ...existingDomains,
  ...createVoiceDomain(ipcRenderer, IPC_CHANNELS, withAuth),
  platform: process.platform,
};
```

- [ ] Add `src/renderer/app/core/services/ipc/voice-ipc.service.ts`.

Expected service methods:

```ts
@Injectable({ providedIn: 'root' })
export class VoiceIpcService extends ElectronIpcService {
  async getStatus(): Promise<VoiceStatus> {
    return this.unwrap(await this.api.getVoiceStatus());
  }

  async setTemporaryOpenAiKey(apiKey: string): Promise<VoiceStatus> {
    return this.unwrap(await this.api.setTemporaryOpenAiVoiceKey(apiKey));
  }

  async clearTemporaryOpenAiKey(): Promise<VoiceStatus> {
    return this.unwrap(await this.api.clearTemporaryOpenAiVoiceKey());
  }

  async createTranscriptionSession(
    payload: { model?: string; language?: string } = {}
  ): Promise<VoiceTranscriptionSession> {
    return this.unwrap(await this.api.createVoiceTranscriptionSession(payload));
  }

  async synthesizeSpeech(payload: {
    requestId: string;
    input: string;
    model?: string;
    voice?: string;
    format?: 'mp3' | 'wav' | 'opus';
  }): Promise<VoiceTtsResult> {
    return this.unwrap(await this.api.synthesizeVoiceSpeech(payload));
  }

  async cancelSpeech(requestId: string): Promise<boolean> {
    const result = this.unwrap<{ cancelled: boolean }>(
      await this.api.cancelVoiceSpeech(requestId)
    );
    return result.cancelled;
  }
}
```

Adapt `unwrap` to the existing `ElectronIpcService` pattern if it uses a different method name.

- [ ] Locate the renderer-side global Electron API declaration by searching for `interface ElectronAPI`, `electronAPI`, and existing preload domain method names.
- [ ] Update that declaration with `getVoiceStatus`, `setTemporaryOpenAiVoiceKey`, `clearTemporaryOpenAiVoiceKey`, `createVoiceTranscriptionSession`, `synthesizeVoiceSpeech`, and `cancelVoiceSpeech`.
- [ ] Add unit tests for `VoiceIpcService` if the repo has existing IPC-service tests. Otherwise rely on preload typecheck plus handler tests.
- [ ] Run:

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
```

Checkpoint: Angular can call voice IPC with typed methods and no direct `ipcRenderer`.

---

## Task 5: Add Renderer Speech Cleanup And TTS Playback Utilities

**Purpose:** Convert assistant output into speakable text and play returned audio safely.

- [ ] Add `src/renderer/app/core/voice/speech-text.ts`.

Required functions:

```ts
export const OPENAI_TTS_INPUT_LIMIT = 4096;
export const DEFAULT_TTS_TARGET_CHARS = 3500;

export function toSpeakableText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' Code block omitted from speech. ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' link omitted ')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[>\-*+]\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_{1,2}([^_]+)_{1,2}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function truncateForTts(text: string, maxChars = DEFAULT_TTS_TARGET_CHARS): string {
  if (text.length <= maxChars) return text;
  const clipped = text.slice(0, maxChars);
  const sentenceEnd = Math.max(
    clipped.lastIndexOf('. '),
    clipped.lastIndexOf('? '),
    clipped.lastIndexOf('! ')
  );
  return clipped.slice(0, sentenceEnd > 500 ? sentenceEnd + 1 : maxChars).trim();
}
```

- [ ] Add tests in `src/renderer/app/core/voice/speech-text.spec.ts`.

Test cases:

- replaces fenced code blocks with `Code block omitted from speech.` once per block instead of speaking code.
- removes inline code.
- preserves link text.
- replaces long raw URLs with `link omitted`.
- strips headings and list markers.
- truncates at a sentence boundary when possible.
- never returns more than `OPENAI_TTS_INPUT_LIMIT` characters when called with the hard-limit value.

- [ ] Add `src/renderer/app/core/voice/voice-playback.service.ts`.

Responsibilities:

- Convert base64 audio to a `Blob`.
- Create a `blob:` URL.
- Play through an `HTMLAudioElement`.
- Revoke previous/current Blob URLs on stop and after playback.
- Expose signals for `isPlaying`, `currentText`, and `error`.

Expected core:

```ts
@Injectable({ providedIn: 'root' })
export class VoicePlaybackService {
  readonly isPlaying = signal(false);
  readonly currentText = signal<string | null>(null);
  readonly error = signal<string | null>(null);

  private audio: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;

  async play(result: VoiceTtsResult, text: string): Promise<void> {
    this.stop();
    this.currentText.set(text);
    this.error.set(null);

    const bytes = Uint8Array.from(atob(result.audioBase64), (char) => char.charCodeAt(0));
    const blob = new Blob([bytes], { type: result.mimeType });
    this.objectUrl = URL.createObjectURL(blob);
    const audio = new Audio(this.objectUrl);
    this.audio = audio;
    this.isPlaying.set(true);

    audio.onended = () => this.finishPlayback();
    audio.onerror = () => {
      this.error.set('Unable to play voice response.');
      this.finishPlayback();
    };

    await audio.play();
  }

  stop(): void {
    if (this.audio) {
      this.audio.pause();
      this.audio.src = '';
      this.audio = null;
    }
    this.finishPlayback();
  }

  private finishPlayback(): void {
    this.isPlaying.set(false);
    this.currentText.set(null);
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }
}
```

- [ ] Add tests for Blob URL revocation and stop behavior.
- [ ] Run:

```bash
npx vitest run src/renderer/app/core/voice
npx tsc --noEmit -p tsconfig.spec.json
```

Checkpoint: TTS playback has no Blob URL leaks and does not speak code blocks.

---

## Task 6: Add Realtime Transcription Client

**Purpose:** Own microphone capture, WebRTC setup, and transcript event normalization in one renderer service.

- [ ] Add `src/renderer/app/core/voice/realtime-transcription.service.ts`.

Public shape:

```ts
export interface VoiceTranscriptEvent {
  kind:
    | 'partial'
    | 'final'
    | 'speech-started'
    | 'speech-stopped'
    | 'connection-lost'
    | 'credential-expired'
    | 'error';
  itemId?: string;
  text?: string;
  error?: string;
}

export interface VoiceTranscriptionConnection {
  events: Observable<VoiceTranscriptEvent>;
  level: Signal<number>;
  close(): void;
}

@Injectable({ providedIn: 'root' })
export class RealtimeTranscriptionService {
  private readonly zone = inject(NgZone);

  async connect(
    session: VoiceTranscriptionSession,
    audioContext: AudioContext
  ): Promise<VoiceTranscriptionConnection> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    const level = signal(0);
    const meter = this.createAudioMeter(audioContext, stream, level);
    const peer = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });

    for (const track of stream.getAudioTracks()) {
      peer.addTrack(track, stream);
    }

    const channel = peer.createDataChannel('oai-events');
    const events = new Subject<VoiceTranscriptEvent>();
    channel.onmessage = (message) =>
      this.zone.run(() => this.handleRealtimeEvent(message.data, events));
    channel.onclose = () =>
      this.zone.run(() => events.next({ kind: 'connection-lost', error: 'Realtime data channel closed.' }));
    peer.oniceconnectionstatechange = () => {
      if (peer.iceConnectionState === 'failed' || peer.iceConnectionState === 'disconnected') {
        this.zone.run(() =>
          events.next({ kind: 'connection-lost', error: `WebRTC ${peer.iceConnectionState}.` })
        );
      }
    };

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const answerSdp = await this.exchangeOfferForAnswer(
      session.clientSecret,
      offer.sdp ?? '',
      session.sdpUrl
    );
    await peer.setRemoteDescription({ type: 'answer', sdp: answerSdp });

    return this.createConnection(peer, stream, channel, events, level, meter);
  }
}
```

WebRTC SDP exchange:

```ts
private async exchangeOfferForAnswer(
  clientSecret: string,
  sdp: string,
  sdpUrl = 'https://api.openai.com/v1/realtime/calls'
): Promise<string> {
  const response = await fetch(sdpUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${clientSecret}`,
      'Content-Type': 'application/sdp',
    },
    body: sdp,
  });
  if (!response.ok) throw new Error(`Realtime connection failed (${response.status})`);
  return response.text();
}
```

Audio level metering:

```ts
private createAudioMeter(
  audioContext: AudioContext,
  stream: MediaStream,
  level: WritableSignal<number>
): { stop(): void } {
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  let frame = 0;
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const value of data) {
      const centered = value - 128;
      sum += centered * centered;
    }
    const rms = Math.sqrt(sum / data.length) / 128;
    this.zone.run(() => level.set(Math.min(1, rms * 3)));
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);

  return {
    stop: () => {
      stopped = true;
      cancelAnimationFrame(frame);
      source.disconnect();
      analyser.disconnect();
      level.set(0);
    },
  };
}
```

Realtime event parsing requirements:

- [ ] Treat `conversation.item.input_audio_transcription.delta` as `partial`, preserving `item_id`.
- [ ] Treat `conversation.item.input_audio_transcription.completed` as `final`, preserving `item_id`.
- [ ] Treat `input_audio_buffer.speech_started` as `speech-started`, preserving `item_id`.
- [ ] Treat `input_audio_buffer.speech_stopped` as `speech-stopped`, preserving `item_id`.
- [ ] Treat authentication/expiry-shaped server errors as `credential-expired`.
- [ ] Treat data channel close and ICE `failed`/`disconnected` as `connection-lost`.
- [ ] Ignore assistant/model response events instead of acting on them.
- [ ] Never send `response.create` or tool configuration messages.
- [ ] Do not import the OpenAI Realtime SDK in Phase 1; use native `RTCPeerConnection`, `RTCDataChannel`, and `getUserMedia`.
- [ ] Wrap WebRTC/data-channel callbacks that mutate signals or subjects in `NgZone.run(...)`.
- [ ] Catch `getUserMedia()` `NotAllowedError` as `microphone-denied`.
- [ ] Catch `getUserMedia()` `NotFoundError` and no-track streams as `microphone-unavailable`.
- [ ] Document that Phase 1 relies on OpenAI/WebRTC ICE and does not ship a custom TURN server; corporate/firewall failures surface as `voice-connection-lost`.

Cleanup requirements:

- [ ] Stop every microphone track on `close()`.
- [ ] Close the data channel.
- [ ] Close the peer connection.
- [ ] Stop the audio level meter animation frame and disconnect audio graph nodes.

Tests:

- [ ] Add `src/renderer/app/core/voice/realtime-transcription.service.spec.ts`.
- [ ] Mock `navigator.mediaDevices.getUserMedia`, `RTCPeerConnection`, and `fetch`.
- [ ] Assert microphone tracks are stopped on close.
- [ ] Assert the SDP exchange uses the ephemeral client secret, not an API key.
- [ ] Assert final transcript events are emitted from completed events.
- [ ] Assert `item_id` is preserved on partial/final/speech-started events.
- [ ] Assert data-channel close emits `connection-lost`.
- [ ] Assert ICE failure emits `connection-lost`.
- [ ] Assert `NotAllowedError` maps to `microphone-denied`.
- [ ] Assert `NotFoundError` maps to `microphone-unavailable`.
- [ ] Assert level meter updates and cleanup cancels its animation frame.
- [ ] Assert `response.create` is never sent.

Run:

```bash
npx vitest run src/renderer/app/core/voice/realtime-transcription.service.spec.ts
npx tsc --noEmit -p tsconfig.spec.json
```

Checkpoint: renderer can transcribe microphone audio but cannot perform credentialed TTS or session creation.

---

## Task 7: Add Voice Conversation Store

**Purpose:** Coordinate transcription, send/steer routing, TTS turn boundaries, barge-in, and UI state.

- [ ] Add `src/renderer/app/core/voice/voice-conversation.store.ts`.

Injected dependencies:

- `VoiceIpcService`
- `RealtimeTranscriptionService`
- `VoicePlaybackService`
- `NgZone` if needed by the app's service pattern

Inputs from component:

```ts
export interface VoiceConversationSessionContext {
  instanceId: string;
  status: InstanceStatus;
  messages: OutputMessage[];
  sendInput: (message: string) => void;
  steerInput: (message: string) => void;
}
```

State signals:

```ts
readonly mode = signal<VoiceConversationPhase>('off');
readonly partialTranscript = signal('');
readonly lastFinalTranscript = signal('');
readonly error = signal<string | null>(null);
readonly voiceAvailable = signal(false);
readonly keySource = signal<'environment' | 'temporary' | 'missing'>('missing');
readonly transcriptDetached = signal(false);
readonly audioLevel = signal(0);

private activeSpeechItemId: string | null = null;
private currentSpeechRequestId: string | null = null;
private audioContext: AudioContext | null = null;
private bargeInGeneration = 0;
private maskedUntilStable = false;
private reconnectAttempted = false;
```

Core behavior:

```ts
async start(context: VoiceConversationSessionContext): Promise<void> {
  if (this.mode() !== 'off') {
    this.stop();
  }
  this.context = context;
  this.voiceStartedAtMessageIndex = context.messages.length;
  this.spokenMessageKeys.clear();
  this.bargeInGeneration = 0;
  this.maskedUntilStable = false;
  this.reconnectAttempted = false;
  this.error.set(null);
  this.transcriptDetached.set(false);
  this.mode.set('connecting');

  const status = await this.voiceIpc.getStatus();
  this.voiceAvailable.set(status.available);
  this.keySource.set(status.keySource);
  if (!status.available) {
    this.mode.set('error');
    this.error.set('OpenAI API key is required for voice.');
    return;
  }

  this.audioContext ??= new AudioContext();
  await this.audioContext.resume();
  const session = await this.voiceIpc.createTranscriptionSession({ model: 'gpt-4o-transcribe' });
  this.connection = await this.transcription.connect(session, this.audioContext);
  this.transcriptSubscription = this.connection.events.subscribe((event) => this.handleTranscriptEvent(event));
  this.mode.set('listening');
}

stop(): void {
  this.transcriptSubscription?.unsubscribe();
  this.transcriptSubscription = null;
  this.connection?.close();
  this.connection = null;
  this.playback.stop();
  void this.cancelCurrentSpeech();
  this.audioLevel.set(0);
  this.mode.set('off');
  this.partialTranscript.set('');
  this.transcriptDetached.set(false);
}
```

Transcript routing:

```ts
private handleFinalTranscript(text: string): void {
  const message = text.trim();
  if (!message || !this.context) return;

  this.lastFinalTranscript.set(message);
  this.partialTranscript.set('');
  this.playback.stop();

  if (this.transcriptDetached()) {
    this.mode.set('listening');
    return;
  }

  if (this.isSessionActive(this.context.status)) {
    this.context.steerInput(message);
  } else {
    this.context.sendInput(message);
  }

  this.mode.set('waiting-for-session');
}
```

`isSessionActive()` should match the existing send/steer behavior in `InstanceMessagingStore`: active means the session is not idle/ready/waiting for normal input and can be interrupted/steered.

Barge-in and connection handling:

- [ ] On `speech-started`, set `activeSpeechItemId`, increment `bargeInGeneration`, set `maskedUntilStable = true`, stop playback, and call `cancelCurrentSpeech()`.
- [ ] On `partial`, update `partialTranscript` only when `transcriptDetached` is false or the event has a new `itemId`.
- [ ] If the user manually edits/submits the voice-owned transcript, set `transcriptDetached` and keep later partials in status only.
- [ ] On `connection-lost`, stop capture/playback and enter `error` with `voice-connection-lost`.
- [ ] On `credential-expired`, reconnect once by calling `voiceIpc.createTranscriptionSession()` and `transcription.connect(newSession, audioContext)`. If reconnect fails, enter `error` with `voice-credential-expired`.
- [ ] When `updateContext()` observes the selected instance status become idle/ready after a barge-in, clear `maskedUntilStable` without speaking output that arrived while masked.
- [ ] All state updates from transcription callbacks must run inside Angular's zone. Prefer the transcription service to emit inside `NgZone.run(...)`; if that is not possible, wrap the store subscriber body in `zone.run(...)`.
- [ ] `start()` must create/resume `AudioContext` directly inside the voice button click flow before asynchronous work escapes the user gesture.

Assistant turn boundary:

- [ ] Add `syncContext(context)` or `updateContext(context)` so the hosting component can push the latest status/messages each change detection pass.
- [ ] When voice is active, inspect assistant messages after `voiceStartedAtMessageIndex`.
- [ ] Candidate message must be `type === 'assistant'`, must not have `thinking`, and must not already be in `spokenMessageKeys`.
- [ ] Candidate text is `truncateForTts(toSpeakableText(message.content))`.
- [ ] Do not speak if cleaned text is empty.
- [ ] Do not speak while `maskedUntilStable` is true.
- [ ] Wait for a stability window of 700 ms after the last message count/content/status change.
- [ ] Speak only when status is one of the existing idle/ready/input-wait states and there is no pending permission/tool input prompt. If no existing prompt signal is available in `InputPanelComponent`, gate only on status in Phase 1 and document the residual risk in the final implementation notes.
- [ ] During speech, if transcription emits `speech-started` or a non-empty partial, immediately stop playback and set mode to `transcribing`.

TTS flow:

```ts
private async speakAssistantMessage(message: OutputMessage, messageKey: string): Promise<void> {
  const text = truncateForTts(toSpeakableText(message.content));
  if (!text) return;

  const generation = this.bargeInGeneration;
  const requestId = crypto.randomUUID();
  this.currentSpeechRequestId = requestId;
  this.spokenMessageKeys.add(messageKey);
  this.mode.set('speaking');
  const audio = await this.voiceIpc.synthesizeSpeech({
    requestId,
    input: text,
    model: 'gpt-4o-mini-tts',
    voice: 'alloy',
    format: 'mp3',
  });
  if (generation !== this.bargeInGeneration || requestId !== this.currentSpeechRequestId) {
    return;
  }
  await this.playback.play(audio, text);
  if (this.mode() === 'speaking') {
    this.mode.set('listening');
  }
}
```

Cancellation helper:

```ts
private async cancelCurrentSpeech(): Promise<void> {
  const requestId = this.currentSpeechRequestId;
  this.currentSpeechRequestId = null;
  if (requestId) {
    await this.voiceIpc.cancelSpeech(requestId).catch(() => undefined);
  }
}
```

Message key:

- [ ] Use a stable message ID if present in `OutputMessage`.
- [ ] If there is no ID, use `${index}:${message.type}:${message.content.length}:${hashFirstAndLastContent}` to avoid collapsing multiple assistant messages with the same length.

Tests:

- [ ] Add `src/renderer/app/core/voice/voice-conversation.store.spec.ts`.
- [ ] Final transcript sends input when status is idle/ready.
- [ ] Final transcript steers input and stops playback when status is active.
- [ ] Detached final transcript is not auto-sent.
- [ ] Assistant messages before voice start are not spoken.
- [ ] Code-only assistant output is not spoken.
- [ ] Assistant output is spoken once, even when `syncContext()` runs multiple times.
- [ ] New assistant output waits for the stability window.
- [ ] Barge-in cancels pending TTS and masks interrupted trailing output until idle/ready.
- [ ] Credential expiry reconnects once and preserves the unsent partial transcript.
- [ ] Connection loss enters recoverable error and stops capture/playback.
- [ ] `stop()` closes transcription, unsubscribes events, and stops playback.

Run:

```bash
npx vitest run src/renderer/app/core/voice/voice-conversation.store.spec.ts
npx tsc --noEmit -p tsconfig.spec.json
```

Checkpoint: the voice store can be tested without Electron or real OpenAI.

---

## Task 8: Integrate Voice Controls Into The Active Session Composer

**Purpose:** Add the microphone control to the UI the user screenshotted while preserving existing send/steer behavior.

- [ ] Read `src/renderer/app/features/instance-detail/input-panel.component.ts`, `.html`, and `.scss` completely before editing.
- [ ] Add optional voice inputs and outputs to `InputPanelComponent` only if direct store injection is not appropriate. Preferred path: inject `VoiceConversationStore` in `InputPanelComponent` because it already owns the active composer controls.

Use these computed values:

```ts
protected readonly voiceMode = this.voice.mode;
protected readonly voiceDisabled = computed(() =>
  this.disabled() || this.isRespawning() || !this.instanceId()
);
protected readonly voiceButtonLabel = computed(() => {
  switch (this.voiceMode()) {
    case 'connecting': return 'Starting voice';
    case 'listening': return 'Listening';
    case 'sending': return 'Sending transcript';
    case 'transcribing': return 'Transcribing';
    case 'waiting-for-session': return 'Waiting for reply';
    case 'speaking': return 'Speaking';
    case 'stopping': return 'Stopping voice';
    case 'error': return 'Voice unavailable';
    default: return 'Start voice conversation';
  }
});
protected readonly showVoiceKeyInput = signal(false);
protected readonly temporaryVoiceKey = signal('');
```

Add actions:

```ts
protected async onToggleVoice(): Promise<void> {
  if (this.voice.mode() === 'off' || this.voice.mode() === 'error') {
    await this.voice.start(this.buildVoiceContext());
    if (this.voice.keySource() === 'missing') {
      this.showVoiceKeyInput.set(true);
    }
    return;
  }
  this.voice.stop();
}

private buildVoiceContext(): VoiceConversationSessionContext {
  return {
    instanceId: this.instanceId(),
    status: this.instanceStatus(),
    messages: this.outputMessages(),
    sendInput: (message) => this.sendMessage.emit(message),
    steerInput: (message) => this.steerMessage.emit(message),
  };
}
```

- [ ] Add an `effect()` to push current context while voice is active:

```ts
effect(() => {
  if (this.voice.mode() === 'off') return;
  this.voice.updateContext(this.buildVoiceContext());
});
```

- [ ] Update `src/renderer/app/features/instance-detail/input-panel.component.html` right action cluster.

Place the voice button before the send button:

```html
<button
  type="button"
  class="icon-btn voice-toggle"
  [class.voice-toggle--active]="voiceMode() !== 'off' && voiceMode() !== 'error'"
  [class.voice-toggle--speaking]="voiceMode() === 'speaking'"
  [disabled]="voiceDisabled() || voiceMode() === 'connecting' || voiceMode() === 'stopping'"
  [attr.aria-pressed]="voiceMode() !== 'off' && voiceMode() !== 'error'"
  [attr.aria-label]="voiceButtonLabel()"
  [title]="voiceButtonLabel()"
  (click)="onToggleVoice()"
>
  <lucide-icon [name]="voiceMode() === 'speaking' ? 'volume-2' : 'mic'" [size]="18"></lucide-icon>
</button>
```

Use the local icon component/import pattern already present in this app. If `lucide-icon` is not used in this component, import the existing icon component the repo uses.

- [ ] Add a compact voice status strip near the existing composer hints, but only when voice is active or errored:

```html
@if (voiceMode() !== 'off' || voice.error()) {
  <div class="voice-status" role="status">
    <span class="voice-status__dot" aria-hidden="true"></span>
    <span>{{ voiceButtonLabel() }}</span>
    @if (voice.partialTranscript()) {
      <span class="voice-status__transcript">{{ voice.partialTranscript() }}</span>
    }
    @if (voice.error()) {
      <button type="button" class="link-btn" (click)="showVoiceKeyInput.set(true)">Set key</button>
    }
  </div>
}

@if (showVoiceKeyInput()) {
  <form class="voice-key-form" (submit)="onSubmitVoiceKey($event)">
    <label class="sr-only" for="voice-openai-key">OpenAI API key for voice</label>
    <input
      id="voice-openai-key"
      class="voice-key-form__input"
      type="password"
      autocomplete="off"
      spellcheck="false"
      [value]="temporaryVoiceKey()"
      (input)="temporaryVoiceKey.set($any($event.target).value)"
      placeholder="OpenAI API key for this app session"
    />
    <button type="submit" class="link-btn">Use key</button>
    <button type="button" class="link-btn" (click)="onCancelVoiceKey()">Cancel</button>
  </form>
}
```

- [ ] Implement inline temporary key entry. Do not use `window.prompt()`.

Behavior:

```ts
protected async onSubmitVoiceKey(event: Event): Promise<void> {
  event.preventDefault();
  const apiKey = this.temporaryVoiceKey().trim();
  if (!apiKey) return;
  this.temporaryVoiceKey.set('');
  this.showVoiceKeyInput.set(false);
  await this.voice.setTemporaryOpenAiKey(apiKey);
  await this.onToggleVoice();
}

protected onCancelVoiceKey(): void {
  this.temporaryVoiceKey.set('');
  this.showVoiceKeyInput.set(false);
}
```

Do not persist this key.

- [ ] Update `src/renderer/app/features/instance-detail/input-panel.component.scss`.

Styling requirements:

- Stable square button dimensions matching the send button.
- Active listening state should be visible without resizing the composer.
- Speaking state may use a subtle color change, not layout movement.
- Status strip must wrap on mobile and never overlap the text area or send button.

Example:

```scss
.voice-toggle {
  width: 2.5rem;
  height: 2.5rem;
  flex: 0 0 auto;
}

.voice-toggle--active {
  color: var(--color-accent);
}

.voice-toggle--speaking {
  color: var(--color-success);
}

.voice-status {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 1.5rem;
  max-width: 100%;
  flex-wrap: wrap;
  font-size: 0.8125rem;
}

.voice-status__transcript {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.voice-key-form {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  width: 100%;
}

.voice-key-form__input {
  min-width: min(18rem, 100%);
  flex: 1 1 14rem;
}
```

- [ ] If `InputPanelComponent` unit tests exist, update them. Add cases for:

- voice button emits/sends through existing `sendMessage` when idle.
- voice button routes through `steerMessage` when active.
- voice status renders partial transcript.
- voice unavailable state offers temporary key entry and does not persist it.

Run:

```bash
npx vitest run src/renderer/app/features/instance-detail/input-panel.component.spec.ts
npx tsc --noEmit -p tsconfig.spec.json
```

Checkpoint: active session composer shows a microphone control beside send, and new-session composer remains unchanged.

---

## Task 9: Manual Runtime Verification

**Purpose:** Verify browser/Electron behavior that unit tests cannot cover.

- [ ] Ensure an OpenAI key is available:

```bash
printenv OPENAI_API_KEY
```

If the command prints nothing, use the temporary in-memory key prompt in the UI during manual testing.

- [ ] Start the app:

```bash
npm run dev
```

- [ ] Open an existing session.
- [ ] Click the microphone button.
- [ ] Confirm macOS prompts for microphone permission the first time.
- [ ] Speak a short prompt: "Please summarize the last response in one sentence."
- [ ] Confirm partial transcript appears while speaking.
- [ ] Confirm final transcript sends to the session.
- [ ] While the assistant is responding or TTS is speaking, start speaking again.
- [ ] Confirm playback stops and the transcript routes through steer/interruption.
- [ ] Confirm interrupted trailing output from the old turn is not spoken.
- [ ] Ask for code in the assistant response.
- [ ] Confirm the spoken response skips fenced code blocks.
- [ ] Disable network or close the Realtime connection during listening and confirm a recoverable voice error appears with capture stopped.
- [ ] Stop voice.
- [ ] Confirm the mic indicator stops and no further transcript events are routed.

If `npm run dev` cannot launch because of a local environment issue, record the exact failure in the implementation notes and still run all compile/test checks.

---

## Task 10: Full Verification Before Claiming Done

**Purpose:** Satisfy project completion standards.

Run these commands after all code changes:

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run test
```

Also inspect:

```bash
git diff --stat
git diff -- src/main src/preload src/renderer packages/contracts electron-builder.json build/entitlements.mac.plist
```

Completion checklist for the final implementation report:

- [ ] Contracts and generated preload channels updated.
- [ ] Runtime aliases for `@contracts/channels/voice` and `@contracts/schemas/voice` updated.
- [ ] Shared voice types added and used by renderer voice state.
- [ ] Existing `ipcAuthToken` flow verified and used for all voice credential/spend IPC.
- [ ] Main process owns API key, transcription session creation, and TTS.
- [ ] Renderer only receives ephemeral Realtime credentials.
- [ ] Electron microphone permission, macOS usage string, entitlement, CSP, and media/connect directives updated.
- [ ] Realtime transcription connects, emits partial/final events, and cleans up tracks.
- [ ] Assistant TTS strips code/Markdown and revokes Blob URLs.
- [ ] Barge-in stops playback and routes to `steerInput()` for active sessions.
- [ ] Barge-in cancels pending TTS and masks trailing interrupted output.
- [ ] Transcript detachment prevents user-edited voice text from being auto-sent.
- [ ] Realtime credential expiry/connection loss paths are tested.
- [ ] Audio level metering uses a gesture-resumed `AudioContext` and cleans up graph nodes.
- [ ] Voice control appears in active session composer and not new-session composer.
- [ ] Unit tests added for credential source, TTS, transcription cleanup, speech cleanup, playback cleanup, and voice routing.
- [ ] Manual runtime verification completed or exact blocker documented.
- [ ] `npx tsc --noEmit` passed.
- [ ] `npx tsc --noEmit -p tsconfig.spec.json` passed.
- [ ] `npm run lint` passed.
- [ ] `npm run test` passed.

Do not commit or push unless the user explicitly asks.
