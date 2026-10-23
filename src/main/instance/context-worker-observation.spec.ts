import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextWorkerClient } from './context-worker-client';

vi.mock('../logging/logger', () => ({ getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/context-worker-observation' } }));

const clients: ContextWorkerClient[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.shutdown())); });
function setup() {
  const worker = Object.assign(new EventEmitter(), { postMessage: vi.fn(), terminate: vi.fn().mockResolvedValue(0) });
  const client = new ContextWorkerClient({ workerFactory: () => worker, userDataPath: '/tmp/context-worker-observation' });
  clients.push(client);
  return { worker, client };
}

describe('Observation context worker setting', () => {
  it('skips worker lookup by default and sends explicit opt-in with enabled requests', async () => {
    const { worker, client } = setup();
    expect(await client.buildObservationContext('task')).toBe('');
    expect(worker.postMessage).not.toHaveBeenCalled();
    client.setObservationMemoryEnabled(true);
    const result = client.buildObservationContext('task', 'inst-1');
    const request = worker.postMessage.mock.calls.at(-1)![0];
    expect(request).toMatchObject({ type: 'build-observation-context', enabled: true, taskContext: 'task' });
    worker.emit('message', { type: 'rpc-response', id: request.id, result: 'Learned reflection' });
    expect(await result).toBe('Learned reflection');
  });
  it('discards an in-flight result when memory is switched off', async () => {
    const { worker, client } = setup();
    client.setObservationMemoryEnabled(true);
    const result = client.buildObservationContext('task');
    const request = worker.postMessage.mock.calls.at(-1)![0];
    client.setObservationMemoryEnabled(false);
    expect(worker.postMessage).toHaveBeenLastCalledWith({ type: 'configure-observation-memory', enabled: false });
    worker.emit('message', { type: 'rpc-response', id: request.id, result: 'Old reflection' });
    expect(await result).toBe('');
  });
});
