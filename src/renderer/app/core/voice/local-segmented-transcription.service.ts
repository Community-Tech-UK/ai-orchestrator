import { Injectable, NgZone, WritableSignal, inject, signal } from '@angular/core';
import { Subject } from 'rxjs';
import type {
  VoiceLocalSegmentedTranscriptionSession,
  VoiceLocalSttEvent,
} from '@contracts/schemas/voice';
import { VoiceIpcService } from '../services/ipc/voice-ipc.service';
import {
  AudioMeter,
  createAudioMeter,
  stopMediaStream,
} from './voice-audio-capture';
import {
  VoiceTranscriptEvent,
  VoiceTranscriptionConnection,
  VoiceTranscriptionError,
} from './realtime-transcription.service';

interface PcmCapture {
  stop(): void;
}

interface LocalConnectionState {
  closed: boolean;
  events: Subject<VoiceTranscriptEvent>;
  session: VoiceLocalSegmentedTranscriptionSession;
  level: WritableSignal<number>;
  meter: AudioMeter;
  stream: MediaStream;
  capture: PcmCapture;
  unsubscribeLocalEvents: () => void;
  pendingChunks: Float32Array[];
  pendingSampleCount: number;
  silenceSamples: number;
  speechActive: boolean;
  seq: number;
  sendQueue: Promise<void>;
}

const SCRIPT_PROCESSOR_BUFFER_SIZE = 4096;
const SILENCE_RMS_THRESHOLD = 0.012;
const MIN_SEGMENT_MS = 700;
const SILENCE_FLUSH_MS = 650;
const DEFAULT_MAX_SEGMENT_MS = 5000;
const WORKLET_NAME = 'aio-local-stt-pcm';

const WORKLET_SOURCE = `
class AioLocalSttPcmProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    const channel = input && input[0];
    if (channel && channel.length) {
      this.port.postMessage(channel.slice(0));
    }
    return true;
  }
}
registerProcessor('${WORKLET_NAME}', AioLocalSttPcmProcessor);
`;

@Injectable({ providedIn: 'root' })
export class LocalSegmentedTranscriptionService {
  private readonly voiceIpc = inject(VoiceIpcService);
  private readonly zone = inject(NgZone);

  async connect(
    session: VoiceLocalSegmentedTranscriptionSession,
    audioContext: AudioContext
  ): Promise<VoiceTranscriptionConnection> {
    const stream = await this.getMicrophoneStream();
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      stopMediaStream(stream);
      throw new VoiceTranscriptionError(
        'microphone-unavailable',
        'No usable microphone track is available.'
      );
    }

    const level = signal(0);
    const meter = createAudioMeter(audioContext, stream, level, this.zone);
    const events = new Subject<VoiceTranscriptEvent>();
    let state: LocalConnectionState | null = null;
    const capture = await this.createPcmCapture(audioContext, stream, (pcm) => {
      if (state) this.processPcm(state, pcm, audioContext.sampleRate);
    });
    const unsubscribeLocalEvents = this.voiceIpc.onLocalSttEvent((event) => {
      if (state) this.handleLocalSttEvent(state, event);
    });
    state = {
      closed: false,
      events,
      session,
      level,
      meter,
      stream,
      capture,
      unsubscribeLocalEvents,
      pendingChunks: [],
      pendingSampleCount: 0,
      silenceSamples: 0,
      speechActive: false,
      seq: 0,
      sendQueue: Promise.resolve(),
    };

    return {
      events: events.asObservable(),
      level,
      close: () => this.closeState(state),
    };
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

  private async createPcmCapture(
    audioContext: AudioContext,
    stream: MediaStream,
    onPcm: (pcm: Float32Array) => void
  ): Promise<PcmCapture> {
    const source = audioContext.createMediaStreamSource(stream);
    const silence = audioContext.createGain();
    silence.gain.value = 0;
    const worklet = await this.tryCreateWorkletCapture(audioContext, onPcm);
    if (worklet) {
      source.connect(worklet);
      worklet.connect(silence);
      silence.connect(audioContext.destination);
      return {
        stop: () => {
          source.disconnect();
          worklet.disconnect();
          silence.disconnect();
        },
      };
    }

    const processor = audioContext.createScriptProcessor(
      SCRIPT_PROCESSOR_BUFFER_SIZE,
      1,
      1
    );
    processor.onaudioprocess = (event) => onPcm(mixToMono(event.inputBuffer));
    source.connect(processor);
    processor.connect(silence);
    silence.connect(audioContext.destination);
    return {
      stop: () => {
        processor.onaudioprocess = null;
        source.disconnect();
        processor.disconnect();
        silence.disconnect();
      },
    };
  }

