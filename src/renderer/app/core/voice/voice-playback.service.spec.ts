import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoicePlaybackService } from './voice-playback.service';

class FakeAudio {
  static instances: FakeAudio[] = [];
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  pause = vi.fn();
  play = vi.fn(async () => undefined);
  src = '';

  constructor(src: string) {
    this.src = src;
    FakeAudio.instances.push(this);
  }
}

describe('VoicePlaybackService', () => {
  let service: VoicePlaybackService;
  let revokeObjectURL: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    FakeAudio.instances = [];
    revokeObjectURL = vi.fn();
    vi.stubGlobal('Audio', FakeAudio);
    vi.stubGlobal('atob', (value: string) => Buffer.from(value, 'base64').toString('binary'));
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:voice-audio'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectURL,
    });
    TestBed.configureTestingModule({ providers: [VoicePlaybackService] });
    service = TestBed.inject(VoicePlaybackService);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('plays a Blob URL and revokes it when playback ends', async () => {
    await service.play({
      requestId: 'tts-1',
      audioBase64: 'AA==',
      mimeType: 'audio/mpeg',
      format: 'mp3',
    }, 'hello');

    expect(service.isPlaying()).toBe(true);
    FakeAudio.instances[0]!.onended?.();

    expect(service.isPlaying()).toBe(false);
    expect(service.currentText()).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:voice-audio');
  });

  it('stops active audio and revokes the current Blob URL', async () => {
    await service.play({
      requestId: 'tts-1',
      audioBase64: 'AA==',
      mimeType: 'audio/mpeg',
      format: 'mp3',
    }, 'hello');

    service.stop();

    expect(FakeAudio.instances[0]!.pause).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:voice-audio');
    expect(service.isPlaying()).toBe(false);
  });
});
