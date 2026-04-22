import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCategory, ErrorSeverity } from '../../shared/types/error-recovery.types';
import type {
  ProviderCapabilities,
  ProviderStatus,
  ProviderType,
} from '../../shared/types/provider.types';

const providerStatusByType = new Map<ProviderType, ProviderStatus>();
const providerCapabilitiesByType = new Map<ProviderType, ProviderCapabilities>();
const breakerStateByName = new Map<
  string,
  { state: 'closed' | 'open' | 'half_open'; failureCount: number }
>();

const checkProviderStatus = vi.fn(async (type: ProviderType) => {
  const status = providerStatusByType.get(type);
  if (!status) {
    throw new Error(`No status configured for ${type}`);
  }
  return status;
});

const createProvider = vi.fn((type: ProviderType) => ({
  getCapabilities: () => providerCapabilitiesByType.get(type),
}));

function getBreaker(name: string) {
  return {
    on: vi.fn(),
    getStats: vi.fn(() => {
      const state = breakerStateByName.get(name) ?? {
        state: 'closed' as const,
        failureCount: 0,
      };
      return {
        state: state.state,
        failureCount: state.failureCount,
      };
    }),
    recordFailure: vi.fn(),
    recordSuccess: vi.fn(),
    execute: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
  };
}

vi.mock('../logging/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('./provider-instance-manager', () => ({
  getProviderInstanceManager: vi.fn(() => ({
    checkProviderStatus,
    createProvider,
  })),
}));

vi.mock('../core/circuit-breaker', () => ({
  CircuitState: {
    CLOSED: 'closed',
    OPEN: 'open',
    HALF_OPEN: 'half_open',
  },
  CircuitBreakerRegistry: {
    getInstance: vi.fn(() => ({
      getBreaker: vi.fn((name: string) => getBreaker(name)),
    })),
  },
}));

vi.mock('../core/error-recovery', () => ({
  ErrorRecoveryManager: {
    getInstance: vi.fn(() => ({
      classifyError: vi.fn((error: Error) => ({
        original: error,
        category: ErrorCategory.PROMPT_DELIVERY,
        severity: ErrorSeverity.ERROR,
        recoverable: true,
        retryAfterMs: 100,
        userMessage: 'retry',
        technicalDetails: error.message,
        timestamp: Date.now(),
      })),
    })),
  },
}));

import { FailoverManager } from './failover-manager';

function setProviderStatus(type: ProviderType, overrides?: Partial<ProviderStatus>): void {
  providerStatusByType.set(type, {
    type,
    available: true,
    authenticated: true,
    ...overrides,
  });
}

function setProviderCapabilities(
  type: ProviderType,
  overrides?: Partial<ProviderCapabilities>,
): void {
  providerCapabilitiesByType.set(type, {
    toolExecution: true,
    streaming: true,
    multiTurn: true,
    vision: false,
    fileAttachments: true,
    functionCalling: true,
    builtInCodeTools: true,
    ...overrides,
  });
}

function setBreakerState(
  provider: ProviderType,
  state: 'closed' | 'open' | 'half_open',
  failureCount = 0,
): void {
  breakerStateByName.set(`provider-${provider}`, { state, failureCount });
}

describe('FailoverManager', () => {
  let manager: FailoverManager;

  beforeEach(() => {
    providerStatusByType.clear();
    providerCapabilitiesByType.clear();
    breakerStateByName.clear();
    checkProviderStatus.mockClear();
    createProvider.mockClear();
    FailoverManager._resetForTesting();
    manager = FailoverManager.getInstance();
    manager.reset();
    manager.configure({
      providerPriority: ['claude-cli', 'openai', 'google'],
      maxProviderAttempts: 3,
      providerCooldownMs: 60_000,
    });

    setProviderStatus('claude-cli');
    setProviderStatus('openai');
    setProviderStatus('google');
    setProviderCapabilities('claude-cli', { vision: true });
    setProviderCapabilities('openai', { vision: false });
    setProviderCapabilities('google', { vision: true });
    setBreakerState('claude-cli', 'closed');
    setBreakerState('openai', 'closed');
    setBreakerState('google', 'closed');
  });

  it('selects the next provider that satisfies required capabilities', async () => {
    const nextProvider = await manager.failover('claude-cli', 'reroute', {
      requiredCapabilities: { vision: true },
      correlationId: 'verify-1:agent-2',
    });

    expect(nextProvider).toBe('google');
    expect(manager.getCurrentProvider()).toBe('google');
  });

  it('rejects higher-priority candidates with unhealthy circuits', async () => {
    setBreakerState('openai', 'open', 4);

    const nextProvider = await manager.failover('claude-cli', 'reroute');

    expect(nextProvider).toBe('google');
  });

  it('retries an operation on the next ranked provider during executeWithFailover', async () => {
    manager.setPrimaryProvider('claude-cli');
    const onFailover = vi.fn();
    const operation = vi.fn(async (provider: ProviderType) => {
      if (provider === 'claude-cli') {
        throw new Error('failed to deliver prompt to provider');
      }
      return provider;
    });

    const result = await manager.executeWithFailover(operation, {
      onFailover,
      requiredCapabilities: { vision: true },
      correlationId: 'debate-4:round-1',
    });

    expect(result).toBe('google');
    expect(operation).toHaveBeenNthCalledWith(1, 'claude-cli');
    expect(operation).toHaveBeenNthCalledWith(2, 'google');
    expect(onFailover).toHaveBeenCalledWith('claude-cli', 'google');
  });
});
