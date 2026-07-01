import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceIpcService } from './voice-ipc.service';
import type { VoiceLocalSttEvent } from '@contracts/schemas/voice';

describe('VoiceIpcService local STT IPC facade', () => {
  const unsubscribe = vi.fn();
  let originalElectronApiDescriptor: PropertyDescriptor | undefined;
  let localEventListener: ((event: VoiceLocalSttEvent) => void) | undefined;
  const api = {
    pushVoiceLocalSttChunk: vi.fn(),
    onVoiceLocalSttEvent: vi.fn((callback: (event: VoiceLocalSttEvent) => void) => {
      localEventListener = callback;
      return unsubscribe;
    }),
  };

  beforeEach(() => {
    originalElectronApiDescriptor = Object.getOwnPropertyDescriptor(window, 'electronAPI');
    vi.clearAllMocks();
    localEventListener = undefined;
    api.pushVoiceLocalSttChunk.mockResolvedValue({
      success: true,
      data: { accepted: true },
    });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: api,
    });

    TestBed.configureTestingModule({
      providers: [VoiceIpcService],
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    if (originalElectronApiDescriptor) {
      Object.defineProperty(window, 'electronAPI', originalElectronApiDescriptor);
    } else {
      delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    }
  });

  it('pushes local STT chunks through the typed preload API', async () => {
    const service = TestBed.inject(VoiceIpcService);

    await expect(service.pushLocalSttChunk({
      sessionId: 'local-session-1',
      seq: 7,
      wavBase64: 'UklGRg==',
      last: true,
    })).resolves.toEqual({ accepted: true });

    expect(api.pushVoiceLocalSttChunk).toHaveBeenCalledWith({
      sessionId: 'local-session-1',
      seq: 7,
      wavBase64: 'UklGRg==',
      last: true,
    });
  });

  it('subscribes to local STT events through the typed preload API', () => {
    const service = TestBed.inject(VoiceIpcService);
    const callback = vi.fn();

    const stop = service.onLocalSttEvent(callback);
    localEventListener?.({
      sessionId: 'local-session-1',
      kind: 'final',
      text: 'hello',
      segmentId: 7,
    });
    stop();

    expect(callback).toHaveBeenCalledWith({
      sessionId: 'local-session-1',
      kind: 'final',
      text: 'hello',
      segmentId: 7,
    });
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
