import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { OpenAICompatibleChatAdapter } from './openai-compatible-chat-adapter';
import { OllamaCliAdapter } from './ollama-cli-adapter';
const native = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('node:http', () => ({ request: native.request }));
vi.mock('../../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
function ready<T extends OpenAICompatibleChatAdapter | OllamaCliAdapter>(adapter: T): T {
  Object.assign(adapter, { isSpawned: true }); adapter.on('error', () => undefined); return adapter;
}
describe('local model native input dispatch', () => {
  it.each(['openai', 'ollama'] as const)('blocks cancelled %s input before a native request', async name => {
    const adapter = ready(name === 'openai' ? new OpenAICompatibleChatAdapter() : new OllamaCliAdapter());
    const fetchNative = vi.fn(); vi.stubGlobal('fetch', fetchNative);
    const controller = new AbortController(); const admission = vi.fn(); const complete = vi.fn();
    adapter.on('status', status => { if (status === 'busy') controller.abort(); }); adapter.on('complete', complete);
    await expect(adapter.sendInput('synthetic continuation', undefined, { dispatch: {
      signal: controller.signal, autoContinuation: true, beforeProviderDispatch: admission,
    } })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchNative).not.toHaveBeenCalled(); expect(native.request).not.toHaveBeenCalled();
    expect(admission).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled();
  });
  it('blocks Ollama body writes when final admission cancels', async () => {
    const write = vi.fn(); const destroy = vi.fn();
    native.request.mockImplementation(() => Object.assign(new EventEmitter(), { setTimeout: vi.fn(), write, end: vi.fn(), destroy }));
    const controller = new AbortController(); const complete = vi.fn(); const adapter = ready(new OllamaCliAdapter()); adapter.on('complete', complete);
    await expect(adapter.sendInput('synthetic continuation', undefined, { dispatch: {
      signal: controller.signal, beforeProviderDispatch: () => controller.abort(),
    } })).rejects.toMatchObject({ name: 'AbortError' });
    expect(native.request).toHaveBeenCalledOnce(); expect(write).not.toHaveBeenCalled(); expect(destroy).toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled();
  });
  it.each(['streaming', 'realm'] as const)('rechecks ownership before the %s fallback POST', async kind => {
    let eligible = true; const admission = vi.fn();
    const fetchNative = vi.fn(async () => {
      eligible = false;
      if (kind === 'realm') throw new TypeError('Expected signal to be an AbortSignal');
      return new Response('streaming not supported', { status: 400 });
    }); vi.stubGlobal('fetch', fetchNative);
    const adapter = ready(new OpenAICompatibleChatAdapter()); const complete = vi.fn(); adapter.on('complete', complete);
    await expect(adapter.sendInput('synthetic continuation', undefined, { dispatch: {
      beforeProviderDispatch: admission, assertCurrent: () => { if (!eligible) { const error = new Error('owner changed'); error.name = 'AbortError'; throw error; } },
    } })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchNative).toHaveBeenCalledOnce(); expect(admission).toHaveBeenCalledOnce(); expect(complete).not.toHaveBeenCalled();
  });
  it('retains one admission while a streaming fallback succeeds', async () => {
    const fetchNative = vi.fn().mockResolvedValueOnce(new Response('streaming not supported', { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: 'synthetic answer' } }] })));
    vi.stubGlobal('fetch', fetchNative); const adapter = ready(new OpenAICompatibleChatAdapter());
    const admission = vi.fn(); const complete = vi.fn(); adapter.on('complete', complete);
    await adapter.sendInput('synthetic continuation', undefined, { dispatch: { beforeProviderDispatch: admission } });
    expect(fetchNative).toHaveBeenCalledTimes(2); expect(admission).toHaveBeenCalledOnce(); expect(complete).toHaveBeenCalledOnce();
  });
});
