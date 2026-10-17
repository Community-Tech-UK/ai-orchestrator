import { describe, expect, it } from 'vitest';
import { normalizeOpenCodeNativeConfig } from './opencode-v2-config';
import { projectOpenCodeConfig } from './opencode-config-shapes';
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


describe('OpenCode 2 permission verification', () => {
  const rules = ['edit', 'shell', 'subagent', 'external_directory', 'webfetch', 'websearch', 'question', 'doom_loop'].map((action) => ({ action, resource: '*', effect: 'ask' }));
  it('rejects an action-specific resource override that silently permits writes', () => {
    expect(() => assertOpenCodePermissionPolicy({ permissionRules: [...rules, { action: 'shell', resource: 'git push *', effect: 'allow' }] }, false, 2)).toThrow('permission');
  });
  it('accepts scoped deny rules while preserving the universal ask brake', () => {
    expect(() => assertOpenCodePermissionPolicy({ permissionRules: [...rules, { action: 'shell', resource: 'git push *', effect: 'deny' }] }, false, 2)).not.toThrow();
  });
  it('rejects custom agents that defeat global ask permissions', () => {
    expect(() => assertOpenCodePermissionPolicy({ permissionRules: rules, agent: { custom: { permissionRules: [{ action: '*', resource: '*', effect: 'allow' }] } } }, false, 2)).toThrow('permission');
  });
});


describe('native action namespace permission verification', () => {
  const nativeRules = ['edit', 'shell', 'subagent', 'external_directory', 'webfetch', 'websearch', 'question', 'doom_loop']
    .map((action) => ({ action, resource: '*', effect: 'ask' }));
  const project = (rules: typeof nativeRules, agents?: Record<string, unknown>) => projectOpenCodeConfig(normalizeOpenCodeNativeConfig([
    { type: 'document', info: { permissions: rules, agents } },
  ]));

  it.each(['shell*', 'she?l', 'subagent*', 'subage?t'])(
    'rejects a later native %s allow for universal and scoped resources, globally and per agent', (action) => {
      for (const resource of ['*', 'git push *']) {
        const allow = { action, resource, effect: 'allow' };
        expect(() => assertOpenCodePermissionPolicy(project([...nativeRules, allow]), false, 2)).toThrow('ask permission');
        expect(() => assertOpenCodePermissionPolicy(project(nativeRules, { custom: { permissions: [allow] } }), false, 2)).toThrow('ask permission');
      }
    },
  );

  it.each(['bash', 'bash*', 'bas?', 'task', 'task*', 'tas?'])(
    'does not treat native %s as the legacy alias for shell or subagent', (action) => {
      const allow = { action, resource: '*', effect: 'allow' };
      expect(() => assertOpenCodePermissionPolicy(project([...nativeRules, allow]), false, 2)).not.toThrow();
      expect(() => assertOpenCodePermissionPolicy(project(nativeRules, { custom: { permissions: [allow] } }), false, 2)).not.toThrow();
    },
  );

  it('honors native rule order, scoped denies, disabled agents and the YOLO exception', () => {
    const allow = { action: 'shell*', resource: '*', effect: 'allow' };
    expect(() => assertOpenCodePermissionPolicy(project([allow, ...nativeRules]), false, 2)).not.toThrow();
    expect(() => assertOpenCodePermissionPolicy(project([...nativeRules, { ...allow, resource: 'git push *', effect: 'deny' }]), false, 2)).not.toThrow();
    expect(() => assertOpenCodePermissionPolicy(project(nativeRules, { custom: { disabled: true, permissions: [allow] } }), false, 2)).not.toThrow();
    expect(() => assertOpenCodePermissionPolicy(project([...nativeRules, allow]), true, 2)).not.toThrow();
    expect(() => assertOpenCodePermissionPolicy(project([...nativeRules, { action: 'doom_loo?', resource: '*', effect: 'allow' }]), true, 2)).toThrow('doom-loop permission');
  });
});


describe('Windows native permission case uncertainty', () => {
  function onWindows(check: () => void): void {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try { check(); } finally { Object.defineProperty(process, 'platform', original); }
  }
  const ask = { action: '*', resource: '*', effect: 'ask' };
  it('rejects a policy safe only under insensitive matching, globally and for agents', () => onWindows(() => {
    const unsafe = [{ action: 'shell', resource: '*', effect: 'allow' }, { action: 'Shell*', resource: '*', effect: 'ask' }];
    expect(() => assertOpenCodePermissionPolicy({ permissionRules: [ask, ...unsafe] }, false, 2)).toThrow('ask permission');
    expect(() => assertOpenCodePermissionPolicy({ permissionRules: [ask], agent: { custom: { permissionRules: unsafe } } }, false, 2)).toThrow('ask permission');
  }));
  it('rejects a policy safe only under sensitive matching and accepts policies safe under both', () => onWindows(() => {
    expect(() => assertOpenCodePermissionPolicy({ permissionRules: [ask, { action: 'Shell*', resource: '*', effect: 'allow' }] }, false, 2)).toThrow('ask permission');
    expect(() => assertOpenCodePermissionPolicy({ permissionRules: [ask] }, false, 2)).not.toThrow();
    expect(() => assertOpenCodePermissionPolicy({ permissionRules: [ask, { action: 'Shell*', resource: 'harmless-placeholder', effect: 'deny' }] }, false, 2)).not.toThrow();
  }));
  it('preserves the existing legacy Windows case-insensitive doom-loop check', () => onWindows(() => {
    expect(() => assertOpenCodePermissionPolicy({ permission: { DOOM_LOOP: 'ask' } }, true, 1)).not.toThrow();
  }));
});
