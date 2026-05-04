# Full Voice Conversation Design

**Date:** 2026-05-02
**Status:** Draft for user review
**Scope:** Add full voice conversation to AI Orchestrator sessions without replacing the existing text/session stack.

## Summary

AI Orchestrator should support speaking to a session and hearing the session answer back. The first implementation should wrap the existing session model:

1. User speech is transcribed.
2. Final user transcript is sent to the selected session through the existing message path.
3. The existing CLI-backed session produces normal text output.
4. Assistant text output is spoken with TTS.
5. If the user starts speaking while the session or spoken response is active, voice mode stops playback and uses the existing steer/interrupt behavior.

This is a full voice conversation loop for existing sessions. It is intentionally not a separate voice assistant, and it should not let a realtime speech model answer instead of the selected Claude, Codex, Gemini, Copilot, or Cursor session.

## Goals

- Add a session-scoped voice mode to the existing composer and selected-session workflow.
- Support continuous turn-taking: listen, transcribe, send, wait for session, speak response, resume listening.
- Support barge-in during spoken responses and active turns.
- Preserve the existing text transcript as the source of truth.
- Keep long-lived provider API keys out of renderer-to-provider network calls and persistent renderer storage.
- Make the voice layer provider-pluggable enough to support OpenAI first and other providers later.
- Keep the first implementation bounded enough to test well.

## Non-Goals

- Do not replace CLI sessions with a realtime assistant.
- Do not route all app interaction through voice commands.
- Do not persist OpenAI API keys in the existing plain JSON settings store.
- Do not require every provider CLI to implement native audio.
- Do not add a global always-listening mode in the first implementation.

## Existing App Context

The right integration point is the selected session path, not a parallel chat surface.

- `src/renderer/app/features/instance-detail/input-panel.component.ts` owns the shared composer, draft text, prompt history, slash-command handling, send, and steer events.
- `src/renderer/app/features/instance-detail/instance-detail.component.ts` binds the input panel to active sessions and routes messages through `store.sendInput()` and `store.steerInput()`.
- `src/renderer/app/core/state/instance/instance-messaging.store.ts` already handles queueing, busy states, terminal-state rejection, and steer interrupt behavior.
- `src/renderer/app/core/state/instance/instance.store.ts` already receives instance output and status updates from IPC, which is enough to detect when a response is ready to speak.
- `src/main/window-manager.ts` creates a sandboxed, context-isolated renderer and currently has no microphone permission handling.
- `src/renderer/index.html` has a restrictive CSP without explicit `connect-src` or `media-src`, so browser audio/network changes must update CSP deliberately.
- `electron-builder.json` enables macOS hardened runtime and uses `build/entitlements.mac.plist`. Microphone support must update both the entitlements file and `extendInfo`, not only Electron runtime permission handling.

## Sibling Project Findings

### Actual Claude

Useful patterns:

- Voice state model: idle, recording, processing, error/warmup states.
- Transcript insertion anchored at the cursor so interim and final transcripts do not clobber typed text.
- Submit-race guard: if the user edits or submits while final transcription is still arriving, stale voice callbacks are ignored.
- User-visible audio/warmup/error feedback.
- Careful distinction between no microphone, no speech, silent audio, and stream failure.

Not directly reusable:

- Terminal hold-to-talk key handling.
- Native terminal audio capture stack.
- Anthropic OAuth/voice-stream gating.

### openclaw

Useful patterns:

- Provider abstraction with callbacks for audio, transcript, ready, error, close, and barge-in.
- Browser session shape that returns an ephemeral client secret instead of exposing the real API key.
- Realtime bridge semantics for `onTranscript`, `onClearAudio`, `handleBargeIn`, and tool/result continuation.
- OpenAI Realtime/WebSocket handling demonstrates the event concepts needed for speech start, transcript completion, response audio, and interruption.

Not directly reusable:

- The openclaw voice provider lets the realtime model own the conversation. AI Orchestrator needs the selected CLI session to own the answer.

## Provider Strategy

Use OpenAI first, with an internal provider boundary.

### Phase 1 Provider Shape

