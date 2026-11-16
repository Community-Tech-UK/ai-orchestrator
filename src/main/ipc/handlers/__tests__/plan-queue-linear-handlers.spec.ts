import type { IpcRenderer } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, type IpcResponse } from '../../../../shared/types/ipc.types';
import { createPlanQueueDomain } from '../../../../preload/domains/plan-queue.preload';
import { LinearCallError } from '../../../plan-queue/linear/linear-errors';

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => Promise<IpcResponse>>(),
  saved: { current: null as unknown },
  service: {
    list: vi.fn(),
    identify: vi.fn(),
    confirm: vi.fn(),
    forget: vi.fn(),
    check: vi.fn(),
    noteCallFailure: vi.fn(),
  },
  links: { readAll: vi.fn(), save: vi.fn() },
  projects: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, callback: (event: unknown, payload: unknown) => Promise<IpcResponse>) =>
      state.handlers.set(channel, callback),
  },
}));
vi.mock('../../../plan-queue/linear/linear-connection-singleton', () => ({ getLinearConnectionService: () => state.service }));
vi.mock('../../../plan-queue/linear/linear-folder-links-singleton', () => ({ getLinearFolderLinkService: () => state.links }));
vi.mock('../../../plan-queue/linear/linear-project-list', () => ({ listLinearProjectChoices: state.projects }));
vi.mock('../../../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ get: () => state.saved.current }),
}));
import { registerPlanQueueLinearHandlers } from '../plan-queue-linear-handlers';

const sendToRenderer = vi.fn();
function api() {
  registerPlanQueueLinearHandlers({ windowManager: { sendToRenderer } });
  return createPlanQueueDomain(
    {
      invoke: (channel: string, payload: unknown) => {
        const callback = state.handlers.get(channel);
        if (!callback) throw new Error(`No handler registered for ${channel}`);
        return callback({}, payload);
      },
    } as unknown as IpcRenderer,
    IPC_CHANNELS,
  );
}

afterEach(() => {
  state.handlers.clear();
  state.saved.current = null;
  sendToRenderer.mockReset();
  Object.values(state.service).forEach((fn) => fn.mockReset());
  Object.values(state.links).forEach((fn) => fn.mockReset());
  state.projects.mockReset();
});

describe('Plan Queue Linear channels, from the preload to the connection service', () => {
  it('registers every channel the page uses', () => {
    api();
    for (const channel of [
      IPC_CHANNELS.PLAN_QUEUE_LINEAR_LIST,
      IPC_CHANNELS.PLAN_QUEUE_LINEAR_IDENTIFY,
      IPC_CHANNELS.PLAN_QUEUE_LINEAR_CONFIRM,
      IPC_CHANNELS.PLAN_QUEUE_LINEAR_FORGET,
      IPC_CHANNELS.PLAN_QUEUE_LINEAR_CHECK,
      IPC_CHANNELS.PLAN_QUEUE_LINEAR_PROJECTS,
      IPC_CHANNELS.PLAN_QUEUE_LINEAR_LINKS,
      IPC_CHANNELS.PLAN_QUEUE_LINEAR_LINKS_SAVE,
    ])
      expect(state.handlers.has(channel)).toBe(true);
  });

  it('lists connectors, identifies one and checks the connection', async () => {
    const domain = api();
    state.service.list.mockReturnValue({ connectors: [], connection: { state: 'not-set-up' } });
    state.service.identify.mockResolvedValue({ userId: 'u' });
    state.service.check.mockResolvedValue({ state: 'ready' });
    await expect(domain.planQueueLinearList()).resolves.toEqual({ success: true, data: { connectors: [], connection: { state: 'not-set-up' } } });
    await expect(domain.planQueueLinearIdentify({ connectorId: 'c1' })).resolves.toEqual({ success: true, data: { userId: 'u' } });
    expect(state.service.identify).toHaveBeenCalledWith('c1');
    await expect(domain.planQueueLinearCheck()).resolves.toEqual({ success: true, data: { state: 'ready' } });
    expect(sendToRenderer).not.toHaveBeenCalled();
  });

  it('confirms with the connector and the user id shown, then announces the saved setting', async () => {
    const domain = api();
    state.saved.current = { connectorId: 'c1' };
    state.service.confirm.mockResolvedValue({ state: 'ready' });
    await expect(domain.planQueueLinearConfirm({ connectorId: 'c1', userId: 'u1' })).resolves.toEqual({ success: true, data: { state: 'ready' } });
    expect(state.service.confirm).toHaveBeenCalledWith('c1', 'u1');
    expect(sendToRenderer).toHaveBeenCalledWith(IPC_CHANNELS.SETTINGS_CHANGED, { key: 'planQueueLinearConnection', value: { connectorId: 'c1' } });
  });

  it('forgets the connection and announces that the setting is cleared', async () => {
    const domain = api();
    state.service.forget.mockReturnValue({ state: 'not-set-up' });
    await expect(domain.planQueueLinearForget()).resolves.toEqual({ success: true, data: { state: 'not-set-up' } });
    expect(sendToRenderer).toHaveBeenCalledWith(IPC_CHANNELS.SETTINGS_CHANGED, { key: 'planQueueLinearConnection', value: null });
  });

  it('refuses a badly shaped request before the service is touched', async () => {
    const domain = api();
    const identify = await domain.planQueueLinearIdentify({ connectorId: 7 } as never);
    const confirm = await domain.planQueueLinearConfirm({ connectorId: 'c1' } as never);
    expect(identify).toMatchObject({ success: false, error: { code: 'PLAN_QUEUE_LINEAR_IDENTIFY_FAILED' } });
    expect(confirm).toMatchObject({ success: false, error: { code: 'PLAN_QUEUE_LINEAR_CONFIRM_FAILED' } });
    expect(state.service.identify).not.toHaveBeenCalled();
    expect(state.service.confirm).not.toHaveBeenCalled();
  });

  it('answers a failure with the fixed words, never what Linear said, and announces nothing', async () => {
    const domain = api();
    state.service.confirm.mockRejectedValue(
      new LinearCallError('needs-sign-in', 'The Linear connector needs to be signed in again.', { detail: 'LINEAR-SAYS-SECRET-WORDS' }),
    );
    const response = await domain.planQueueLinearConfirm({ connectorId: 'c1', userId: 'u1' });
    expect(response).toMatchObject({ success: false, error: { message: 'The Linear connector needs to be signed in again.' } });
    expect(JSON.stringify(response)).not.toContain('LINEAR-SAYS-SECRET-WORDS');
    expect(sendToRenderer).not.toHaveBeenCalled();
  });
});

