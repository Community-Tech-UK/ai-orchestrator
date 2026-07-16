import { describe, expect, it } from 'vitest';
import { ContextTokenEstimator } from './context-token-estimator';
import { WorkingSetPlanner, type WorkingSetCandidate } from './working-set-planner';

const oneCharOneToken = new ContextTokenEstimator((text) => text.length);

function candidate(
  id: string,
  overrides: Partial<WorkingSetCandidate> = {},
): WorkingSetCandidate {
  return {
    id,
    content: id,
    createdAt: 1,
    captureCompleteness: 'complete',
    ...overrides,
  };
}

describe('WorkingSetPlanner', () => {
  it('uses the default 15/15/15/15/25/15 allocation for a known window', () => {
    const planner = new WorkingSetPlanner(oneCharOneToken);

    const result = planner.plan({
      capacityTokens: 1_000,
      requiredInstructions: ['rules'],
      latestUserIntent: 'intent',
      recentDialogue: [],
      activeTaskState: [],
      evidenceCards: [],
      exactExcerpts: [],
    });

    expect(result.allocation).toEqual({
      capacityTokens: 1_000,
      instructionsTokens: 150,
      recentDialogueTokens: 150,
      evidenceCardTokens: 150,
      exactExcerptTokens: 150,
      reasoningAndAnswerTokens: 250,
      emergencyReserveTokens: 150,
      normalWorkingSetTokens: 600,
      totalAllocatedTokens: 1_000,
      estimateKind: 'provider-tokenizer',
    });
    expect(result.status).toBe('ready');
  });

  it('expands required control-plane allocation without exceeding the 60% ordinary ceiling', () => {
    const planner = new WorkingSetPlanner(oneCharOneToken);

    const result = planner.plan({
      capacityTokens: 100,
      requiredInstructions: ['x'.repeat(20)],
      latestUserIntent: 'y'.repeat(5),
      recentDialogue: [candidate('dialogue', { content: 'd'.repeat(20) })],
      activeTaskState: [],
      evidenceCards: [candidate('card', { content: 'c'.repeat(20) })],
      exactExcerpts: [candidate('excerpt', { content: 'e'.repeat(20) })],
    });

    expect(result.requiredControlTokens).toBe(25);
    expect(result.controlPlaneOverageTokens).toBe(10);
    expect(result.allocation.instructionsTokens).toBe(25);
    expect(result.allocation.normalWorkingSetTokens).toBe(60);
    expect(result.allocation.exactExcerptTokens).toBeLessThan(15);
    expect(result.status).toBe('ready');
  });

  it('enters a visible degraded state when required control exceeds 30% of capacity', () => {
    const planner = new WorkingSetPlanner(oneCharOneToken);

    const result = planner.plan({
      capacityTokens: 100,
      requiredInstructions: ['x'.repeat(31)],
      latestUserIntent: '',
      recentDialogue: [],
      activeTaskState: [],
      evidenceCards: [],
      exactExcerpts: [],
    });

    expect(result.status).toBe('degraded');
    expect(result.requiredControlTokens).toBe(31);
    expect(result.disclosures).toContain('Required control-plane content exceeds 30% of the provider window.');
  });

  it('routes to an available larger model window before degrading optional context', () => {
    const planner = new WorkingSetPlanner(oneCharOneToken);

    const result = planner.plan({
      capacityTokens: 100,
      largerModelCapacityTokens: 200,
      requiredInstructions: ['x'.repeat(31)],
      latestUserIntent: '',
      recentDialogue: [],
      activeTaskState: [],
      evidenceCards: [],
      exactExcerpts: [],
    });

    expect(result.status).toBe('ready');
    expect(result.allocation.capacityTokens).toBe(200);
    expect(result.disclosures).toContain('Working set routed to an available larger provider window.');
  });

  it('pauses instead of truncating required instructions or latest user intent above 60%', () => {
    const planner = new WorkingSetPlanner(oneCharOneToken);
    const required = 'r'.repeat(50);
    const intent = 'i'.repeat(11);

    const result = planner.plan({
      capacityTokens: 100,
      requiredInstructions: [required],
      latestUserIntent: intent,
      recentDialogue: [],
      activeTaskState: [],
      evidenceCards: [],
      exactExcerpts: [],
    });

    expect(result.status).toBe('paused');
    expect(result.requiredControlTokens).toBe(61);
    expect(result.requiredControl).toEqual([required, intent]);
    expect(result.selected).toEqual({ recentDialogue: [], evidenceCards: [], exactExcerpts: [] });
    expect(result.allocation.normalWorkingSetTokens).toBe(60);
  });

  it('uses an explicit absolute budget without pretending an unknown window is known', () => {
    const planner = new WorkingSetPlanner(oneCharOneToken);

    const result = planner.plan({
      requiredInstructions: ['rules'],
      latestUserIntent: 'intent',
      recentDialogue: [],
      activeTaskState: [],
      evidenceCards: [],
      exactExcerpts: [],
    });

    expect(result.allocation.capacityTokens).toBeUndefined();
    expect(result.allocation).toMatchObject({
      instructionsTokens: 1_024,
      recentDialogueTokens: 1_024,
      evidenceCardTokens: 1_024,
      exactExcerptTokens: 1_024,
      reasoningAndAnswerTokens: 2_048,
      emergencyReserveTokens: 1_024,
      normalWorkingSetTokens: 4_096,
      totalAllocatedTokens: 7_168,
    });
    expect(result.disclosures).toContain('Provider context capacity is unknown; absolute token budgets are in effect.');
  });

  it('ranks candidates deterministically by explicit references, contradictions, failures, entities, recency, then id', () => {
    const planner = new WorkingSetPlanner(oneCharOneToken);
    const candidates = [
      candidate('z-recent', { createdAt: 9 }),
      candidate('a-recent', { createdAt: 9 }),
      candidate('entity', { activeTaskEntityMatches: 1 }),
      candidate('failed', { failedVerification: true }),
      candidate('contradiction', { hasUnresolvedContradiction: true }),
      candidate('explicit', { explicitUserReference: true }),
    ];

    const result = planner.plan({
      capacityTokens: 10_000,
      requiredInstructions: [],
      latestUserIntent: '',
      recentDialogue: [],
      activeTaskState: [],
      evidenceCards: candidates,
      exactExcerpts: [],
    });

    expect(result.selected.evidenceCards.map((item) => item.id)).toEqual([
      'explicit',
      'contradiction',
      'failed',
      'entity',
      'a-recent',
      'z-recent',
    ]);
  });

  it('does not spend unused card capacity on additional exact excerpts', () => {
    const planner = new WorkingSetPlanner(oneCharOneToken);
    const excerpts = Array.from({ length: 4 }, (_, index) => candidate(`e${index}`, {
      content: 'x'.repeat(50),
      createdAt: index,
    }));

    const result = planner.plan({
      capacityTokens: 1_000,
      requiredInstructions: [],
      latestUserIntent: '',
      recentDialogue: [],
      activeTaskState: [],
      evidenceCards: [],
      exactExcerpts: excerpts,
    });

    expect(result.selected.exactExcerpts).toHaveLength(1);
    expect(result.usedTokens.exactExcerpts).toBeLessThanOrEqual(150);
    expect(result.unusedOptionalTokens).toBeGreaterThan(0);
    expect(result.reasoningAndEmergencyAvailableTokens).toBe(
      result.allocation.reasoningAndAnswerTokens
      + result.allocation.emergencyReserveTokens
      + result.unusedOptionalTokens,
    );
  });

  it('enforces known 30/60 percent and unknown absolute budgets with the fallback estimator', () => {
    const planner = new WorkingSetPlanner();
    const base = {
      latestUserIntent: '', recentDialogue: [], activeTaskState: [],
      evidenceCards: [], exactExcerpts: [],
    };

    const degraded = planner.plan({
      ...base, capacityTokens: 1_000, requiredInstructions: ['x'.repeat(301)],
    });
    const paused = planner.plan({
      ...base, capacityTokens: 1_000, requiredInstructions: ['x'.repeat(601)],
    });
    const unknown = planner.plan({
      ...base, requiredInstructions: ['x'.repeat(1_000)],
    });

    expect(degraded.status).toBe('degraded');
    expect(degraded.allocation.estimateKind).toBe('conservative-fallback');
    expect(degraded.renderAccounting.totalTokens)
      .toBeLessThanOrEqual(degraded.allocation.normalWorkingSetTokens);
    expect(paused.status).toBe('paused');
    expect(unknown.status).toBe('ready');
    expect(unknown.allocation.capacityTokens).toBeUndefined();
    expect(unknown.renderAccounting.totalTokens)
      .toBeLessThanOrEqual(unknown.allocation.normalWorkingSetTokens);
  });
});
