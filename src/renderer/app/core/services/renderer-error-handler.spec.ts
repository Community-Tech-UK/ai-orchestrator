import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RendererErrorHandler } from './renderer-error-handler';

describe('RendererErrorHandler', () => {
  let handler: RendererErrorHandler;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let logMessageMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    handler = new RendererErrorHandler();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    logMessageMock = vi.fn().mockResolvedValue(undefined);

    (window as unknown as Record<string, unknown>).electronAPI = {
      infrastructure: { logMessage: logMessageMock },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as unknown as Record<string, unknown>).electronAPI;
    sessionStorage.clear();
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

    const keys = Object.keys(sessionStorage).filter((k) => k.startsWith('aio:last-renderer-crash:'));
    expect(keys.length).toBeGreaterThan(0);
  });

  it('does not throw when electronAPI is absent', () => {
    delete (window as unknown as Record<string, unknown>).electronAPI;
    expect(() => handler.handleError(new Error('no api'))).not.toThrow();
  });

  it('does not throw when IPC call rejects', async () => {
    logMessageMock.mockRejectedValue(new Error('ipc failure'));
    expect(() => handler.handleError(new Error('ipc rejects'))).not.toThrow();
    await Promise.resolve(); // allow rejection to settle
  });
});
