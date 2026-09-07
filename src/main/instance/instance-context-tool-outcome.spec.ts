/**
 * LT-196: the `tool_outcome` record exists only so the correction miner can
 * read a real `is_error` out of the archived transcript. It must never be
 * ingested into RLM — doing so spends the user's context budget on a message
 * with no reader and feeds the model an "external" section it cannot use.
 *
 * `ingestToRLM`'s type switch has a `default:` arm that files anything it does
 * not recognise as `external`, so a new `OutputMessage.type` leaks in by
 * default rather than being ignored. This covers the explicit exclusion.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';

const contextMocks = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  rlm: {
    getStore: vi.fn(() => ({ totalSize: 0 })),
    executeQuery: vi.fn(),
    addSection: vi.fn(),
    createStore: vi.fn((sessionId: string) => ({ id: `store-${sessionId}` })),
    startSession: vi.fn(async (_storeId: string, sessionId: string) => ({ id: `rlm-${sessionId}` })),
    endSession: vi.fn(),
  },
}));

vi.mock('../logging/logger', () => ({ getLogger: () => contextMocks.logger }));
vi.mock('../memory/unified-controller', () => ({
  getUnifiedMemory: () => ({ retrieve: vi.fn().mockResolvedValue(null) }),
}));
vi.mock('../rlm/context-manager', () => ({
  RLMContextManager: { getInstance: () => contextMocks.rlm },
}));

import { InstanceContextManager } from './instance-context';

/** Long enough to clear `ingestToRLM`'s 20-character minimum. */
const ERROR_TEXT = 'grep: unrecognized option --bogus-flag, aborting run';

function message(overrides: Partial<OutputMessage>): OutputMessage {
  return {
    id: `m-${Math.random().toString(36).slice(2)}`,
    timestamp: Date.now(),
    type: 'assistant',
    content: ERROR_TEXT,
    ...overrides,
  } as OutputMessage;
}

describe('InstanceContextManager.ingestToRLM — LT-196 tool_outcome exclusion', () => {
  let manager: InstanceContextManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    manager = new InstanceContextManager();
    await manager.initializeRlm({
      id: 'inst-1',
      sessionId: 'sess-1',
      metadata: {},
    } as unknown as Instance);
    contextMocks.rlm.addSection.mockClear();
  });

  it('never ingests a tool_outcome record, even with substantial error text', () => {
    manager.ingestToRLM('inst-1', message({
      type: 'tool_outcome',
      metadata: { tool_use_id: 'toolu_1', is_error: true, name: 'Bash' },
    }));

    expect(contextMocks.rlm.addSection).not.toHaveBeenCalled();
  });

  it('still ingests an ordinary tool_result, so the exclusion is not over-broad', () => {
    manager.ingestToRLM('inst-1', message({
      type: 'tool_result',
      metadata: { tool_use_id: 'toolu_1', is_error: true },
    }));

    expect(contextMocks.rlm.addSection).toHaveBeenCalledTimes(1);
  });
});
