/**
 * ConsensusCoordinator Tests
 *
 * Validates that consensus fan-out uses non-persistent Codex sessions so
 * internal orchestration prompts do not leak into the user's Codex app.
 */

import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { detectAllMock, createAdapterMock } = vi.hoisted(() => ({
  detectAllMock: vi.fn(),
  createAdapterMock: vi.fn(),
}));

vi.mock('../../logging/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('../../cli/cli-detection', () => ({
  CliDetectionService: {
    getInstance: vi.fn(() => ({
      detectAll: detectAllMock,
    })),
  },
}));

vi.mock('../../providers/provider-runtime-service', () => ({
  getProviderRuntimeService: vi.fn(() => ({
    createAdapter: createAdapterMock,
  })),
}));

vi.mock('../utils/coordinator-error-handler', () => ({
  handleCoordinatorError: vi.fn((error: unknown) => ({
    classified: {
      category: 'unknown',
      message: error instanceof Error ? error.message : String(error),
    },
  })),
}));

import { ConsensusCoordinator } from '../consensus-coordinator';

class MockConsensusAdapter extends EventEmitter {
  spawn = vi.fn().mockResolvedValue(1234);
  terminate = vi.fn().mockResolvedValue(undefined);
  sendInput = vi.fn(async () => {
    this.emit('output', {
      id: 'response-1',
      timestamp: Date.now(),
      type: 'assistant',
      content: 'Consensus response',
    });
    this.emit('status', 'idle');
  });
}

describe('ConsensusCoordinator', () => {
  beforeEach(() => {
    ConsensusCoordinator._resetForTesting();
    vi.clearAllMocks();
  });

  afterEach(() => {
    ConsensusCoordinator._resetForTesting();
  });

  it('uses ephemeral Codex sessions for consensus fan-out', async () => {
    detectAllMock.mockResolvedValue({ available: [{ name: 'codex' }] });
    createAdapterMock.mockImplementation(() => new MockConsensusAdapter());

    const coordinator = ConsensusCoordinator.getInstance();
    const result = await coordinator.query('Should this stay hidden?', undefined, {
      providers: [{ provider: 'codex' }],
      workingDirectory: '/tmp/project',
      timeout: 1,
    });

    expect(createAdapterMock).toHaveBeenCalledWith({
      cliType: 'codex',
      options: expect.objectContaining({
        workingDirectory: '/tmp/project',
        ephemeral: true,
      }),
    });
    expect(result.successCount).toBe(1);
    expect(result.responses[0]?.success).toBe(true);
  });

  it('does not force ephemeral mode for non-Codex providers', async () => {
    detectAllMock.mockResolvedValue({ available: [{ name: 'claude' }] });
    createAdapterMock.mockImplementation(() => new MockConsensusAdapter());

    const coordinator = ConsensusCoordinator.getInstance();
    await coordinator.query('Normal provider query', undefined, {
      providers: [{ provider: 'claude' }],
      workingDirectory: '/tmp/project',
      timeout: 1,
    });

    expect(createAdapterMock).toHaveBeenCalledWith({
      cliType: 'claude',
      options: expect.not.objectContaining({
        ephemeral: true,
      }),
    });
  });

	  it('collects only assistant output when providers emit mixed message types', async () => {
    detectAllMock.mockResolvedValue({ available: [{ name: 'claude' }] });
    createAdapterMock.mockImplementation(() => {
      const adapter = new MockConsensusAdapter();
      adapter.sendInput = vi.fn(async () => {
        adapter.emit('output', {
          id: 'system-1',
          timestamp: Date.now(),
          type: 'system',
          content: 'system noise',
        });
        adapter.emit('output', {
          id: 'assistant-1',
          timestamp: Date.now(),
          type: 'assistant',
          content: 'Assistant answer',
        });
        adapter.emit('status', 'idle');
      });
      return adapter;
    });

    const coordinator = ConsensusCoordinator.getInstance();
    const result = await coordinator.query('Mixed output query', undefined, {
      providers: [{ provider: 'claude' }],
      workingDirectory: '/tmp/project',
      timeout: 1,
    });

    expect(result.responses[0]?.content).toBe('Assistant answer');
	  });

  it('bounds raw all-strategy consensus output', async () => {
    detectAllMock.mockResolvedValue({ available: [{ name: 'claude' }, { name: 'gemini' }] });
    createAdapterMock.mockImplementation(() => {
      const adapter = new MockConsensusAdapter();
      adapter.sendInput = vi.fn(async () => {
        adapter.emit('output', {
          id: 'assistant-long',
          timestamp: Date.now(),
          type: 'assistant',
          content: 'x'.repeat(10_000),
        });
        adapter.emit('status', 'idle');
      });
      return adapter;
    });

    const coordinator = ConsensusCoordinator.getInstance();
    const result = await coordinator.query('Give long output', undefined, {
      providers: [{ provider: 'claude' }, { provider: 'gemini' }],
      strategy: 'all',
      timeout: 1,
    });

    expect(result.consensus.length).toBeLessThanOrEqual(8_003);
    expect(result.consensus).toContain('...');
  });
	});
