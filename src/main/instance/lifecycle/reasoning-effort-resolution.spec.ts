import { describe, expect, it } from 'vitest';
import { resolveSpawnReasoningEffort } from './reasoning-effort-resolution';

describe('resolveSpawnReasoningEffort', () => {
  it('applies the app default when the caller supplies no effort', () => {
    // The regression this pins: loops, orchestration children, reviewers and
    // effort-less automations all spawn Codex with no effort, which silently
    // handed the session to the CLI's own default (medium).
    expect(resolveSpawnReasoningEffort({}, 'codex')).toBe('high');
    expect(resolveSpawnReasoningEffort({ reasoningEffort: undefined }, 'codex')).toBe('high');
  });

  it('treats null as the explicit "let the provider decide" choice', () => {
    // The model picker renders a "Provider — let the provider decide" row that
    // emits null. Collapsing it into the app default would make that control
    // do the opposite of its label.
    expect(resolveSpawnReasoningEffort({ reasoningEffort: null }, 'codex')).toBeUndefined();
    expect(resolveSpawnReasoningEffort({ reasoningEffort: null }, 'claude')).toBeUndefined();
  });

  it('honours an explicit caller choice over the default', () => {
    expect(resolveSpawnReasoningEffort({ reasoningEffort: 'low' }, 'codex')).toBe('low');
    expect(resolveSpawnReasoningEffort({ reasoningEffort: 'xhigh' }, 'claude')).toBe('xhigh');
  });

  it('leaves providers without an app default provider-decided', () => {
    expect(resolveSpawnReasoningEffort({}, 'gemini')).toBeUndefined();
    expect(resolveSpawnReasoningEffort({}, undefined)).toBeUndefined();
  });

  it('never defaults an effort for local-model runtime targets', () => {
    // Local-model adapters never read reasoningEffort, so defaulting one in
    // would only mislead the picker, which renders the instance's stored
    // effort back to the user.
    expect(resolveSpawnReasoningEffort({
      modelRuntimeTarget: {
        kind: 'local-model',
        source: 'worker-node',
        selectorId: 'lm://worker-node/node-win/ollama/ollama/qwen',
        nodeId: 'node-win',
        endpointProvider: 'ollama',
        endpointId: 'ollama',
        modelId: 'qwen',
      },
    }, 'codex')).toBeUndefined();
  });
});
