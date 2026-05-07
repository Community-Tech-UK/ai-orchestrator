import { describe, expect, it } from 'vitest';
import { OPERATOR_CHANNELS } from '../operator.channels';
import { IPC_CHANNELS } from '../index';

describe('OPERATOR_CHANNELS', () => {
  it('defines only the retained operator run audit IPC channels', () => {
    expect(OPERATOR_CHANNELS).toEqual({
      OPERATOR_LIST_RUNS: 'operator:list-runs',
      OPERATOR_GET_RUN: 'operator:get-run',
      OPERATOR_CANCEL_RUN: 'operator:cancel-run',
      OPERATOR_EVENT: 'operator:event',
    });
  });

  it('is included in the merged IPC channel map', () => {
    expect(IPC_CHANNELS.OPERATOR_GET_RUN).toBe('operator:get-run');
    expect(IPC_CHANNELS.OPERATOR_CANCEL_RUN).toBe('operator:cancel-run');
    expect(IPC_CHANNELS.OPERATOR_EVENT).toBe('operator:event');
  });

  it('does not expose deleted deterministic operator surface channels', () => {
    const channels = IPC_CHANNELS as Record<string, string | undefined>;

    expect(channels['OPERATOR_GET_THREAD']).toBeUndefined();
    expect(channels['OPERATOR_SEND_MESSAGE']).toBeUndefined();
    expect(channels['OPERATOR_LIST_PROJECTS']).toBeUndefined();
    expect(channels['OPERATOR_RESCAN_PROJECTS']).toBeUndefined();
    expect(channels['OPERATOR_RETRY_RUN']).toBeUndefined();
  });
});