The voice layer is a text-agent voice wrapper:

- STT provider streams user speech into partial and final transcripts.
- Session bridge sends final transcripts to the existing session.
- TTS provider speaks selected assistant text after the session responds.

This matches OpenAI's recommended "chained" voice-agent pattern for adding voice to existing text agents. It has higher latency than native speech-to-speech, but it preserves control and keeps the selected session as the authority.

### OpenAI Integration

Use a hybrid architecture for Phase 1:

- **Realtime transcription:** renderer connects directly to OpenAI using a short-lived client secret minted by the main process. The long-lived API key never goes to OpenAI from the renderer.
- **Speech synthesis:** main process performs all TTS REST calls. Realtime ephemeral client secrets must not be used as bearer tokens for REST TTS endpoints. REST TTS is intentionally chosen for Phase 1 because the selected CLI session, not a realtime model, owns the assistant response; using Realtime TTS in Phase 1 would add another model/session boundary and blur authority. Lower-latency streaming speech remains Phase 2.
- **No Phase 1 push IPC:** live transcript and audio-level updates stay inside the renderer because the renderer owns the WebRTC transcription session and local microphone analysis. TTS is request/response and buffered before playback.

The transcription session must use OpenAI's transcription-only realtime mode:

- Create a `/v1/realtime/transcription_sessions` session, not a normal speech-to-speech conversation session.
- The session `type` must be `transcription`.
- The session configuration uses the current OpenAI transcription-session shape: `audio.input.transcription`, `audio.input.turn_detection`, optional `audio.input.noise_reduction`, and no output modalities.
- The session must not produce model responses. If a non-transcription realtime session is ever used as a fallback, VAD may remain enabled only with automatic responses disabled: `create_response: false` and `interrupt_response: false`; never call `response.create`; set `tools: []` and `tool_choice: 'none'`.
- The renderer performs the WebRTC SDP exchange directly against OpenAI with the ephemeral client secret. The app does not stream microphone audio through Electron IPC in Phase 1.
- The renderer implementation must use native browser WebRTC APIs first. Do not add the OpenAI Realtime SDK unless implementation proves the SDK bundles cleanly inside Electron's sandboxed renderer.
- Ephemeral Realtime credentials are allowed to be visible to renderer DevTools because they are short-lived and scoped to the transcription session. They must never be persisted, logged, or accepted by the REST TTS IPC path.
- If an ephemeral credential expires during a long voice session, the store stops the old transcription connection, asks main for a fresh transcription session, reconnects once, and preserves unsent partial transcript state.

Credential resolution:

- Main process first checks `process.env.OPENAI_API_KEY`.
- Because macOS GUI apps launched from Finder/Spotlight usually do not inherit shell profile environment variables, Phase 1 must also provide a temporary voice API-key entry path in the app. The renderer may collect the typed key, send it once to main over authenticated IPC, and then clear the input; main stores it in memory only for the current app process.
- Persisted voice credentials are a later feature and require an encrypted credential store. The existing `SettingsManager` persists plain JSON, and `ChannelCredentialStore` persists plaintext SQLite tokens, so neither is acceptable for persisted OpenAI API keys.
- Any temporary-key IPC tracing, debug logging, error reporting, and crash-report metadata must redact the key and authorization header.

## User Experience

Voice mode appears inside the existing composer.

### Controls

- Add a microphone/voice button beside the send button in `InputPanelComponent`.
- Click toggles voice conversation for the current session.
- The button state reflects off, connecting, listening, waiting, speaking, and error.
- A compact status strip above or inside the composer shows the live transcript and current voice phase.
- Text input remains available while voice mode is on.

### Turn Behavior

