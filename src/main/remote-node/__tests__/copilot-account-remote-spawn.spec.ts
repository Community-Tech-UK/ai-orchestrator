import { describe, expect, it } from 'vitest';
import { InstanceSpawnParamsSchema } from '../rpc-schemas';

/**
 * Spec §19.5. The controlling invariant for remote Copilot execution: a
 * Copilot binding is NODE-LOCAL. The controller resolves and stamps an
 * account, the RPC carries only enough metadata for the worker to derive its
 * own home and check its own sign-in, and credentials never travel.
 */
describe('instance.spawn Copilot account metadata', () => {
  const base = {
    instanceId: 'session-1',
    cliType: 'copilot',
    workingDirectory: '/work/repo',
  };

  it('accepts profile ID, expected identity, host, and routing source', () => {
    const result = InstanceSpawnParamsSchema.safeParse({
      ...base,
      copilotAccountRoute: {
        profileId: 'enterprise',
        expectedLogin: 'octocat',
        host: 'github.com',
        source: 'owner',
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a spawn with no Copilot metadata at all (non-Copilot providers)', () => {
    expect(InstanceSpawnParamsSchema.safeParse({ ...base, cliType: 'claude' }).success).toBe(true);
  });

  it('rejects a profile ID that could escape a directory on the worker', () => {
    for (const profileId of ['../escape', 'a/b', '/etc/passwd', 'Upper', '']) {
      const result = InstanceSpawnParamsSchema.safeParse({
        ...base,
        copilotAccountRoute: { profileId },
      });
      expect(result.success, profileId).toBe(false);
    }
  });

  it('never carries a controller home path or a token', () => {
    const parsed = InstanceSpawnParamsSchema.parse({
      ...base,
      copilotAccountRoute: {
        profileId: 'enterprise',
        expectedLogin: 'octocat',
        host: 'github.com',
        source: 'owner',
      },
    });
    // The schema is closed over exactly four fields; anything path- or
    // token-shaped has nowhere to live.
    expect(Object.keys(parsed.copilotAccountRoute ?? {}).sort()).toEqual([
      'expectedLogin',
      'host',
      'profileId',
      'source',
    ]);
    expect(JSON.stringify(parsed.copilotAccountRoute)).not.toMatch(/\/(Users|home|var|tmp)\//);
  });

  it('drops an attempt to smuggle a home path through the route object', () => {
    const parsed = InstanceSpawnParamsSchema.parse({
      ...base,
      copilotAccountRoute: {
        profileId: 'enterprise',
        // Not part of the schema — Zod's default object mode strips it, so it
        // cannot reach the worker even if a caller sets it.
        copilotHome: '/Users/attacker/copilot',
        token: 'placeholder',
      },
    });
    expect(JSON.stringify(parsed.copilotAccountRoute)).not.toContain('/Users/attacker');
    expect(JSON.stringify(parsed.copilotAccountRoute)).not.toContain('token');
  });
});
