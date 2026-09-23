import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CliVerificationCoordinator, type AgentConfig } from './cli-verification-extension';
import { EmbeddingService } from './embedding-service';
import { EARLY_CONSENSUS_DROP_ERROR } from './verification-early-consensus';
import type { VerificationRequest, VerificationResult } from '../../shared/types/verification.types';
import type { ProviderAdapter } from '@sdk/provider-adapter';
import type {
  ProviderRuntimeEvent,
  ProviderRuntimeEventEnvelope,
} from '@contracts/types/provider-runtime-events';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/aio-test' } }));
vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

interface Session {
  request: VerificationRequest;
  providers: Map<string, ProviderAdapter>;
  cancelled: boolean;
  dropped?: Set<number>;
}

type Seam = Omit<CliVerificationCoordinator, 'runCliVerification'> & {
  runCliVerification(request: VerificationRequest, agents: AgentConfig[], session: Session): Promise<VerificationResult>;
};

const AGREED = [
  'The retry helper caps attempts at three and rethrows the final network error with its cause preserved.',
  '## Key Points',
  '- [fact] Retry is bounded (Confidence: 90%)',
  '## Overall Confidence',
  '90%',
].join('\n');

describe('CliVerificationCoordinator early consensus wiring', () => {
  let coordinator: CliVerificationCoordinator;

  beforeEach(() => {
    CliVerificationCoordinator._resetForTesting();
    EmbeddingService._resetForTesting();
    coordinator = CliVerificationCoordinator.getInstance();
  });

  it('terminates only the still-running agent once two answers agree, without cancelling', async () => {
    const earlyConsensus = vi.fn();
    const agentComplete = vi.fn();
    const cancelled = vi.fn();
    coordinator.on('verification:early-consensus', earlyConsensus);
    coordinator.on('verification:agent-complete', agentComplete);
    coordinator.on('verification:cancelled', cancelled);
    const request = makeRequest('early-on', true);
    const session = makeSession(request);
    const hanging = makeHangingProvider('Partial thoughts about an unrelated caching layer');

    const result = await seam(coordinator).runCliVerification(request, [
      makeAgent('Agent A', makeSuccessfulProvider(AGREED)),
      makeAgent('Agent B', makeSuccessfulProvider(AGREED)),
      makeAgent('Agent C', hanging),
    ], session);

    expect(hanging.terminate).toHaveBeenCalledWith(false);
    expect(session.cancelled).toBe(false);
    expect(cancelled).not.toHaveBeenCalled();
    expect(earlyConsensus).toHaveBeenCalledTimes(1);
    expect(earlyConsensus).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'early-on',
      droppedAgentIndexes: [2],
      consideredAgents: 2,
    }));
    // The idle fired by the forced termination must not turn the partial answer into a success.
    expect(result.responses[2]?.error).toBe(EARLY_CONSENSUS_DROP_ERROR);
    expect(result.responses[0]?.error).toBeUndefined();
    expect(result.earlyConsensus).toMatchObject({ threshold: 0.8, consideredAgents: 2, droppedAgentIndexes: [2] });
    expect(result.synthesizedResponse).toContain('**Agents**: 2');
    expect(agentComplete).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'early-on-agent-c-2',
      success: false,
      error: EARLY_CONSENSUS_DROP_ERROR,
    }));
    // Partial spend of the dropped agent is still reported, never hidden as savings.
    expect(result.responses[2]?.tokens).toBeGreaterThan(0);
    expect(result.totalTokens).toBe(result.responses.reduce((sum, r) => sum + r.tokens, 0));
  }, 15_000);

  it('labels a dropped blocking-provider agent as dropped and keeps its spend (Codex exec, Gemini)', async () => {
    const agentError = vi.fn();
    const agentComplete = vi.fn();
    coordinator.on('verification:agent-error', agentError);
    coordinator.on('verification:agent-complete', agentComplete);
    const request = makeRequest('early-blocking', true);
    const blocking = makeBlockingProvider();

    const result = await seam(coordinator).runCliVerification(request, [
      makeAgent('Agent A', makeSuccessfulProvider(AGREED)),
      makeAgent('Agent B', makeSuccessfulProvider(AGREED)),
      makeAgent('Agent C', blocking),
    ], makeSession(request));

    expect(blocking.terminate).toHaveBeenCalledWith(false);
    expect(result.responses[2]?.error).toBe(EARLY_CONSENSUS_DROP_ERROR);
    expect(result.responses[2]?.tokens).toBeGreaterThan(0);
    expect(agentError).not.toHaveBeenCalled();
    expect(agentComplete).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'early-blocking-agent-c-2',
      error: EARLY_CONSENSUS_DROP_ERROR,
    }));
  }, 15_000);

  it('labels an agent dropped while still initializing as dropped, not as an agent error', async () => {
    const agentError = vi.fn();
    const agentComplete = vi.fn();
    coordinator.on('verification:agent-error', agentError);
    coordinator.on('verification:agent-complete', agentComplete);
    const request = makeRequest('early-init', true);
    const slowInit = makeSlowInitProvider();

    const result = await seam(coordinator).runCliVerification(request, [
      makeAgent('Agent A', makeSuccessfulProvider(AGREED)),
      makeAgent('Agent B', makeSuccessfulProvider(AGREED)),
      makeAgent('Agent C', slowInit),
    ], makeSession(request));

    expect(slowInit.terminate).toHaveBeenCalledWith(false);
    expect(result.responses[2]?.error).toBe(EARLY_CONSENSUS_DROP_ERROR);
    expect(agentError).not.toHaveBeenCalled();
    // The agent's card must settle instead of staying "running" until the session ends.
    expect(agentComplete).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'early-init-agent-c-2',
      success: false,
      error: EARLY_CONSENSUS_DROP_ERROR,
    }));
  }, 15_000);

  it('waits for every agent when the answers disagree', async () => {
    const earlyConsensus = vi.fn();
    coordinator.on('verification:early-consensus', earlyConsensus);
    const request = makeRequest('early-disagree', true);

    const result = await seam(coordinator).runCliVerification(request, [
      makeAgent('Agent A', makeSuccessfulProvider('Database migrations lack rollback scripts entirely.')),
      makeAgent('Agent B', makeSuccessfulProvider('Frontend button colours violate accessibility contrast.')),
      makeAgent('Agent C', makeSuccessfulProvider('Kubernetes pods restart because memory limits are low.')),
    ], makeSession(request));

    expect(earlyConsensus).not.toHaveBeenCalled();
    expect(result.earlyConsensus).toBeUndefined();
    expect(result.responses.every((r) => !r.error)).toBe(true);
  }, 15_000);

  it('changes nothing when earlyTermination is not configured', async () => {
    const earlyConsensus = vi.fn();
    coordinator.on('verification:early-consensus', earlyConsensus);
    const request = makeRequest('early-off', false);

    const result = await seam(coordinator).runCliVerification(request, [
      makeAgent('Agent A', makeSuccessfulProvider(AGREED)),
      makeAgent('Agent B', makeSuccessfulProvider(AGREED)),
    ], makeSession(request));

    expect(earlyConsensus).not.toHaveBeenCalled();
    expect('earlyConsensus' in result).toBe(false);
    expect(result.responses.every((r) => !('error' in r))).toBe(true);
  }, 15_000);
});