- When voice mode is on, the app listens for speech.
- Interim transcript is shown in the composer/status strip.
- Final transcript is auto-sent by default.
- If the user edits the transcript before finalization, the voice callback must not overwrite their edit. The store tracks the last voice-owned partial text and a `transcriptDetached` flag. If the composer/status transcript text differs from the last voice-owned partial because of user typing or manual submit, further partial updates remain in the status strip and the final transcript is not auto-sent until it arrives as a new voice item.
- If the selected session is ready, final transcript uses `sendInput()`.
- If the selected session is actively working and the user speaks, final transcript uses `steerInput()` so it enters the existing interrupt/front-queue path. This is an interrupt/steer operation, not merely "say this next"; the existing session queue remains responsible for provider-specific interruption semantics.
- Spoken assistant audio stops immediately when the user starts speaking.
- Only one voice session may be active at a time in Phase 1. Starting voice for another selected session must stop the current voice session first, clear local media/playback, and bind the new voice session to the newly selected instance id.

### New Sessions

Initial implementation supports active sessions first. The new-session composer can show the voice button disabled with a clear unavailable state until an implementation plan explicitly handles "speak first turn to create session." This keeps the first release smaller and avoids coupling voice startup to provider/model/working-directory selection.

## State Model

Use one store-owned state machine. Avoid spreading voice state across the component tree.

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
```

Core state:

- `enabled`: whether voice conversation is active for the selected session.
- `instanceId`: selected instance bound to this voice session.
- `phase`: current voice phase.
- `partialTranscript`: latest non-final transcript.
- `finalTranscript`: last finalized user transcript.
- `lastSentTranscript`: last transcript sent to a session.
- `activeSpeechItemId`: provider item id for the current speech segment, if supplied.
- `transcriptDetached`: whether user editing/manual submit detached the current transcript from voice ownership.
- `bargeInGeneration`: monotonically increasing generation used to ignore stale assistant output and TTS requests after barge-in.
- `spokenMessageIds`: set of assistant message ids already spoken.
- `voiceStartedAtOutputIndex`: output-buffer index where the current voice session started, so historical messages are never spoken.
- `error`: recoverable user-facing error message.
- `audioLevel`: optional normalized input level for UI feedback.
- `speaking`: whether output audio is actively playing.

Derived behavior:

- `canStart`: selected instance exists and is not terminal.
- `shouldUseSteer`: selected instance is busy, processing, thinking, or waiting for permission.
- `shouldSpeakMessage`: message is assistant-visible text, belongs to the bound instance, and has not been spoken.

## Component Design

### Shared Types

Create shared voice types under `src/shared/types/voice.types.ts`.

Responsibilities:

- Voice phases and provider ids.
- IPC request/response shapes.
- Browser session descriptor shape.
- TTS request/result shapes.
- User-facing voice error codes.

### IPC Contracts

Add a new voice channel group in `packages/contracts/src/channels/voice.channels.ts` and merge it into `packages/contracts/src/channels/index.ts`.

Required channels:

- `voice:get-status`
- `voice:set-temporary-api-key`
- `voice:clear-temporary-api-key`
- `voice:create-transcription-session`
- `voice:synthesize-speech`
- `voice:cancel-speech`

Add Zod payload schemas under `packages/contracts/src/schemas/voice.schemas.ts`.

The preload bridge gets a dedicated `src/preload/domains/voice.preload.ts`, and `src/preload/preload.ts` composes it into `electronAPI`.

All voice IPC calls that can expose credentials, spend money, or create provider sessions must follow the existing `withAuth` IPC token pattern used by infrastructure/provider domains.

Phase 1 deliberately avoids renderer push-event IPC. If Phase 2 streams TTS chunks or moves transcription into the main process, the implementation plan must add explicit push event channels, listener cleanup APIs, throttle rules, and schemas for transcript/audio events.

### Main Process Voice Service

Create `src/main/voice/voice-service.ts`.

Responsibilities:

- Resolve whether voice is available.
- Resolve OpenAI API key from `process.env.OPENAI_API_KEY` or the in-memory temporary key set by authenticated IPC.
- Create ephemeral browser sessions for realtime transcription only.
- Synthesize speech for assistant text.
- Normalize provider errors into stable app error codes.
- Never send the long-lived API key to the renderer.
- Reject or truncate TTS requests above the provider hard limit, after markdown/code-block speech cleanup. For OpenAI REST TTS, Phase 1 caps request input at 4096 characters and should target 3500 cleaned characters before the main-process hard guard.

Create `src/main/ipc/handlers/voice-handlers.ts`.

Responsibilities:

- Validate voice IPC payloads.
- Call `VoiceService`.
- Return `IpcResponse` with typed data.
- Avoid logging transcript text or secrets.

Register handlers in `src/main/ipc/ipc-main-handler.ts`.

### Electron Window and Security

Modify `src/main/window-manager.ts`.

Responsibilities:

- Add a `session.setPermissionRequestHandler` for microphone access.
- Allow microphone only for the app's own dev/prod origins.
- Deny unrelated permission types.
- Preserve existing external navigation protections.

Modify `electron-builder.json` and `build/entitlements.mac.plist`.

Responsibilities:

- Add `NSMicrophoneUsageDescription` to `mac.extendInfo`.
- Add the macOS audio-input entitlement required for hardened runtime microphone access.
- Verify a packaged macOS build can request microphone permission; dev-only verification is not enough.

Modify `src/renderer/index.html` CSP.

Needed directives:

- `connect-src` for app origins plus the OpenAI endpoints needed for realtime transcription, including `https://api.openai.com` and `wss://api.openai.com` if the selected transport uses WebSocket signaling.
- `media-src 'self' blob:` for generated audio playback.

