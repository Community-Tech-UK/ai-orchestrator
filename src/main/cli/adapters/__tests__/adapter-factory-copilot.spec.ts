import { describe, expect, it } from 'vitest';
import { createCliAdapter, getCliDisplayName, mapSettingsToDetectionType } from '../adapter-factory';

describe('adapter factory — copilot', () => {
  it('getCliDisplayName returns GitHub Copilot', () => {
    expect(getCliDisplayName('copilot')).toBe('GitHub Copilot');
  });

  it('mapSettingsToDetectionType accepts copilot', () => {
    expect(mapSettingsToDetectionType('copilot')).toBe('copilot');
  });

  it('createCliAdapter(copilot, ...) instantiates AcpCliAdapter with a copilot provider name', () => {
    const adapter = createCliAdapter('copilot', { workingDirectory: '/tmp' });
    expect(adapter.constructor.name).toBe('AcpCliAdapter');
    expect(adapter.getName()).toBe('copilot-acp');
  });

  it('passes --model <id> to the copilot subprocess when a model is specified', () => {
    // Regression: AcpCliAdapter silently dropped options.model, leaving the
    // copilot subprocess on its own default model while the orchestrator UI
    // showed the user's selection.
    const adapter = createCliAdapter('copilot', {
      workingDirectory: '/tmp',
      model: 'claude-opus-4.7',
    });
    const args = adapter.getConfig().args ?? [];
    const modelIdx = args.indexOf('--model');
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(args[modelIdx + 1]).toBe('claude-opus-4.7');
    // Core ACP flags must still be present.
    expect(args).toContain('--acp');
    expect(args).toContain('--stdio');
  });

  it('omits --model when no model is specified so copilot uses its configured default', () => {
    const adapter = createCliAdapter('copilot', { workingDirectory: '/tmp' });
    const args = adapter.getConfig().args ?? [];
    expect(args).not.toContain('--model');
  });

  it('preserves the literal "auto" sentinel when model === "auto"', () => {
    const adapter = createCliAdapter('copilot', {
      workingDirectory: '/tmp',
      model: 'auto',
    });
    const args = adapter.getConfig().args ?? [];
    const modelIdx = args.indexOf('--model');
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(args[modelIdx + 1]).toBe('auto');
  });
});
