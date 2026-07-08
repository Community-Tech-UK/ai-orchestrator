import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalModelSessionManager } from '../local-model-session-manager';
import type { CliResponse, InterruptResult } from '../../main/cli/adapters/base-cli-adapter';
import type { FileAttachment, OutputMessage } from '../../shared/types/instance.types';
import type { LocalModelEndpointProvider } from '../../shared/types/local-model-runtime.types';

class MockLocalModelAdapter extends EventEmitter {
  spawn = vi.fn(async () => 123);
  sendInput = vi.fn(async (_message: string, _attachments?: FileAttachment[]) => undefined);
  terminate = vi.fn(async () => undefined);
  interrupt = vi.fn((): InterruptResult => ({ status: 'accepted' }));
  getEndpointProvider = vi.fn((): LocalModelEndpointProvider => 'ollama');
  getModelId = vi.fn(() => 'llama3.2');
}

describe('LocalModelSessionManager', () => {
  let adapter: MockLocalModelAdapter;
  let createAdapter: ReturnType<typeof vi.fn>;
  let manager: LocalModelSessionManager;

  beforeEach(() => {
    adapter = new MockLocalModelAdapter();
    createAdapter = vi.fn(() => adapter);
    manager = new LocalModelSessionManager({ createAdapter, maxSessions: 1 });
  });

  it('starts a local model adapter session and forwards input', async () => {
    await manager.start({
      sessionId: 'lm-session-1',
      endpointProvider: 'ollama',
      endpointId: 'ollama',
      modelId: 'llama3.2',
      workingDirectory: '/workspace',
      systemPrompt: 'Be brief.',
    });

    expect(createAdapter).toHaveBeenCalledWith({
      sessionId: 'lm-session-1',
      endpointProvider: 'ollama',
      endpointId: 'ollama',
      modelId: 'llama3.2',
      workingDirectory: '/workspace',
      systemPrompt: 'Be brief.',
    });
    expect(adapter.spawn).toHaveBeenCalledOnce();

    await manager.sendInput({
      sessionId: 'lm-session-1',
      message: 'hello',
      attachments: [{ name: 'note.txt', type: 'text/plain', size: 5, data: 'hello' }],
    });

    expect(adapter.sendInput).toHaveBeenCalledWith(
      'hello',
      [{ name: 'note.txt', type: 'text/plain', size: 5, data: 'hello' }],
    );
  });

  it('bridges adapter runtime events as instance events using the session id', async () => {
    const outputHandler = vi.fn();
    const stateHandler = vi.fn();
    const completeHandler = vi.fn();
    const contextHandler = vi.fn();
    manager.on('instance:output', outputHandler);
    manager.on('instance:stateChange', stateHandler);
    manager.on('instance:complete', completeHandler);
    manager.on('instance:context', contextHandler);

    await manager.start({
      sessionId: 'lm-session-2',
      endpointProvider: 'ollama',
      endpointId: 'ollama',
      modelId: 'llama3.2',
    });

    const output: OutputMessage = {
      id: 'out-1',
      timestamp: 123,
      type: 'assistant',
      content: 'streamed text',
    };
    const complete: CliResponse = {
      id: 'response-1',
      role: 'assistant',
      content: 'done',
    };
    adapter.emit('output', output);
    adapter.emit('status', 'busy');
    adapter.emit('context', { used: 10, total: 100, percentage: 10 });
    adapter.emit('complete', complete);

    expect(outputHandler).toHaveBeenCalledWith('lm-session-2', output);
    expect(stateHandler).toHaveBeenCalledWith('lm-session-2', 'busy');
    expect(contextHandler).toHaveBeenCalledWith('lm-session-2', { used: 10, total: 100, percentage: 10 });
    expect(completeHandler).toHaveBeenCalledWith('lm-session-2', complete);
  });

  it('terminates sessions and releases capacity', async () => {
    await manager.start({
      sessionId: 'lm-session-3',
      endpointProvider: 'ollama',
      endpointId: 'ollama',
      modelId: 'llama3.2',
    });

    await expect(manager.start({
      sessionId: 'lm-session-4',
      endpointProvider: 'ollama',
      endpointId: 'ollama',
      modelId: 'llama3.2',
    })).rejects.toThrow('Worker at local model session capacity');

    await manager.terminate({ sessionId: 'lm-session-3' });

    expect(adapter.terminate).toHaveBeenCalledOnce();
    await expect(manager.start({
      sessionId: 'lm-session-4',
      endpointProvider: 'ollama',
      endpointId: 'ollama',
      modelId: 'llama3.2',
    })).resolves.toEqual({ sessionId: 'lm-session-4' });
  });
});
