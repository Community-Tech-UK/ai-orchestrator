import { describe, expect, it, vi } from 'vitest';
import type { LoopConfigInput } from '@contracts/schemas/loop';
import type { InstanceManager } from '../../../instance/instance-manager';
import { buildExistingSessionContext } from '../loop-handlers';

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
  },
}));

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../../orchestration/loop-coordinator', () => ({
  getLoopCoordinator: () => ({
    registerIterationHook: vi.fn(),
    on: vi.fn(),
    startLoop: vi.fn(),
    pauseLoop: vi.fn(),
    resumeLoop: vi.fn(),
    intervene: vi.fn(),
    cancelLoop: vi.fn(),
    getLoop: vi.fn(),
  }),
}));

vi.mock('../../../orchestration/loop-store', () => ({
  getLoopStore: () => ({
    upsertRun: vi.fn(),
    insertIteration: vi.fn(),
    getRunSummary: vi.fn(),
    listRunsForChat: vi.fn(),
    getIterations: vi.fn(),
  }),
}));

function makeConfig(initialPrompt = 'Please continue the current implementation.'): LoopConfigInput {
  return {
    initialPrompt,
    workspaceCwd: '/tmp/project',
  };
}

function makeInstanceManager(outputBuffer: unknown[]): InstanceManager {
  return {
    getInstance: vi.fn(() => ({ outputBuffer })),
  } as unknown as InstanceManager;
}

describe('buildExistingSessionContext', () => {
  it('builds runtime-only recent visible-session transcript context for an existing-session loop', () => {
    const marker = 'EXISTING_CONTEXT_MARKER_54291';
    const config = makeConfig('Use the previous context to write the marker to disk.');
    const instanceManager = makeInstanceManager([
      {
        id: 'msg-1',
        type: 'user',
        content: `Remember this marker for the next continuation: ${marker}`,
        timestamp: 1,
      },
      {
        id: 'msg-2',
        type: 'assistant',
        content: 'I will use that marker when continuing.',
        timestamp: 2,
      },
    ]);

    const context = buildExistingSessionContext(
      instanceManager,
      'chat-existing',
    );

    expect(config.initialPrompt).toBe('Use the previous context to write the marker to disk.');
    expect(context).toContain('<conversation_history>');
    expect(context).toContain(marker);
    expect(context).toContain('read-only background');
  });

  it('leaves new or transcriptless loop starts unchanged', () => {
    const instanceManager = makeInstanceManager([]);

    const result = buildExistingSessionContext(instanceManager, 'chat-empty');

    expect(result).toBeUndefined();
  });
});
