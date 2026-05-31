import { describe, it, expect, afterEach } from 'vitest';
import { PermissionManager } from '../permission-manager';

/**
 * Per-agent permission overrides (#18). Verifies that a rule registered for a
 * specific agentId applies only to requests carrying that agentId.
 */
describe('per-agent permission overrides', () => {
  const pm = PermissionManager.getInstance();
  const agentId = `agent-test-${Math.random().toString(36).slice(2)}`;

  afterEach(() => pm.clearAgentRules(agentId));

  // The decision cache keys on instanceId:scope:resource, and in production an
  // instance has a fixed agentId (1:1), so each check uses a distinct instanceId
  // to mirror reality (and avoid a cross-agent cache hit).
  function check(resource: string, ctxAgentId: string | undefined, instanceId: string) {
    return pm.checkPermission({
      id: `t-${Math.random().toString(36).slice(2)}`,
      instanceId,
      scope: 'tool_use',
      resource,
      context: ctxAgentId ? { agentId: ctxAgentId } : undefined,
      timestamp: Date.now(),
    });
  }

  it('applies a deny override only to the matching agent', () => {
    pm.addAgentRule(agentId, {
      name: 'block dangerous_tool for this agent',
      scope: 'tool_use',
      pattern: '^dangerous_tool$',
      action: 'deny',
      priority: 1, // highest — evaluated first
      enabled: true,
    });

    const denied = check('dangerous_tool', agentId, 'inst-risky');
    expect(denied.action).toBe('deny');
    expect(denied.matchedRule?.source).toBe('agent');

    // A request from a different agent is NOT governed by this override.
    const other = check('dangerous_tool', 'some-other-agent', 'inst-other');
    expect(other.matchedRule?.source).not.toBe('agent');

    // A request with no agent identity is likewise unaffected.
    const anon = check('dangerous_tool', undefined, 'inst-anon');
    expect(anon.matchedRule?.source).not.toBe('agent');
  });

  it('cannot override a built-in system security deny (priority is clamped)', () => {
    // A hostile agent rule tries to ALLOW SSH key reads at top priority.
    pm.addAgentRule(agentId, {
      name: 'evil allow ssh',
      scope: 'file_read',
      pattern: '**/.ssh/**',
      action: 'allow',
      priority: 1, // will be clamped to the floor (20), below system deny (5)
      enabled: true,
    });
    const decision = pm.checkPermission({
      id: `t-${Math.random().toString(36).slice(2)}`,
      instanceId: 'inst-evil',
      scope: 'file_read',
      resource: '/home/user/.ssh/id_rsa',
      context: { agentId },
      timestamp: Date.now(),
    });
    expect(decision.action).toBe('deny');
    // The clamp must have been applied.
    expect(pm.getAgentRules(agentId)[0].priority).toBeGreaterThanOrEqual(20);
  });

  it('records and clears agent rules', () => {
    pm.addAgentRule(agentId, {
      name: 'rule', scope: 'tool_use', pattern: 'x', action: 'allow', priority: 5, enabled: true,
    });
    expect(pm.getAgentRules(agentId)).toHaveLength(1);
    pm.clearAgentRules(agentId);
    expect(pm.getAgentRules(agentId)).toHaveLength(0);
  });
});
