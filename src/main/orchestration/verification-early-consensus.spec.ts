import { describe, expect, it, vi } from 'vitest';
import type { AgentResponse, EarlyTerminationConfig } from '../../shared/types/verification.types';
import {
  DEFAULT_EARLY_TERMINATION,
  EARLY_CONSENSUS_DROP_ERROR,
  checkEarlyConsensus,
  dropPendingAgents,
  raceWithEarlyConsensus,
  stripVerificationBoilerplate,
  type ConsensusEmbedder,
  type EarlyDropSession,
} from './verification-early-consensus';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const ENABLED: EarlyTerminationConfig = { ...DEFAULT_EARLY_TERMINATION, enabled: true };

function response(index: number, text: string, error?: string): AgentResponse {
  return {
    agentId: `agent-${index}`,
    agentIndex: index,
    model: `cli:agent-${index}`,
    response: text,
    keyPoints: [],
    confidence: 0.8,
    duration: 1,
    tokens: 10,
    cost: 0,
    ...(error ? { error } : {}),
  };
}

/** Embeds each text as a fixed vector looked up by its first word. */
function fakeEmbedder(vectors: Record<string, number[]>): ConsensusEmbedder & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    getEmbeddings: async (texts) => {
      calls.push(texts);
      return texts.map((text) => vectors[text.split(/\s+/)[0]] ?? [0, 0, 1]);
    },
    cosineSimilarity: (a, b) => {
      const dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
      const norm = Math.hypot(...a) * Math.hypot(...b);
      return norm === 0 ? 0 : dot / norm;
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('DEFAULT_EARLY_TERMINATION', () => {
  it('is off by default with the conservative plan thresholds', () => {
    expect(DEFAULT_EARLY_TERMINATION).toEqual({ enabled: false, consensusThreshold: 0.8, minAgentsForConsensus: 2 });
  });
});

describe('stripVerificationBoilerplate', () => {
  it('removes the shared Key Points / Overall Confidence / Reasoning Summary sections', () => {
    const text = [
      'The retry loop is bounded.',
      '## Key Points',
      '- [fact] bounded (Confidence: 90%)',
      '## Reasoning Summary',
      'Because of the counter.',
      '**Overall Confidence**',
      '90%',
      '## Other',
      'Kept text.',
    ].join('\n');
    expect(stripVerificationBoilerplate(text)).toBe('The retry loop is bounded.\n## Other\nKept text.');
  });

  it('leaves nothing for an answer that is only boilerplate', () => {
    expect(stripVerificationBoilerplate('## Key Points\n- [fact] x\n## Overall Confidence\n80%')).toBe('');
  });
});

describe('checkEarlyConsensus', () => {
  const embed = fakeEmbedder({ alpha: [1, 0, 0], alpha2: [0.99, 0.1, 0], beta: [0, 1, 0] });

  it('reaches consensus when answers are highly similar and enough agents answered', async () => {
    const check = await checkEarlyConsensus([response(0, 'alpha one'), response(1, 'alpha2 two')], ENABLED, embed);
    expect(check.reached).toBe(true);
    expect(check.consideredAgents).toBe(2);
    expect(check.similarity).toBeGreaterThan(0.9);
  });

  it('does not reach consensus when answers diverge', async () => {
    const check = await checkEarlyConsensus([response(0, 'alpha'), response(1, 'beta')], ENABLED, embed);
    expect(check.reached).toBe(false);
    expect(check.similarity).toBeCloseTo(0);
  });

  it('returns false below minAgentsForConsensus', async () => {
    const cfg = { ...ENABLED, minAgentsForConsensus: 3 };
    const check = await checkEarlyConsensus([response(0, 'alpha'), response(1, 'alpha')], cfg, embed);
    expect(check).toEqual({ reached: false, similarity: 0, consideredAgents: 2 });
  });

  it('returns false when disabled or unset without embedding anything', async () => {
    const spy = fakeEmbedder({});
    const pair = [response(0, 'alpha'), response(1, 'alpha')];
    expect((await checkEarlyConsensus(pair, DEFAULT_EARLY_TERMINATION, spy)).reached).toBe(false);
    expect((await checkEarlyConsensus(pair, undefined, spy)).reached).toBe(false);
    expect(spy.calls).toHaveLength(0);
  });

  it('ignores errored answers and answers that are only shared boilerplate', async () => {
    const spy = fakeEmbedder({ alpha: [1, 0, 0] });
    const check = await checkEarlyConsensus([
      response(0, 'alpha'),
      response(1, 'alpha', 'provider failed'),
      response(2, '## Key Points\n- [fact] alpha\n## Overall Confidence\n90%'),
    ], ENABLED, spy);
    expect(check.reached).toBe(false);
    expect(check.consideredAgents).toBe(1);
    expect(spy.calls).toHaveLength(0);
  });
});

describe('raceWithEarlyConsensus', () => {
  const embed = fakeEmbedder({ alpha: [1, 0, 0], beta: [0, 1, 0] });

  it('is plain Promise.all when disabled', async () => {
    const onConsensus = vi.fn();
    const result = await raceWithEarlyConsensus(
      [Promise.resolve(response(0, 'alpha')), Promise.resolve(response(1, 'alpha'))],
      DEFAULT_EARLY_TERMINATION,
      onConsensus,
      embed,
    );
    expect(result).toEqual({ responses: [response(0, 'alpha'), response(1, 'alpha')] });
    expect(onConsensus).not.toHaveBeenCalled();
  });

  it('calls onConsensus once with only the still-pending agents and keeps agent order', async () => {
    const slow = deferred<AgentResponse>();
    const onConsensus = vi.fn(() => { slow.resolve(response(2, '', EARLY_CONSENSUS_DROP_ERROR)); });

    const result = await raceWithEarlyConsensus(
      [Promise.resolve(response(0, 'alpha a')), Promise.resolve(response(1, 'alpha b')), slow.promise],
      ENABLED,
      onConsensus,
      embed,
    );

    expect(onConsensus).toHaveBeenCalledTimes(1);
    expect(onConsensus).toHaveBeenCalledWith([2], expect.objectContaining({ reached: true, consideredAgents: 2 }));
    expect(result.responses.map((r) => r.agentIndex)).toEqual([0, 1, 2]);
    expect(result.responses[2]?.error).toBe(EARLY_CONSENSUS_DROP_ERROR);
    expect(result.earlyConsensus).toEqual({
      similarity: 1,
      threshold: 0.8,
      consideredAgents: 2,
      droppedAgentIndexes: [2],
    });
  });

  it('never fires when the panel disagrees, and waits for everyone', async () => {
    const onConsensus = vi.fn();
    const result = await raceWithEarlyConsensus(
      [Promise.resolve(response(0, 'alpha')), Promise.resolve(response(1, 'beta')), Promise.resolve(response(2, 'alpha'))],
      ENABLED,
      onConsensus,
      embed,
    );
    expect(onConsensus).not.toHaveBeenCalled();
    expect(result.earlyConsensus).toBeUndefined();
    expect(result.responses).toHaveLength(3);
  });

  it('does not fire once every agent has already settled', async () => {
    const onConsensus = vi.fn();
    const result = await raceWithEarlyConsensus(
      [Promise.resolve(response(0, 'alpha')), Promise.resolve(response(1, 'alpha'))],
      ENABLED,
      onConsensus,
      embed,
    );
    expect(onConsensus).not.toHaveBeenCalled();
    expect(result.earlyConsensus).toBeUndefined();
  });

  it('falls back to waiting for everyone when the embedding check throws', async () => {
    const broken: ConsensusEmbedder = {
      getEmbeddings: () => Promise.reject(new Error('embedding offline')),
      cosineSimilarity: () => 1,
    };
    const slow = deferred<AgentResponse>();
    const onConsensus = vi.fn();
    const race = raceWithEarlyConsensus(
      [Promise.resolve(response(0, 'alpha')), Promise.resolve(response(1, 'alpha')), slow.promise],
      ENABLED,
      onConsensus,
      broken,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    slow.resolve(response(2, 'alpha'));
    const result = await race;
    expect(onConsensus).not.toHaveBeenCalled();
    expect(result.responses[2]?.error).toBeUndefined();
  });
});

describe('dropPendingAgents', () => {
  it('marks, announces, then force-terminates only the pending agents without cancelling', async () => {
    const session: EarlyDropSession & { cancelled: boolean } = { cancelled: false };
    const order: string[] = [];
    const agents = [0, 1, 2].map((index) => ({
      provider: {
        terminate: vi.fn(async (graceful?: boolean) => {
          order.push(`terminate-${index}-${String(graceful)}-${String(session.dropped?.has(index))}`);
        }),
      },
    }));
    const announce = vi.fn(() => order.push('announce'));

    await dropPendingAgents(session, agents, [2], announce, { reached: true, similarity: 0.9, consideredAgents: 2 });

    expect(order).toEqual(['announce', 'terminate-2-false-true']);
    expect(agents[0]?.provider.terminate).not.toHaveBeenCalled();
    expect(announce).toHaveBeenCalledWith({ droppedAgentIndexes: [2], similarity: 0.9, consideredAgents: 2 });
    expect(session.cancelled).toBe(false);
    expect([...(session.dropped ?? [])]).toEqual([2]);
  });

  it('swallows termination failures', async () => {
    const session: EarlyDropSession = {};
    const agents = [{ provider: { terminate: vi.fn(() => Promise.reject(new Error('gone'))) } }];
    await expect(dropPendingAgents(session, agents, [0], vi.fn(), { reached: true, similarity: 1, consideredAgents: 2 }))
      .resolves.toBeUndefined();
  });
});
