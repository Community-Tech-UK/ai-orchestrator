import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioTranscribeParamsSchema } from '../main/remote-node/rpc-schemas';
import { COORDINATOR_TO_NODE, RPC_ERROR_CODES } from '../main/remote-node/worker-node-rpc';
import { SPEACHES_STT_LOCAL_BASE_URL } from './local-model-config';
import { WorkerRpcDispatcher } from './worker-rpc-dispatcher';
import type { RpcMessage } from './worker-rpc-types';

function makeDispatcher() {
  const sendResult = vi.fn();
  const sendError = vi.fn();
  const dispatcher = new WorkerRpcDispatcher({
    config: {} as never,
    instanceManager: {} as never,
    getFilesystemHandler: () => ({}) as never,
    getSyncHandler: () => ({}) as never,
    getTerminalHandler: () => ({}) as never,
    applyConfigUpdate: vi.fn() as never,
    getCdpTunnel: () => ({ open: vi.fn(), send: vi.fn(), close: vi.fn() }) as never,
    stopManagedBrowser: vi.fn(async () => undefined),
    sendResult,
    sendError,
  });
  return { dispatcher, sendResult, sendError };
}

function audioTranscribeMsg(params: unknown): RpcMessage {
  return {
    jsonrpc: '2.0',
    id: 42,
    method: COORDINATOR_TO_NODE.AUDIO_TRANSCRIBE,
    params,
  } as RpcMessage;
}

describe('WorkerRpcDispatcher audio.transcribe', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts base64 WAV audio to worker-local speaches and returns transcript text', async () => {
    const wavBytes = Buffer.from('tiny-wav');
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(`${SPEACHES_STT_LOCAL_BASE_URL}/v1/audio/transcriptions`);
      expect(init?.method).toBe('POST');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const body = init?.body as FormData;
      expect(body.get('model')).toBe('distil-large-v3');
      expect(body.get('language')).toBe('en');
      expect(body.get('task')).toBe('transcribe');
      expect(body.get('response_format')).toBe('json');
      const file = body.get('file');
      expect(file).toBeInstanceOf(Blob);
      expect((file as Blob).size).toBe(wavBytes.length);
      expect((file as Blob).type).toBe('audio/wav');
      return new Response(JSON.stringify({ text: 'transcribed locally' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchImpl);
    const { dispatcher, sendResult, sendError } = makeDispatcher();

    await dispatcher.handleRpcRequest(audioTranscribeMsg({
      provider: 'openai-compatible',
      baseUrl: SPEACHES_STT_LOCAL_BASE_URL,
      model: 'distil-large-v3',
      language: 'en',
      task: 'transcribe',
      audioBase64: wavBytes.toString('base64'),
      sampleRate: 16000,
      timeoutMs: 5000,
    }));

    expect(sendResult).toHaveBeenCalledWith(42, { text: 'transcribed locally' });
    expect(sendError).not.toHaveBeenCalled();
  });

  it('rejects invalid audio.transcribe params before touching the STT engine', async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    const { dispatcher, sendError, sendResult } = makeDispatcher();

    await dispatcher.handleRpcRequest(audioTranscribeMsg({
      provider: 'openai-compatible',
      baseUrl: SPEACHES_STT_LOCAL_BASE_URL,
      model: 'distil-large-v3',
      language: 'en',
      task: 'transcribe',
      audioBase64: '',
      sampleRate: 16000,
      timeoutMs: 5000,
    }));

    expect(AudioTranscribeParamsSchema.safeParse({
      provider: 'openai-compatible',
      baseUrl: SPEACHES_STT_LOCAL_BASE_URL,
      model: 'distil-large-v3',
      language: 'en',
      task: 'transcribe',
      audioBase64: '',
      sampleRate: 16000,
      timeoutMs: 5000,
    }).success).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sendResult).not.toHaveBeenCalled();
    expect(sendError).toHaveBeenCalledWith(
      42,
      RPC_ERROR_CODES.INVALID_PARAMS,
      expect.stringContaining('audioBase64')
    );
  });
});
