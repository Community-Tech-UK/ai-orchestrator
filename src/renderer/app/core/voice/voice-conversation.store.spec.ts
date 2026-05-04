import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceIpcService } from '../services/ipc/voice-ipc.service';
import type { OutputMessage } from '../state/instance/instance.types';
import {
  RealtimeTranscriptionService,
  type VoiceTranscriptEvent,
  type VoiceTranscriptionConnection,
} from './realtime-transcription.service';
import { VoiceConversationStore } from './voice-conversation.store';
import { VoicePlaybackService } from './voice-playback.service';

class FakeAudioContext {
  resume = vi.fn(async () => undefined);
  close = vi.fn(async () => undefined);
}

interface StoreHarness {
  store: VoiceConversationStore;
  events: Subject<VoiceTranscriptEvent>;
  sendInput: ReturnType<typeof vi.fn>;
  steerInput: ReturnType<typeof vi.fn>;
  closeConnection: ReturnType<typeof vi.fn>;
  voiceIpc: {
    getStatus: ReturnType<typeof vi.fn>;
    createTranscriptionSession: ReturnType<typeof vi.fn>;
    closeTranscriptionSession: ReturnType<typeof vi.fn>;
    synthesizeSpeech: ReturnType<typeof vi.fn>;
    cancelSpeech: ReturnType<typeof vi.fn>;
  };
}

function message(
  id: string,
  type: OutputMessage['type'],
  content: string
): OutputMessage {
  return {
    id,
    timestamp: 1,
    type,
    content,
  };
}

function createHarness(status: StoreHarnessContextStatus = 'idle'): StoreHarness {
  const events = new Subject<VoiceTranscriptEvent>();
  const closeConnection = vi.fn();
  const connection: VoiceTranscriptionConnection = {
    events: events.asObservable(),
    level: signal(0),
    close: closeConnection,
  };
  const voiceIpc = {
    getStatus: vi.fn(async () => ({
      available: true,
      keySource: 'temporary' as const,
      canConfigureTemporaryKey: true,
      activeTranscriptionProviderId: 'openai-realtime',
      activeTtsProviderId: 'local-macos-say',
      providers: [
        {
          id: 'openai-realtime',
          label: 'OpenAI Realtime STT',
          source: 'cloud' as const,
          capabilities: ['stt' as const],
          available: true,
          configured: true,
          active: true,
          privacy: 'provider-cloud' as const,
        },
        {
          id: 'local-macos-say',
          label: 'macOS Local Voice',
          source: 'local' as const,
          capabilities: ['tts' as const],
          available: true,
          configured: true,
          active: true,
          privacy: 'local' as const,
        },
      ],
    })),
    createTranscriptionSession: vi.fn(async () => ({
      sessionId: 'voice-session-1',
      clientSecret: 'ephemeral-client-secret',
      model: 'gpt-4o-transcribe',
    })),
    closeTranscriptionSession: vi.fn(async () => true),
    synthesizeSpeech: vi.fn(async () => ({
      requestId: 'tts-1',
      audioBase64: 'AA==',
      mimeType: 'audio/wav',
      format: 'wav' as const,
      providerId: 'local-macos-say',
      local: true,
    })),
    cancelSpeech: vi.fn(async () => true),
  };
  const transcription = {
    connect: vi.fn(async () => connection),
  };
  const playback = {
    stop: vi.fn(),
    play: vi.fn(async () => undefined),
  };

  TestBed.configureTestingModule({
    providers: [
      VoiceConversationStore,
      { provide: VoiceIpcService, useValue: voiceIpc },
      { provide: RealtimeTranscriptionService, useValue: transcription },
      { provide: VoicePlaybackService, useValue: playback },
    ],
  });

  const sendInput = vi.fn();
  const steerInput = vi.fn();
  const store = TestBed.inject(VoiceConversationStore);
  store.updateContext({
    instanceId: 'instance-1',
    status,
    messages: [],
    provider: 'claude',
    sendInput,
    steerInput,
  });

  return {
    store,
    events,
    sendInput,
    steerInput,
    closeConnection,
    voiceIpc,
  };
}

