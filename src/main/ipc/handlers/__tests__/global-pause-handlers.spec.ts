import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { registerGlobalPauseHandlers } from '../global-pause-handlers';

const { handle } = vi.hoisted(() => ({ handle: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: { handle }, app: { quit: vi.fn() } }));
vi.mock('../../../global-pause/global-pause-service', () => ({ getGlobalPauseService: vi.fn() }));

describe('global pause IPC', () => {
  const state = { phase: 'none' };
  const service = Object.assign(new EventEmitter(), {
    getState: () => state, hold: vi.fn(), release: vi.fn(), pauseForRestart: vi.fn(),
    skipNotes: vi.fn(), resume: vi.fn(), discard: vi.fn(),
  });
  const sendToRenderer = vi.fn();
  const trust = vi.fn();
  beforeEach(() => { vi.clearAllMocks(); service.removeAllListeners(); trust.mockReturnValue(null); });
  const install = () => registerGlobalPauseHandlers({
    service: service as never, windowManager: { sendToRenderer } as never, ensureTrustedSender: trust,
  });
  const invoke = (channel: string, payload?: unknown) => {
    const fn = handle.mock.calls.find(args => args[0] === channel)?.[1];
    if (!fn) throw new Error(`No handler for ${channel}`);
    return fn({} as IpcMainInvokeEvent, payload);
  };
  it('refuses mutations from an untrusted window', async () => {
    install();
    trust.mockReturnValue({ success: false, error: { message: 'Untrusted' } });
    expect((await invoke('global-pause:hold', {})).success).toBe(false);
    expect(service.hold).not.toHaveBeenCalled();
  });
  it('validates note collection choice before interrupting sessions', async () => {
    install();
    expect((await invoke('global-pause:restart', { withNotes: 'yes' })).success).toBe(false);
    expect(service.pauseForRestart).not.toHaveBeenCalled();
    expect((await invoke('global-pause:restart', { withNotes: false })).success).toBe(true);
    expect(service.pauseForRestart).toHaveBeenCalledWith({ withNotes: false });
  });
  it('pushes updated state to the renderer', () => {
    install();
    service.emit('state-changed', state);
    expect(sendToRenderer).toHaveBeenCalledWith('global-pause:state-changed', state);
  });
});
