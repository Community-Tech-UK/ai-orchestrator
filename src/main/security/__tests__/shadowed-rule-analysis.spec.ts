import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockHome = vi.hoisted(() => ({ dir: '' }));

// Same isolation approach as permission-manager.literal-bash.spec.ts: pin the
// home dir PermissionManager persists to so tests never touch a real
// ~/.orchestrator/permissions.json.
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => mockHome.dir) },
}));
vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { PermissionManager } from '../permission-manager';

describe('PermissionManager.analyzeShadowedRules', () => {
  let pm: PermissionManager;
  let prevHome: string | undefined;

  beforeEach(() => {
    mockHome.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-mgr-shadow-'));
    prevHome = process.env['HOME'];
    process.env['HOME'] = mockHome.dir;
    PermissionManager._resetForTesting();
    pm = PermissionManager.getInstance();
  });

  afterEach(() => {
    PermissionManager._resetForTesting();
    if (prevHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = prevHome;
    try {
      fs.rmSync(mockHome.dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it('reuses PermissionManager precedence ordering to find a real shadowed rule', () => {
    // System ships 'Allow CWD Read' (./** , priority 1000, allow) for
    // file_read. Add a user rule that can never fire because the system
    // rule — despite its lower precedence tier — has a lower (higher-
    // priority) number... use a scope/pattern combo where a genuinely
    // unreachable user rule is created via addRuleSet/addRule.
    const userRuleSet = pm.getRuleSet('user') ?? { id: 'user', name: 'User Rules', source: 'user' as const, rules: [], enabled: true };
    pm.addRuleSet(userRuleSet);
    pm.addRule('user', {
      name: 'Redundant CWD allow',
      scope: 'file_read',
      pattern: 'src/index.ts',
      literal: true,
      action: 'allow',
      priority: 2000, // evaluated after the system './**' rule (priority 1000)
      source: 'user',
      enabled: true,
    });

    const findings = pm.analyzeShadowedRules('file_read');
    const shadowed = findings.find((f) => f.rule.pattern === 'src/index.ts');
    expect(shadowed).toBeDefined();
    expect(shadowed?.shadowedBy.name).toBe('Allow CWD Read');
    expect(shadowed?.kind).toBe('redundant'); // both allow
  });

  it('is read-only: repeated calls do not mutate rule sets or cache', () => {
    const before = pm.getStats();
    pm.analyzeShadowedRules();
    pm.analyzeShadowedRules('bash_dangerous');
    const after = pm.getStats();
    expect(after).toEqual(before);
  });

  it('scopes analysis to a single scope when requested', () => {
    const fileFindings = pm.analyzeShadowedRules('file_read');
    const allFindings = pm.analyzeShadowedRules();
    expect(fileFindings.every((f) => f.rule.scope === 'file_read')).toBe(true);
    expect(allFindings.length).toBeGreaterThanOrEqual(fileFindings.length);
  });

  it('does not consider session or per-agent rules tied to a live request', () => {
    pm.addSessionRule('some-instance', {
      name: 'session-only deny',
      scope: 'file_read',
      pattern: 'src/index.ts',
      literal: true,
      action: 'deny',
      priority: 1,
      enabled: true,
    });
    pm.addAgentRule('some-agent', {
      name: 'agent-only allow',
      scope: 'file_read',
      pattern: 'src/other.ts',
      literal: true,
      action: 'allow',
      priority: 1,
      enabled: true,
    });

    const findings = pm.analyzeShadowedRules('file_read');
    expect(findings.some((f) => f.rule.source === 'session' || f.shadowedBy.source === 'session')).toBe(false);
    expect(findings.some((f) => f.rule.source === 'agent' || f.shadowedBy.source === 'agent')).toBe(false);
  });
});