type StoreHarnessContextStatus =
  | 'idle'
  | 'ready'
  | 'waiting_for_input'
  | 'busy'
  | 'failed';

describe('VoiceConversationStore', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    vi.stubGlobal('AudioContext', FakeAudioContext);
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      value: FakeAudioContext,
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sends final voice transcripts to idle sessions', async () => {
    const harness = createHarness('idle');

    await harness.store.start({
      instanceId: 'instance-1',
      status: 'idle',
      messages: [],
      provider: 'claude',
      sendInput: harness.sendInput,
      steerInput: harness.steerInput,
    });
    harness.events.next({ kind: 'final', text: '  hello session  ' });

    expect(harness.sendInput).toHaveBeenCalledWith('hello session');
    expect(harness.steerInput).not.toHaveBeenCalled();
    expect(harness.store.mode()).toBe('waiting-for-session');
  });

  it('steers final voice transcripts while a session is actively working', async () => {
    const harness = createHarness('busy');

    await harness.store.start({
      instanceId: 'instance-1',
      status: 'busy',
      messages: [],
      provider: 'claude',
      sendInput: harness.sendInput,
      steerInput: harness.steerInput,
    });
    harness.events.next({ kind: 'final', text: 'take a narrower path' });

    expect(harness.steerInput).toHaveBeenCalledWith('take a narrower path');
    expect(harness.sendInput).not.toHaveBeenCalled();
  });

  it('does not send detached transcripts after manual composer edits', async () => {
    const harness = createHarness('idle');

    await harness.store.start({
      instanceId: 'instance-1',
      status: 'idle',
      messages: [],
      provider: 'claude',
      sendInput: harness.sendInput,
      steerInput: harness.steerInput,
    });
    harness.events.next({ kind: 'partial', text: 'voice draft' });
    harness.store.detachTranscript();
    harness.events.next({ kind: 'final', text: 'voice draft' });

    expect(harness.sendInput).not.toHaveBeenCalled();
    expect(harness.steerInput).not.toHaveBeenCalled();
    expect(harness.store.mode()).toBe('listening');
  });

  it('fails closed instead of routing voice transcripts into terminal sessions', async () => {
    const harness = createHarness('failed');

    await harness.store.start({
      instanceId: 'instance-1',
      status: 'failed',
      messages: [],
      provider: 'claude',
      sendInput: harness.sendInput,
      steerInput: harness.steerInput,
    });
    harness.events.next({ kind: 'final', text: 'are you there' });

    expect(harness.sendInput).not.toHaveBeenCalled();
    expect(harness.steerInput).not.toHaveBeenCalled();
    expect(harness.store.mode()).toBe('error');
    expect(harness.store.errorCode()).toBe('session-unavailable');
  });

  it('releases the main-process transcription session on stop', async () => {
    const harness = createHarness('idle');

    await harness.store.start({
      instanceId: 'instance-1',
      status: 'idle',
      messages: [],
      provider: 'claude',
      sendInput: harness.sendInput,
      steerInput: harness.steerInput,
    });
    harness.store.stop();
    await Promise.resolve();

    expect(harness.closeConnection).toHaveBeenCalled();
    expect(harness.voiceIpc.closeTranscriptionSession).toHaveBeenCalledWith('voice-session-1');
  });

  it('speaks the latest assistant message after the session returns to idle', async () => {
    vi.useFakeTimers();
    const harness = createHarness('idle');

    await harness.store.start({
      instanceId: 'instance-1',
      status: 'idle',
      messages: [],
      provider: 'claude',
      sendInput: harness.sendInput,
      steerInput: harness.steerInput,
    });

    harness.store.updateContext({
      instanceId: 'instance-1',
      status: 'idle',
      messages: [message('assistant-1', 'assistant', 'Done with the task.')],
      provider: 'claude',
      sendInput: harness.sendInput,
      steerInput: harness.steerInput,
    });
    await vi.advanceTimersByTimeAsync(701);

    expect(harness.voiceIpc.synthesizeSpeech).toHaveBeenCalledWith(
      expect.objectContaining({
        input: 'Done with the task.',
        model: 'gpt-4o-mini-tts',
        providerId: 'local-macos-say',
        format: 'wav',
      }),
    );
  });

  it('does not speak assistant messages that existed before voice started', async () => {
    vi.useFakeTimers();
    const harness = createHarness('idle');
    const existing = [message('assistant-before', 'assistant', 'Already said.')];

    await harness.store.start({
      instanceId: 'instance-1',
      status: 'idle',
      messages: existing,
      provider: 'claude',
      sendInput: harness.sendInput,
      steerInput: harness.steerInput,
    });
    harness.store.updateContext({
      instanceId: 'instance-1',
      status: 'idle',
      messages: existing,
      provider: 'claude',
      sendInput: harness.sendInput,
      steerInput: harness.steerInput,
    });
    await vi.advanceTimersByTimeAsync(701);

    expect(harness.voiceIpc.synthesizeSpeech).not.toHaveBeenCalled();
  });

  it('does not speak code-only assistant output and speaks each message once', async () => {
    vi.useFakeTimers();
    const harness = createHarness('idle');

    await harness.store.start({
      instanceId: 'instance-1',
      status: 'idle',
      messages: [],
      provider: 'claude',
      sendInput: harness.sendInput,
      steerInput: harness.steerInput,
    });
    const messages = [
      message('assistant-code', 'assistant', '```ts\nconsole.log("skip");\n```'),
      message('assistant-final', 'assistant', 'Plain answer.'),
    ];
    harness.store.updateContext({
      instanceId: 'instance-1',
      status: 'idle',
      messages,
      provider: 'claude',
      sendInput: harness.sendInput,
      steerInput: harness.steerInput,
    });
    await vi.advanceTimersByTimeAsync(701);
    harness.store.updateContext({
      instanceId: 'instance-1',
      status: 'idle',
      messages,
      provider: 'claude',
      sendInput: harness.sendInput,
      steerInput: harness.steerInput,
    });
    await vi.advanceTimersByTimeAsync(701);

    expect(harness.voiceIpc.synthesizeSpeech).toHaveBeenCalledTimes(1);
    expect(harness.voiceIpc.synthesizeSpeech).toHaveBeenCalledWith(expect.objectContaining({
      input: 'Plain answer.',
    }));
  });

  it('credential expiry reconnects once and connection loss stops capture with a recoverable error', async () => {
    const harness = createHarness('idle');

    await harness.store.start({
      instanceId: 'instance-1',
      status: 'idle',
      messages: [],
      provider: 'claude',
      sendInput: harness.sendInput,
      steerInput: harness.steerInput,
    });
    harness.events.next({ kind: 'partial', text: 'unsent' });
    harness.events.next({ kind: 'credential-expired' });
    for (let index = 0; index < 5; index += 1) {
      await Promise.resolve();
    }

    expect(harness.voiceIpc.createTranscriptionSession).toHaveBeenCalledTimes(2);
    expect(harness.voiceIpc.createTranscriptionSession).toHaveBeenCalledWith({
      model: 'gpt-4o-transcribe',
      providerId: 'openai-realtime',
    });
    expect(harness.store.partialTranscript()).toBe('unsent');

    harness.events.next({ kind: 'connection-lost', error: 'network down' });
    expect(harness.store.mode()).toBe('error');
    expect(harness.store.errorCode()).toBe('voice-connection-lost');
    expect(harness.closeConnection).toHaveBeenCalled();
  });
});
