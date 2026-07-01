import { describe, expect, it } from 'vitest';

import { AntigravityCliAdapter } from './antigravity-cli-adapter';
import type { CliMessage } from './base-cli-adapter';

/** Expose the protected buildArgs for assertion. */
interface BuildArgsAccess {
  buildArgs(message: CliMessage): string[];
}

function buildArgs(adapter: AntigravityCliAdapter, content = 'hello'): string[] {
  return (adapter as unknown as BuildArgsAccess).buildArgs({ role: 'user', content });
}

describe('AntigravityCliAdapter buildArgs model forwarding', () => {
  it('forwards a known agy label as --model <label>', () => {
    const adapter = new AntigravityCliAdapter({ model: 'Gemini 3.1 Pro (High)' });
    const args = buildArgs(adapter);
    const modelIdx = args.indexOf('--model');
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(args[modelIdx + 1]).toBe('Gemini 3.1 Pro (High)');
  });

  it('omits --model for a stale cross-provider id so agy uses its default', () => {
    const adapter = new AntigravityCliAdapter({ model: 'gemini-3-pro-preview' });
    expect(buildArgs(adapter)).not.toContain('--model');
  });

  it('omits --model when no model is configured', () => {
    const adapter = new AntigravityCliAdapter({});
    expect(buildArgs(adapter)).not.toContain('--model');
  });

  it('always ends with --print and the prompt as the final arg', () => {
    const adapter = new AntigravityCliAdapter({ model: 'GPT-OSS 120B (Medium)' });
    const args = buildArgs(adapter, 'do the thing');
    expect(args[args.length - 2]).toBe('--print');
    expect(args[args.length - 1]).toBe('do the thing');
  });

  it('adds --dangerously-skip-permissions when yolo is enabled', () => {
    const adapter = new AntigravityCliAdapter({ yolo: true });
    expect(buildArgs(adapter)).toContain('--dangerously-skip-permissions');
  });
});
