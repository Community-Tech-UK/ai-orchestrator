import { describe, expect, it, vi } from 'vitest';
import { OrchestratorToolsRpcServer } from './orchestrator-tools-rpc-server';
const state = vi.hoisted(() => ({ ready: () => {}, resume: Promise.resolve(), writes: 0 }));
vi.mock('./connector-rpc', () => ({
  dispatchConnectorRpc: async (
    _method: string,
    _id: string,
    _payload: unknown,
    _deps: unknown,
    context: { assertActive(): void },
  ) => {
    state.ready();
    await state.resume;
    context.assertActive();
    state.writes++;
    return { ok: true };
  },
}));
describe('connector session generation checks', () => {
  it('rejects an old request after the provider restarts under the same session id', async () => {
    let ready!: () => void;
    const waiting = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let resume!: () => void;
    state.resume = new Promise<void>((resolve) => {
      resume = resolve;
    });
    state.ready = ready;
    state.writes = 0;
    let generation = '1:1';
    const server = new OrchestratorToolsRpcServer({
      userDataPath: '/tmp/connector-generation-fixture',
      operatorDbPath: ':memory:',
      isKnownLocalInstance: () => true,
      getInstanceGeneration: () => generation,
      registerCleanup: () => undefined,
      toolFactory: () => [],
    });
    const pending = server.handleRequest({
      method: 'connectors.graph',
      params: { instanceId: 'fixture', payload: { name: 'example' } },
    });
    const rejected = expect(pending).rejects.toThrow('changed');
    await waiting;
    generation = '2:2';
    resume();
    await rejected;
    expect(state.writes).toBe(0);
    await server.stop();
  });
});
