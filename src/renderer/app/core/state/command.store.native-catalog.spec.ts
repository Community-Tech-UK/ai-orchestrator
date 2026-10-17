import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IpcRenderer } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import { createInstanceDomain } from '../../../../preload/domains/instance.preload';
import { createOrchestrationDomain } from '../../../../preload/domains/orchestration.preload';
import type { CommandTemplate } from '../../../../shared/types/command.types';
import { InstanceEventsService } from '../services/instance-events.service';
import type { IpcResponse } from '../services/ipc/electron-ipc.service';
import { CommandStore } from './command.store';
import { SkillStore } from './skill.store';
import { InstanceStore } from './instance.store';

const originalApi = window.electronAPI;
afterEach(() => { TestBed.resetTestingModule(); window.electronAPI = originalApi; });
const builtin: CommandTemplate = { id: 'builtin:help', name: 'help', description: 'Help', template: '', builtIn: true, createdAt: 0, updatedAt: 0 };
function native(name: string, description = name): CommandTemplate {
  return { ...builtin, id: `acp:opencode:${name}`, name, description, builtIn: false };
}
function response(commands: CommandTemplate[]): IpcResponse {
  return { success: true, data: { commands: [builtin, ...commands], diagnostics: [], scanDirs: [] } };
}
function deferred() {
  let resolve!: (value: IpcResponse) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<IpcResponse>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function settle() { TestBed.tick(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }
function setup() {
  const listeners = new Map<string, Set<(event: unknown, payload: unknown) => void>>();
  const invoke = vi.fn().mockResolvedValue(response([native('compact')]));
  const renderer = { invoke,
    on: (channel: string, handler: (event: unknown, payload: unknown) => void) => {
      const handlers = listeners.get(channel) ?? new Set(); handlers.add(handler); listeners.set(channel, handlers);
    },
    removeListener: (channel: string, handler: (event: unknown, payload: unknown) => void) => listeners.get(channel)?.delete(handler),
  } as unknown as IpcRenderer;
  window.electronAPI = { ...createInstanceDomain(renderer, IPC_CHANNELS), ...createOrchestrationDomain(renderer, IPC_CHANNELS) } as unknown as typeof window.electronAPI;
  const selected = signal({ id: 'one', provider: 'opencode', status: 'idle', workingDirectory: '/workspace', restartEpoch: 0, adapterGeneration: 1, providerSessionId: 'session-one' });
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection(), CommandStore,
    { provide: InstanceEventsService, useValue: { outputEvents$: new Subject() } },
    { provide: SkillStore, useValue: { skillCommands: () => [], discoverSkills: async () => undefined } },
    { provide: InstanceStore, useValue: { selectedInstance: selected } },
  ] });
  const store = TestBed.inject(CommandStore);
  const emit = (payload: unknown) => { for (const listener of listeners.get(IPC_CHANNELS.INSTANCE_STATE_UPDATE) ?? []) listener({}, payload); };
  return { store, selected, invoke, listeners, emit, names: () => store.rawCommands().filter(command => command.id.startsWith('acp:')).map(command => command.name) };
}