The implementation plan must verify CSP in both dev server and packaged-file paths.

### Renderer Voice Services

Create `src/renderer/app/core/services/voice/voice-conversation.store.ts`.

Responsibilities:

- Own the voice state machine.
- Bind voice mode to the selected active instance.
- Start/stop provider sessions.
- Receive transcript callbacks.
- Decide `sendInput()` versus `steerInput()`.
- Watch selected instance output/status and trigger TTS.
- Track spoken message ids to avoid replaying history.
- Reset state on session switch, termination, or app teardown.

Create `src/renderer/app/core/services/voice/voice-audio-input.service.ts`.

Responsibilities:

- Own browser microphone acquisition.
- Connect browser audio to the OpenAI realtime transcription session created from the main-process ephemeral client secret.
- Emit partial/final transcripts and speech-start events.
- Emit local audio levels from the browser audio graph with throttling.
- Surface permission and device errors.

Create `src/renderer/app/core/services/voice/voice-audio-output.service.ts`.

Responsibilities:

- Play synthesized assistant audio.
- Stop/clear audio on barge-in.
- Emit speaking start/end events.
- Avoid overlapping TTS playback.
- Resume/create `AudioContext` from the user's voice-button click so Chromium's user-gesture requirement is satisfied.
- Revoke Blob URLs after playback or cancellation.

### UI Integration

Modify `src/renderer/app/features/instance-detail/input-panel.component.ts`.

Responsibilities:

- Inject the voice conversation store.
- Expose state to the template.
- Add handlers for starting/stopping voice.
- Keep existing send/steer behavior unchanged.

Modify `src/renderer/app/features/instance-detail/input-panel.component.html`.

Responsibilities:

- Add microphone button in the right composer action cluster before send.
- Add a compact voice status strip near the composer hints.
- Use accessible labels and titles for each phase.

Modify `src/renderer/app/features/instance-detail/input-panel.component.scss`.

Responsibilities:

- Add stable dimensions for the voice button.
- Add visual states for listening, waiting, speaking, and error.
- Keep mobile composer layout stable.

## Data Flow

### Start Voice Mode

1. User clicks the voice button.
2. `VoiceConversationStore.start(instanceId)` enters `connecting`.
3. Output service creates or resumes its `AudioContext` inside this user gesture.
4. Store asks main process for voice availability/session details.
5. If no API key is available, UI offers temporary in-memory key entry and does not start provider networking until a key is provided.
6. Main process creates an OpenAI realtime transcription session and returns only the ephemeral client secret/session descriptor.
7. Renderer requests microphone permission via `getUserMedia({ audio: true })`.
8. Input provider connects to the transcription session and enters `listening`.
9. UI shows listening state.

### User Speech Turn

