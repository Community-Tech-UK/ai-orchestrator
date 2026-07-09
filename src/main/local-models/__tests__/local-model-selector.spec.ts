import { describe, expect, it } from 'vitest';
import {
  decodeLocalModelSelector,
  encodeLocalModelSelector,
} from '../local-model-selector';

describe('local model selector helpers', () => {
  it('round-trips worker local model selector IDs', () => {
    const id = encodeLocalModelSelector({
      source: 'worker-node',
      nodeId: 'node/windows pc',
      endpointProvider: 'ollama',
      endpointId: 'ollama',
      modelId: 'qwen2.5-coder:14b',
    });

    expect(id).toBe('lm://worker-node/node%2Fwindows%20pc/ollama/ollama/qwen2.5-coder%3A14b');
    expect(decodeLocalModelSelector(id)).toEqual({
      source: 'worker-node',
      nodeId: 'node/windows pc',
      endpointProvider: 'ollama',
      endpointId: 'ollama',
      modelId: 'qwen2.5-coder:14b',
    });
  });

  it('round-trips this-device local model selector IDs', () => {
    const id = encodeLocalModelSelector({
      source: 'this-device',
      endpointProvider: 'openai-compatible',
      endpointId: 'lm-studio',
      modelId: 'qwen/qwen3 coder',
    });

    expect(id).toBe('lm://this-device/openai-compatible/lm-studio/qwen%2Fqwen3%20coder');
    expect(decodeLocalModelSelector(id)).toEqual({
      source: 'this-device',
      endpointProvider: 'openai-compatible',
      endpointId: 'lm-studio',
      modelId: 'qwen/qwen3 coder',
    });
  });

  it('rejects non-local-model selectors', () => {
    expect(() => decodeLocalModelSelector('http://127.0.0.1:11434')).toThrow(
      'Invalid local model selector',
    );
  });

  it('rejects unsupported endpoint providers', () => {
    expect(() => decodeLocalModelSelector('lm://this-device/custom/x/qwen')).toThrow(
      'Invalid local model selector',
    );
  });

  it('rejects worker local model selectors without a node id', () => {
    expect(() => decodeLocalModelSelector('lm://worker-node//ollama/ollama/qwen')).toThrow(
      'Invalid local model selector',
    );
  });

  it('rejects encoding worker local model selectors without a node id', () => {
    expect(() => encodeLocalModelSelector({
      source: 'worker-node',
      endpointProvider: 'ollama',
      endpointId: 'ollama',
      modelId: 'qwen',
    })).toThrow('Invalid local model selector');
  });
});
