import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutputMessage } from '../../../shared/types/instance.types';
import type { StoppedHelper } from '../../session/session-continuity.types';

const logs = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../../logging/logger', () => ({ getLogger: () => logs }));

import { ClaudeBackgroundWorkTermination } from './claude-background-work-termination';

const helper = (overrides: Partial<StoppedHelper> = {}): StoppedHelper => ({
  toolUseId: 'toolu-1',
  agentId: 'agent-1',
  sessionId: 'session-old',
  toolUseCount: 2,
  lastActivityAt: 111,
  ...overrides,
});

function makeTermination() {
  const emitted: OutputMessage[] = [];
  const termination = new ClaudeBackgroundWorkTermination((message) => {
    emitted.push(message);
  });
  return { emitted, termination };
}

beforeEach(() => {
  logs.warn.mockClear();
});

describe('ClaudeBackgroundWorkTermination', () => {
  it('reports one system message with the settled wording and the stopped helper records', () => {
    const { emitted, termination } = makeTermination();
    const stopped = [helper(), helper({ toolUseId: 'toolu-2', agentId: 'agent-2' })];
    termination.report(stopped);
    expect(emitted).toHaveLength(1);
    const message = emitted[0]!;
    expect(message.type).toBe('system');
    expect(message.content).toBe('Stopped 2 helper agents that had not finished.');
    expect(message.metadata?.['stoppedHelpers']).toEqual(stopped);
  });

  it('uses the singular wording for one helper', () => {
    const { emitted, termination } = makeTermination();
    termination.report([helper()]);
    expect(emitted[0]!.content).toBe('Stopped 1 helper agent that had not finished.');
  });

  it('routes the notice to the reporter instead of the output sink', () => {
    const { emitted, termination } = makeTermination();
    const reported: OutputMessage[] = [];
    termination.setReporter((message) => {
      reported.push(message);
    });
    termination.report([helper()]);
    expect(emitted).toHaveLength(0);
    expect(reported).toHaveLength(1);
    expect(reported[0]!.metadata?.['stoppedHelpers']).toEqual([helper()]);
  });

  it('reports a stopped helper once but reports it again when it progressed', () => {
    const { emitted, termination } = makeTermination();
    termination.report([helper({ toolUseCount: 1 })]);
    termination.report([helper({ toolUseCount: 1 })]);
    expect(emitted).toHaveLength(1);
    termination.report([helper({ toolUseCount: 2 })]);
    expect(emitted).toHaveLength(2);
    expect(emitted[1]!.metadata?.['stoppedHelpers']).toEqual([helper({ toolUseCount: 2 })]);
  });

  it('stays silent when there is nothing new to report', () => {
    const { emitted, termination } = makeTermination();
    termination.report([]);
    expect(emitted).toHaveLength(0);
    termination.report([helper()]);
    termination.report([helper()]);
    expect(emitted).toHaveLength(1);
  });

  it('waits for an asynchronous reporter before settling', async () => {
    const { termination } = makeTermination();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    termination.setReporter(async () => {
      await gate;
      order.push('reported');
    });
    termination.report([helper()]);
    const settled = termination.settle().then(() => order.push('settled'));
    expect(order).toEqual([]);
    release();
    await settled;
    expect(order).toEqual(['reported', 'settled']);
  });

  it('keeps shutdown alive when the reporter rejects', async () => {
    const { termination } = makeTermination();
    termination.setReporter(() => Promise.reject(new Error('sink down')));
    termination.report([helper()]);
    await expect(termination.settle()).resolves.toBeUndefined();
    expect(logs.warn).toHaveBeenCalledWith('Could not save stopped helper agents', expect.objectContaining({ count: 1 }));
  });

  it('keeps shutdown alive when the reporter throws', async () => {
    const { emitted, termination } = makeTermination();
    termination.setReporter(() => {
      throw new Error('sink down');
    });
    expect(() => termination.report([helper()])).not.toThrow();
    await expect(termination.settle()).resolves.toBeUndefined();
    expect(emitted).toHaveLength(0);
    expect(logs.warn).toHaveBeenCalledWith('Could not record stopped helper agents', expect.objectContaining({ count: 1 }));
  });

  it('falls back to the output sink when the reporter is cleared', () => {
    const { emitted, termination } = makeTermination();
    termination.setReporter(() => undefined);
    termination.setReporter(null);
    termination.report([helper()]);
    expect(emitted).toHaveLength(1);
  });
});
