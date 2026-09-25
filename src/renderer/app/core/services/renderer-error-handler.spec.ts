import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IPC_CHANNELS } from '../../../../preload/generated/channels';
import { createInfrastructureDomain } from '../../../../preload/domains/infrastructure.preload';
import { RendererErrorHandler } from './renderer-error-handler';

function crashKeys(): string[] {
  return Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index))
    .filter((key): key is string => key?.startsWith('aio:last-renderer-crash:') ?? false);
}

describe('RendererErrorHandler', () => {
  let handler: RendererErrorHandler;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let invoke: ReturnType<typeof vi.fn>;
  let logMessageMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    handler = new RendererErrorHandler();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    invoke = vi.fn().mockResolvedValue({ success: true });

    // Expose the real preload bridge shape: domains are spread flat onto
    // `electronAPI`. A hand-written `{ infrastructure: { logMessage } }` double
    // once agreed with a handler that read that non-existent path, so every
    // Angular error was dropped before it reached the main-process log.
    const electronAPI = createInfrastructureDomain(
      { invoke } as unknown as Parameters<typeof createInfrastructureDomain>[0],
      IPC_CHANNELS,
    );
    logMessageMock = vi.spyOn(electronAPI, 'logMessage') as unknown as ReturnType<typeof vi.fn>;
    (window as unknown as Record<string, unknown>)['electronAPI'] = electronAPI;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (window as unknown as Record<string, unknown>)['electronAPI'];
    sessionStorage.clear();
  });

  it('reaches the LOG_MESSAGE channel through the real preload bridge', () => {
    handler.handleError(new Error('bridge test'));

    expect(invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.LOG_MESSAGE,
      expect.objectContaining({
        level: 'error',
        message: 'bridge test',
        context: 'RendererErrorHandler',
      }),
    );
  });

  it('forwards and persists a repeating error once per window, then again after it', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const repeat = () => {
      const err = new Error('render loop');
      err.stack = 'Error: render loop\n    at assignLiveRailTitles (chunk.js:17:13132)';
      handler.handleError(err);
    };

    repeat();
    vi.setSystemTime(1_000_001);
    repeat();
    repeat();

    expect(logMessageMock).toHaveBeenCalledTimes(1);
    expect(crashKeys()).toHaveLength(1);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(3);

    vi.setSystemTime(1_000_000 + 60_001);
    repeat();

    expect(logMessageMock).toHaveBeenCalledTimes(2);
    expect(crashKeys()).toHaveLength(2);
  });

  it('forwards distinct errors inside the same window', () => {
    handler.handleError(new Error('first'));
    handler.handleError(new Error('second'));

    expect(logMessageMock).toHaveBeenCalledTimes(2);
  });

  it('logs the error to console.error', () => {
    const err = new Error('test error');
    handler.handleError(err);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('RendererErrorHandler'),
      err,
    );
  });

  it('forwards Error instances to main-process logger via IPC', async () => {
    const err = new Error('ipc test');
    handler.handleError(err);

    await Promise.resolve();

    expect(logMessageMock).toHaveBeenCalledWith(
      'error',
      'ipc test',
      'RendererErrorHandler',
      expect.objectContaining({ name: 'Error', message: 'ipc test' }),
    );
  });

  it('handles non-Error values gracefully', () => {
    expect(() => handler.handleError('a string error')).not.toThrow();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('persists crash info to sessionStorage', () => {
    handler.handleError(new Error('storage test'));

    const keys = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index));
    const crashKey = keys.find((key) => key?.startsWith('aio:last-renderer-crash:'));
    expect(crashKey).toBeDefined();

    const storedCrash = sessionStorage.getItem(crashKey ?? '');
    expect(storedCrash).not.toBeNull();
    expect(JSON.parse(storedCrash ?? '{}')).toEqual(
      expect.objectContaining({ name: 'Error', message: 'storage test' }),
    );
  });

  it('does not throw when electronAPI is absent', () => {
    delete (window as unknown as Record<string, unknown>)['electronAPI'];
    expect(() => handler.handleError(new Error('no api'))).not.toThrow();
  });

  it('does not throw when IPC call rejects', async () => {
    logMessageMock.mockRejectedValue(new Error('ipc failure'));
    expect(() => handler.handleError(new Error('ipc rejects'))).not.toThrow();
    await Promise.resolve(); // allow rejection to settle
  });
});
