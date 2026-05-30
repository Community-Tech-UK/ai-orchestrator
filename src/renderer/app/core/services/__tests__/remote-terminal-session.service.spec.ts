import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteTerminalSessionService } from '../terminal-session.service';
import { ElectronIpcService } from '../ipc/electron-ipc.service';
import type { TerminalLifecycleEvent } from '../../../../../shared/types/terminal.types';

type Cb = (payload: unknown) => void;

function makeApi() {
  const subs: Record<string, Cb | undefined> = {};
  return {
    terminalSpawn: vi.fn(async () => ({ success: true, data: { sessionId: 's1', pid: 42 } })),
    terminalWrite: vi.fn(async () => ({ success: true })),
    terminalResize: vi.fn(async () => ({ success: true })),
    terminalKill: vi.fn(async () => ({ success: true })),
    onTerminalSpawned: vi.fn((cb: Cb) => { subs.spawned = cb; return () => { subs.spawned = undefined; }; }),
    onTerminalOutput: vi.fn((cb: Cb) => { subs.output = cb; return () => { subs.output = undefined; }; }),
    onTerminalExit: vi.fn((cb: Cb) => { subs.exit = cb; return () => { subs.exit = undefined; }; }),
    _subs: subs,
  };
}

function setup(api: ReturnType<typeof makeApi> | null) {
  TestBed.configureTestingModule({
    providers: [{ provide: ElectronIpcService, useValue: { getApi: () => api } }],
  });
  return TestBed.inject(RemoteTerminalSessionService);
}

describe('RemoteTerminalSessionService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('rejects spawning without a nodeId (remote-only)', async () => {
    const svc = setup(makeApi());
    await expect(svc.spawn({ cwd: '/tmp' })).rejects.toThrow(/worker node/i);
  });

  it('forwards spawn options to the bridge and returns the session', async () => {
    const api = makeApi();
    const svc = setup(api);
    const result = await svc.spawn({ nodeId: 'windows-pc', cwd: '/work' });
    expect(api.terminalSpawn).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: 'windows-pc', cwd: '/work' }),
    );
    expect(result).toEqual({ sessionId: 's1', pid: 42 });
  });

  it('throws with the bridge error message when spawn fails', async () => {
    const api = makeApi();
    api.terminalSpawn.mockResolvedValueOnce({
      success: false,
      error: { code: 'X', message: 'node disconnected', timestamp: 0 },
    } as never);
    const svc = setup(api);
    await expect(svc.spawn({ nodeId: 'windows-pc', cwd: '/work' })).rejects.toThrow('node disconnected');
  });

  it('maps bridge events to lifecycle events', () => {
    const api = makeApi();
    const svc = setup(api);
    const events: TerminalLifecycleEvent[] = [];
    svc.subscribe((e) => events.push(e));

    api._subs.spawned?.({ sessionId: 's1', pid: 42, nodeId: 'windows-pc' });
    api._subs.output?.({ sessionId: 's1', data: 'hi' });
    api._subs.exit?.({ sessionId: 's1', exitCode: 0, signal: null });

    expect(events).toEqual([
      { kind: 'spawned', sessionId: 's1', pid: 42 },
      { kind: 'data', sessionId: 's1', data: 'hi' },
      { kind: 'exited', sessionId: 's1', code: 0, signal: null },
    ]);
  });

  it('delegates write/resize/kill to the bridge', async () => {
    const api = makeApi();
    const svc = setup(api);
    await svc.write('s1', 'ls\n');
    await svc.resize('s1', 80, 24);
    await svc.kill('s1');
    expect(api.terminalWrite).toHaveBeenCalledWith('s1', 'ls\n');
    expect(api.terminalResize).toHaveBeenCalledWith('s1', 80, 24);
    expect(api.terminalKill).toHaveBeenCalledWith('s1', undefined);
  });
});
