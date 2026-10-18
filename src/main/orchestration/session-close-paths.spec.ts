import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoopState } from '../../shared/types/loop.types';

const harness = vi.hoisted(() => ({
  loops: [] as Pick<LoopState, 'id' | 'chatId' | 'status' | 'endedAt'>[],
  events: [] as string[],
  handlers: new Map<string, (event?: unknown, payload?: unknown) => Promise<unknown>>(),
  cancelLoop: vi.fn(async (id: string) => { harness.events.push(`loop:${id}`); return true; }),
}));
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: never) => harness.handlers.set(channel, handler) },
  app: { getPath: () => '/tmp/aio-test', isPackaged: false },
}));
vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ get: () => undefined, getAll: () => ({}) }),
}));
vi.mock('../commands/command-manager', () => ({ getCommandManager: vi.fn(), CommandManager: vi.fn() }));
vi.mock('./loop-coordinator', () => ({ getLoopCoordinator: () => ({
  getActiveLoops: () => harness.loops, cancelLoop: harness.cancelLoop,
}) }));

import { IPC_CHANNELS } from '@contracts/channels';
import { registerInstanceHandlers } from '../ipc/handlers/instance-handlers';
import { terminateInstance as thinTerminate } from '../event-bus/thin-client-instance-commands';
import { MobileGatewayInstanceRoutes } from '../mobile-gateway/mobile-gateway-instance-routes';

describe('deliberate session close boundaries', () => {
  beforeEach(() => {
    harness.events.length = 0;
    harness.handlers.clear();
    harness.cancelLoop.mockClear();
    harness.loops = [
      { id: 'owned', chatId: 's1', status: 'paused', endedAt: null },
      { id: 'other-session', chatId: 's2', status: 'running', endedAt: null },
      { id: 'chat-owned', chatId: 'chat-id', status: 'running', endedAt: null },
    ];
  });

  const manager = () => ({
    getAllInstances: () => [{ id: 's1' }, { id: 's2' }],
    terminateInstance: vi.fn(async (id: string, _graceful: boolean) => { harness.events.push(`session:${id}`); }),
    terminateAllInstances: vi.fn(async () => { harness.events.push('all'); }),
  });

  it('desktop single close waits for its session loop before teardown and leaves chat-id loops alone', async () => {
    const instanceManager = manager();
    registerInstanceHandlers({ instanceManager, windowManager: {} } as never);
    const response = await harness.handlers.get(IPC_CHANNELS.INSTANCE_TERMINATE)!({}, { instanceId: 's1' });
    expect(response).toEqual({ success: true });
    expect(harness.events).toEqual(['loop:owned', 'session:s1']);
  });

  it('desktop Close all stops only session-keyed loops before bulk close', async () => {
    registerInstanceHandlers({ instanceManager: manager(), windowManager: {} } as never);
    const response = await harness.handlers.get(IPC_CHANNELS.INSTANCE_TERMINATE_ALL)!();
    expect(response).toEqual({ success: true });
    expect(harness.events).toEqual(['loop:owned', 'loop:other-session', 'all']);
  });

  it('thin client stops its loop before graceful=false is forwarded', async () => {
    const instanceManager = manager();
    expect(await thinTerminate({ instanceManager } as never, { instanceId: 's1', graceful: false }))
      .toEqual({ success: true });
    expect(harness.events).toEqual(['loop:owned', 'session:s1']);
    expect(instanceManager.terminateInstance).toHaveBeenCalledWith('s1', false);
  });

  it('mobile terminate stops its loop before teardown and responds only afterward', async () => {
    const instanceManager = manager();
    const routes = new MobileGatewayInstanceRoutes({
      getInstanceSource: () => instanceManager,
      promptStore: { clearForInstance: vi.fn() },
      getModelCatalog: () => ({}),
      getListDynamicModels: () => undefined,
    } as never);
    const req = new PassThrough();
    const res = { writeHead: vi.fn(), end: vi.fn() };
    const url = new URL('http://localhost/api/instances/s1/terminate');
    const pending = routes.handle(req as unknown as IncomingMessage, res as unknown as ServerResponse, url,
      ['api', 'instances', 's1', 'terminate'], 'POST');
    req.end(JSON.stringify({ graceful: false }));
    expect(await pending).toBe(true);
    expect(harness.events).toEqual(['loop:owned', 'session:s1']);
    expect(instanceManager.terminateInstance).toHaveBeenCalledWith('s1', false);
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ ok: true }));
  });
});
