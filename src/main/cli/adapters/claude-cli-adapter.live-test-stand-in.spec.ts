import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ standIn: null as string | null | Error }));

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../app/live-test-context', () => ({
  resolveLiveTestClaudeStandIn: () => {
    if (mocks.standIn instanceof Error) throw mocks.standIn;
    return mocks.standIn;
  },
}));

import { ClaudeCliAdapter } from './claude-cli-adapter';

describe('ClaudeCliAdapter live-test stand-in', () => {
  beforeEach(() => { mocks.standIn = null; });

  it('spawns the bare claude command when no stand-in is installed', () => {
    expect(new ClaudeCliAdapter().getConfig().command).toBe('claude');
  });

  it('spawns the owned stand-in when the live-test profile has one', () => {
    mocks.standIn = '/tmp/aio-lt-x/live-test-overrides/claude';
    expect(new ClaudeCliAdapter().getConfig().command).toBe('/tmp/aio-lt-x/live-test-overrides/claude');
  });

  it('surfaces an unsafe stand-in instead of falling back to the real CLI', () => {
    mocks.standIn = new Error('unsafe stand-in');
    expect(() => new ClaudeCliAdapter()).toThrow('unsafe stand-in');
  });
});
