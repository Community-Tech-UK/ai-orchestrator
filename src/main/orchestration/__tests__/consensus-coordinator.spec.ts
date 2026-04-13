/**
 * ConsensusCoordinator Tests
 *
 * Validates that consensus fan-out uses non-persistent Codex sessions so
 * internal orchestration prompts do not leak into the user's Codex app.
 */

import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { detectAllMock, createCliAdapterMock } = vi.hoisted(() => ({
  detectAllMock: vi.fn(),
  createCliAdapterMock: vi.fn(),
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

vi.mock('../../cli/adapters/adapter-factory', () => ({
  createCliAdapter: createCliAdapterMock,
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
    createCliAdapterMock.mockImplementation(() => new MockConsensusAdapter());

    const coordinator = ConsensusCoordinator.getInstance();
    const result = await coordinator.query('Should this stay hidden?', undefined, {
      providers: [{ provider: 'codex' }],
      workingDirectory: '/tmp/project',
      timeout: 1,
    });

    expect(createCliAdapterMock).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({
        workingDirectory: '/tmp/project',
        ephemeral: true,
      }),
    );
    expect(result.successCount).toBe(1);
    expect(result.responses[0]?.success).toBe(true);
  });

  it('does not force ephemeral mode for non-Codex providers', async () => {
    detectAllMock.mockResolvedValue({ available: [{ name: 'claude' }] });
    createCliAdapterMock.mockImplementation(() => new MockConsensusAdapter());

    const coordinator = ConsensusCoordinator.getInstance();
    await coordinator.query('Normal provider query', undefined, {
      providers: [{ provider: 'claude' }],
      workingDirectory: '/tmp/project',
      timeout: 1,
    });

    expect(createCliAdapterMock).toHaveBeenCalledWith(
      'claude',
      expect.not.objectContaining({
        ephemeral: true,
      }),
    );
  });
});
