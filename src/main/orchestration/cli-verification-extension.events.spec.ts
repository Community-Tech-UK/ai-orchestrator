import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CliVerificationCoordinator, type AgentConfig } from './cli-verification-extension';
import type { VerificationRequest } from '../../shared/types/verification.types';
import type { ProviderAdapter } from '@sdk/provider-adapter';
import type {
  ProviderRuntimeEvent,
  ProviderRuntimeEventEnvelope,
} from '@contracts/types/provider-runtime-events';

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/aio-test',
  },
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('CliVerificationCoordinator verification lifecycle events', () => {
  let coordinator: CliVerificationCoordinator;

  beforeEach(() => {
    CliVerificationCoordinator._resetForTesting();
    coordinator = CliVerificationCoordinator.getInstance();
  });

  it('emits round progress and consensus score during CLI verification', async () => {
    const roundProgress = vi.fn();
    const consensusUpdate = vi.fn();
    coordinator.on('verification:round-progress', roundProgress);
    coordinator.on('verification:consensus-update', consensusUpdate);

    const request = makeRequest('verification-consensus');
    const session = makeSession(request);
    const sharedResponse = [
      '## Key Points',
      '- [fact] shared finding (Confidence: 80%)',
      '',
      '## Overall Confidence',
      '80%',
    ].join('\n');
    const agents = [
      makeAgent('Agent A', makeSuccessfulProvider(sharedResponse)),
      makeAgent('Agent B', makeSuccessfulProvider(sharedResponse)),
    ];

    await testSeam(coordinator).runCliVerification(request, agents, session);

    expect(roundProgress).toHaveBeenCalledWith({
      requestId: 'verification-consensus',
      round: 1,
      total: 1,
    });
    expect(consensusUpdate).toHaveBeenCalledWith({
      requestId: 'verification-consensus',
      score: 1,
    });
  });

  it('emits an agent-error event when an agent provider fails', async () => {
    const agentError = vi.fn();
    coordinator.on('verification:agent-error', agentError);

    const request = makeRequest('verification-agent-error');
    const session = makeSession(request);

    await testSeam(coordinator).runAgent(
      request,
      makeAgent('Agent A', makeFailingProvider(new Error('provider failed'))),
      0,
      session,
    );

    expect(agentError).toHaveBeenCalledWith({
      requestId: 'verification-agent-error',
      agentId: 'verification-agent-error-agent-a-0',
      agentName: 'Agent A',
      error: 'provider failed',
    });
  });
});

interface VerificationSession {
  request: VerificationRequest;
  providers: Map<string, ProviderAdapter>;
  cancelled: boolean;
}

type CliVerificationCoordinatorTestSeam = CliVerificationCoordinator & {
  runCliVerification(
    request: VerificationRequest,
    agents: AgentConfig[],
    session: VerificationSession,
  ): Promise<unknown>;
  runAgent(
    request: VerificationRequest,
    agent: AgentConfig,
    index: number,
    session: VerificationSession,
  ): Promise<unknown>;
};

function testSeam(coordinator: CliVerificationCoordinator): CliVerificationCoordinatorTestSeam {
  return coordinator as unknown as CliVerificationCoordinatorTestSeam;
}

function makeRequest(id: string): VerificationRequest {
  return {
    id,
    instanceId: 'instance-1',
    prompt: 'Check this implementation',
    config: {
      agentCount: 2,
      timeout: 2000,
      synthesisStrategy: 'merge',
    },
  };
}

function makeSession(request: VerificationRequest): {
  request: VerificationRequest;
  providers: Map<string, ProviderAdapter>;
  cancelled: boolean;
} {
  return {
    request,
    providers: new Map<string, unknown>(),
    cancelled: false,
  };
}

function makeAgent(name: string, provider: ProviderAdapter): AgentConfig {
  return {
    type: 'cli',
    name,
    command: name.toLowerCase().replace(/\s+/g, '-'),
    provider,
  };
}

function makeSuccessfulProvider(response: string): ProviderAdapter {
  const events$ = new Subject<ProviderRuntimeEventEnvelope>();
  return {
    events$,
    initialize: vi.fn(() => Promise.resolve()),
    sendMessage: vi.fn(() => {
      events$.next(makeProviderEvent({ kind: 'output', content: response }));
      events$.next(makeProviderEvent({ kind: 'context', used: 42, total: 100 }));
      events$.next(makeProviderEvent({ kind: 'status', status: 'idle' }));
      return Promise.resolve();
    }),
    terminate: vi.fn(() => Promise.resolve()),
  } as unknown as ProviderAdapter;
}

function makeFailingProvider(error: Error): ProviderAdapter {
  const events$ = new Subject<ProviderRuntimeEventEnvelope>();
  return {
    events$,
    initialize: vi.fn(() => Promise.resolve()),
    sendMessage: vi.fn(() => Promise.reject(error)),
    terminate: vi.fn(() => Promise.resolve()),
  } as unknown as ProviderAdapter;
}

function makeProviderEvent(event: ProviderRuntimeEvent): ProviderRuntimeEventEnvelope {
  return {
    eventId: `event-${event.kind}`,
    seq: 1,
    timestamp: 1,
    provider: 'codex',
    instanceId: 'instance-1',
    event,
  };
}