describe('selected native command catalog invalidation through preload and event bus', () => {
  it.each(['failed response', 'rejection'])('retries an invalidated catalog after a %s through ordinary loading', async (failure) => {
    const fixture = setup(); await settle();
    expect(fixture.names()).toEqual(['compact']);
    if (failure === 'rejection') fixture.invoke.mockRejectedValueOnce(new Error('Catalog temporarily unavailable'));
    else fixture.invoke.mockResolvedValueOnce({ success: false, error: { message: 'Catalog temporarily unavailable' } });
    fixture.emit({ instanceId: 'one', status: 'idle', commandsChanged: true });
    await settle();
    expect(fixture.names()).toEqual([]);
    expect(fixture.store.error()).toBe('Catalog temporarily unavailable');
    expect(fixture.store.loading()).toBe(false);
    for (let index = 0; index < 3; index++) {
      fixture.selected.set({ ...fixture.selected() });
      await settle();
    }
    expect(fixture.invoke).toHaveBeenCalledTimes(2);
    fixture.invoke.mockResolvedValue(response([native('new-action')]));
    await fixture.store.loadCommands();
    expect(fixture.invoke).toHaveBeenCalledTimes(3);
    expect(fixture.names()).toEqual(['new-action']);
    expect(fixture.store.error()).toBeNull();
  });
  it('refreshes additions, descriptions and empty withdrawals without a status change', async () => {
    const fixture = setup(); await settle();
    expect(fixture.names()).toEqual(['compact']);
    fixture.invoke.mockResolvedValue(response([native('new-action', 'First description')]));
    fixture.emit({ instanceId: 'one', status: 'idle', commandsChanged: true });
    await settle();
    expect(fixture.names()).toEqual(['new-action']);
    fixture.invoke.mockResolvedValue(response([native('new-action', 'Changed description')]));
    fixture.emit({ instanceId: 'one', status: 'idle', commandsChanged: true });
    await settle();
    expect(fixture.store.getCommandByName('new-action')?.description).toBe('Changed description');
    fixture.invoke.mockResolvedValue(response([]));
    fixture.emit({ instanceId: 'one', status: 'idle', commandsChanged: true });
    await settle();
    expect(fixture.names()).toEqual([]);
    expect(fixture.store.rawCommands()).toEqual([builtin]);
    expect(fixture.invoke).toHaveBeenCalledTimes(4);
  });
  it('ignores ordinary updates, other sessions and non-OpenCode sessions', async () => {
    const fixture = setup(); await settle();
    for (let index = 0; index < 20; index++) {
      fixture.emit({ instanceId: 'one', status: 'idle' });
      fixture.emit({ instanceId: 'other', status: 'idle', commandsChanged: true });
      fixture.selected.set({ ...fixture.selected() });
      await settle();
    }
    expect(fixture.invoke).toHaveBeenCalledTimes(1);
    fixture.selected.set({ ...fixture.selected(), provider: 'claude' }); await settle();
    const count = fixture.invoke.mock.calls.length;
    fixture.emit({ instanceId: 'one', status: 'idle', commandsChanged: true }); await settle();
    expect(fixture.invoke).toHaveBeenCalledTimes(count);
  });
  it('hides the old session immediately and ignores its late success while the new session is loading', async () => {
    const fixture = setup(); await settle();
    const old = deferred(); const next = deferred();
    fixture.invoke.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    fixture.emit({ instanceId: 'one', status: 'idle', commandsChanged: true });
    fixture.selected.set({ ...fixture.selected(), id: 'two', providerSessionId: 'session-two' });
    expect(fixture.names()).toEqual([]);
    await settle();
    old.resolve(response([native('old-only')])); await settle();
    expect(fixture.names()).toEqual([]);
    expect(fixture.store.loading()).toBe(true);
    next.resolve(response([native('new-only')])); await settle();
    expect(fixture.names()).toEqual(['new-only']);
    expect(fixture.store.error()).toBeNull();
    expect(fixture.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.COMMAND_LIST, { workingDirectory: '/workspace', instanceId: 'two' });
  });
  it('fences stale rejection and finally against a newer pending request', async () => {
    const fixture = setup(); await settle();
    const old = deferred(); const next = deferred();
    fixture.invoke.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const oldLoad = fixture.store.loadCommands(undefined, true);
    const nextLoad = fixture.store.loadCommands(undefined, true);
    old.reject(new Error('Stale failure')); await oldLoad;
    expect(fixture.store.error()).toBeNull();
    expect(fixture.store.loading()).toBe(true);
    next.resolve(response([native('current')])); await nextLoad;
    expect(fixture.names()).toEqual(['current']);
    expect(fixture.store.loading()).toBe(false);
  });
  it.each(['adapterGeneration', 'restartEpoch', 'providerSessionId'] as const)('invalidates a changed %s with the same instance and status', async (field) => {
    const fixture = setup(); await settle();
    const pending = deferred(); fixture.invoke.mockReturnValueOnce(pending.promise);
    fixture.selected.set({ ...fixture.selected(), [field]: field === 'providerSessionId' ? 'replacement-session' : fixture.selected()[field] as number + 1 });
    expect(fixture.names()).toEqual([]); await settle();
    expect(fixture.invoke).toHaveBeenCalledTimes(2);
    pending.resolve(response([])); await settle(); expect(fixture.names()).toEqual([]);
  });
  it('hides recovering native commands and reloads when the replacement becomes ready', async () => {
    const fixture = setup(); await settle();
    fixture.selected.set({ ...fixture.selected(), status: 'initializing' });
    expect(fixture.names()).toEqual([]); await settle();
    expect(fixture.names()).toEqual([]);
    fixture.invoke.mockResolvedValue(response([native('replacement')]));
    fixture.selected.set({ ...fixture.selected(), status: 'idle', adapterGeneration: 2 }); await settle();
    expect(fixture.names()).toEqual(['replacement']);
  });
  it('unsubscribes and refuses pending results after destruction', async () => {
    const fixture = setup(); await settle();
    const pending = deferred(); fixture.invoke.mockReturnValueOnce(pending.promise);
    const work = fixture.store.loadCommands(undefined, true);
    TestBed.resetTestingModule();
    expect(fixture.listeners.get(IPC_CHANNELS.INSTANCE_STATE_UPDATE)?.size ?? 0).toBe(0);
    pending.resolve(response([native('after-destroy')])); await work;
    expect(fixture.names()).toEqual(['compact']);
  });
});
