import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockHome = vi.hoisted(() => ({ dir: '' }));

// Mirrors permission-manager.literal-bash.spec.ts: pin the "home" dir so
// PermissionManager's constructor-time disk load/persist never touches the
// real ~/.orchestrator/permissions.json.
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => mockHome.dir) },
}));
vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { PermissionManager, type PermissionRequest } from './permission-manager';

function secretRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id: `req-${Math.random().toString(36).slice(2)}`,
    instanceId: 'inst-1',
    scope: 'secret_access',
    resource: 'DB_PASSWORD',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('PermissionManager — WS-B3 never-delegable category guard', () => {
  let pm: PermissionManager;
  let prevHome: string | undefined;

  beforeEach(() => {
    mockHome.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-mgr-b3-'));
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

  it('forces ask on a categorized request even under YOLO mode', () => {
    const decision = pm.checkPermission(
      secretRequest({ context: { yoloMode: true } }),
    );
    expect(decision.action).toBe('ask');
    expect(decision.category).toBe('credentials');
    expect(decision.decidedBy).toBe('never-delegable-guard');
    expect(decision.reason).toBe('never-delegable:credentials');
  });

  it('forces ask on a categorized request even when a matching allow-rule exists', () => {
    // Record a user "always allow" rule for this exact secret_access resource —
    // without the guard this would auto-allow on the next identical request.
    pm.recordUserDecision('sess-1', secretRequest(), 'allow', 'always');

    const decision = pm.checkPermission(secretRequest());
    expect(decision.action).toBe('ask');
    expect(decision.category).toBe('credentials');
    expect(decision.decidedBy).toBe('never-delegable-guard');
  });

  it('never caches a categorized decision, so a later non-categorized identical resource is unaffected', () => {
    const first = pm.checkPermission(secretRequest());
    expect(first.fromCache).toBe(false);

    const second = pm.checkPermission(secretRequest());
    expect(second.fromCache).toBe(false); // re-derived, never served from cache
    expect(second.action).toBe('ask');
  });

  it('an explicit hint forces ask for a scope with no structural signal (external_publish)', () => {
    const request: PermissionRequest = {
      id: 'req-publish',
      instanceId: 'inst-1',
      scope: 'external_service',
      resource: 'gh pr create',
      context: { yoloMode: true, categoryHint: 'external_publish' },
      timestamp: Date.now(),
    };
    const decision = pm.checkPermission(request);
    expect(decision.action).toBe('ask');
    expect(decision.category).toBe('external_publish');
  });

  it('ordinary (uncategorized) YOLO requests are unaffected — still an immediate allow', () => {
    const decision = pm.checkPermission({
      id: 'req-ordinary',
      instanceId: 'inst-1',
      scope: 'file_read',
      resource: '/tmp/foo.txt',
      context: { yoloMode: true },
      timestamp: Date.now(),
    });
    expect(decision.action).toBe('allow');
    expect(decision.category).toBeUndefined();
    expect(decision.decidedBy).toBe('yolo');
  });

  it('tags decidedBy="user" for a matched rule sourced from an explicit user decision', () => {
    const request: PermissionRequest = {
      id: 'req-tool',
      instanceId: 'inst-1',
      scope: 'tool_use',
      resource: 'tool:Read',
      timestamp: Date.now(),
    };
    pm.recordUserDecision('sess-1', request, 'allow', 'always');

    const decision = pm.checkPermission(request);
    expect(decision.action).toBe('allow');
    expect(decision.decidedBy).toBe('user');
  });

  it('tags decidedBy="rule" for a matched system rule', () => {
    const decision = pm.checkPermission({
      id: 'req-system',
      instanceId: 'inst-1',
      scope: 'bash_dangerous',
      resource: 'rm -rf /',
      timestamp: Date.now(),
    });
    expect(decision.action).toBe('deny');
    expect(decision.decidedBy).toBe('rule');
  });
});