describe('Plan Queue folder-link channels, from the preload to the link service', () => {
  it('returns Linear\'s teams and projects', async () => {
    const domain = api();
    state.projects.mockResolvedValue({ teams: [] });
    await expect(domain.planQueueLinearProjects()).resolves.toEqual({ success: true, data: { teams: [] } });
  });

  it('answers a failed read with the fixed words only, and asks for a fresh connection check', async () => {
    const domain = api();
    state.projects.mockRejectedValue(
      new LinearCallError('needs-sign-in', 'The Linear connector needs to be signed in again.', { detail: 'LINEAR-SAYS-SECRET-WORDS' }),
    );
    const response = await domain.planQueueLinearProjects();
    expect(response).toMatchObject({ success: false, error: { message: 'The Linear connector needs to be signed in again.' } });
    expect(JSON.stringify(response)).not.toContain('LINEAR-SAYS-SECRET-WORDS');
    expect(state.service.noteCallFailure).toHaveBeenCalledTimes(1);
  });

  it('does not start a connection check just because nothing is set up', async () => {
    const domain = api();
    state.projects.mockRejectedValue(new LinearCallError('not-set-up', 'No Linear connection has been set up.'));
    await domain.planQueueLinearProjects();
    expect(state.service.noteCallFailure).not.toHaveBeenCalled();
  });

  it('reads the saved links with their live state', async () => {
    const domain = api();
    state.links.readAll.mockResolvedValue([{ link: { folder: '/work/shop' }, broken: null }]);
    await expect(domain.planQueueLinearLinks()).resolves.toEqual({ success: true, data: { links: [{ link: { folder: '/work/shop' }, broken: null }] } });
  });

  it('passes every row to the one checked save, and announces the saved list only when it was saved', async () => {
    const domain = api();
    state.saved.current = [{ folder: '/work/shop' }];
    state.links.save.mockResolvedValueOnce({ saved: true, links: [{ folder: '/work/shop' }] });
    await expect(domain.planQueueLinearLinksSave({ links: [{ folder: '/work/shop' }] })).resolves.toEqual({
      success: true,
      data: { saved: true, links: [{ folder: '/work/shop' }] },
    });
    expect(state.links.save).toHaveBeenCalledWith([{ folder: '/work/shop' }]);
    expect(sendToRenderer).toHaveBeenCalledWith(IPC_CHANNELS.SETTINGS_CHANGED, { key: 'planQueueLinearFolderLinks', value: [{ folder: '/work/shop' }] });

    sendToRenderer.mockReset();
    state.links.save.mockResolvedValueOnce({ saved: false, refused: [{ index: 0, reason: 'No.' }] });
    await expect(domain.planQueueLinearLinksSave({ links: [{}] })).resolves.toEqual({
      success: true,
      data: { saved: false, refused: [{ index: 0, reason: 'No.' }] },
    });
    expect(sendToRenderer).not.toHaveBeenCalled();
  });

  it('refuses a request that is not a list before the save is touched', async () => {
    const domain = api();
    const response = await domain.planQueueLinearLinksSave({ links: 'nope' } as never);
    expect(response).toMatchObject({ success: false, error: { code: 'PLAN_QUEUE_LINEAR_LINKS_SAVE_FAILED' } });
    expect(state.links.save).not.toHaveBeenCalled();
  });
});
