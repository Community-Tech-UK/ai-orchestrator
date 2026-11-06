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

  describe('create_automation (R2C S6)', () => {
    const automation = {
      name: 'Mail check',
      schedule: { type: 'cron', expression: '*/5 * * * *', timezone: 'UTC' },
      action: { prompt: 'Check the mailbox.' },
    };
    const create = (extra: Record<string, unknown> = {}, patch: Record<string, unknown> = {}): OrchestratorCommand => ({
      action: 'create_automation',
      automation: { ...automation, ...patch },
      ...extra,
    } as OrchestratorCommand);

    it('is identical for an identical repeat', () => {
      expect(computeCommandSignature(create())).toBe(computeCommandSignature(create()));
    });

    it('differs once the command carries confirmedByUser: true', () => {
      expect(computeCommandSignature(create({ confirmedByUser: true }))).not.toBe(computeCommandSignature(create()));
    });

    it('treats an absent flag and an explicit false the same, and a non-true flag as unconfirmed', () => {
      expect(computeCommandSignature(create({ confirmedByUser: false }))).toBe(computeCommandSignature(create()));
      expect(computeCommandSignature(create({ confirmedByUser: 'true' }))).toBe(computeCommandSignature(create()));
    });

    it('differs when a corrected retry changes a field outside name, schedule and prompt', () => {
      expect(computeCommandSignature(create({}, { enabled: false }))).not.toBe(computeCommandSignature(create()));
    });
  });

  it('falls back to action plus a JSON slice for unknown shapes', () => {
    expect(computeCommandSignature({
      action: 'get_children',
    } as OrchestratorCommand)).toMatch(/^get_children:/);
  });
});
