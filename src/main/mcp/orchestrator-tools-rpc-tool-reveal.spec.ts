import { describe, expect, it } from 'vitest';
import {
  dispatchToolRevealRpc,
  isToolRevealRpcMethod,
  OrchestratorToolRevealStore,
  TOOL_REVEAL_RPC_METHODS,
} from './orchestrator-tools-rpc-tool-reveal';

describe('orchestrator tool reveal RPC', () => {
  it('remembers revealed tools per session and hands them back', () => {
    const store = new OrchestratorToolRevealStore();
    dispatchToolRevealRpc(store, TOOL_REVEAL_RPC_METHODS.record, 'session-a', { names: ['plan_queue_status'] });
    dispatchToolRevealRpc(store, TOOL_REVEAL_RPC_METHODS.record, 'session-a', { names: ['plan_queue_control', 'plan_queue_status'] });

    expect(dispatchToolRevealRpc(store, TOOL_REVEAL_RPC_METHODS.get, 'session-a', {}))
      .toEqual({ revealedNames: ['plan_queue_status', 'plan_queue_control'] });
    expect(dispatchToolRevealRpc(store, TOOL_REVEAL_RPC_METHODS.get, 'session-b', {}))
      .toEqual({ revealedNames: [] });
  });

  it('rejects malformed payloads', () => {
    const store = new OrchestratorToolRevealStore();
    expect(() => dispatchToolRevealRpc(store, TOOL_REVEAL_RPC_METHODS.record, 'session-a', { names: 'plan_queue_status' })).toThrow();
    expect(() => dispatchToolRevealRpc(store, TOOL_REVEAL_RPC_METHODS.record, 'session-a', { names: [''] })).toThrow();
    expect(() => dispatchToolRevealRpc(store, TOOL_REVEAL_RPC_METHODS.record, 'session-a', { names: [], extra: true })).toThrow();
    expect(() => dispatchToolRevealRpc(store, TOOL_REVEAL_RPC_METHODS.get, 'session-a', { instanceId: 'session-b' })).toThrow();
    expect(store.get('session-a')).toEqual([]);
  });

  it('keeps the most recently active sessions when it has to forget some', () => {
    const store = new OrchestratorToolRevealStore();
    store.record('first', ['plan_queue_status']);
    for (let index = 0; index < 499; index += 1) store.record(`session-${index}`, ['get_setting']);
    store.record('first', ['plan_queue_control']);
    store.record('one-too-many', ['get_setting']);

    expect(store.get('first')).toEqual(['plan_queue_status', 'plan_queue_control']);
    expect(store.get('session-0')).toEqual([]);
  });

  it('claims only its own two methods', () => {
    expect(isToolRevealRpcMethod(TOOL_REVEAL_RPC_METHODS.get)).toBe(true);
    expect(isToolRevealRpcMethod(TOOL_REVEAL_RPC_METHODS.record)).toBe(true);
    expect(isToolRevealRpcMethod('browser.tool_reveal_get')).toBe(false);
  });
});
