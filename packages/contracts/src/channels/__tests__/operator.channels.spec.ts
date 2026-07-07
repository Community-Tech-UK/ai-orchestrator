import { describe, expect, it } from 'vitest';
import { OPERATOR_CHANNELS } from '../operator.channels';
import { IPC_CHANNELS } from '../index';

describe('OPERATOR_CHANNELS', () => {
  it('defines only the retained operator run audit IPC channels', () => {
    expect(OPERATOR_CHANNELS).toEqual({
      OPERATOR_LIST_RUNS: 'operator:list-runs',
      OPERATOR_GET_RUN: 'operator:get-run',
      OPERATOR_CANCEL_RUN: 'operator:cancel-run',
      OPERATOR_LIST_PROJECTS: 'operator:list-projects',
      OPERATOR_RESCAN_PROJECTS: 'operator:rescan-projects',
      OPERATOR_RESOLVE_PROJECT: 'operator:resolve-project',
      OPERATOR_PLAN_PROJECT_VERIFICATION: 'operator:plan-project-verification',
      OPERATOR_EVENT: 'operator:event',
    });
  });

  it('is included in the merged IPC channel map', () => {
    expect(IPC_CHANNELS.OPERATOR_GET_RUN).toBe('operator:get-run');
    expect(IPC_CHANNELS.OPERATOR_CANCEL_RUN).toBe('operator:cancel-run');
    expect(IPC_CHANNELS.OPERATOR_LIST_PROJECTS).toBe('operator:list-projects');
    expect(IPC_CHANNELS.OPERATOR_RESCAN_PROJECTS).toBe('operator:rescan-projects');
    expect(IPC_CHANNELS.OPERATOR_RESOLVE_PROJECT).toBe('operator:resolve-project');
    expect(IPC_CHANNELS.OPERATOR_PLAN_PROJECT_VERIFICATION).toBe('operator:plan-project-verification');
    expect(IPC_CHANNELS.OPERATOR_EVENT).toBe('operator:event');
  });

  it('does not expose deleted deterministic operator surface channels', () => {
    const channels = IPC_CHANNELS as Record<string, string | undefined>;

    expect(channels['OPERATOR_GET_THREAD']).toBeUndefined();
    expect(channels['OPERATOR_SEND_MESSAGE']).toBeUndefined();
    expect(channels['OPERATOR_RETRY_RUN']).toBeUndefined();
  });
});