1. Provider emits partial transcripts.
2. Store updates `partialTranscript`.
3. Provider emits final transcript.
4. Store moves to `sending`.
5. If `transcriptDetached` is false, store calls `sendInput()` if the instance is ready.
6. If `transcriptDetached` is false, store calls `steerInput()` if the instance is active.
7. If `transcriptDetached` is true, store keeps the final transcript visible but does not auto-send it.
8. Store clears partial transcript, records `lastSentTranscript` when sent, and moves to `waiting-for-session`.

### Assistant Speech Turn

1. Instance output arrives through existing `InstanceStore`.
2. Store identifies the newest speakable assistant message for the bound instance.
3. Store waits for a stable turn boundary: the instance is `idle`, `ready`, or `waiting_for_input`; no new speakable output has arrived for a short stability window; no pending tool-use or permission prompt is active; and the message is after `voiceStartedAtOutputIndex`.
4. While waiting, the UI remains in `waiting-for-session` with a visible status. If speakable text exceeds the Phase 1 speech cap as it streams, the store may mark the turn as long and later speak only the short long-response message instead of waiting to synthesize the full text.
5. Store calls TTS for that message text, carrying the current `bargeInGeneration`.
6. Main process buffers the full Phase 1 TTS result and returns a playable audio payload.
7. Before playback starts, the store verifies that the `bargeInGeneration` has not changed and the message is still the newest selected speakable output.
8. Output service plays audio and phase becomes `speaking`.
9. Playback completion returns voice mode to `listening` if still enabled.

### Barge-In

1. Provider emits speech-start while phase is `speaking`, `waiting-for-session`, or `transcribing`.
2. Output service stops current audio immediately.
3. Store increments `bargeInGeneration`, cancels any pending TTS playback start, and ignores stale TTS responses from older generations.
4. Store masks assistant output that arrives after barge-in until the instance reaches the next stable `idle` or `ready` state, so trailing output from the interrupted turn is not spoken.
5. If a previous partial transcript has not been finalized or sent, the store keeps it visible and does not overwrite it with a new turn unless the provider supplies a new `item_id`.
6. If the underlying instance is active, the final transcript uses `steerInput()`.
7. If the underlying instance is ready, the final transcript uses `sendInput()`.
8. Existing queue/interruption rules remain responsible for provider-specific behavior.

### Stop Voice Mode

1. User clicks the active voice button or switches away from the session.
2. Store enters `stopping`.
3. Input provider stops microphone capture.
4. Output provider stops audio.
5. Store clears transient transcripts and moves to `off`.
6. If provider shutdown fails, store moves to `error` with a retryable cleanup error, but still releases local media tracks and audio playback.

## Timeout and Retry Rules

- `connecting` times out after 15 seconds and surfaces `provider-session-failed`.
- `listening` has no hard timeout while the session is healthy.
- A speech segment that starts but produces no final transcript within 20 seconds enters `transcription-failed` and keeps the last partial transcript visible.
- TTS requests time out after 30 seconds and surface `speech-synthesis-failed`.
- WebRTC ICE failures, data-channel close, and OpenAI Realtime session expiry surface `transcription-failed`. The first expiry-related failure may reconnect once with a fresh transcription session; repeated failures stop capture and keep the unsent transcript visible.
- `stopping` runs local cleanup best-effort first, then provider cleanup; local media tracks and Blob URLs must be released even if provider cleanup fails.
- Retrying from `error` calls `stop()` first, then `start(instanceId)` from a clean local state.
- Transcript and audio-level events are throttled to UI-safe rates: transcript deltas update at most every animation frame, and audio levels update at most 15 times per second.

## Speakable Output Rules

The first implementation should speak only assistant text that would normally be visible as a session response.

Rules:

- Speak `OutputMessage` entries whose type represents assistant text.
- Do not speak user messages, tool-use details, tool results, system notices, or thinking blocks.
- Do not speak historical messages already present before voice mode started.
- Do not speak the same message id twice.
- Track spoken output with a set of message ids plus the voice-start high-water mark; a scalar last id is not sufficient for multi-message turns.
- Strip minimal markdown for natural speech: remove heading markers, emphasis markers, inline-code backticks, code fences, and raw markdown link syntax.
- Replace fenced code blocks with a short spoken placeholder such as "Code block omitted from speech." Do not speak large code blocks verbatim in Phase 1.
- Replace long URLs with "link omitted" unless the message is mostly a URL.
- Enforce a TTS text length cap after cleanup; long responses can be summarized by speech as "Long response available in the transcript" rather than sending multi-megabyte audio requests.
- The OpenAI REST TTS hard guard is 4096 input characters. The renderer targets 3500 cleaned characters; main rejects anything above 4096 characters even if a renderer bug sends it.
- Preserve the exact text transcript in the UI; speech cleanup affects TTS input only.

