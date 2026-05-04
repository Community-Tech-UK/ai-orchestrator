import { describe, expect, it } from 'vitest';
import {
  type AppServerRequestParams,
  type AppServerResponseResult,
  BROKER_BUSY_RPC_CODE,
  BROKER_ENDPOINT_ENV,
  DEFAULT_OPT_OUT_NOTIFICATIONS,
  SERVICE_NAME,
  STREAMING_METHODS,
  TASK_THREAD_PREFIX,
} from './app-server-types';

describe('app-server-types constants', () => {
  it('exports BROKER_BUSY_RPC_CODE as -32001', () => {
    expect(BROKER_BUSY_RPC_CODE).toBe(-32001);
  });

  it('exports BROKER_ENDPOINT_ENV', () => {
    expect(BROKER_ENDPOINT_ENV).toBe('CODEX_COMPANION_APP_SERVER_ENDPOINT');
  });

  it('exports STREAMING_METHODS with expected methods', () => {
    expect(STREAMING_METHODS.has('turn/start')).toBe(true);
    expect(STREAMING_METHODS.has('review/start')).toBe(true);
    expect(STREAMING_METHODS.has('thread/compact/start')).toBe(true);
    expect(STREAMING_METHODS.size).toBe(3);
  });

  it('exports DEFAULT_OPT_OUT_NOTIFICATIONS for delta streaming', () => {
    expect(DEFAULT_OPT_OUT_NOTIFICATIONS).toContain('item/agentMessage/delta');
    expect(DEFAULT_OPT_OUT_NOTIFICATIONS).toContain('item/reasoning/summaryTextDelta');
    expect(DEFAULT_OPT_OUT_NOTIFICATIONS.length).toBe(4);
  });

  it('exports SERVICE_NAME for orchestrator identification', () => {
    expect(SERVICE_NAME).toBe('ai-orchestrator');
  });

  it('exports TASK_THREAD_PREFIX', () => {
    expect(TASK_THREAD_PREFIX).toBe('AI Orchestrator Task');
  });

  it('types current durable thread read and list methods', () => {
    const listParams: AppServerRequestParams<'thread/list'> = {
      sourceKinds: ['cli', 'vscode', 'appServer'],
      limit: 25,
      sortDirection: 'desc',
      useStateDbOnly: true,
    };
    const listResponse: AppServerResponseResult<'thread/list'> = {
      data: [],
      nextCursor: null,
      backwardsCursor: null,
    };
    const readParams: AppServerRequestParams<'thread/read'> = {
      threadId: 'thr_1',
      includeTurns: true,
    };
    const turnsParams: AppServerRequestParams<'thread/turns/list'> = {
      threadId: 'thr_1',
      limit: 50,
      sortDirection: 'desc',
    };

    expect(listParams.sourceKinds).toContain('appServer');
    expect(listResponse.data).toEqual([]);
    expect(readParams.includeTurns).toBe(true);
    expect(turnsParams.limit).toBe(50);
  });
});
