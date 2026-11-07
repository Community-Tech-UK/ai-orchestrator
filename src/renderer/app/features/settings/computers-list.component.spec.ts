import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ɵresolveComponentResources as resolveComponentResources, signal } from '@angular/core';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ComputersListComponent } from './computers-list.component';
import { SettingsStore } from '../../core/state/settings.store';
import { RemoteNodeIpcService } from '../../core/services/ipc/remote-node-ipc.service';
import type { RemoteNodeRosterEntry } from '../../../../shared/types/worker-node.types';
import type { TestMachineView, WorkToday } from '../../../../shared/types/computers.types';
import type { ComputerChoice } from '../../../../shared/types/settings.types';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(resolve(specDirectory, './computers-list.component.html'), 'utf8');
await resolveComponentResources((url) => {
  if (url.endsWith('computers-list.component.html')) return Promise.resolve(template);
  if (url.endsWith('.scss')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

const node = (id: string, change: Partial<RemoteNodeRosterEntry> = {}): RemoteNodeRosterEntry => ({
  id, name: id, status: 'connected', address: '', connected: true, supportedClis: [], hasBrowserRuntime: false,
  hasBrowserMcp: false, hasAndroidMcp: false, hasDocker: false, activeInstances: 0, maxConcurrentInstances: 10,
  workingDirectories: [],
  capabilities: {
    platform: 'win32', arch: 'x64', cpuCores: 16, totalMemoryMB: 1, availableMemoryMB: 1, supportedClis: [],
    hasBrowserRuntime: false, hasBrowserMcp: false, hasAndroidMcp: false, hasDocker: false, maxConcurrentInstances: 10,
    workingDirectories: [], browsableRoots: [], discoveredProjects: [],
  },
  ...change,
});
const MACHINE: TestMachineView = {
  host: 'harness-checks', label: 'the Windows PC', nodeName: 'windows-pc', paused: false, testRuns: true, checks: true, slots: 3,
};
const TODAY: WorkToday = {
  testRuns: { there: 59, here: 8 }, checks: { there: 4, here: 0 }, shortRunsHere: 0,
  hereBecause: [{ reason: 'the Windows PC could not be reached', count: 8 }],
};

describe('ComputersListComponent', () => {
  const choices = signal<ComputerChoice[]>([]);
  const storeError = signal<string | null>(null);
  const store = {
    computers: choices.asReadonly(),
    error: storeError.asReadonly(),
    clearError: () => storeError.set(null),
    remoteNodesAutoOffloadBrowser: () => true,
    remoteNodesAutoOffloadAndroid: () => true,
    set: vi.fn(async (_key: string, value: ComputerChoice[]) => { choices.set(value); }),
  };
  const ipc = {
    getTestMachine: vi.fn(async (): Promise<
      { ok: true; testMachine: TestMachineView | null; today: WorkToday | null } | { ok: false; error: unknown }
    > => ({ ok: true, testMachine: MACHINE, today: TODAY })),
    changeTestMachine: vi.fn(async (change: Partial<TestMachineView>): Promise<
      { ok: true; testMachine: TestMachineView } | { ok: false; error: unknown }
    > => ({ ok: true, testMachine: { ...MACHINE, ...change } })),
  };
  let fixture: ComponentFixture<ComputersListComponent>;

  async function render(nodes: RemoteNodeRosterEntry[], readOnly = false): Promise<HTMLElement> {
    fixture = TestBed.createComponent(ComputersListComponent);
    fixture.componentRef.setInput('nodes', nodes);
    fixture.componentRef.setInput('readOnly', readOnly);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  const names = (element: HTMLElement) => [...element.querySelectorAll('.computer-name')].map(name => name.textContent?.trim());
  /** As a click does: the box changes first, then the change event fires. */
  const toggle = (element: HTMLElement, id: string): HTMLInputElement => {
    const input = element.querySelector(`#${id}`) as HTMLInputElement;
    input.checked = !input.checked;
    input.dispatchEvent(new Event('change'));
    return input;
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    choices.set([]);
    storeError.set(null);
    store.set.mockImplementation(async (_key: string, value: ComputerChoice[]) => { choices.set(value); });
    ipc.changeTestMachine.mockImplementation(async (change: Partial<TestMachineView>) => ({ ok: true, testMachine: { ...MACHINE, ...change } }));
    ipc.getTestMachine.mockResolvedValue({ ok: true, testMachine: MACHINE, today: TODAY });
    await TestBed.configureTestingModule({
      imports: [ComputersListComponent],
      providers: [
        { provide: SettingsStore, useValue: store },
        { provide: RemoteNodeIpcService, useValue: ipc },
      ],
    }).compileComponents();
  });

  it('lists the computers in order with this Mac last, the test machine with its computer, and today\'s work', async () => {
    const element = await render([node('windows-pc', { hasBrowserMcp: true }), node('laptop', { connected: false })]);
    expect(names(element)).toEqual(['windows-pc', 'laptop', 'This Mac']);
    expect(element.querySelector('#test-runs-windows-pc')).not.toBeNull();
    expect(element.querySelector('#test-runs-laptop')).toBeNull();
    expect(element.textContent).toContain('Also takes browser work');
    expect(element.textContent).toContain('Away');
    expect(element.textContent).toContain('Test runs: 59 on the Windows PC, 8 here.');
    expect(element.textContent).toContain('8 ran here because the Windows PC could not be reached.');
  });

  it('saves the whole order when a computer moves, and each change to a computer\'s switches', async () => {
    const element = await render([node('windows-pc'), node('laptop')]);
    (element.querySelectorAll('.move-buttons button')[2] as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(store.set).toHaveBeenLastCalledWith('computers', [
      { id: 'laptop', paused: false, sessions: true },
      { id: 'windows-pc', paused: false, sessions: true },
    ]);
    fixture.detectChanges();
    toggle(element, 'sessions-laptop');
    await fixture.whenStable();
    expect(store.set).toHaveBeenLastCalledWith('computers', [
      { id: 'laptop', paused: false, sessions: false },
      { id: 'windows-pc', paused: false, sessions: true },
    ]);
  });

  it('does nothing when the first computer is moved up', async () => {
    const element = await render([node('windows-pc'), node('laptop')]);
    (element.querySelectorAll('.move-buttons button')[0] as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(store.set).not.toHaveBeenCalled();
  });

  it('pauses a computer and its test machine together, and changes the test machine\'s own switches', async () => {
    const element = await render([node('windows-pc')]);
    toggle(element, 'paused-windows-pc');
    await fixture.whenStable();
    expect(store.set).toHaveBeenCalledWith('computers', [{ id: 'windows-pc', paused: true, sessions: true }]);
    expect(ipc.changeTestMachine).toHaveBeenCalledWith({ paused: true });
    fixture.detectChanges();
    toggle(element, 'checks-windows-pc');
    await fixture.whenStable();
    expect(ipc.changeTestMachine).toHaveBeenLastCalledWith({ checks: false });
    const slots = element.querySelector('#slots-windows-pc') as HTMLSelectElement;
    slots.value = '5';
    slots.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(ipc.changeTestMachine).toHaveBeenLastCalledWith({ slots: 5 });
  });

  it('says when a change wasn\'t saved', async () => {
    ipc.changeTestMachine.mockResolvedValueOnce({ ok: false, error: { code: 'COMPUTERS_CHANGE_TEST_MACHINE_FAILED', message: 'No test machine is set up on this Mac.' } });
    const element = await render([node('windows-pc')]);
    toggle(element, 'checks-windows-pc');
    await fixture.whenStable();
    fixture.detectChanges();
    expect(element.querySelector('[role="alert"]')?.textContent).toBe('That change wasn\'t saved.');
    expect(element.querySelector('details')?.textContent).toContain('No test machine is set up on this Mac.');
  });

  it('only shows in read-only mode, saying what each computer takes', async () => {
    const element = await render([node('windows-pc')], true);
    expect(element.querySelectorAll('input, select, button')).toHaveLength(0);
    expect(element.textContent).toContain('Takes agent sessions, test runs and checks, 3 test runs or checks at once.');
  });

  it('says when a computer\'s change wasn\'t kept, puts its switch back, and leaves the test machine alone', async () => {
    // The store keeps its own failures: it records the message and reloads what was saved.
    store.set.mockImplementation(async () => { storeError.set('Disk full'); });
    const element = await render([node('windows-pc')]);
    const pause = toggle(element, 'paused-windows-pc');
    await fixture.whenStable();
    fixture.detectChanges();
    expect(element.querySelector('[role="alert"]')?.textContent).toBe('That change wasn\'t saved.');
    expect(element.querySelector('details')?.textContent).toContain('Disk full');
    expect(pause.checked).toBe(false);
    expect(ipc.changeTestMachine).not.toHaveBeenCalled();
  });

  it('shows a half-done pause as it really is: the computer paused, the test machine not', async () => {
    ipc.changeTestMachine.mockResolvedValueOnce({ ok: false, error: { message: 'Permission denied' } });
    const element = await render([node('windows-pc')]);
    const pause = toggle(element, 'paused-windows-pc');
    await fixture.whenStable();
    fixture.detectChanges();
    expect(choices()).toEqual([{ id: 'windows-pc', paused: true, sessions: true }]);
    expect(element.querySelector('[role="alert"]')?.textContent).toBe('That change wasn\'t saved.');
    expect(pause.checked).toBe(true);
  });

  it('reports a failed save even when the store still shows the unsaved value, and puts the switch back', async () => {
    // A failed save whose reload failed too: the store keeps the optimistic value and records the error.
    store.set.mockImplementation(async (_key: string, value: ComputerChoice[]) => { choices.set(value); storeError.set('Main process unreachable'); });
    const element = await render([node('windows-pc')]);
    const sessions = toggle(element, 'sessions-windows-pc');
    await fixture.whenStable();
    fixture.detectChanges();
    expect(element.querySelector('[role="alert"]')?.textContent).toBe('That change wasn\'t saved.');
    expect(element.querySelector('details')?.textContent).toContain('Main process unreachable');
    expect(sessions.checked).toBe(false);
  });

  it('puts a test machine switch and the slot count back when their change fails', async () => {
    ipc.changeTestMachine.mockResolvedValue({ ok: false, error: { message: 'Permission denied' } });
    const element = await render([node('windows-pc')]);
    const checks = toggle(element, 'checks-windows-pc');
    await fixture.whenStable();
    expect(checks.checked).toBe(true);
    const slots = element.querySelector('#slots-windows-pc') as HTMLSelectElement;
    slots.value = '6';
    slots.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(slots.value).toBe('3');
  });

  it('takes one change at a time, and puts back a switch flipped while another change is saving', async () => {
    let finishSave!: () => void;
    store.set.mockImplementationOnce(async (_key: string, value: ComputerChoice[]) => {
      await new Promise<void>(resolve => { finishSave = resolve; });
      choices.set(value);
    });
    const element = await render([node('windows-pc'), node('laptop')]);
    toggle(element, 'sessions-windows-pc');
    const second = toggle(element, 'sessions-laptop');
    expect(second.checked).toBe(true);
    finishSave();
    await fixture.whenStable();
    expect(store.set).toHaveBeenCalledTimes(1);
  });

  it('does not let a refresh that began before a change put the old values back', async () => {
    const element = await render([node('windows-pc')]);
    let finishRefresh!: (value: { ok: true; testMachine: TestMachineView; today: WorkToday }) => void;
    ipc.getTestMachine.mockImplementationOnce(() => new Promise(resolve => { finishRefresh = resolve; }));
    void (fixture.componentInstance as unknown as { load: () => Promise<void> }).load();
    toggle(element, 'checks-windows-pc');
    await fixture.whenStable();
    finishRefresh({ ok: true, testMachine: MACHINE, today: TODAY });
    await fixture.whenStable();
    fixture.detectChanges();
    expect((element.querySelector('#checks-windows-pc') as HTMLInputElement).checked).toBe(false);
  });

  it('says when the test machine\'s settings can\'t be read, and still lists the rest', async () => {
    ipc.getTestMachine.mockResolvedValueOnce({ ok: false, error: { message: 'The test machine settings file names no host.' } });
    const element = await render([node('windows-pc')]);
    expect(element.querySelector('[role="alert"]')?.textContent).toContain('couldn\'t be read');
    expect(element.querySelector('details')?.textContent).toContain('names no host');
    expect(names(element)).toEqual(['windows-pc', 'This Mac']);
  });
});