The implementation plan must inspect the concrete `OutputMessage` variants before writing these filters.

## Errors and Recovery

User-facing error states:

- `missing-api-key`: `OPENAI_API_KEY` is not available to the main process.
- `temporary-api-key-rejected`: temporary key validation failed or provider rejected it.
- `microphone-denied`: Electron/browser microphone permission was denied.
- `microphone-unavailable`: no usable input device is available.
- `provider-session-failed`: OpenAI browser/session creation failed.
- `transcription-failed`: speech stream failed after connection.
- `voice-connection-lost`: Realtime connection dropped after a previously healthy session.
- `voice-credential-expired`: ephemeral Realtime credential expired and reconnect failed.
- `speech-synthesis-failed`: TTS request or playback failed.
- `session-unavailable`: selected instance is terminal or missing.
- `cleanup-failed`: local cleanup completed but provider cleanup failed.

Recovery behavior:

- Errors stop active capture and playback.
- The voice button remains visible so the user can retry.
- Transcript text that has already been finalized and sent remains in the normal session transcript.
- Partial transcript that was not sent is retained in the status strip until the user stops or retries, so speech is not silently lost.

## Privacy and Logging

- Do not log raw transcripts.
- Do not log OpenAI client secrets.
- Do not log temporary API keys, Authorization headers, or full TTS inputs.
- Do not persist audio blobs.
- Do not persist partial transcripts outside normal session messages.
- Do not persist temporary API keys.
- Do not write raw OpenAI API keys to `SettingsManager`, SQLite credential tables, logs, crash reports, or renderer storage.
- Final user transcripts become normal session messages once sent.
- TTS audio is memory-only unless a provider API requires a temporary blob URL; revoke blob URLs after playback.

## Testing Strategy

Unit tests:

- Voice state transitions for start, final transcript, send, wait, speak, stop.
- Send-vs-steer decision based on instance status.
- Barge-in stops playback and routes the next final transcript correctly.
- Spoken-message tracking does not replay history or duplicate the same message id.
- Spoken-message tracking supports multiple assistant messages in one turn.
- Tool-call status transitions do not trigger speech before a stable turn boundary.
- Barge-in masks trailing interrupted output until the next stable idle/ready state.
- Transcript detachment prevents user-edited partial transcripts from being auto-sent.
- Realtime token expiry reconnects once and preserves unsent transcript state.
- Timeout and retry transitions clear local media state.
- Markdown/code-block speech cleanup omits fenced code blocks and strips common markdown markers.
- Blob URL playback revokes object URLs after completion and cancellation.
- Transcript and audio-level updates are throttled.
- Error mapping from provider/main failures.

Renderer component tests:

- Voice button renders with correct labels/states.
- Disabled state appears when no active session is selected.
- Missing key state offers temporary in-memory key entry without persisting the value.
- Existing send and steer buttons still work.
- Mobile layout does not overflow.

Main process tests:

- Voice handlers validate payloads and return stable errors.
- Missing API key returns `missing-api-key`.
- Temporary API key is stored only in memory and can be cleared.
- Main process never includes the long-lived API key in responses.
- Realtime transcription session creation uses transcription-only session configuration.
- Realtime transcription session creation uses the current `type: "transcription"` and `audio.input.transcription` payload shape.
- TTS IPC runs through main process and rejects renderer-supplied ephemeral realtime secrets for REST TTS.
- TTS IPC enforces the 4096-character hard limit in main process.

Manual Electron checks:

