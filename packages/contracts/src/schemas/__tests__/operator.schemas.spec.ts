import { describe, expect, it } from 'vitest';
import {
  OperatorRunBudgetSchema,
  OperatorRunEventPayloadSchema,
  OperatorRunUsageSchema,
  OperatorListProjectsPayloadSchema,
  OperatorRescanProjectsPayloadSchema,
  OperatorRunIdPayloadSchema,
  OperatorSendMessagePayloadSchema,
} from '../operator.schemas';

describe('operator schemas', () => {
  it('accepts list-projects filters with a bounded limit', () => {
    expect(OperatorListProjectsPayloadSchema.parse({
      query: 'AI Orchestrator',
      limit: 25,
    })).toEqual({
      query: 'AI Orchestrator',
      limit: 25,
    });
  });

  it('accepts rescan roots and source toggles', () => {
    expect(OperatorRescanProjectsPayloadSchema.parse({
      roots: ['/Users/suas/work'],
      includeRecent: true,
      includeActiveInstances: false,
      includeConversationLedger: true,
    })).toEqual({
      roots: ['/Users/suas/work'],
      includeRecent: true,
      includeActiveInstances: false,
      includeConversationLedger: true,
    });
  });

  it('rejects blank operator messages', () => {
    expect(() => OperatorSendMessagePayloadSchema.parse({ text: '' })).toThrow();
  });

  it('accepts operator run-id control payloads', () => {
    expect(OperatorRunIdPayloadSchema.parse({ runId: 'run-1' })).toEqual({
      runId: 'run-1',
    });
    expect(() => OperatorRunIdPayloadSchema.parse({ runId: '' })).toThrow();
  });

  it('validates persisted operator budget and usage payloads', () => {
    expect(OperatorRunBudgetSchema.parse({
      maxNodes: 50,
      maxRetries: 3,
      maxWallClockMs: 7200000,
      maxConcurrentNodes: 3,
    })).toEqual({
      maxNodes: 50,
      maxRetries: 3,
      maxWallClockMs: 7200000,
      maxConcurrentNodes: 3,
    });
    expect(() => OperatorRunBudgetSchema.parse({
      maxNodes: -1,
      maxRetries: 3,
      maxWallClockMs: 7200000,
      maxConcurrentNodes: 3,
    })).toThrow();
    expect(() => OperatorRunUsageSchema.parse({
      nodesStarted: -1,
      nodesCompleted: 0,
      retriesUsed: 0,
      wallClockMs: 0,
    })).toThrow();
  });

  it('validates discriminated operator event payloads', () => {
    expect(OperatorRunEventPayloadSchema.parse({
      kind: 'shell-command',
      payload: {
        cmd: 'git',
        args: ['fetch', '--prune'],
        cwd: '/work/app',
        exitCode: 0,
        durationMs: 10,
        stdoutBytes: 0,
        stderrBytes: 0,
      },
    })).toMatchObject({
      kind: 'shell-command',
      payload: {
        cmd: 'git',
        args: ['fetch', '--prune'],
      },
    });
    expect(() => OperatorRunEventPayloadSchema.parse({
      kind: 'shell-command',
      payload: {
        cmd: 'git',
        args: 'fetch',
        cwd: '/work/app',
        exitCode: 0,
        durationMs: 10,
        stdoutBytes: 0,
        stderrBytes: 0,
      },
    })).toThrow();
  });
});
