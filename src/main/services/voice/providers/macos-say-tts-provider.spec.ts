import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MacosSayTtsProvider } from './macos-say-tts-provider';

function createChild() {
  const child = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
  child.kill = vi.fn();
  return child;
}

describe('MacosSayTtsProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports unavailable outside macOS', () => {
    const provider = new MacosSayTtsProvider({
      platform: 'linux',
      exists: () => true,
    });

    expect(provider.getStatus()).toMatchObject({
      id: 'local-macos-say',
      available: false,
      configured: false,
      privacy: 'local',
      reason: 'macOS local voice requires macOS.',
    });
  });

  it('synthesizes WAV audio with say and afconvert and cleans the temp directory', async () => {
    const calls: { command: string; args: string[] }[] = [];
    const removePath = vi.fn(async () => undefined);
    const spawnProcess = vi.fn((command: string, args: string[]) => {
      calls.push({ command, args });
      const child = createChild();
      queueMicrotask(() => child.emit('exit', 0, null));
      return child as never;
    });
    const provider = new MacosSayTtsProvider({
      platform: 'darwin',
      exists: () => true,
      spawnProcess,
      makeTempDir: vi.fn(async () => '/tmp/ai-orchestrator-voice-test'),
      readFile: vi.fn(async () => Buffer.from('RIFF')),
      removePath,
      tempRoot: () => '/tmp',
    });

    await expect(provider.synthesize({
      requestId: 'tts-local',
      input: 'hello local',
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      format: 'wav',
    })).resolves.toMatchObject({
      requestId: 'tts-local',
      audioBase64: Buffer.from('RIFF').toString('base64'),
      mimeType: 'audio/wav',
      format: 'wav',
      providerId: 'local-macos-say',
      local: true,
    });

    expect(calls).toEqual([
      {
        command: '/usr/bin/say',
        args: ['-o', '/tmp/ai-orchestrator-voice-test/tts-local.aiff', 'hello local'],
      },
      {
        command: '/usr/bin/afconvert',
        args: [
          '/tmp/ai-orchestrator-voice-test/tts-local.aiff',
          '/tmp/ai-orchestrator-voice-test/tts-local.wav',
          '-f',
          'WAVE',
          '-d',
          'LEI16@24000',
        ],
      },
    ]);
    expect(removePath).toHaveBeenCalledWith(
      '/tmp/ai-orchestrator-voice-test',
      { recursive: true, force: true }
    );
  });

  it('kills the active local process when speech is cancelled', async () => {
    const child = createChild();
    const provider = new MacosSayTtsProvider({
      platform: 'darwin',
      exists: () => true,
      spawnProcess: vi.fn(() => child as never),
      makeTempDir: vi.fn(async () => '/tmp/ai-orchestrator-voice-test'),
      readFile: vi.fn(async () => Buffer.from('RIFF')),
      removePath: vi.fn(async () => undefined),
      tempRoot: () => '/tmp',
    });

    const result = provider.synthesize({
      requestId: 'tts-cancel',
      input: 'stop this',
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      format: 'wav',
    });
    await Promise.resolve();

    expect(provider.cancel('tts-cancel')).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    child.emit('exit', null, 'SIGTERM');
    await expect(result).rejects.toMatchObject({
      code: 'VOICE_TTS_CANCELLED',
    });
  });
});