  private async tryCreateWorkletCapture(
    audioContext: AudioContext,
    onPcm: (pcm: Float32Array) => void
  ): Promise<AudioWorkletNode | null> {
    if (!audioContext.audioWorklet || typeof AudioWorkletNode === 'undefined') {
      return null;
    }
    try {
      const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      try {
        await audioContext.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const node = new AudioWorkletNode(audioContext, WORKLET_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      node.port.onmessage = (event: MessageEvent<Float32Array | number[]>) => {
        const data = event.data;
        onPcm(data instanceof Float32Array ? data : new Float32Array(data));
      };
      return node;
    } catch {
      return null;
    }
  }

  private processPcm(
    state: LocalConnectionState,
    pcm: Float32Array,
    sourceSampleRate: number
  ): void {
    if (state.closed) return;
    const sampleRate = state.session.sampleRate;
    const samples = downsamplePcm(pcm, sourceSampleRate, sampleRate);
    if (samples.length === 0) return;
    const rms = calculateRms(samples);
    this.zone.run(() => state.level.set(Math.min(1, rms * 3)));
    const voiced = rms >= SILENCE_RMS_THRESHOLD;
    if (voiced && !state.speechActive) {
      state.speechActive = true;
      state.silenceSamples = 0;
      this.zone.run(() => {
        state.events.next({ kind: 'speech-started', itemId: `local-${state.seq}` });
      });
    }
    if (!state.speechActive) return;

    state.pendingChunks.push(samples);
    state.pendingSampleCount += samples.length;
    state.silenceSamples = voiced ? 0 : state.silenceSamples + samples.length;

    const durationMs = samplesToMs(state.pendingSampleCount, sampleRate);
    const silenceMs = samplesToMs(state.silenceSamples, sampleRate);
    if (
      durationMs >= this.maxSegmentMs(state.session) ||
      (durationMs >= MIN_SEGMENT_MS && silenceMs >= SILENCE_FLUSH_MS)
    ) {
      this.flushSegment(state, false);
    }
  }

  private flushSegment(state: LocalConnectionState, last: boolean): void {
    if (state.pendingSampleCount === 0) return;
    const seq = state.seq;
    const pcm = concatPcm(state.pendingChunks, state.pendingSampleCount);
    state.pendingChunks = [];
    state.pendingSampleCount = 0;
    state.silenceSamples = 0;
    state.speechActive = false;
    state.seq += 1;
    this.zone.run(() => {
      state.events.next({ kind: 'speech-stopped', itemId: `local-${seq}` });
    });
    const wavBase64 = encodePcm16WavBase64(pcm, state.session.sampleRate);
    state.sendQueue = state.sendQueue.then(async () => {
      try {
        await this.voiceIpc.pushLocalSttChunk({
          sessionId: state.session.sessionId,
          seq,
          wavBase64,
          last,
        });
      } catch (error) {
        this.emitError(state, errorMessage(error));
      }
    });
  }

  private handleLocalSttEvent(
    state: LocalConnectionState,
    event: VoiceLocalSttEvent
  ): void {
    if (state.closed || event.sessionId !== state.session.sessionId) return;
    const itemId = event.segmentId === undefined ? undefined : `local-${event.segmentId}`;
    this.zone.run(() => {
      if (event.kind === 'final') {
        state.events.next({ kind: 'final', itemId, text: event.text ?? '' });
        return;
      }
      if (event.kind === 'partial') {
        state.events.next({ kind: 'partial', itemId, text: event.text ?? '' });
        return;
      }
      state.events.next({
        kind: 'error',
        itemId,
        error: event.error ?? 'Local speech-to-text failed.',
      });
    });
  }

  private closeState(state: LocalConnectionState): void {
    if (state.closed) return;
    state.closed = true;
    this.flushSegment(state, true);
    state.capture.stop();
    state.meter.stop();
    stopMediaStream(state.stream);
    state.unsubscribeLocalEvents();
    state.sendQueue.finally(() => this.zone.run(() => state.events.complete()));
  }

  private emitError(state: LocalConnectionState, error: string): void {
    if (state.closed) return;
    this.zone.run(() => state.events.next({ kind: 'error', error }));
  }

  private maxSegmentMs(session: VoiceLocalSegmentedTranscriptionSession): number {
    return session.maxSegmentMs ?? DEFAULT_MAX_SEGMENT_MS;
  }
}

export function downsamplePcm(
  input: Float32Array,
  sourceSampleRate: number,
  targetSampleRate: number
): Float32Array {
  if (sourceSampleRate <= 0 || targetSampleRate <= 0) return new Float32Array();
  if (sourceSampleRate === targetSampleRate) return input.slice();
  const ratio = sourceSampleRate / targetSampleRate;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    output[index] = input[Math.floor(index * ratio)] ?? 0;
  }
  return output;
}

export function encodePcm16WavBase64(pcm: Float32Array, sampleRate: number): string {
  const dataSize = pcm.length * 2;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(bytes, 8, 'WAVE');
  writeAscii(bytes, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(bytes, 36, 'data');
  view.setUint32(40, dataSize, true);
  for (let index = 0; index < pcm.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, pcm[index] ?? 0));
    view.setInt16(
      44 + index * 2,
      sample < 0 ? sample * 32768 : sample * 32767,
      true
    );
  }
  return bytesToBase64(bytes);
}

function mixToMono(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels <= 1) return buffer.getChannelData(0).slice();
  const output = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < output.length; index += 1) {
      output[index] += (data[index] ?? 0) / buffer.numberOfChannels;
    }
  }
  return output;
}

function concatPcm(chunks: Float32Array[], totalLength: number): Float32Array {
  const output = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function calculateRms(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

function samplesToMs(samples: number, sampleRate: number): number {
  return (samples / sampleRate) * 1000;
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Local speech-to-text failed.';
}
