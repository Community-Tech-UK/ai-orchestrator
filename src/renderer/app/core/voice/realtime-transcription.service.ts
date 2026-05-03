import {
  Injectable,
  NgZone,
  Signal,
  WritableSignal,
  inject,
  signal,
} from '@angular/core';
import { Observable, Subject } from 'rxjs';
import type { VoiceTranscriptionSession } from '@contracts/schemas/voice';
import type { VoiceErrorCode } from '../../../../shared/types/voice.types';

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

export class VoiceTranscriptionError extends Error {
  constructor(
    public readonly code: VoiceErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'VoiceTranscriptionError';
  }
}

interface AudioMeter {
  stop(): void;
}

interface ConnectionState {
  closed: boolean;
  disconnectTimer: ReturnType<typeof setTimeout> | null;
}

const SDP_EXCHANGE_TIMEOUT_MS = 15000;
const ICE_CONNECTION_TIMEOUT_MS = 15000;

@Injectable({ providedIn: 'root' })
export class RealtimeTranscriptionService {
  private readonly zone = inject(NgZone);

  async connect(
    session: VoiceTranscriptionSession,
    audioContext: AudioContext
  ): Promise<VoiceTranscriptionConnection> {
    const stream = await this.getMicrophoneStream();
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      this.stopStream(stream);
      throw new VoiceTranscriptionError(
        'microphone-unavailable',
        'No usable microphone track is available.'
      );
    }

