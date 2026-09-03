import { describe, expect, it } from 'vitest';
import { computeCommandSignature } from './orchestration-command-signature';
import type { OrchestratorCommand } from './orchestration-protocol';

describe('computeCommandSignature', () => {
  it('uses the task prefix and spawn identity for spawn_child', () => {
    expect(computeCommandSignature({
      action: 'spawn_child',
      task: 'Investigate the failing login flow in depth',
      name: 'login-probe',
      provider: 'claude',
      model: 'opus',
    } as OrchestratorCommand)).toBe(
      'spawn_child:Investigate the failing login flow in depth:login-probe:claude:opus',
    );
  });

  it('dedups message_child by child and truncated message', () => {
    expect(computeCommandSignature({
      action: 'message_child',
      childId: 'child-1',
      message: 'please continue',
    } as OrchestratorCommand)).toBe('message_child:child-1:please continue');
  });

  it('is stable for identical consensus queries', () => {
    const command = {
      action: 'consensus_query',
      question: 'Should we ship this?',
      providers: ['claude', 'codex'],
    } as OrchestratorCommand;
    expect(computeCommandSignature(command)).toBe(computeCommandSignature({ ...command }));
  });

  it('falls back to action plus a JSON slice for unknown shapes', () => {
    expect(computeCommandSignature({
      action: 'get_children',
    } as OrchestratorCommand)).toMatch(/^get_children:/);
  });
});
