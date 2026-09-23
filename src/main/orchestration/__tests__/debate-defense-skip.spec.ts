/**
 * Opt-in defense-round skipping (token/memory plan Task 7).
 *
 * vi.mock() paths are relative to this file: '../../logging/logger' is
 * src/main/logging/logger.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
}));
vi.mock('../../rlm/token-counter', () => ({
  estimateTokens: vi.fn((text: string) => Math.ceil(text.length / 4)),
}));

import { DebateCoordinator } from '../debate-coordinator';
import { critiquesShowNoMaterialIssues } from '../debate-consensus';
import type { CritiqueSeverity, DebateConfig, DebateSessionRound } from '../../../shared/types/debate.types';

const BASE_CONFIG: DebateConfig = {
  agents: 2,
  maxRounds: 4, // initial -> critique -> defense -> synthesis
  convergenceThreshold: 0.99,
  synthesisModel: 'default',
  temperatureRange: [0.3, 0.9],
  timeout: 5000,
};

type Callback = (response: string, tokens?: number) => void;

function wireHandlers(
  coordinator: DebateCoordinator,
  severityFor: (agentIndex: number) => CritiqueSeverity,
): string[] {
  const phases: string[] = [];
  coordinator.on('debate:generate-response', (p: { agentIndex: number; callback: Callback }) => {
    phases.push('initial');
    p.callback(`Agent ${p.agentIndex} unique stance ${'xyz'.repeat(p.agentIndex + 1)} alpha${p.agentIndex}. Confidence: 70%`, 30);
  });
  coordinator.on('debate:generate-critiques', (p: { agentIndex: number; callback: Callback }) => {
    phases.push('critique');
    const target = `agent-${p.agentIndex === 0 ? 1 : 0}`;
    p.callback(JSON.stringify({
      critiques: [{
        targetAgentId: target,
        issue: 'no material issues',
        severity: severityFor(p.agentIndex),
        counterpoint: 'the response is sound',
      }],
    }));
  });
  coordinator.on('debate:generate-defense', (p: { callback: Callback }) => {
    phases.push('defense');
    p.callback('I defend my position.\n## Confidence\n75%');
  });
  coordinator.on('debate:generate-synthesis', (p: { callback: Callback }) => {
    phases.push('synthesis');
    p.callback('Final synthesis.');
  });
  return phases;
}

async function runToCompletion(coordinator: DebateCoordinator, config: DebateConfig): Promise<string> {
  const completed = new Promise<void>((resolve) => coordinator.once('debate:completed', () => resolve()));
  const id = await coordinator.startDebate('Is the change safe?', undefined, config);
  await completed;
  return id;
}

describe('DebateCoordinator skipDefenseOnLowSeverityCritiques', () => {
  let coordinator: DebateCoordinator;

  beforeEach(() => {
    DebateCoordinator._resetForTesting();
    coordinator = DebateCoordinator.getInstance();
  });

  afterEach(() => {
    DebateCoordinator._resetForTesting();
  });

  it('skips the defense round and synthesizes when every critique is low severity', async () => {
    const phases = wireHandlers(coordinator, () => 'low');
    const skipped = vi.fn();
    coordinator.on('debate:defense-skipped', skipped);

    const id = await runToCompletion(coordinator, { ...BASE_CONFIG, skipDefenseOnLowSeverityCritiques: true });

    expect(phases.filter((p) => p === 'defense')).toHaveLength(0);
    expect(phases.filter((p) => p === 'synthesis')).toHaveLength(1);
    expect(coordinator.getResult(id)?.rounds.map((r) => r.type)).toEqual(['initial', 'critique', 'synthesis']);
    expect(coordinator.getResult(id)?.status).toBe('completed');
    expect(skipped).toHaveBeenCalledWith(expect.objectContaining({ debateId: id, round: 2 }));
  });

  it('still runs defense when one critique is medium severity', async () => {
    const phases = wireHandlers(coordinator, (agentIndex) => (agentIndex === 0 ? 'low' : 'medium'));
    const skipped = vi.fn();
    coordinator.on('debate:defense-skipped', skipped);

    const id = await runToCompletion(coordinator, { ...BASE_CONFIG, skipDefenseOnLowSeverityCritiques: true });

    expect(phases.filter((p) => p === 'defense')).toHaveLength(2);
    expect(coordinator.getResult(id)?.rounds.map((r) => r.type)).toEqual(['initial', 'critique', 'defense', 'synthesis']);
    expect(skipped).not.toHaveBeenCalled();
  });

  it('still runs defense for all-low critiques when the flag is off (default)', async () => {
    const phases = wireHandlers(coordinator, () => 'low');
    const skipped = vi.fn();
    coordinator.on('debate:defense-skipped', skipped);

    const id = await runToCompletion(coordinator, BASE_CONFIG);

    expect(phases.filter((p) => p === 'defense')).toHaveLength(2);
    expect(coordinator.getResult(id)?.rounds.map((r) => r.type)).toEqual(['initial', 'critique', 'defense', 'synthesis']);
    expect(skipped).not.toHaveBeenCalled();
  });
});

describe('critiquesShowNoMaterialIssues', () => {
  function critiqueRound(severities: (CritiqueSeverity[] | undefined)[], type: DebateSessionRound['type'] = 'critique'): DebateSessionRound {
    return {
      roundNumber: 2,
      type,
      contributions: severities.map((list, i) => ({
        agentId: `agent-${i}`,
        content: 'position',
        confidence: 0.7,
        reasoning: '',
        ...(list ? { critiques: list.map((severity) => ({ targetAgentId: 'agent-9', issue: 'x', severity })) } : {}),
      })),
      consensusScore: 0.2,
      timestamp: 1,
      durationMs: 1,
    };
  }

  it('is true when every contribution has only low critiques', () => {
    expect(critiquesShowNoMaterialIssues(critiqueRound([['low'], ['low', 'low']]))).toBe(true);
  });

  it.each<CritiqueSeverity>(['medium', 'high', 'critical'])('is false when any critique is %s', (severity) => {
    expect(critiquesShowNoMaterialIssues(critiqueRound([['low'], ['low', severity]]))).toBe(false);
  });

  it('is false when a contribution has no critiques or an empty list', () => {
    expect(critiquesShowNoMaterialIssues(critiqueRound([['low'], undefined]))).toBe(false);
    expect(critiquesShowNoMaterialIssues(critiqueRound([['low'], []]))).toBe(false);
  });

  it('is false for non-critique rounds and empty rounds', () => {
    expect(critiquesShowNoMaterialIssues(critiqueRound([['low']], 'defense'))).toBe(false);
    expect(critiquesShowNoMaterialIssues(critiqueRound([]))).toBe(false);
  });
});