function seam(coordinator: CliVerificationCoordinator): Seam {
  return coordinator as unknown as Seam;
}

function makeRequest(id: string, enabled: boolean): VerificationRequest {
  return {
    id,
    instanceId: 'instance-1',
    prompt: 'Check this implementation',
    config: {
      agentCount: 3,
      timeout: 10_000,
      synthesisStrategy: 'best-of',
      ...(enabled ? { earlyTermination: { enabled: true, consensusThreshold: 0.8, minAgentsForConsensus: 2 } } : {}),
    },
  };
}

function makeSession(request: VerificationRequest): Session {
  return { request, providers: new Map<string, ProviderAdapter>(), cancelled: false };
}

function makeAgent(name: string, provider: ProviderAdapter): AgentConfig {
  return { type: 'cli', name, command: name.toLowerCase().replace(/\s+/g, '-'), provider };
}

function makeSuccessfulProvider(response: string): ProviderAdapter {
  const events$ = new Subject<ProviderRuntimeEventEnvelope>();
  return {
    events$,
    initialize: vi.fn(() => Promise.resolve()),
    sendMessage: vi.fn(() => {
      events$.next(event({ kind: 'output', content: response }));
      events$.next(event({ kind: 'status', status: 'idle' }));
      return Promise.resolve();
    }),
    terminate: vi.fn(() => Promise.resolve()),
  } as unknown as ProviderAdapter;
}

/** Streams some output and never finishes until force-terminated, which then reports idle. */
function makeHangingProvider(partial: string): ProviderAdapter {
  const events$ = new Subject<ProviderRuntimeEventEnvelope>();
  return {
    events$,
    initialize: vi.fn(() => Promise.resolve()),
    sendMessage: vi.fn(() => {
      events$.next(event({ kind: 'output', content: partial }));
      return Promise.resolve();
    }),
    terminate: vi.fn(() => {
      events$.next(event({ kind: 'status', status: 'idle' }));
      return Promise.resolve();
    }),
  } as unknown as ProviderAdapter;
}

/** initialize() stays pending until a forced terminate rejects it; any later terminate throws. */
function makeSlowInitProvider(): ProviderAdapter {
  const events$ = new Subject<ProviderRuntimeEventEnvelope>();
  let rejectInit: ((error: Error) => void) | undefined;
  let terminated = false;
  return {
    events$,
    initialize: vi.fn(() => new Promise<void>((_resolve, reject) => { rejectInit = reject; })),
    sendMessage: vi.fn(() => Promise.resolve()),
    terminate: vi.fn(() => {
      if (terminated) return Promise.reject(new Error('process already exited'));
      terminated = true;
      rejectInit?.(new Error('initialization aborted'));
      return Promise.resolve();
    }),
  } as unknown as ProviderAdapter;
}

/** Holds sendMessage for the whole turn, like Codex exec: a forced terminate rejects it; a second terminate throws. */
function makeBlockingProvider(): ProviderAdapter {
  const events$ = new Subject<ProviderRuntimeEventEnvelope>();
  let rejectTurn: ((error: Error) => void) | undefined;
  let terminated = false;
  return {
    events$,
    initialize: vi.fn(() => Promise.resolve()),
    sendMessage: vi.fn(() => new Promise<void>((_resolve, reject) => { rejectTurn = reject; })),
    terminate: vi.fn(() => {
      if (terminated) return Promise.reject(new Error('process already exited'));
      terminated = true;
      rejectTurn?.(new Error('Codex exited with code null'));
      return Promise.resolve();
    }),
  } as unknown as ProviderAdapter;
}

function event(e: ProviderRuntimeEvent): ProviderRuntimeEventEnvelope {
  return { eventId: `event-${e.kind}`, seq: 1, timestamp: 1, provider: 'codex', instanceId: 'instance-1', event: e };
}
