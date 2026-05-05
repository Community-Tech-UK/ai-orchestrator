import { describe, expect, it } from 'vitest';
import { OPERATOR_CHANNELS } from '../operator.channels';
import { IPC_CHANNELS } from '../index';

describe('OPERATOR_CHANNELS', () => {
  it('defines the global operator IPC channels', () => {
    expect(OPERATOR_CHANNELS).toEqual({
      OPERATOR_GET_THREAD: 'operator:get-thread',
      OPERATOR_SEND_MESSAGE: 'operator:send-message',
      OPERATOR_LIST_PROJECTS: 'operator:list-projects',
      OPERATOR_RESCAN_PROJECTS: 'operator:rescan-projects',
      OPERATOR_LIST_RUNS: 'operator:list-runs',
      OPERATOR_GET_RUN: 'operator:get-run',
    });
  });

  it('is included in the merged IPC channel map', () => {
    expect(IPC_CHANNELS.OPERATOR_GET_THREAD).toBe('operator:get-thread');
    expect(IPC_CHANNELS.OPERATOR_SEND_MESSAGE).toBe('operator:send-message');
    expect(IPC_CHANNELS.OPERATOR_GET_RUN).toBe('operator:get-run');
    expect(IPC_CHANNELS.OPERATOR_LIST_PROJECTS).toBe('operator:list-projects');
    expect(IPC_CHANNELS.OPERATOR_RESCAN_PROJECTS).toBe('operator:rescan-projects');
  });
});
