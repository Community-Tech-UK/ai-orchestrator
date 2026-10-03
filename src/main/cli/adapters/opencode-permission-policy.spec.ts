import { describe, expect, it } from 'vitest';
import { applyOpenCodePermissionPolicy, assertOpenCodePermissionPolicy } from './opencode-permission-policy';

describe('native OpenCode doom-loop permission precedence', () => {
  it('adds a fresh final wildcard globally and to native/custom agents while preserving unrelated rules', () => {
    const base: Record<string, unknown> = { permission: { doom_loop: 'allow', '*': 'allow', custom: 'deny' },
      agent: { build: { prompt: 'LOCAL_TEST_PLACEHOLDER', permission: { doom_loop: 'allow', '*': 'allow' } },
        custom: { permission: { read: { '*.test': 'deny' }, custom: 'allow' } } } };
    applyOpenCodePermissionPolicy(base, true);
    expect(base).toMatchObject({ permission: { '*': 'allow', custom: 'deny', 'doom_loop*': 'ask' },
      agent: { build: { prompt: 'LOCAL_TEST_PLACEHOLDER', permission: { '*': 'allow', 'doom_loop*': 'ask' } },
        custom: { permission: { read: { '*.test': 'deny' }, custom: 'allow', 'doom_loop*': 'ask' } } } });
    expect(() => assertOpenCodePermissionPolicy(base)).not.toThrow();
  });
  it('avoids collisions at every native permission layer without copying native rules', () => {
    const base: Record<string, unknown> = {};
    const effective = { permission: { 'doom_loop*': 'allow' },
      agent: { custom: { permission: { 'doom_loop*': 'allow', 'doom_loop**': 'allow', private: 'LOCAL_PRIVATE_BODY_PLACEHOLDER' } } } };
    applyOpenCodePermissionPolicy(base, false, effective);
    expect(Object.keys(base['permission'] as object).at(-1)).toBe('doom_loop**');
    expect(base).toMatchObject({ agent: { custom: { permission: { doom_loop: 'ask', 'doom_loop***': 'ask' } } } });
    expect(JSON.stringify(base)).not.toContain('LOCAL_PRIVATE_BODY_PLACEHOLDER');
  });
  it('bounds collision selection and fails closed instead of weakening a native rule', () => {
    const permission = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`doom_loop${'*'.repeat(index + 1)}`, 'allow']));
    expect(() => applyOpenCodePermissionPolicy({ permission }, true)).toThrow('doom-loop permission');
  });
  it('rejects a final native wildcard or per-agent permission that defeats the ask brake', () => {
    const base: Record<string, unknown> = {};
    applyOpenCodePermissionPolicy(base, true);
    const agents = base['agent'] as Record<string, { permission: Record<string, string> }>;
    agents['build']!.permission['doom_*'] = 'allow';
    expect(() => assertOpenCodePermissionPolicy(base)).toThrow('doom-loop permission');
  });
});
