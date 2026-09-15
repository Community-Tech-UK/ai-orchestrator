import { beforeEach, describe, expect, it, vi } from 'vitest';

const { logSpies, traceSpy } = vi.hoisted(() => ({
  logSpies: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  traceSpy: vi.fn(),
}));

vi.mock('../../logging/logger', () => ({ getLogger: () => logSpies }));
vi.mock('../../observability/lifecycle-trace', () => ({ recordLifecycleTrace: traceSpy }));

import { emitProviderAccountEvent, type ProviderAccountEvent } from './provider-account-events';

beforeEach(() => {
  logSpies.info.mockClear();
  traceSpy.mockClear();
});

describe('emitProviderAccountEvent', () => {
  it('logs and traces only the closed field set', () => {
    const smuggled = {
      event: 'account_failover_performed',
      provider: 'claude',
      profileId: 'max-b',
      fromProfileId: 'max-a',
      resumeAt: 123,
      instanceId: 'inst-1',
      home: '/Users/me/Library/Application Support/Harness/claude-cli-profiles/max-b',
      accessToken: 'placeholder-not-a-token',
    } as unknown as ProviderAccountEvent;

    emitProviderAccountEvent(smuggled);

    const logged = JSON.stringify(logSpies.info.mock.calls);
    const traced = JSON.stringify(traceSpy.mock.calls);
    for (const output of [logged, traced]) {
      expect(output).toContain('max-b');
      expect(output).not.toContain('claude-cli-profiles');
      expect(output).not.toContain('placeholder-not-a-token');
    }
    expect(traceSpy).toHaveBeenCalledWith(expect.objectContaining({ instanceId: 'inst-1', provider: 'claude' }));
  });
});
