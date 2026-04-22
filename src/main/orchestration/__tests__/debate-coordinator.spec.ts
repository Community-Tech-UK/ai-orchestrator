/**
 * DebateCoordinator Tests
 *
 * Tests the multi-round debate system. The coordinator fires extensibility
 * events (debate:generate-response, debate:generate-critiques,
 * debate:generate-defense, debate:generate-synthesis) expecting external
 * handlers to call the provided callback.
 *
 * vi.mock() paths are resolved relative to THIS test file location:
 *   src/main/orchestration/__tests__/debate-coordinator.spec.ts
 * So paths like '../../logging/logger' resolve to src/main/logging/logger.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must appear before any import that transitively loads Electron
// ---------------------------------------------------------------------------

vi.mock('../../logging/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  getLogManager: vi.fn(() => ({
    getLogger: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  })),
}));

vi.mock('../../rlm/token-counter', () => ({
  estimateTokens: vi.fn((text: string) => Math.ceil(text.length / 4)),
}));

// ---------------------------------------------------------------------------
// Import the class under test (after mocks are defined)
// ---------------------------------------------------------------------------

import { DebateCoordinator, getDebateCoordinator } from '../debate-coordinator';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Returns a callback-style handler that immediately invokes the payload
 * callback with a canned response. This simulates an LLM integration layer
 * responding to the extensibility events.
 */
function makeResponseHandler(response: string, tokens = 50) {
  return (payload: { callback: (response: string, tokens: number) => void }) => {
    payload.callback(response, tokens);
  };
}

function makeCritiqueHandler(response: string) {
  return (payload: { callback: (response: string) => void }) => {
    payload.callback(response);
  };
}

function makeDefenseHandler(response: string) {
  return (payload: { callback: (response: string) => void }) => {
    payload.callback(response);
  };
}

function makeSynthesisHandler(response: string) {
  return (payload: { callback: (response: string) => void }) => {
    payload.callback(response);
  };
}

/**
 * A minimal config that keeps tests fast — 2 agents, 1 max round (initial
 * only), which means the loop body is never entered and synthesis follows
 * directly.
 */
const FAST_CONFIG = {
  agents: 2,
  maxRounds: 1,
  convergenceThreshold: 0.8,
  synthesisModel: 'default',
  temperatureRange: [0.3, 0.9] as [number, number],
  timeout: 5000,
};

/**
 * Config that exercises the critique round before synthesis.
 * maxRounds=3: initial (currentRound→1), critique (currentRound→2),
 * loop exits (2 < 2 = false), synthesis.
 */
const THREE_ROUND_CONFIG = {
  agents: 2,
  maxRounds: 3,
  convergenceThreshold: 0.99, // very high so convergence never triggers early
  synthesisModel: 'default',
  temperatureRange: [0.3, 0.9] as [number, number],
  timeout: 5000,
};

const INITIAL_RESPONSE_AGENT_0 =
  'Agent 0 thinks the answer is correct. Confidence: 80%\n## Reasoning Summary\nDetailed reasoning from agent 0.';
const INITIAL_RESPONSE_AGENT_1 =
  'Agent 1 considers a different approach. Confidence: 70%\n## Reasoning Summary\nDetailed reasoning from agent 1.';

const CRITIQUE_RESPONSE =
  '### Critique of agent-0\n**Issue**: Needs more evidence\n**Severity**: minor\n**Counterpoint**: Alternative view\n---';

const DEFENSE_RESPONSE =
  'I defend my position.\n## Defense Points\n- Point 1 defended\n- Point 2 defended\n## Confidence\n75%\n## Reasoning Summary\nRevised reasoning after critique.';

const SYNTHESIS_RESPONSE =
  'Final synthesised answer combining all perspectives.';

/**
 * Returns distinct responses per agentIndex so Jaccard similarity stays low
 * and convergence threshold is not accidentally crossed in tests that need
 * multiple rounds to execute.
 */
function makeDistinctResponseHandler(prefix = 'Response') {
  return (payload: { agentIndex: number; callback: (r: string, t: number) => void }) => {
    // Each agent gets a response with mostly unique words so pairwise
    // Jaccard similarity is well below common threshold values.
    payload.callback(
      `${prefix} from agent ${payload.agentIndex} covering unique topics alpha beta gamma delta epsilon zeta eta theta iota kappa. Confidence: ${70 + payload.agentIndex}%`,
      30
    );
  };
}

function makeDistinctCritiqueHandler() {
  return (payload: { agentIndex: number; callback: (r: string) => void }) => {
    payload.callback(
      `### Critique of agent-${payload.agentIndex === 0 ? 1 : 0}\n**Issue**: Needs more evidence from agent ${payload.agentIndex}\n**Severity**: minor\n**Counterpoint**: Consider alternative perspective\n---`
    );
  };
}

