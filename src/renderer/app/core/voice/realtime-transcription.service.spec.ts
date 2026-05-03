import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RealtimeTranscriptionService,
  VoiceTranscriptionError,
  type VoiceTranscriptEvent,
} from './realtime-transcription.service';

class FakeDataChannel {
  readyState: RTCDataChannelState = 'open';
  onmessage: ((this: RTCDataChannel, ev: MessageEvent<string>) => void) | null = null;
  onclose: ((this: RTCDataChannel, ev: Event) => void) | null = null;

  close(): void {
    this.readyState = 'closed';
    this.onclose?.call(this as unknown as RTCDataChannel, new Event('close'));
  }
}

class FakePeerConnection {
  static last: FakePeerConnection | null = null;

  iceConnectionState: RTCIceConnectionState = 'connected';
  oniceconnectionstatechange: ((this: RTCPeerConnection, ev: Event) => void) | null = null;
  readonly channel = new FakeDataChannel();
  private readonly iceListeners = new Set<(event: Event) => void>();

  constructor() {
    FakePeerConnection.last = this;
  }

  addTrack = vi.fn();
  createDataChannel = vi.fn(() => this.channel as unknown as RTCDataChannel);
  createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'offer-sdp' }) as RTCSessionDescriptionInit);
  setLocalDescription = vi.fn(async () => undefined);
  setRemoteDescription = vi.fn(async () => undefined);
  close = vi.fn();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type !== 'iceconnectionstatechange') return;
    this.iceListeners.add((event) => {
      if (typeof listener === 'function') {
        listener.call(this as unknown as RTCPeerConnection, event);
        return;
      }
      listener.handleEvent(event);
    });
  }

  removeEventListener(type: string): void {
    if (type === 'iceconnectionstatechange') {
      this.iceListeners.clear();
    }
  }

  emitIceState(): void {
    const event = new Event('iceconnectionstatechange');
    this.oniceconnectionstatechange?.call(this as unknown as RTCPeerConnection, event);
    for (const listener of this.iceListeners) {
      listener(event);
    }
  }
}

function createAudioContext(): AudioContext {
  const source = {
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  const analyser = {
    fftSize: 0,
    frequencyBinCount: 1,
    getByteTimeDomainData: vi.fn((data: Uint8Array) => {
      data[0] = 128;
    }),
    disconnect: vi.fn(),
  };
  return {
    createMediaStreamSource: vi.fn(() => source),
    createAnalyser: vi.fn(() => analyser),
  } as unknown as AudioContext;
}

function createMediaStream(): { stream: MediaStream; trackStop: ReturnType<typeof vi.fn> } {
  const trackStop = vi.fn();
  const track = { stop: trackStop };
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  return { stream, trackStop };
}

describe('RealtimeTranscriptionService', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    FakePeerConnection.last = null;
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(),
      },
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rejects untrusted SDP exchange URLs before sending the ephemeral secret', async () => {
    const { stream, trackStop } = createMediaStream();
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(stream);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const service = TestBed.inject(RealtimeTranscriptionService);

    await expect(service.connect({
      sessionId: 'voice-session-1',
      clientSecret: 'ephemeral-client-secret',
      model: 'gpt-4o-transcribe',
      sdpUrl: 'https://attacker.example/realtime',
    }, createAudioContext())).rejects.toMatchObject({
      code: 'provider-session-failed',
      message: 'Realtime SDP endpoint is not trusted.',
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(trackStop).toHaveBeenCalled();
  });

  it('debounces transient ICE disconnected states and emits only after the grace period', async () => {
    vi.useFakeTimers();
    const { stream } = createMediaStream();
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(stream);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('answer-sdp', { status: 200 })));
    const service = TestBed.inject(RealtimeTranscriptionService);

    const connection = await service.connect({
      sessionId: 'voice-session-1',
      clientSecret: 'ephemeral-client-secret',
      model: 'gpt-4o-transcribe',
    }, createAudioContext());
    const emitted: VoiceTranscriptEvent[] = [];
    connection.events.subscribe((event) => emitted.push(event));
    const peer = FakePeerConnection.last;
    expect(peer).not.toBeNull();

    peer!.iceConnectionState = 'disconnected';
    peer!.emitIceState();
    await vi.advanceTimersByTimeAsync(3999);
    expect(emitted).toEqual([]);

    peer!.iceConnectionState = 'connected';
    peer!.emitIceState();
    await vi.advanceTimersByTimeAsync(10);
    expect(emitted).toEqual([]);

    peer!.iceConnectionState = 'disconnected';
    peer!.emitIceState();
    await vi.advanceTimersByTimeAsync(4000);
    expect(emitted).toEqual([
      { kind: 'connection-lost', error: 'WebRTC disconnected.' },
    ]);
    connection.close();
  });

  it('maps denied microphone permission to the expected voice error code', async () => {
    vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValue(
      new DOMException('denied', 'NotAllowedError')
    );
    const service = TestBed.inject(RealtimeTranscriptionService);

    await expect(service.connect({
      sessionId: 'voice-session-1',
      clientSecret: 'ephemeral-client-secret',
      model: 'gpt-4o-transcribe',
    }, createAudioContext())).rejects.toBeInstanceOf(VoiceTranscriptionError);
    await expect(service.connect({
      sessionId: 'voice-session-1',
      clientSecret: 'ephemeral-client-secret',
      model: 'gpt-4o-transcribe',
    }, createAudioContext())).rejects.toMatchObject({
      code: 'microphone-denied',
    });
  });
});
