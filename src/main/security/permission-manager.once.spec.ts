import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('fs', () => ({ existsSync: () => false }));
vi.mock('electron', () => ({ app: { getPath: () => '/unused-test-home' } }));
vi.mock('../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
import { PermissionManager, type PermissionRequest } from './permission-manager';

describe('single-use permission decisions', () => {
  let manager: PermissionManager;
  const request = (id: string): PermissionRequest => ({ id, instanceId: 'once-test', scope: 'bash_execute', resource: 'echo example', timestamp: 1 });
  beforeEach(() => { PermissionManager._resetForTesting(); manager = PermissionManager.getInstance(); });
  afterEach(() => { manager.destroy(); });
  it.each(['allow', 'deny'] as const)('consumes a once %s on exactly one recheck', action => {
    manager.recordUserDecision('once-test', request('original'), action, 'once');
    expect(manager.checkPermission(request('original'))).toMatchObject({ action, fromCache: true });
    expect(manager.checkPermission(request('later'))).toMatchObject({ action: 'ask', fromCache: false });
  });
  it.each(['allow', 'deny'] as const)('keeps a once %s exclusive to the approved request', action => {
    manager.recordUserDecision('once-test', request('original'), action, 'once');
    expect(manager.checkPermission(request('distinct'))).toMatchObject({ action: 'ask', fromCache: false });
    expect(manager.checkPermission(request('original'))).toMatchObject({ action, fromCache: true });
    expect(manager.checkPermission(request('original'))).toMatchObject({ action: 'ask', fromCache: false });
  });
  it.each(['allow_all', 'deny_all'] as const)('preserves each duplicate-resource batch approval for %s once', action => {
    const batch = { batchId: 'duplicates', requests: [request('first'), request('second')], timestamp: 1 };
    manager.recordBatchDecision('once-test', batch, action, 'once');
    expect(manager.checkPermission(request('unapproved'))).toMatchObject({ action: 'ask', fromCache: false });
    const result = manager.checkBatchPermissions(batch);
    expect(result.aggregateAction).toBe(action);
    expect(result.decisions.map(decision => decision.request.id)).toEqual(['first', 'second']);
    expect(result.decisions.every(decision => decision.fromCache)).toBe(true);
    expect(manager.checkBatchPermissions(batch).aggregateAction).toBe('ask');
  });
  it('preserves the batch and queued-request recheck', () => {
    const batch = { batchId: 'batch', requests: [request('batch-request')], timestamp: 1 };
    manager.recordBatchDecision('once-test', batch, 'allow_all', 'once');
    expect(manager.checkBatchPermissions(batch).aggregateAction).toBe('allow_all');
    expect(manager.checkBatchPermissions(batch).aggregateAction).toBe('ask');
    manager.queuePermission(request('queued'));
    expect(manager.recordDecisionByRequestId('queued', 'allow', 'once')).toBe(true);
    expect(manager.checkPermission(request('distinct-queued')).action).toBe('ask');
    expect(manager.checkPermission(request('queued'))).toMatchObject({ action: 'allow', fromCache: true });
    expect(manager.checkPermission(request('next')).action).toBe('ask');
  });
  it('keeps session permission reusable', () => {
    manager.recordUserDecision('once-test', request('original'), 'allow', 'session');
    for (const id of ['one', 'two', 'three']) expect(manager.checkPermission(request(id)).action).toBe('allow');
  });
});
