import { describe, expect, it } from 'vitest';
import { applyOpenCodeUnattendedPolicy, assertOpenCodeHelpersDenied, isUnattendedOpenCodeSpawn } from './opencode-unattended-policy';

describe('OpenCode unattended policy', () => {
  it.each([
    [{ machineSession: 'plan-queue' as const }, true], [{ machineSession: 'loop' as const }, true],
    [{ machineSession: 'automation' as const }, true], [{ concurrencyPriority: 'overflow' }, true],
    [{}, false], [{ machineSession: 'child' as const }, false],
  ])('decides whether a spawn is automatic: %j', (options, expected) => {
    expect(isUnattendedOpenCodeSpawn(options)).toBe(expected);
  });
  it('accepts valid native zero and percentage compaction buffers while reserving room', () => {
    const zero: Record<string, unknown> = { compaction: { buffer: 0 } };
    applyOpenCodeUnattendedPolicy(zero, {}, 2);
    expect(zero['compaction']).toMatchObject({ buffer: 20000 });
    const percent: Record<string, unknown> = { compaction: { buffer: '25%' } };
    applyOpenCodeUnattendedPolicy(percent, {}, 2);
    expect(percent['compaction']).toMatchObject({ buffer: '25%' });
  });
  it('rejects a managed helper override after the deny', () => {
    expect(() => assertOpenCodeHelpersDenied({ permissionRules: [
      { action: 'subagent', resource: '*', effect: 'deny' },
      { action: 'subagent', resource: '<pattern>', effect: 'allow' },
    ] }, 2)).toThrow('Could not deny');
  });
  it('on Windows, requires the helper deny to hold whether or not native matching is case-sensitive', () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      // Case-insensitively the last universal rule is the upper-case deny; case-sensitively the
      // lower-case allow comes after the only matching universal deny.
      expect(() => assertOpenCodeHelpersDenied({ permissionRules: [
        { action: 'subagent', resource: '*', effect: 'deny' },
        { action: 'subagent', resource: '<pattern>', effect: 'allow' },
        { action: 'SUBAGENT', resource: '*', effect: 'deny' },
      ] }, 2)).toThrow('Could not deny');
      expect(() => assertOpenCodeHelpersDenied({ permission: { 'task*': 'deny', TASK: 'allow' } }, 1)).toThrow('Could not deny');
      expect(() => assertOpenCodeHelpersDenied({ permissionRules: [{ action: 'subagent', resource: '*', effect: 'deny' }] }, 2)).not.toThrow();
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  });
});
