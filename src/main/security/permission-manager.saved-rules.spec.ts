import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionManager, type PermissionRequest } from './permission-manager';

describe('saved permission decisions', () => {
  let directory: string;
  let manager: PermissionManager;
  const request: PermissionRequest = { id: 'ask', instanceId: 'session', scope: 'bash_execute', resource: 'bash:echo hello', timestamp: 1 };
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'saved-permissions-'));
    vi.spyOn(PermissionManager.prototype as unknown as { getHomeDir(): string }, 'getHomeDir').mockReturnValue(directory);
    PermissionManager._resetForTesting();
    manager = PermissionManager.getInstance();
  });
  afterEach(() => { manager.destroy(); vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }); });
  it('removes a lasting deny from disk and cache so the next call asks again, including after restart', () => {
    manager.recordUserDecision('session', request, 'deny', 'always');
    expect(manager.checkPermission(request).action).toBe('deny');
    expect(manager.checkPermission(request).fromCache).toBe(true);
    const rule = manager.listUserRules()[0];
    const removed = vi.fn(); manager.on('user_rule:removed', removed);
    expect(manager.removeUserRule(rule.id)).toBe(true);
    expect(removed).toHaveBeenCalledWith({ ruleId: rule.id });
    expect(manager.checkPermission(request).action).toBe('ask');
    expect(JSON.parse(readFileSync(join(directory, '.orchestrator/permissions.json'), 'utf8')).ruleSet.rules).toEqual([]);
    manager.destroy(); manager = PermissionManager.getInstance();
    expect(manager.listUserRules()).toEqual([]);
    expect(manager.checkPermission(request).action).toBe('ask');
    expect(manager.removeUserRule('missing')).toBe(false);
  });
  it('returns independent copies, including nested rule conditions', () => {
    manager.recordUserDecision('session', request, 'allow', 'always');
    manager.getRuleSet('user')!.rules[0].conditions = [{ type: 'instance_depth', value: 0, operator: 'equals' }];
    const copies = manager.listUserRules(); copies[0].pattern = 'changed';
    copies[0].conditions![0].value = 99;
    expect(manager.listUserRules()[0].conditions![0].value).toBe(0);
    expect(manager.listUserRules()[0].pattern).toBe(request.resource);
    copies.length = 0; expect(manager.listUserRules()).toHaveLength(1);
  });
  it('keeps the saved deny active when persisting its removal fails', () => {
    manager.recordUserDecision('session', request, 'deny', 'always');
    const id = manager.listUserRules()[0].id;
    rmSync(join(directory, '.orchestrator'), { recursive: true, force: true });
    writeFileSync(join(directory, '.orchestrator'), 'storage unavailable');
    const removed = vi.fn(); manager.on('user_rule:removed', removed);
    expect(() => manager.removeUserRule(id)).toThrow();
    expect(manager.listUserRules()[0].id).toBe(id);
    expect(manager.checkPermission(request).action).toBe('deny');
    expect(removed).not.toHaveBeenCalled();
  });

});
