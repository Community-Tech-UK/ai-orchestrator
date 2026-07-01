import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { VoiceIpcService } from '../services/ipc/voice-ipc.service';
import type { VoiceLocalSttEvent } from '@contracts/schemas/voice';
import {
  downsamplePcm,
  encodePcm16WavBase64,
  LocalSegmentedTranscriptionService,
} from './local-segmented-transcription.service';

class FakeAudioContext {
  readonly sampleRate = 48000;
  readonly destination = {};
  readonly createdProcessors: FakeScriptProcessorNode[] = [];
  createMediaStreamSource = vi.fn(() => fakeAudioNode());
  createAnalyser = vi.fn(() => ({
    fftSize: 0,
    frequencyBinCount: 8,
    getByteTimeDomainData: (data: Uint8Array) => data.fill(128),
    disconnect: vi.fn(),
  }));
  createGain = vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }));
  createScriptProcessor = vi.fn(() => {
    const processor = new FakeScriptProcessorNode();
    this.createdProcessors.push(processor);
    return processor;
  });
}

class FakeScriptProcessorNode {
  onaudioprocess: ((event: AudioProcessingEvent) => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
}

function fakeAudioNode() {
  return { connect: vi.fn(), disconnect: vi.fn() };
}

function makeMediaStream(): MediaStream {
  return {
    getAudioTracks: () => [{ stop: vi.fn() }],
    getTracks: () => [{ stop: vi.fn() }],
  } as unknown as MediaStream;
}

function audioEvent(samples: Float32Array): AudioProcessingEvent {
  return {
    inputBuffer: {
      numberOfChannels: 1,
      getChannelData: () => samples,
    },
  } as unknown as AudioProcessingEvent;
}

describe('LocalSegmentedTranscriptionService', () => {
  let mediaDevicesDescriptor: PropertyDescriptor | undefined;
  let localEventListener: ((event: VoiceLocalSttEvent) => void) | undefined;
  let voiceIpc: {
    pushLocalSttChunk: ReturnType<typeof vi.fn>;
    onLocalSttEvent: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mediaDevicesDescriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => makeMediaStream()) },
    });
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    localEventListener = undefined;
    voiceIpc = {
      pushLocalSttChunk: vi.fn(async () => ({ accepted: true })),
      onLocalSttEvent: vi.fn((callback: (event: VoiceLocalSttEvent) => void) => {
        localEventListener = callback;
        return vi.fn();
      }),
    };
    TestBed.configureTestingModule({
      providers: [
        LocalSegmentedTranscriptionService,
        { provide: VoiceIpcService, useValue: voiceIpc },
      ],
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    if (mediaDevicesDescriptor) {
      Object.defineProperty(navigator, 'mediaDevices', mediaDevicesDescriptor);
    } else {
      delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('downsamples PCM to the local STT session sample rate', () => {
    const input = new Float32Array([0, 0.25, 0.5, 0.75, 1, -1]);

    const output = downsamplePcm(input, 48000, 16000);

    expect(Array.from(output)).toEqual([0, 0.75]);
  });

  it('encodes mono PCM as a 16 kHz 16-bit WAV payload', () => {
    const wavBase64 = encodePcm16WavBase64(new Float32Array([0, 1, -1]), 16000);
    const bytes = Uint8Array.from(atob(wavBase64), (char) => char.charCodeAt(0));
    const view = new DataView(bytes.buffer);

    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(bytes.slice(8, 12))).toBe('WAVE');
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(32767);
    expect(view.getInt16(48, true)).toBe(-32768);
  });

  it('segments speech on silence and sends ordered WAV chunks through IPC', async () => {
    const service = TestBed.inject(LocalSegmentedTranscriptionService);
    const audioContext = new FakeAudioContext() as unknown as AudioContext;

    const connection = await service.connect({
      transport: 'local-segmented',
      sessionId: 'local-session-1',
      model: 'distil-large-v3',
      providerId: 'local-whisper',
      sampleRate: 16000,
      maxSegmentMs: 5000,
      language: 'en',
      task: 'transcribe',
    }, audioContext);
    const firstEvent = firstValueFrom(connection.events);
    const receivedEvents: unknown[] = [];
    const subscription = connection.events.subscribe((event) => receivedEvents.push(event));
    const processor = (audioContext as unknown as FakeAudioContext).createdProcessors[0];

    processor.onaudioprocess?.(audioEvent(new Float32Array(48000).fill(0.08)));
    processor.onaudioprocess?.(audioEvent(new Float32Array(48000).fill(0)));
    await Promise.resolve();
    localEventListener?.({
      sessionId: 'local-session-1',
      kind: 'final',
      text: 'hello local worker',
      segmentId: 0,
    });

    expect(await firstEvent).toEqual({ kind: 'speech-started', itemId: 'local-0' });
    expect(voiceIpc.pushLocalSttChunk).toHaveBeenCalledWith({
      sessionId: 'local-session-1',
      seq: 0,
      wavBase64: expect.stringMatching(/^UklGR/),
      last: false,
    });
    expect(receivedEvents).toContainEqual({
      kind: 'final',
      itemId: 'local-0',
      text: 'hello local worker',
    });
    expect(connection.level()).toBeGreaterThanOrEqual(0);
    subscription.unsubscribe();
    connection.close();
  });
});
