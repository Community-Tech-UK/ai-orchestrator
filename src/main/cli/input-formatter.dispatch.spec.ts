import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Writable } from 'node:stream';
import { InputFormatter } from './input-formatter';
vi.mock('../logging/logger', () => ({ getLogger: () => ({ debug: vi.fn(), warn: vi.fn() }) }));
function formatter(write: (data: string, encoding: string, callback: (error?: Error) => void) => boolean) {
  const stdin = Object.assign(new EventEmitter(), { writable: true, write }) as unknown as Writable;
  return { input: new InputFormatter(stdin), stdin };
}
describe('InputFormatter native delivery', () => {
  it('rejects synchronous cancellation at admission without writing', async () => {
    const write = vi.fn(() => true); const { input } = formatter(write);
    const controller = new AbortController();
    await expect(input.sendMessage('synthetic continuation', undefined, {
      signal: controller.signal, beforeProviderDispatch: () => controller.abort(),
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(write).not.toHaveBeenCalled();
  });
  it('does not report delivery on drain before a failed write callback', async () => {
    let callback: ((error?: Error) => void) | undefined;
    const { input, stdin } = formatter((_data, _encoding, cb) => { callback = cb; return false; });
    const result = input.sendRaw('synthetic continuation'); const settled = vi.fn();
    void result.then(settled, settled); stdin.emit('drain'); await Promise.resolve();
    expect(settled).not.toHaveBeenCalled(); callback?.(new Error('synthetic write failed'));
    await expect(result).rejects.toThrow('synthetic write failed');
  });
  it('rejects cancellation while awaiting the write callback', async () => {
    let callback: ((error?: Error) => void) | undefined;
    const { input } = formatter((_data, _encoding, cb) => { callback = cb; return true; });
    const controller = new AbortController(); const result = input.sendRaw('synthetic continuation', { signal: controller.signal });
    controller.abort(); callback?.(); await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('admits and writes successful input once', async () => {
    const write = vi.fn((_data: string, _encoding: string, callback: (error?: Error) => void) => { callback(); return true; });
    const admission = vi.fn(); const { input } = formatter(write);
    await input.sendMessage('synthetic continuation', undefined, { beforeProviderDispatch: admission });
    expect(admission).toHaveBeenCalledOnce(); expect(write).toHaveBeenCalledOnce();
    expect(JSON.parse(write.mock.calls[0]![0]).message.content).toBe('synthetic continuation');
  });
});
