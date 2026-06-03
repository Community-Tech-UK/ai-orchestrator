import { describe, it, expect, vi } from 'vitest';
import {
  deriveSubagentRules,
  applySubagentPermissions,
  type SubagentPermissionContext,
} from '../derive-subagent-permission';
import type { PermissionManager, PermissionRule } from '../../security/permission-manager';

/** Minimal PermissionManager stand-in exposing only what the module uses. */
function fakeManager(parentDenies: PermissionRule[] = []) {
  const applied: { key: string; rule: Omit<PermissionRule, 'id' | 'source'> }[] = [];
  const mgr = {
    getSessionDenyRules: vi.fn(() => parentDenies),
    addSessionRule: vi.fn((key: string, rule: Omit<PermissionRule, 'id' | 'source'>) => {
      applied.push({ key, rule });
      return { ...rule, id: 'x', source: 'session' } as PermissionRule;
    }),
  } as unknown as PermissionManager;
  return { mgr, applied };
}

const baseCtx = (overrides: Partial<SubagentPermissionContext>, mgr: PermissionManager): SubagentPermissionContext => ({
  parentInstanceId: 'parent-1',
  permissionManager: mgr,
  ...overrides,
});

describe('deriveSubagentRules (A7#18 child ≤ parent)', () => {
  it('forwards the parent\'s actual session deny rules (read by instance id)', () => {
    const parentDenies: PermissionRule[] = [
      {
        id: 'p1', source: 'session', name: 'no-secrets', scope: 'secret_access',
        pattern: '**', action: 'deny', priority: 5, enabled: true,
      } as PermissionRule,
    ];
    const { mgr } = fakeManager(parentDenies);
    const rules = deriveSubagentRules(baseCtx({}, mgr));
    expect(mgr.getSessionDenyRules).toHaveBeenCalledWith('parent-1');
    expect(rules.some((r) => r.scope === 'secret_access' && r.action === 'deny')).toBe(true);
    expect(rules.find((r) => r.scope === 'secret_access')?.name).toContain('inherited:');
  });

  it('forwards Plan-Mode write denies when the parent is planning', () => {
    const { mgr } = fakeManager();
    const rules = deriveSubagentRules(baseCtx({ parentPlanModeActive: true }, mgr));
    for (const scope of ['file_write', 'file_delete', 'directory_create', 'directory_delete', 'git_operation']) {
      expect(rules.some((r) => r.scope === scope && r.action === 'deny')).toBe(true);
    }
  });

  it('does NOT impose extra default-denies by default (no breakage of env/bash children)', () => {
    const { mgr } = fakeManager();
    const rules = deriveSubagentRules(baseCtx({}, mgr));
    expect(rules.some((r) => r.scope === 'environment_access')).toBe(false);
    expect(rules.some((r) => r.scope === 'secret_access')).toBe(false);
    expect(rules.some((r) => r.scope === 'bash_dangerous')).toBe(false);
  });

  it('imposes the stricter subagent default-denies only when opted in', () => {
    const { mgr } = fakeManager();
    const rules = deriveSubagentRules(baseCtx({ includeDefaultDenies: true }, mgr));
    for (const scope of ['bash_dangerous', 'environment_access', 'secret_access']) {
      expect(rules.some((r) => r.scope === scope && r.action === 'deny')).toBe(true);
    }
  });

  it('forwards external-directory restrictions', () => {
    const { mgr } = fakeManager();
    const rules = deriveSubagentRules(baseCtx({ parentExternalDirectories: ['/secret/dir'] }, mgr));
    expect(rules.some((r) => r.scope === 'directory_read' && r.pattern === '/secret/dir' && r.action === 'deny')).toBe(true);
  });
});

describe('applySubagentPermissions (keying)', () => {
  it('applies every derived rule under the CHILD instance id (what the evaluator reads)', () => {
    const { mgr, applied } = fakeManager();
    applySubagentPermissions('child-9', baseCtx({ parentPlanModeActive: true }, mgr));
    expect(applied.length).toBeGreaterThan(0);
    expect(applied.every((a) => a.key === 'child-9')).toBe(true);
    expect(applied.every((a) => a.rule.action === 'deny')).toBe(true);
  });

  it('is a no-op (no rules) for an unconstrained parent', () => {
    const { mgr, applied } = fakeManager();
    applySubagentPermissions('child-9', baseCtx({}, mgr));
    expect(applied.length).toBe(0);
  });
});