    const level = signal(0);
    const meter = this.createAudioMeter(audioContext, stream, level);
    const peer = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });

    for (const track of audioTracks) {
      peer.addTrack(track, stream);
    }

    const channel = peer.createDataChannel('oai-events');
    const events = new Subject<VoiceTranscriptEvent>();
    const state: ConnectionState = { closed: false, disconnectTimer: null };
    channel.onmessage = (message) =>
      this.zone.run(() => this.handleRealtimeEvent(message.data, events));
    channel.onclose = () =>
      this.zone.run(() => {
        if (state.closed) return;
        events.next({
          kind: 'connection-lost',
          error: 'Realtime data channel closed.',
        });
      });
    peer.oniceconnectionstatechange = () => {
      if (state.closed) return;
      if (peer.iceConnectionState === 'connected' || peer.iceConnectionState === 'completed') {
        this.clearDisconnectTimer(state);
        return;
      }
      if (peer.iceConnectionState === 'disconnected') {
        this.clearDisconnectTimer(state);
        state.disconnectTimer = setTimeout(() => {
          if (state.closed || peer.iceConnectionState !== 'disconnected') return;
          this.zone.run(() => {
            events.next({
              kind: 'connection-lost',
              error: 'WebRTC disconnected.',
            });
          });
        }, 4000);
        return;
      }
      if (peer.iceConnectionState === 'failed') {
        this.clearDisconnectTimer(state);
        this.zone.run(() => {
          events.next({
            kind: 'connection-lost',
            error: `WebRTC ${peer.iceConnectionState}.`,
          });
        });
      }
    };

    try {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const answerSdp = await this.exchangeOfferForAnswer(
        session.clientSecret,
        offer.sdp ?? '',
        session.sdpUrl
      );
      await peer.setRemoteDescription({ type: 'answer', sdp: answerSdp });
      await this.waitForIceConnection(peer, state);
    } catch (error) {
      state.closed = true;
      this.clearDisconnectTimer(state);
      meter.stop();
      this.stopStream(stream);
      peer.close();
      throw error;
    }

    return this.createConnection(peer, stream, channel, events, level, meter, state);
  }

  private async getMicrophoneStream(): Promise<MediaStream> {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotAllowedError') {
        throw new VoiceTranscriptionError(
          'microphone-denied',
          'Microphone permission was denied.'
        );
      }
      if (error instanceof DOMException && error.name === 'NotFoundError') {
        throw new VoiceTranscriptionError(
          'microphone-unavailable',
          'No microphone is available.'
        );
      }
      throw error;
    }
  }

  private createConnection(
    peer: RTCPeerConnection,
    stream: MediaStream,
    channel: RTCDataChannel,
    events: Subject<VoiceTranscriptEvent>,
    level: WritableSignal<number>,
    meter: AudioMeter,
    state: ConnectionState
  ): VoiceTranscriptionConnection {
    return {
      events: events.asObservable(),
      level,
      close: () => {
        if (state.closed) return;
        state.closed = true;
        this.clearDisconnectTimer(state);
        meter.stop();
        this.stopStream(stream);
        if (channel.readyState !== 'closed') channel.close();
        peer.close();
        events.complete();
      },
    };
  }

  private async exchangeOfferForAnswer(
    clientSecret: string,
    sdp: string,
    sdpUrl = 'https://api.openai.com/v1/realtime/calls'
  ): Promise<string> {
    this.assertAllowedSdpUrl(sdpUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SDP_EXCHANGE_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(sdpUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${clientSecret}`,
          'Content-Type': 'application/sdp',
        },
        body: sdp,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new VoiceTranscriptionError(
          'provider-session-failed',
          'Realtime SDP exchange timed out.'
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new VoiceTranscriptionError(
          'voice-credential-expired',
          `Realtime connection failed (${response.status}).`
        );
      }
      throw new VoiceTranscriptionError(
        'provider-session-failed',
        `Realtime connection failed (${response.status}).`
      );
    }
    return response.text();
  }

  private waitForIceConnection(
    peer: RTCPeerConnection,
    state: ConnectionState
  ): Promise<void> {
    if (peer.iceConnectionState === 'connected' || peer.iceConnectionState === 'completed') {
      return Promise.resolve();
    }
    if (peer.iceConnectionState === 'failed') {
      return Promise.reject(new VoiceTranscriptionError(
        'voice-connection-lost',
        `WebRTC ${peer.iceConnectionState}.`
      ));
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new VoiceTranscriptionError(
          'voice-connection-lost',
          'WebRTC connection timed out.'
        ));
      }, ICE_CONNECTION_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timeout);
        peer.removeEventListener('iceconnectionstatechange', onStateChange);
      };

      const onStateChange = () => {
        if (state.closed) {
          cleanup();
          resolve();
          return;
        }
        if (peer.iceConnectionState === 'connected' || peer.iceConnectionState === 'completed') {
          cleanup();
          resolve();
          return;
        }
        if (peer.iceConnectionState === 'failed') {
          cleanup();
          reject(new VoiceTranscriptionError(
            'voice-connection-lost',
            `WebRTC ${peer.iceConnectionState}.`
          ));
        }
      };

      peer.addEventListener('iceconnectionstatechange', onStateChange);
    });
  }

  private assertAllowedSdpUrl(sdpUrl: string): void {
    try {
      const url = new URL(sdpUrl);
      if (url.protocol === 'https:' && url.hostname.endsWith('.openai.com')) {
        return;
      }
    } catch {
      // Fall through to the typed error below.
    }

    throw new VoiceTranscriptionError(
      'provider-session-failed',
      'Realtime SDP endpoint is not trusted.'
    );
  }

  private clearDisconnectTimer(state: ConnectionState): void {
    if (!state.disconnectTimer) return;
    clearTimeout(state.disconnectTimer);
    state.disconnectTimer = null;
  }

  private createAudioMeter(
    audioContext: AudioContext,
    stream: MediaStream,
    level: WritableSignal<number>
  ): AudioMeter {
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

  private handleRealtimeEvent(
    rawData: string,
    events: Subject<VoiceTranscriptEvent>
  ): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(rawData) as Record<string, unknown>;
    } catch {
      events.next({ kind: 'error', error: 'Invalid realtime event.' });
      return;
    }

    const type = event['type'];
    const itemId = this.stringValue(event['item_id']);
    if (type === 'conversation.item.input_audio_transcription.delta') {
      events.next({
        kind: 'partial',
        itemId,
        text: this.extractTranscriptDelta(event),
      });
      return;
    }

    if (type === 'conversation.item.input_audio_transcription.completed') {
      events.next({
        kind: 'final',
        itemId,
        text: this.stringValue(event['transcript']),
      });
      return;
    }

    if (type === 'input_audio_buffer.speech_started') {
      events.next({ kind: 'speech-started', itemId });
      return;
    }

    if (type === 'input_audio_buffer.speech_stopped') {
      events.next({ kind: 'speech-stopped', itemId });
      return;
    }

    if (type === 'error') {
      const message = this.extractErrorMessage(event);
      events.next({
        kind: /expired|unauthori[sz]ed|forbidden|credential/i.test(message)
          ? 'credential-expired'
          : 'error',
        error: message,
      });
    }
  }

  private extractTranscriptDelta(event: Record<string, unknown>): string {
    const delta = event['delta'];
    if (typeof delta === 'string') return delta;
    if (delta && typeof delta === 'object') {
      const transcript = (delta as Record<string, unknown>)['transcript'];
      if (typeof transcript === 'string') return transcript;
    }
    return '';
  }

  private extractErrorMessage(event: Record<string, unknown>): string {
    const error = event['error'];
    if (error && typeof error === 'object') {
      const message = (error as Record<string, unknown>)['message'];
      if (typeof message === 'string') return message;
    }
    return 'Realtime transcription failed.';
  }

  private stringValue(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
  }

  private stopStream(stream: MediaStream): void {
    for (const track of stream.getTracks()) {
      track.stop();
    }
  }
}