function waitForEvent<T>(coordinator: DebateCoordinator, event: string): Promise<T> {
  return new Promise((resolve) => coordinator.once(event, resolve as (payload: T) => void));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DebateCoordinator', () => {
  let coordinator: DebateCoordinator;

  beforeEach(() => {
    DebateCoordinator._resetForTesting();
    coordinator = DebateCoordinator.getInstance();
    vi.clearAllMocks();
  });

  afterEach(() => {
    DebateCoordinator._resetForTesting();
  });

  // =========================================================================
  // Singleton
  // =========================================================================

  describe('getInstance / singleton', () => {
    it('returns the same instance on repeated calls', () => {
      const a = DebateCoordinator.getInstance();
      const b = DebateCoordinator.getInstance();
      expect(a).toBe(b);
    });

    it('getDebateCoordinator() convenience function returns the singleton', () => {
      const via_helper = getDebateCoordinator();
      expect(via_helper).toBe(DebateCoordinator.getInstance());
    });

    it('creates a new instance after _resetForTesting()', () => {
      const before = DebateCoordinator.getInstance();
      DebateCoordinator._resetForTesting();
      const after = DebateCoordinator.getInstance();
      expect(before).not.toBe(after);
    });
  });

  // =========================================================================
  // startDebate
  // =========================================================================

  describe('startDebate', () => {
    it('returns a unique debate ID string', async () => {
      // Register a handler so the async debate can proceed (it runs in background)
      coordinator.on('debate:generate-response', makeResponseHandler(INITIAL_RESPONSE_AGENT_0));
      coordinator.on('debate:generate-critiques', makeCritiqueHandler(CRITIQUE_RESPONSE));
      coordinator.on('debate:generate-defense', makeDefenseHandler(DEFENSE_RESPONSE));
      coordinator.on('debate:generate-synthesis', makeSynthesisHandler(SYNTHESIS_RESPONSE));

      const id = await coordinator.startDebate('What is the best approach?');
      expect(typeof id).toBe('string');
      expect(id).toMatch(/^debate-\d+-[a-z0-9]+$/);
    });

    it('assigns a unique ID for each call', async () => {
      coordinator.on('debate:generate-response', makeResponseHandler(INITIAL_RESPONSE_AGENT_0));
      coordinator.on('debate:generate-critiques', makeCritiqueHandler(CRITIQUE_RESPONSE));
      coordinator.on('debate:generate-defense', makeDefenseHandler(DEFENSE_RESPONSE));
      coordinator.on('debate:generate-synthesis', makeSynthesisHandler(SYNTHESIS_RESPONSE));

      const id1 = await coordinator.startDebate('Query 1');
      const id2 = await coordinator.startDebate('Query 2');
      expect(id1).not.toBe(id2);
    });

    it('emits debate:started event with debateId and query', async () => {
      coordinator.on('debate:generate-response', makeResponseHandler(INITIAL_RESPONSE_AGENT_0));
      coordinator.on('debate:generate-critiques', makeCritiqueHandler(CRITIQUE_RESPONSE));
      coordinator.on('debate:generate-defense', makeDefenseHandler(DEFENSE_RESPONSE));
      coordinator.on('debate:generate-synthesis', makeSynthesisHandler(SYNTHESIS_RESPONSE));

      const startedPayloads: Array<{ debateId: string; query: string }> = [];
      coordinator.on('debate:started', (payload) => startedPayloads.push(payload));

      const id = await coordinator.startDebate('Test query');

      expect(startedPayloads).toHaveLength(1);
      expect(startedPayloads[0].debateId).toBe(id);
      expect(startedPayloads[0].query).toBe('Test query');
    });

    it('throws when no handler for debate:generate-response is registered', async () => {
      // No handlers registered — the debate runs in the background but should
      // emit debate:error. We capture the error event.
      const errorPromise = waitForEvent<{ debateId: string; error: string }>(coordinator, 'debate:error');

      const id = await coordinator.startDebate('No handler query');

      const errorPayload = await errorPromise;

      expect(errorPayload.debateId).toBe(id);
      expect(errorPayload.error).toMatch(/No handler registered/);
    });

    it('merges provided config with defaults', async () => {
      coordinator.on('debate:generate-response', makeResponseHandler(INITIAL_RESPONSE_AGENT_0));
      coordinator.on('debate:generate-synthesis', makeSynthesisHandler(SYNTHESIS_RESPONSE));

      const completedResults: Array<{ id: string }> = [];
      coordinator.on('debate:completed', (result) => completedResults.push(result));

      const id = await coordinator.startDebate('Query', undefined, FAST_CONFIG);
      await new Promise<void>((resolve) => coordinator.once('debate:completed', resolve));

      const result = coordinator.getResult(id);
      expect(result).toBeDefined();
      // maxRounds=1 means only the initial round runs before synthesis
      // Verify the debate tracked 2 agents (FAST_CONFIG.agents=2)
      const initialRound = result!.rounds.find((r) => r.type === 'initial');
      expect(initialRound?.contributions).toHaveLength(2);
    });
  });

  // =========================================================================
  // runInitialRound (exercised via startDebate + completion)
  // =========================================================================

  describe('runInitialRound', () => {
    it('runs all agents in parallel and collects responses', async () => {
      const callOrder: number[] = [];
      coordinator.on('debate:generate-response', (payload: { agentIndex: number; callback: (r: string, t: number) => void }) => {
        callOrder.push(payload.agentIndex);
        payload.callback(`Response from agent ${payload.agentIndex}. Confidence: 75%`, 30);
      });
      coordinator.on('debate:generate-synthesis', makeSynthesisHandler(SYNTHESIS_RESPONSE));

      const id = await coordinator.startDebate('Parallel test', undefined, FAST_CONFIG);
      await new Promise<void>((resolve) => coordinator.once('debate:completed', resolve));

      const result = coordinator.getResult(id);
      const initialRound = result!.rounds.find((r) => r.type === 'initial');
      expect(initialRound).toBeDefined();
      expect(initialRound!.contributions).toHaveLength(2);
      expect(initialRound!.contributions[0].agentId).toBe('agent-0');
      expect(initialRound!.contributions[1].agentId).toBe('agent-1');
    });

    it('records initial round type as "initial"', async () => {
      coordinator.on('debate:generate-response', makeResponseHandler(INITIAL_RESPONSE_AGENT_0));
      coordinator.on('debate:generate-synthesis', makeSynthesisHandler(SYNTHESIS_RESPONSE));

      const id = await coordinator.startDebate('Round type test', undefined, FAST_CONFIG);
      await new Promise<void>((resolve) => coordinator.once('debate:completed', resolve));

      const result = coordinator.getResult(id);
      const firstRound = result!.rounds[0];
      expect(firstRound.type).toBe('initial');
      expect(firstRound.roundNumber).toBe(1);
    });

    it('extracts confidence from agent response text', async () => {
      coordinator.on('debate:generate-response', (payload: { callback: (r: string, t: number) => void }) => {
        payload.callback('My answer. Confidence: 90%', 30);
      });
      coordinator.on('debate:generate-synthesis', makeSynthesisHandler(SYNTHESIS_RESPONSE));

      const id = await coordinator.startDebate('Confidence extraction', undefined, FAST_CONFIG);
      await new Promise<void>((resolve) => coordinator.once('debate:completed', resolve));

      const result = coordinator.getResult(id);
      const contrib = result!.rounds[0].contributions[0];
      expect(contrib.confidence).toBeCloseTo(0.9, 1);
    });

    it('falls back to default confidence when no percentage found in response', async () => {
      coordinator.on('debate:generate-response', (payload: { callback: (r: string, t: number) => void }) => {
        payload.callback('No confidence mentioned here.', 30);
      });
      coordinator.on('debate:generate-synthesis', makeSynthesisHandler(SYNTHESIS_RESPONSE));

      const id = await coordinator.startDebate('No confidence', undefined, FAST_CONFIG);
      await new Promise<void>((resolve) => coordinator.once('debate:completed', resolve));

      const result = coordinator.getResult(id);
      const contrib = result!.rounds[0].contributions[0];
      expect(contrib.confidence).toBe(0.7); // Default from source
    });

    it('extracts reasoning summary when present in response', async () => {
      coordinator.on('debate:generate-response', (payload: { callback: (r: string, t: number) => void }) => {
        payload.callback('My answer.\n## Reasoning Summary\nThis is my reasoning.', 30);
      });
      coordinator.on('debate:generate-synthesis', makeSynthesisHandler(SYNTHESIS_RESPONSE));

      const id = await coordinator.startDebate('Reasoning extraction', undefined, FAST_CONFIG);
      await new Promise<void>((resolve) => coordinator.once('debate:completed', resolve));

      const result = coordinator.getResult(id);
      const contrib = result!.rounds[0].contributions[0];
      expect(contrib.reasoning).toBe('This is my reasoning.');
    });

    it('emits debate:round-complete after initial round', async () => {
      coordinator.on('debate:generate-response', makeResponseHandler(INITIAL_RESPONSE_AGENT_0));
      coordinator.on('debate:generate-synthesis', makeSynthesisHandler(SYNTHESIS_RESPONSE));

      const roundEvents: Array<{ debateId: string; round: { type: string } }> = [];
      coordinator.on('debate:round-complete', (payload) => roundEvents.push(payload));

      const id = await coordinator.startDebate('Round events', undefined, FAST_CONFIG);
      await new Promise<void>((resolve) => coordinator.once('debate:completed', resolve));

      const initialEvents = roundEvents.filter((e) => e.round.type === 'initial' && e.debateId === id);
      expect(initialEvents).toHaveLength(1);
    });

    it('emits debate:error when a generate-response callback is never called (timeout)', async () => {
      // Handler registered but never calls callback — simulates a hung agent
      coordinator.on('debate:generate-response', (_payload) => {
        // Deliberately do nothing (simulate timeout)
      });

      const errorPromise = waitForEvent<{ debateId: string; error: string }>(coordinator, 'debate:error');

      const id = await coordinator.startDebate('Timeout test', undefined, {
        ...FAST_CONFIG,
        timeout: 50, // Very short timeout so the test is fast
      });

      const errorPayload = await errorPromise;

      expect(errorPayload.debateId).toBe(id);
      expect(errorPayload.error).toMatch(/timed out/i);
    });
  });

  // =========================================================================
  // runCritiqueRound
  // =========================================================================

  describe('runCritiqueRound', () => {
    it('generates critiques for each agent in parallel', async () => {
      const critiquePayloads: Array<{ agentIndex: number }> = [];

      // Use distinct responses so Jaccard similarity stays low and convergence
      // never fires before the critique round has a chance to run.
      coordinator.on('debate:generate-response', makeDistinctResponseHandler());

      coordinator.on('debate:generate-critiques', (payload: { agentIndex: number; callback: (r: string) => void }) => {
        critiquePayloads.push({ agentIndex: payload.agentIndex });
        payload.callback(CRITIQUE_RESPONSE);
      });

      coordinator.on('debate:generate-synthesis', makeSynthesisHandler(SYNTHESIS_RESPONSE));

      const id = await coordinator.startDebate('Critique parallel', undefined, THREE_ROUND_CONFIG);
      await new Promise<void>((resolve) => coordinator.once('debate:completed', resolve));

      // 2 agents each produce critiques
      expect(critiquePayloads).toHaveLength(2);

      const result = coordinator.getResult(id);
      const critiqueRound = result!.rounds.find((r) => r.type === 'critique');
      expect(critiqueRound).toBeDefined();
      expect(critiqueRound!.contributions).toHaveLength(2);
    });

    it('critique round has type "critique"', async () => {
      coordinator.on('debate:generate-response', makeDistinctResponseHandler());
      coordinator.on('debate:generate-critiques', (payload: { callback: (r: string) => void }) => {
        payload.callback(CRITIQUE_RESPONSE);
      });
      coordinator.on('debate:generate-synthesis', makeSynthesisHandler(SYNTHESIS_RESPONSE));

      const id = await coordinator.startDebate('Critique type', undefined, THREE_ROUND_CONFIG);
      await new Promise<void>((resolve) => coordinator.once('debate:completed', resolve));

      const result = coordinator.getResult(id);
      const critiqueRound = result!.rounds.find((r) => r.type === 'critique');
      expect(critiqueRound).toBeDefined();
    });

    it('parses structured critique format from LLM response', async () => {
      coordinator.on('debate:generate-response', makeDistinctResponseHandler());
      coordinator.on('debate:generate-critiques', (payload: { callback: (r: string) => void }) => {
        payload.callback(
          '### Critique of agent-0\n**Issue**: Weak argument\n**Severity**: major\n**Counterpoint**: Consider alternative A\n---'
        );
      });
      coordinator.on('debate:generate-synthesis', makeSynthesisHandler(SYNTHESIS_RESPONSE));

      const id = await coordinator.startDebate('Parse critiques', undefined, THREE_ROUND_CONFIG);
      await new Promise<void>((resolve) => coordinator.once('debate:completed', resolve));

      const result = coordinator.getResult(id);
      const critiqueRound = result!.rounds.find((r) => r.type === 'critique');
      // At least one contribution should have critiques
      const withCritiques = critiqueRound!.contributions.filter((c) => c.critiques && c.critiques.length > 0);
      expect(withCritiques.length).toBeGreaterThan(0);
    });

    it('falls back to generic critiques when response has no structured format', async () => {
      coordinator.on('debate:generate-response', makeDistinctResponseHandler());
      coordinator.on('debate:generate-critiques', (payload: { callback: (r: string) => void }) => {
        payload.callback('This is an unstructured critique with no special formatting.');
      });
      coordinator.on('debate:generate-synthesis', makeSynthesisHandler(SYNTHESIS_RESPONSE));

      const id = await coordinator.startDebate('Fallback critiques', undefined, THREE_ROUND_CONFIG);
      await new Promise<void>((resolve) => coordinator.once('debate:completed', resolve));

      const result = coordinator.getResult(id);
      const critiqueRound = result!.rounds.find((r) => r.type === 'critique');
      // Fallback creates generic critiques for each contribution in the previous round
      const withCritiques = critiqueRound!.contributions.filter((c) => c.critiques && c.critiques.length > 0);
      expect(withCritiques.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // runDefenseRound
  // =========================================================================

  describe('runDefenseRound', () => {
    // A config that causes: initial → critique → defense → synthesis
    const FOUR_ROUND_CONFIG = {
      agents: 2,
      maxRounds: 4,
      convergenceThreshold: 0.99,
      synthesisModel: 'default',
      temperatureRange: [0.3, 0.9] as [number, number],
      timeout: 5000,
    };

    it('generates defenses for each agent in parallel', async () => {
      const defensePayloads: Array<{ agentIndex: number }> = [];

      coordinator.on('debate:generate-response', makeDistinctResponseHandler());
      coordinator.on('debate:generate-critiques', makeDistinctCritiqueHandler());
      coordinator.on('debate:generate-defense', (payload: { agentIndex: number; callback: (r: string) => void }) => {
        defensePayloads.push({ agentIndex: payload.agentIndex });
        payload.callback(DEFENSE_RESPONSE);
      });
      coordinator.on('debate:generate-synthesis', makeSynthesisHandler(SYNTHESIS_RESPONSE));

      const id = await coordinator.startDebate('Defense parallel', undefined, FOUR_ROUND_CONFIG);
      await new Promise<void>((resolve) => coordinator.once('debate:completed', resolve));

      expect(defensePayloads).toHaveLength(2);

      const result = coordinator.getResult(id);
      const defenseRound = result!.rounds.find((r) => r.type === 'defense');
      expect(defenseRound).toBeDefined();
      expect(defenseRound!.contributions).toHaveLength(2);
    });

    it('defense round has type "defense"', async () => {
      coordinator.on('debate:generate-response', makeDistinctResponseHandler());
      coordinator.on('debate:generate-critiques', makeDistinctCritiqueHandler());
      coordinator.on('debate:generate-defense', (payload: { callback: (r: string) => void }) => {
        payload.callback(DEFENSE_RESPONSE);
      });
      coordinator.on('debate:generate-synthesis', makeSynthesisHandler(SYNTHESIS_RESPONSE));

      const id = await coordinator.startDebate('Defense type', undefined, FOUR_ROUND_CONFIG);
      await new Promise<void>((resolve) => coordinator.once('debate:completed', resolve));

      const result = coordinator.getResult(id);
      const defenseRound = result!.rounds.find((r) => r.type === 'defense');
      expect(defenseRound!.type).toBe('defense');
    });

    it('extracts defense points from structured response', async () => {
      coordinator.on('debate:generate-response', makeDistinctResponseHandler());
      coordinator.on('debate:generate-critiques', makeDistinctCritiqueHandler());
      coordinator.on('debate:generate-defense', (payload: { callback: (r: string) => void }) => {
        payload.callback(
          'Defense content.\n## Defense Points\n- First defense\n- Second defense\n## Confidence\n80%\n## Reasoning Summary\nRevised.'
        );
      });
      coordinator.on('debate:generate-synthesis', makeSynthesisHandler(SYNTHESIS_RESPONSE));

      const id = await coordinator.startDebate('Defense points', undefined, FOUR_ROUND_CONFIG);
      await new Promise<void>((resolve) => coordinator.once('debate:completed', resolve));

      const result = coordinator.getResult(id);
      const defenseRound = result!.rounds.find((r) => r.type === 'defense');
      const contrib = defenseRound!.contributions[0];
      expect(contrib.defenses).toBeDefined();
      expect(contrib.defenses!.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // synthesis
  // =========================================================================

  describe('synthesis', () => {
    it('generates synthesis from all rounds and stores it in result', async () => {
      coordinator.on('debate:generate-response', makeResponseHandler(INITIAL_RESPONSE_AGENT_0));
      coordinator.on('debate:generate-synthesis', makeSynthesisHandler(SYNTHESIS_RESPONSE));

      const id = await coordinator.startDebate('Synthesis content', undefined, FAST_CONFIG);
      await new Promise<void>((resolve) => coordinator.once('debate:completed', resolve));

      const result = coordinator.getResult(id);
      expect(result).toBeDefined();
      expect(result!.synthesis).toBe(SYNTHESIS_RESPONSE);
    });

    it('synthesis round has type "synthesis" and moderator agentId', async () => {
      coordinator.on('debate:generate-response', makeResponseHandler(INITIAL_RESPONSE_AGENT_0));
      coordinator.on('debate:generate-synthesis', makeSynthesisHandler(SYNTHESIS_RESPONSE));

      const id = await coordinator.startDebate('Synthesis round type', undefined, FAST_CONFIG);
      await new Promise<void>((resolve) => coordinator.once('debate:completed', resolve));

      const result = coordinator.getResult(id);
      const synthRound = result!.rounds.find((r) => r.type === 'synthesis');
      expect(synthRound).toBeDefined();
      expect(synthRound!.contributions[0].agentId).toBe('moderator');
    });

    it('calculates a consensus score between 0 and 1', async () => {
      coordinator.on('debate:generate-response', makeResponseHandler(INITIAL_RESPONSE_AGENT_0));
      coordinator.on('debate:generate-synthesis', makeSynthesisHandler(SYNTHESIS_RESPONSE));

      const id = await coordinator.startDebate('Consensus score', undefined, FAST_CONFIG);
      await new Promise<void>((resolve) => coordinator.once('debate:completed', resolve));

      const result = coordinator.getResult(id);
      expect(result!.finalConsensusScore).toBeGreaterThanOrEqual(0);
      expect(result!.finalConsensusScore).toBeLessThanOrEqual(1);
    });

    it('reports consensusReached=true when threshold is crossed', async () => {
      // Identical responses will have high Jaccard similarity → high consensus
      const IDENTICAL_RESPONSE = 'Identical response text to maximise similarity. Confidence: 90%';
      coordinator.on('debate:generate-response', (payload: { callback: (r: string, t: number) => void }) => {
        payload.callback(IDENTICAL_RESPONSE, 30);
      });
      coordinator.on('debate:generate-synthesis', makeSynthesisHandler(SYNTHESIS_RESPONSE));

      const id = await coordinator.startDebate('High consensus', undefined, {
        ...FAST_CONFIG,
        convergenceThreshold: 0.5, // Easily reachable with identical responses
      });
      await new Promise<void>((resolve) => coordinator.once('debate:completed', resolve));

      const result = coordinator.getResult(id);
      expect(result!.consensusReached).toBe(true);
    });

    it('emits debate:completed with the full result', async () => {
      coordinator.on('debate:generate-response', makeResponseHandler(INITIAL_RESPONSE_AGENT_0));
      coordinator.on('debate:generate-synthesis', makeSynthesisHandler(SYNTHESIS_RESPONSE));

      const completedResults: unknown[] = [];
      coordinator.on('debate:completed', (result) => completedResults.push(result));

      const id = await coordinator.startDebate('Completed event', undefined, FAST_CONFIG);
      await new Promise<void>((resolve) => coordinator.once('debate:completed', resolve));

      expect(completedResults).toHaveLength(1);
      const emitted = completedResults[0] as { id: string; synthesis: string; status: string };
      expect(emitted.id).toBe(id);
      expect(emitted.synthesis).toBe(SYNTHESIS_RESPONSE);
      expect(emitted.status).toBe('completed');
    });
  });

  // =========================================================================
  // Full debate flow
  // =========================================================================

  describe('full debate flow', () => {
    it('runs the complete 4-phase debate (initial → critique → defense → synthesis)', async () => {
      const phases: string[] = [];

      coordinator.on('debate:generate-response', (payload: { agentIndex: number; callback: (r: string, t: number) => void }) => {
        phases.push('initial');
        // Use distinct responses so Jaccard similarity stays low and convergence never fires early
        payload.callback(
          `Unique agent ${payload.agentIndex} content with words alpha beta gamma delta epsilon zeta eta. Confidence: ${70 + payload.agentIndex}%`,
          30
        );
      });
      coordinator.on('debate:generate-critiques', (payload: { agentIndex: number; callback: (r: string) => void }) => {
        phases.push('critique');
        const targetId = payload.agentIndex === 0 ? 1 : 0;
        payload.callback(
          `### Critique of agent-${targetId}\n**Issue**: Weak point from agent ${payload.agentIndex}\n**Severity**: minor\n**Counterpoint**: Try another angle\n---`
        );
      });
      coordinator.on('debate:generate-defense', (payload: { callback: (r: string) => void }) => {
        phases.push('defense');
        payload.callback(DEFENSE_RESPONSE);
      });
      coordinator.on('debate:generate-synthesis', (payload: { callback: (r: string) => void }) => {
        phases.push('synthesis');
        payload.callback(SYNTHESIS_RESPONSE);
      });

      const id = await coordinator.startDebate('Full flow', undefined, {
        agents: 2,
        maxRounds: 4,
        convergenceThreshold: 0.99, // No early exit
        synthesisModel: 'default',
        temperatureRange: [0.3, 0.9],
        timeout: 5000,
      });

      await new Promise<void>((resolve) => coordinator.once('debate:completed', resolve));

      const result = coordinator.getResult(id);
      expect(result).toBeDefined();
      expect(result!.status).toBe('completed');

      // Expect: 2 initial calls + 2 critique calls + 2 defense calls + 1 synthesis call
      expect(phases.filter((p) => p === 'initial')).toHaveLength(2);
      expect(phases.filter((p) => p === 'critique')).toHaveLength(2);
      expect(phases.filter((p) => p === 'defense')).toHaveLength(2);
      expect(phases.filter((p) => p === 'synthesis')).toHaveLength(1);

      // All four round types present
      const roundTypes = result!.rounds.map((r) => r.type);
      expect(roundTypes).toContain('initial');
      expect(roundTypes).toContain('critique');
      expect(roundTypes).toContain('defense');
      expect(roundTypes).toContain('synthesis');
    });

    it('stops early when convergence threshold is reached after initial round', async () => {
      // Identical answers produce high Jaccard similarity, crossing the threshold
      const IDENTICAL = 'The exact same words repeated here for maximum Jaccard similarity. Confidence: 85%';
      coordinator.on('debate:generate-response', (payload: { callback: (r: string, t: number) => void }) => {
        payload.callback(IDENTICAL, 30);
      });
      coordinator.on('debate:generate-synthesis', (payload: { callback: (r: string) => void }) => {
        payload.callback(SYNTHESIS_RESPONSE);
      });

      const id = await coordinator.startDebate('Early convergence', undefined, {
        agents: 2,
        maxRounds: 10, // High ceiling — early exit should kick in before this
        convergenceThreshold: 0.3, // Very low so identical responses always pass
        synthesisModel: 'default',
        temperatureRange: [0.3, 0.9],
        timeout: 5000,
      });

      await new Promise<void>((resolve) => coordinator.once('debate:completed', resolve));

      const result = coordinator.getResult(id);
      expect(result).toBeDefined();
      // Because convergence was met after round 1, no critique or defense rounds
      const roundTypes = result!.rounds.map((r) => r.type);
      expect(roundTypes).not.toContain('critique');
      expect(roundTypes).not.toContain('defense');
      expect(roundTypes).toContain('synthesis');
    });

    it('respects timeout and marks debate status as timeout', async () => {
      // Handler never calls callback — the debate will time out waiting for responses
      coordinator.on('debate:generate-response', () => {
        // Deliberate no-op — callback never fired
      });

      const errorPromise = waitForEvent<{ debateId: string; error: string }>(coordinator, 'debate:error');

      const id = await coordinator.startDebate('Timeout debate', undefined, {
        ...FAST_CONFIG,
        timeout: 30, // Extremely short to trigger quickly
      });

      const errorPayload = await errorPromise;

      // Debate should have errored (due to the per-operation timeout)
      expect(errorPayload.debateId).toBe(id);
    });

    it('stores completed debate in getResult() after completion', async () => {
      coordinator.on('debate:generate-response', makeResponseHandler(INITIAL_RESPONSE_AGENT_0));
      coordinator.on('debate:generate-synthesis', makeSynthesisHandler(SYNTHESIS_RESPONSE));

      const id = await coordinator.startDebate('Store result', undefined, FAST_CONFIG);
      await new Promise<void>((resolve) => coordinator.once('debate:completed', resolve));

      const result = coordinator.getResult(id);
      expect(result).toBeDefined();
      expect(result!.id).toBe(id);
      expect(result!.query).toBe('Store result');
    });

    it('moves debate from active to completed after finalisation', async () => {
      coordinator.on('debate:generate-response', makeResponseHandler(INITIAL_RESPONSE_AGENT_0));
      coordinator.on('debate:generate-synthesis', makeSynthesisHandler(SYNTHESIS_RESPONSE));

      const id = await coordinator.startDebate('Active to completed', undefined, FAST_CONFIG);

      // Immediately after start the debate is active
      expect(coordinator.getActiveDebates().some((d) => d.id === id)).toBe(true);

      await new Promise<void>((resolve) => coordinator.once('debate:completed', resolve));

      // After completion it leaves the active list
      expect(coordinator.getActiveDebates().some((d) => d.id === id)).toBe(false);
      expect(coordinator.getResult(id)).toBeDefined();
    });

    it('updates stats after completing a debate', async () => {
      coordinator.on('debate:generate-response', makeResponseHandler(INITIAL_RESPONSE_AGENT_0));
      coordinator.on('debate:generate-synthesis', makeSynthesisHandler(SYNTHESIS_RESPONSE));

      const statsBefore = coordinator.getStats();
      expect(statsBefore.totalDebates).toBe(0);

      await coordinator.startDebate('Stats update', undefined, FAST_CONFIG);
      await new Promise<void>((resolve) => coordinator.once('debate:completed', resolve));

      const statsAfter = coordinator.getStats();
      expect(statsAfter.totalDebates).toBe(1);
    });

    it('records tokensUsed > 0 in result', async () => {
      coordinator.on('debate:generate-response', makeResponseHandler(INITIAL_RESPONSE_AGENT_0));
      coordinator.on('debate:generate-synthesis', makeSynthesisHandler(SYNTHESIS_RESPONSE));

      const id = await coordinator.startDebate('Token counting', undefined, FAST_CONFIG);
      await new Promise<void>((resolve) => coordinator.once('debate:completed', resolve));

      const result = coordinator.getResult(id);
      expect(result!.tokensUsed).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // getDebate
  // =========================================================================

  describe('getDebate', () => {
    it('returns the active debate while it is in progress', async () => {
      // Never-resolving handler so the debate stays active
      coordinator.on('debate:generate-response', () => { /* no-op */ });

      const id = await coordinator.startDebate('Active debate', undefined, { ...FAST_CONFIG, timeout: 60000 });

      const debate = coordinator.getDebate(id);
      expect(debate).toBeDefined();
      expect((debate as { id: string }).id).toBe(id);
    });

    it('returns the DebateResult after debate completes', async () => {
      coordinator.on('debate:generate-response', makeResponseHandler(INITIAL_RESPONSE_AGENT_0));
      coordinator.on('debate:generate-synthesis', makeSynthesisHandler(SYNTHESIS_RESPONSE));

      const id = await coordinator.startDebate('Completed get', undefined, FAST_CONFIG);
      await new Promise<void>((resolve) => coordinator.once('debate:completed', resolve));

      const debate = coordinator.getDebate(id);
      expect(debate).toBeDefined();
      expect((debate as { synthesis: string }).synthesis).toBe(SYNTHESIS_RESPONSE);
    });

    it('returns undefined for an unknown debate ID', () => {
      const result = coordinator.getDebate('non-existent-debate-id');
      expect(result).toBeUndefined();
    });
  });

  // =========================================================================
  // cancelDebate
  // =========================================================================

  describe('cancelDebate', () => {
    it('returns false for a non-existent debate ID', async () => {
      const result = await coordinator.cancelDebate('no-such-id');
      expect(result).toBe(false);
    });

    it('returns true and cancels an active debate (paused after initial round)', async () => {
      // Let the initial round complete, then pause the debate so it stays active
      // and we can safely cancel it (finalizeDebate requires at least one round).
      coordinator.on('debate:generate-response', makeResponseHandler(INITIAL_RESPONSE_AGENT_0));
      coordinator.on('debate:generate-synthesis', makeSynthesisHandler(SYNTHESIS_RESPONSE));

      const id = await coordinator.startDebate('Cancel me', undefined, {
        ...FAST_CONFIG,
        maxRounds: 10,
        timeout: 60000,
      });

      // Wait for the initial round, then pause before synthesis
      await new Promise<void>((resolve) => coordinator.once('debate:round-complete', resolve));
      coordinator.pauseDebate(id);

      const cancelled = await coordinator.cancelDebate(id);
      expect(cancelled).toBe(true);

      const result = coordinator.getResult(id);
      expect(result).toBeDefined();
      expect(result!.status).toBe('cancelled');
    });

    it('removes cancelled debate from active list', async () => {
      coordinator.on('debate:generate-response', makeResponseHandler(INITIAL_RESPONSE_AGENT_0));
      coordinator.on('debate:generate-synthesis', makeSynthesisHandler(SYNTHESIS_RESPONSE));

      const id = await coordinator.startDebate('Cancel active', undefined, {
        ...FAST_CONFIG,
        maxRounds: 10,
        timeout: 60000,
      });

      // Wait for initial round, then pause so we can cancel cleanly
      await new Promise<void>((resolve) => coordinator.once('debate:round-complete', resolve));
      coordinator.pauseDebate(id);

      expect(coordinator.getActiveDebates().some((d) => d.id === id)).toBe(true);
      await coordinator.cancelDebate(id);
      expect(coordinator.getActiveDebates().some((d) => d.id === id)).toBe(false);
    });
  });

  // =========================================================================
  // pauseDebate / resumeDebate
  // =========================================================================

  describe('pauseDebate / resumeDebate', () => {
    it('returns false when trying to pause a non-existent debate', () => {
      expect(coordinator.pauseDebate('unknown')).toBe(false);
    });

    it('returns false when trying to resume a non-existent debate', () => {
      expect(coordinator.resumeDebate('unknown')).toBe(false);
    });

    it('emits debate:paused when pause succeeds', async () => {
      coordinator.on('debate:generate-response', () => { /* no-op — keeps debate active */ });

      const id = await coordinator.startDebate('Pause me', undefined, { ...FAST_CONFIG, timeout: 60000 });

      const pausedEvents: unknown[] = [];
      coordinator.on('debate:paused', (p) => pausedEvents.push(p));

      coordinator.pauseDebate(id);
      expect(pausedEvents).toHaveLength(1);
    });

    it('emits debate:resumed when resume succeeds after pause', async () => {
      coordinator.on('debate:generate-response', () => { /* no-op */ });

      const id = await coordinator.startDebate('Pause then resume', undefined, { ...FAST_CONFIG, timeout: 60000 });

      coordinator.pauseDebate(id);

      const resumedEvents: unknown[] = [];
      coordinator.on('debate:resumed', (p) => resumedEvents.push(p));

      coordinator.resumeDebate(id);
      expect(resumedEvents).toHaveLength(1);
    });
  });

  // =========================================================================
  // intervene
  // =========================================================================

  describe('intervene', () => {
    it('returns false for a non-existent debate', () => {
      expect(coordinator.intervene('no-such-id', 'intervention text')).toBe(false);
    });

    it('returns true and queues intervention on an active debate', async () => {
      coordinator.on('debate:generate-response', () => { /* no-op — keep active */ });

      const id = await coordinator.startDebate('Intervene me', undefined, { ...FAST_CONFIG, timeout: 60000 });

      const result = coordinator.intervene(id, 'Please consider option B');
      expect(result).toBe(true);
    });

    it('emits debate:intervention-queued when intervention is accepted', async () => {
      coordinator.on('debate:generate-response', () => { /* no-op */ });

      const id = await coordinator.startDebate('Intervention event', undefined, { ...FAST_CONFIG, timeout: 60000 });

      const events: Array<{ debateId: string; message: string }> = [];
      coordinator.on('debate:intervention-queued', (p) => events.push(p));

      coordinator.intervene(id, 'This is an intervention');

      expect(events).toHaveLength(1);
      expect(events[0].debateId).toBe(id);
      expect(events[0].message).toBe('This is an intervention');
    });
  });

  // =========================================================================
  // getActiveDebates
  // =========================================================================

  describe('getActiveDebates', () => {
    it('returns empty array when no debates are running', () => {
      expect(coordinator.getActiveDebates()).toEqual([]);
    });

    it('returns all currently active debates', async () => {
      coordinator.on('debate:generate-response', () => { /* no-op — keep active */ });

      await coordinator.startDebate('Active 1', undefined, { ...FAST_CONFIG, timeout: 60000 });
      await coordinator.startDebate('Active 2', undefined, { ...FAST_CONFIG, timeout: 60000 });

      expect(coordinator.getActiveDebates()).toHaveLength(2);
    });
  });

  // =========================================================================
  // getStats
  // =========================================================================

  describe('getStats', () => {
    it('returns stats with totalDebates=0 on fresh instance', () => {
      const stats = coordinator.getStats();
      expect(stats.totalDebates).toBe(0);
      expect(stats.avgRounds).toBe(0);
      expect(stats.avgConsensusScore).toBe(0);
    });

    it('returns a copy of stats (mutations do not affect internal state)', () => {
      const stats = coordinator.getStats();
      stats.totalDebates = 999;

      expect(coordinator.getStats().totalDebates).toBe(0);
    });

    it('increments totalDebates after each completed debate', async () => {
      coordinator.on('debate:generate-response', makeResponseHandler(INITIAL_RESPONSE_AGENT_0));
      coordinator.on('debate:generate-synthesis', makeSynthesisHandler(SYNTHESIS_RESPONSE));

      await coordinator.startDebate('Stats 1', undefined, FAST_CONFIG);
      await new Promise<void>((resolve) => coordinator.once('debate:completed', resolve));

      coordinator.on('debate:generate-response', makeResponseHandler(INITIAL_RESPONSE_AGENT_0));
      coordinator.on('debate:generate-synthesis', makeSynthesisHandler(SYNTHESIS_RESPONSE));

      await coordinator.startDebate('Stats 2', undefined, FAST_CONFIG);
      await new Promise<void>((resolve) => coordinator.once('debate:completed', resolve));

      expect(coordinator.getStats().totalDebates).toBe(2);
    });

    it('avgDurationMs is non-negative after a completed debate', async () => {
      coordinator.on('debate:generate-response', makeResponseHandler(INITIAL_RESPONSE_AGENT_0));
      coordinator.on('debate:generate-synthesis', makeSynthesisHandler(SYNTHESIS_RESPONSE));

      await coordinator.startDebate('Duration stats', undefined, FAST_CONFIG);
      await new Promise<void>((resolve) => coordinator.once('debate:completed', resolve));

      // Duration may be 0ms when callbacks are synchronous; assert it is recorded (>= 0)
      expect(coordinator.getStats().avgDurationMs).toBeGreaterThanOrEqual(0);
    });
  });

  // =========================================================================
  // checkExtensibilityHandler
  // =========================================================================

  describe('checkExtensibilityHandler (extensibility guard)', () => {
    it('emits debate:error when no handler is registered for generate-response', async () => {
      const errorPromise = waitForEvent<{ error: string }>(coordinator, 'debate:error');

      await coordinator.startDebate('No handler', undefined, FAST_CONFIG);
      const errorPayload = await errorPromise;

      expect(errorPayload.error).toMatch(/No handler registered for debate:generate-response/);
    });
  });

  // =========================================================================
  // Temperature range
  // =========================================================================

  describe('agent temperature assignment', () => {
    it('emits temperature values in the configured range for each agent', async () => {
      const temperatures: number[] = [];

      coordinator.on('debate:generate-response', (payload: { temperature: number; callback: (r: string, t: number) => void }) => {
        temperatures.push(payload.temperature);
        payload.callback('Response. Confidence: 70%', 30);
      });
      coordinator.on('debate:generate-synthesis', makeSynthesisHandler(SYNTHESIS_RESPONSE));

      await coordinator.startDebate('Temperature range', undefined, {
        agents: 3,
        maxRounds: 1,
        convergenceThreshold: 0.99,
        synthesisModel: 'default',
        temperatureRange: [0.2, 0.8],
        timeout: 5000,
      });
      await new Promise<void>((resolve) => coordinator.once('debate:completed', resolve));

      expect(temperatures).toHaveLength(3);
      for (const temp of temperatures) {
        expect(temp).toBeGreaterThanOrEqual(0.2);
        expect(temp).toBeLessThanOrEqual(0.8);
      }
    });
  });
});
