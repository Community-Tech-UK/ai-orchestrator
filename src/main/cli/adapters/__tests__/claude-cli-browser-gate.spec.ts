import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

import { ClaudeCliAdapter } from '../claude-cli-adapter';

function buildArgs(adapter: ClaudeCliAdapter): string[] {
  return (
    adapter as unknown as {
      buildArgs(message: { role: 'user'; content: string }): string[];
    }
  ).buildArgs({ role: 'user', content: 'hello' });
}

describe('Claude CLI browser gate', () => {
  it('does not pass --chrome by default', () => {
    const adapter = new ClaudeCliAdapter({});

    expect(buildArgs(adapter)).not.toContain('--chrome');
  });

  it('passes --chrome only when explicitly requested', () => {
    const adapter = new ClaudeCliAdapter({ chrome: true });

    expect(buildArgs(adapter)).toContain('--chrome');
  });
});