- Microphone permission prompt appears and works in dev.
- Packaged macOS app includes microphone usage description and audio-input entitlement.
- Denied microphone permission produces the correct error.
- Realtime connection loss or network disablement stops capture and reports a recoverable error.
- Spoken response plays and stops on barge-in.
- CSP allows required voice traffic and does not permit unrelated navigation.

Required verification after implementation:

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run test
```

## Phasing

### Phase 1: Chained Full Voice Conversation

Build the full wrapper loop: OpenAI realtime transcription session, send/steer, stable turn-boundary detection, main-mediated buffered TTS, barge-in, temporary key entry, macOS microphone packaging support, UI, and tests. Assistant speech starts from cleaned final assistant messages after the session reaches a stable boundary.

### Phase 2: Lower-Latency Speech

Improve assistant speech latency by speaking stable response chunks as they stream instead of waiting for the full response boundary. This phase may use streaming REST TTS, Realtime-generated speech for already-authoritative text, or renderer-side chunking, but it must preserve selected-session authority. It requires careful duplicate/chunk tracking, stronger markdown-to-speech cleanup, and explicit push-event IPC or renderer-side chunking design.

### Phase 3: Realtime Tool Bridge Option

Add an optional realtime model front-end that can call a strict `send_to_session` tool and speak returned session output. This remains optional because it introduces another model into the conversation and can blur authority between the voice model and the selected session.

## Decisions

- Voice is session-scoped, not global.
- The selected CLI session owns answers.
- OpenAI is the first voice provider.
- Long-lived API keys never authenticate renderer-to-OpenAI calls. A temporary key may pass through renderer input only long enough to send it to main memory.
- Active-session voice ships before new-session voice.
- Auto-send is enabled for final speech transcripts in voice mode.
- Barge-in stops audio immediately and uses existing steer/interrupt behavior when the session is active.
- Phase 1 uses OpenAI realtime transcription sessions, not speech-to-speech sessions.
- Phase 1 TTS is main-process REST TTS with buffered audio, not renderer-authenticated REST calls.
- Phase 1 uses native WebRTC APIs in the renderer instead of relying on an SDK until Electron bundling is proven.
- Phase 1 supports one active voice session at a time.
- Realtime token refresh is handled by reconnecting once on expiry; long-lived background refresh is not part of Phase 1.

## Source References

- OpenAI audio guide: https://developers.openai.com/api/docs/guides/audio
- OpenAI Realtime WebRTC guide: https://platform.openai.com/docs/guides/realtime-webrtc
- OpenAI realtime transcription guide: https://developers.openai.com/api/docs/guides/realtime-transcription
- OpenAI Realtime VAD guide: https://platform.openai.com/docs/guides/realtime-vad
- Electron security guide: https://www.electronjs.org/docs/latest/tutorial/security
- Electron session permissions: https://www.electronjs.org/docs/latest/api/session
- Actual Claude voice integration: `/Users/suas/work/orchestrat0r/Actual Claude/hooks/useVoiceIntegration.tsx`
- Actual Claude voice service: `/Users/suas/work/orchestrat0r/Actual Claude/services/voice.ts`
- openclaw realtime voice types: `/Users/suas/work/orchestrat0r/openclaw/src/realtime-voice/provider-types.ts`
- openclaw OpenAI realtime provider: `/Users/suas/work/orchestrat0r/openclaw/extensions/openai/realtime-voice-provider.ts`

## Spec Self-Review

- Placeholder scan: no unresolved placeholders remain.
- Internal consistency: the architecture now explicitly uses renderer-side ephemeral WebRTC for transcription only and main-mediated REST TTS for speech output.
- Peer review changes: Claude and Gemini review feedback was incorporated for current transcription-session payload shape, realtime response suppression, TTS hard limits, transcript detachment, barge-in masking, token expiry, Realtime drop handling, REST TTS rationale, macOS env/key handling, packaging entitlements, no-push-IPC Phase 1 boundaries, timeouts, speech cleanup, and stable turn detection.
- Scope check: the first implementation remains a single bounded subsystem with explicit follow-up phases.
- Ambiguity check: provider, key handling, auto-send, barge-in, active-session scope, TTS delivery, and testing expectations are explicit.
