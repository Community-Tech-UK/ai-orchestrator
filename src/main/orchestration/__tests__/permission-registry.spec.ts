import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PermissionRegistry } from '../permission-registry';
import { evaluateOrchestrationCapability } from '../role-capability-policy';

describe('PermissionRegistry', () => {
  beforeEach(() => {
    PermissionRegistry._resetForTesting();
  });

  it('should register and resolve a permission', async () => {
    const registry = PermissionRegistry.getInstance();
    const promise = registry.requestPermission({
      id: 'perm-1', instanceId: 'inst-1', action: 'write_file',
      description: 'Write to /tmp/test.txt', createdAt: Date.now(), timeoutMs: 5000,
    });

    expect(registry.getPendingCount()).toBe(1);
    registry.resolve('perm-1', true, 'user');

    const decision = await promise;
    expect(decision.granted).toBe(true);
    expect(decision.decidedBy).toBe('user');
    expect(registry.getPendingCount()).toBe(0);
  });

  it('should deny on timeout', async () => {
    vi.useFakeTimers();
    const registry = PermissionRegistry.getInstance();
    const promise = registry.requestPermission({
      id: 'perm-2', instanceId: 'inst-1', action: 'delete_file',
      description: 'Delete /tmp/test.txt', createdAt: Date.now(), timeoutMs: 100,
    });

    vi.advanceTimersByTime(150);
    const decision = await promise;
    expect(decision.granted).toBe(false);
    expect(decision.decidedBy).toBe('timeout');
    vi.useRealTimers();
  });

  it('should handle resolving unknown request gracefully', () => {
    const registry = PermissionRegistry.getInstance();
    registry.resolve('nonexistent', true, 'user'); // Should not throw
  });

  it('should list pending requests', () => {
    const registry = PermissionRegistry.getInstance();
    registry.requestPermission({ id: 'a', instanceId: 'i1', action: 'bash', description: 'Run cmd', createdAt: Date.now(), timeoutMs: 5000 });
    registry.requestPermission({ id: 'b', instanceId: 'i2', action: 'write', description: 'Write file', createdAt: Date.now(), timeoutMs: 5000 });
    expect(registry.listPending()).toHaveLength(2);
  });

  it('should clean up on instance removal', () => {
    const registry = PermissionRegistry.getInstance();
    registry.requestPermission({ id: 'c', instanceId: 'remove-me', action: 'bash', description: 'Something', createdAt: Date.now(), timeoutMs: 60000 });
    expect(registry.getPendingCount()).toBe(1);
    registry.clearForInstance('remove-me');
    expect(registry.getPendingCount()).toBe(0);
  });
});

describe('role capability policy', () => {
  it('allows parents to spawn children but blocks workers from spawning recursively', () => {
    const command = {
      action: 'spawn_child' as const,
      task: 'Review this patch',
    };

    expect(evaluateOrchestrationCapability('parent_orchestrator', command).allowed).toBe(true);
    const workerDecision = evaluateOrchestrationCapability('worker', command);
    expect(workerDecision.allowed).toBe(false);
    expect(workerDecision.reason).toContain('worker cannot spawn');
  });

  it('allows workers to report results', () => {
    const command = {
      action: 'report_result' as const,
      summary: 'done',
      success: true,
    };

    expect(evaluateOrchestrationCapability('worker', command).allowed).toBe(true);
  });
});
