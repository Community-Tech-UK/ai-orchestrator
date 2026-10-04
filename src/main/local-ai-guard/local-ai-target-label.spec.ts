import { describe, expect, it } from 'vitest';
import { friendlyLocalAiTargetLabel } from './local-ai-target-label';

const worker = { type: 'worker' as const, nodeId: 'bb62e3ee-ccd7-4ea4-93f1-4ac0a0cd04be' };

describe('friendlyLocalAiTargetLabel', () => {
  it.each([
    ['worker LM Studio', { location: worker, provider: 'openai-compatible' as const, baseUrl: 'http://127.0.0.1:1234' }, 'windows-pc · LM Studio'],
    ['worker Ollama', { location: worker, provider: 'ollama' as const, baseUrl: 'http://127.0.0.1:11434' }, 'windows-pc · Ollama'],
    ['a second Ollama on another port', { location: worker, provider: 'ollama' as const, baseUrl: 'http://127.0.0.1:11435' }, 'windows-pc · Ollama (127.0.0.1:11435)'],
    ['coordinator Ollama', { location: { type: 'coordinator' as const }, provider: 'ollama' as const, baseUrl: 'http://127.0.0.1:11434' }, 'This computer · Ollama'],
    ['coordinator OpenAI-compatible', { location: { type: 'coordinator' as const }, provider: 'openai-compatible' as const, baseUrl: 'http://100.64.0.2:8080/v1' }, 'This computer · OpenAI-compatible (100.64.0.2:8080)'],
  ])('labels %s readably', (_case, config, expected) => {
    expect(friendlyLocalAiTargetLabel(config, 'windows-pc')).toBe(expected);
  });

  it('falls back to the node id when the worker name is unknown or blank', () => {
    const config = { location: worker, provider: 'ollama' as const, baseUrl: 'http://127.0.0.1:11434' };
    expect(friendlyLocalAiTargetLabel(config)).toBe(`${worker.nodeId} · Ollama`);
    expect(friendlyLocalAiTargetLabel(config, '   ')).toBe(`${worker.nodeId} · Ollama`);
  });

  it('appends no host when the base URL cannot be parsed', () => {
    expect(friendlyLocalAiTargetLabel(
      { location: worker, provider: 'openai-compatible', baseUrl: 'not a url' }, 'windows-pc',
    )).toBe('windows-pc · LM Studio');
  });

  it('never exceeds the 256-character label limit', () => {
    const label = friendlyLocalAiTargetLabel(
      { location: worker, provider: 'ollama', baseUrl: 'http://127.0.0.1:11434' }, 'x'.repeat(400),
    );
    expect(label.length).toBe(256);
  });
});
