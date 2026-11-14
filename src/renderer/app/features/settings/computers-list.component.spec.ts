import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ɵresolveComponentResources as resolveComponentResources, signal } from '@angular/core';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ComputersListComponent } from './computers-list.component';
import { SettingsStore } from '../../core/state/settings.store';
import { RemoteNodeIpcService } from '../../core/services/ipc/remote-node-ipc.service';
import { ProviderAccountIpcService } from '../../core/services/ipc/provider-account-ipc.service';
import type { RemoteNodeRosterEntry } from '../../../../shared/types/worker-node.types';
import type { TestMachineView, WorkToday } from '../../../../shared/types/computers.types';
import type { ComputerChoice } from '../../../../shared/types/settings.types';
import type { QueueJobComputer, QueueJobProjectCheck } from '../../../../shared/types/plan-queue-computers.types';
import type { QueueJobProject, QueueJobsChange, QueueJobsPageView } from '../../../../shared/types/plan-queue-computers-page.types';

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
  host: 'harness-checks', platform: 'linux', label: 'the Windows PC', nodeName: 'windows-pc', paused: false, testRuns: true,
  checks: true, slots: 3,
};
const TEST_MAC: TestMachineView = { ...MACHINE, host: 'ct-test-mac', platform: 'darwin', label: 'the test Mac', nodeName: null };
const ALL_MACHINES = [MACHINE, TEST_MAC];
const TODAY: WorkToday = {
  testRuns: { there: 59, here: 8 }, checks: { there: 4, here: 0 }, iphone: { there: 0, here: 0 }, shortRunsHere: 0,
  hereBecause: [{ reason: 'the Windows PC could not be reached', count: 8 }],
};

const REPO: QueueJobProject = { key: 'repo-aaaaaaaa', name: 'repo', repoRoot: '/work/repo' };
const OTHER: QueueJobProject = { key: 'other-bbbbbbbb', name: 'other', repoRoot: '/work/other' };
const PASSED: QueueJobProjectCheck = { ok: true, checkedAt: Date.now(), problem: null, summary: 'Checks took 43 s.' };
const queueComputer = (nodeId: string, change: Partial<QueueJobComputer> = {}): QueueJobComputer => ({
  nodeId, label: nodeId, takesJobs: false, paused: false, jobsAtOnce: 2, projects: {}, ...change,
});
/** Both paired computers' Plan Queue settings, the way the main process lists them. */
const queueView = (change: Partial<Record<string, Partial<QueueJobComputer>>> = {}): QueueJobsPageView => ({
  computers: ['windows-pc', 'laptop'].map(id => queueComputer(id, change[id])),
  projects: [REPO, OTHER],
});

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
    getTestMachines: vi.fn(async (): Promise<
      { ok: true; testMachines: TestMachineView[]; useThisMac: boolean; today: WorkToday | null } | { ok: false; error: unknown }
    > => ({ ok: true, testMachines: [MACHINE], useThisMac: true, today: TODAY })),
    setUseThisMac: vi.fn(async (useThisMac: boolean): Promise<
      { ok: true; useThisMac: boolean } | { ok: false; error: unknown }
    > => ({ ok: true, useThisMac })),
    changeTestMachine: vi.fn(async (host: string, change: Partial<TestMachineView>): Promise<
      { ok: true; testMachine: TestMachineView } | { ok: false; error: unknown }
    > => ({ ok: true, testMachine: { ...ALL_MACHINES.find(machine => machine.host === host)!, ...change } })),
  };
  type QueueOutcome = { ok: true; computers: QueueJobComputer[] } | { ok: false; error: unknown };
  const queueIpc = {
    getQueueJobs: vi.fn(async (): Promise<{ ok: true; view: QueueJobsPageView } | { ok: false; error: unknown }> => ({ ok: true, view: queueView() })),
    changeQueueJobs: vi.fn(async (_nodeId: string, _change: QueueJobsChange): Promise<QueueOutcome> => ({ ok: true, computers: [] })),
    checkQueueProject: vi.fn(async (_nodeId: string, _repoRoot: string): Promise<QueueOutcome> => ({ ok: true, computers: [] })),
  };
  const accounts = {
    list: vi.fn(async (_provider?: string) => ({ profiles: [{ id: 'work', provider: 'claude', label: 'Comtech' }], pools: {} })),
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
    const input = element.querySelector(`[id="${id}"]`) as HTMLInputElement;
    input.checked = !input.checked;
    input.dispatchEvent(new Event('change'));
    return input;
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    choices.set([]);
    storeError.set(null);
    store.set.mockImplementation(async (_key: string, value: ComputerChoice[]) => { choices.set(value); });
    ipc.changeTestMachine.mockImplementation(async (host: string, change: Partial<TestMachineView>) => ({
      ok: true, testMachine: { ...ALL_MACHINES.find(machine => machine.host === host)!, ...change },
    }));
    ipc.getTestMachines.mockResolvedValue({ ok: true, testMachines: [MACHINE], useThisMac: true, today: TODAY });
    queueIpc.getQueueJobs.mockResolvedValue({ ok: true, view: queueView() });
    queueIpc.changeQueueJobs.mockResolvedValue({ ok: true, computers: queueView().computers });
    queueIpc.checkQueueProject.mockResolvedValue({ ok: true, computers: queueView().computers });
    await TestBed.configureTestingModule({
      imports: [ComputersListComponent],
      providers: [
        { provide: SettingsStore, useValue: store },
        { provide: RemoteNodeIpcService, useValue: { ...ipc, ...queueIpc } },
        { provide: ProviderAccountIpcService, useValue: accounts },
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

  it('offers the setup steps on a paired computer with no test machine, in Settings only', async () => {
    const element = await render([node('windows-pc'), node('laptop')]);
    const offers = [...element.querySelectorAll('details.setup')];
    expect(offers).toHaveLength(1);
    expect(offers[0]!.closest('li')?.querySelector('.computer-name')?.textContent?.trim()).toBe('laptop');
    expect(offers[0]!.querySelector('summary')?.textContent?.trim()).toBe('Set up for tests and checks');
    expect(offers[0]!.textContent).toContain('setup-linux.sh');
    expect((await render([node('laptop')], true)).querySelector('details.setup')).toBeNull();
  });

  it('shows each connected computer\'s AI tools, sign-ins by this Mac\'s names, and folders, in both views', async () => {
    const pc = node('windows-pc', { capabilities: { ...node('x').capabilities, supportedClis: ['claude', 'codex'],
      workingDirectories: ['C:\\Users\\shutu\\Documents\\Work'],
      signIns: [
        { provider: 'claude', profileId: 'work', state: 'signed-in' },
        { provider: 'codex', profileId: 'legacy', state: 'signed-out' },
      ] } });
    for (const readOnly of [false, true]) {
      const element = await render([pc, node('laptop', { connected: false })], readOnly);
      const details = [...element.querySelectorAll('.computer-detail')];
      expect(details).toHaveLength(1);
      const text = details[0]!.textContent!.replace(/\s+/g, ' ');
      expect(text).toContain('AI tools there: Claude and Codex.');
      expect(text).toContain('Claude account Comtech is signed in.');
      expect(details[0]!.querySelector('p code')?.textContent).toBe('codex login');
      expect(text).toContain('Opens folders in C:\\Users\\shutu\\Documents\\Work, with 0 projects found there.');
      expect(text).toContain('.orchestrator\\worker-node.json');
      expect(text).toContain('C:\\ProgramData\\Orchestrator\\worker-node.json');
    }
    // Reading names runs this Mac's own sign-in checks: only for the tool with an extra account, once per list.
    expect(accounts.list.mock.calls).toEqual([['claude'], ['claude']]);
  });

  it('reads no account names when every computer reports only default sign-ins', async () => {
    await render([node('windows-pc', { capabilities: { ...node('x').capabilities, supportedClis: ['codex'],
      signIns: [{ provider: 'codex', profileId: 'legacy', state: 'signed-in' }] } })]);
    expect(accounts.list).not.toHaveBeenCalled();
  });

  it('names an account by its ID when this Mac\'s accounts can\'t be read', async () => {
    accounts.list.mockRejectedValueOnce(new Error('Not in Electron'));
    const element = await render([node('windows-pc', { capabilities: { ...node('x').capabilities, supportedClis: ['claude'],
      signIns: [{ provider: 'claude', profileId: 'work', state: 'signed-out' }] } })]);
    expect(element.querySelector('.computer-detail')!.textContent).toContain('Claude account work isn\'t signed in there.');
  });

  it('shows a second test machine on its own row, changes it by its own name, and names both in today\'s work', async () => {
    ipc.getTestMachines.mockResolvedValue({ ok: true, testMachines: ALL_MACHINES, useThisMac: true, today: TODAY });
    const element = await render([node('windows-pc')]);
    expect(names(element)).toEqual(['windows-pc', 'the test Mac', 'This Mac']);
    expect(element.textContent).toContain('Test runs: 59 on your test machines, 8 here.');
    toggle(element, 'checks-test-machine:ct-test-mac');
    await fixture.whenStable();
    expect(ipc.changeTestMachine).toHaveBeenLastCalledWith('ct-test-mac', { checks: false });
    fixture.detectChanges();
    expect((element.querySelector('[id="checks-test-machine:ct-test-mac"]') as HTMLInputElement).checked).toBe(false);
    expect((element.querySelector('#checks-windows-pc') as HTMLInputElement).checked).toBe(true);
    toggle(element, 'paused-test-machine:ct-test-mac');
    await fixture.whenStable();
    expect(ipc.changeTestMachine).toHaveBeenLastCalledWith('ct-test-mac', { paused: true });
    expect(store.set).not.toHaveBeenCalled();
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

  it('turns this Mac\'s backup role off and says what it still takes, in Settings only', async () => {
    const element = await render([node('windows-pc')]);
    expect((element.querySelector('#use-this-mac') as HTMLInputElement).checked).toBe(true);
    toggle(element, 'use-this-mac');
    await fixture.whenStable();
    fixture.detectChanges();
    expect(ipc.setUseThisMac).toHaveBeenCalledWith(false);
    expect(element.textContent).toContain('Takes only work that needs this Mac. Other work waits for the other computers.');
    fixture.destroy();
    expect((await render([node('windows-pc')], true)).querySelector('#use-this-mac')).toBeNull();
  });

  it('shows no backup switch when there is no test machine', async () => {
    ipc.getTestMachines.mockResolvedValue({ ok: true, testMachines: [], useThisMac: true, today: null });
    expect((await render([node('windows-pc')])).querySelector('#use-this-mac')).toBeNull();
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
    expect(ipc.changeTestMachine).toHaveBeenCalledWith('harness-checks', { paused: true });
    fixture.detectChanges();
    toggle(element, 'checks-windows-pc');
    await fixture.whenStable();
    expect(ipc.changeTestMachine).toHaveBeenLastCalledWith('harness-checks', { checks: false });
    const slots = element.querySelector('#slots-windows-pc') as HTMLSelectElement;
    slots.value = '5';
    slots.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(ipc.changeTestMachine).toHaveBeenLastCalledWith('harness-checks', { slots: 5 });
  });

  it('says when a change wasn\'t saved', async () => {
    ipc.changeTestMachine.mockResolvedValueOnce({ ok: false, error: { code: 'COMPUTERS_CHANGE_TEST_MACHINE_FAILED', message: 'No test machine is set up on this Mac.' } });
    const element = await render([node('windows-pc')]);
    toggle(element, 'checks-windows-pc');
    await fixture.whenStable();
    fixture.detectChanges();
    expect(element.querySelector('[role="alert"]')?.textContent).toBe('That change wasn\'t saved.');
    expect(element.querySelector('[role="alert"] + details')?.textContent).toContain('No test machine is set up on this Mac.');
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
    expect(element.querySelector('[role="alert"] + details')?.textContent).toContain('Disk full');
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
    expect(element.querySelector('[role="alert"] + details')?.textContent).toContain('Main process unreachable');
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
    let finishRefresh!: (value: { ok: true; testMachines: TestMachineView[]; useThisMac: boolean; today: WorkToday }) => void;
    ipc.getTestMachines.mockImplementationOnce(() => new Promise(resolve => { finishRefresh = resolve; }));
    void (fixture.componentInstance as unknown as { load: () => Promise<void> }).load();
    toggle(element, 'checks-windows-pc');
    await fixture.whenStable();
    finishRefresh({ ok: true, testMachines: [MACHINE], useThisMac: true, today: TODAY });
    await fixture.whenStable();
    fixture.detectChanges();
    expect((element.querySelector('#checks-windows-pc') as HTMLInputElement).checked).toBe(false);
  });

  it('says when the test machine\'s settings can\'t be read, and still lists the rest', async () => {
    ipc.getTestMachines.mockResolvedValueOnce({ ok: false, error: { message: 'The test machine settings file names no host.' } });
    const element = await render([node('windows-pc')]);
    expect(element.querySelector('[role="alert"]')?.textContent).toContain('couldn\'t be read');
    expect(element.querySelector('[role="alert"] + details')?.textContent).toContain('names no host');
    expect(names(element)).toEqual(['windows-pc', 'This Mac']);
  });

  describe('Plan Queue jobs', () => {
    /** A connected computer that reports it can hold a Plan Queue job. */
    const capable = (id: string) => node(id, { capabilities: { ...node('x').capabilities, queueJobs: 1 } });
    const switchOf = (element: HTMLElement, id: string) => element.querySelector(`[id="queue-jobs-${id}"]`) as HTMLInputElement | null;
    /** Each project line as "name: what it says". */
    const rows = (element: HTMLElement) => [...element.querySelectorAll('.project-line')].map(line =>
      `${line.querySelector('.project-name')!.textContent!.trim()}: ${line.querySelector('.project-text')!.textContent!.trim()}`);

    it('is off until it is switched on, and has no switch for this Mac', async () => {
      const element = await render([capable('windows-pc')]);
      expect(switchOf(element, 'windows-pc')!.checked).toBe(false);
      expect(switchOf(element, 'windows-pc')!.disabled).toBe(false);
      expect(element.querySelectorAll('[id^="queue-jobs-"]')).toHaveLength(1);
      expect(element.querySelector('#queue-jobs-this-mac')).toBeNull();
      expect(element.querySelector('#queue-jobs-at-once-windows-pc')).toBeNull();
      expect(element.querySelector('.queue-projects')).toBeNull();
    });

    it('switches on through the main process and then shows jobs at once and the projects', async () => {
      queueIpc.changeQueueJobs.mockResolvedValue({ ok: true, computers: queueView({ 'windows-pc': { takesJobs: true } }).computers });
      const element = await render([capable('windows-pc')]);
      toggle(element, 'queue-jobs-windows-pc');
      await fixture.whenStable();
      fixture.detectChanges();
      expect(queueIpc.changeQueueJobs).toHaveBeenCalledWith('windows-pc', { takesJobs: true });
      expect(switchOf(element, 'windows-pc')!.checked).toBe(true);
      expect(element.querySelector('#queue-jobs-at-once-windows-pc')).not.toBeNull();
      expect(rows(element)).toEqual(['repo: Not checked there yet.', 'other: Not checked there yet.']);
      expect(store.set).not.toHaveBeenCalled();
    });

    it('puts the switch back and says so when the change is not saved', async () => {
      queueIpc.changeQueueJobs.mockResolvedValue({ ok: false, error: { message: 'The Plan Queue computers file can\'t be read.' } });
      const element = await render([capable('windows-pc')]);
      const input = toggle(element, 'queue-jobs-windows-pc');
      await fixture.whenStable();
      fixture.detectChanges();
      expect(input.checked).toBe(false);
      expect(element.querySelector('[role="alert"]')?.textContent).toBe('That change wasn\'t saved.');
      expect(element.querySelector('[role="alert"] + details')?.textContent).toContain('file can\'t be read');
    });

    it('is disabled with its reason beside it when the computer does not report the ability', async () => {
      const element = await render([node('windows-pc'), capable('laptop')]);
      const input = switchOf(element, 'windows-pc')!;
      expect(input.disabled).toBe(true);
      const reason = element.querySelector('[id="queue-jobs-reason-windows-pc"]')!;
      expect(reason.textContent).toBe('Needs the newer Harness on that computer.');
      expect(input.getAttribute('aria-describedby')).toBe('queue-jobs-reason-windows-pc');
      expect(switchOf(element, 'laptop')!.disabled).toBe(false);
      expect(element.querySelector('[id="queue-jobs-reason-laptop"]')).toBeNull();
    });

    it('can still be changed for a computer that is away, because its ability is unknown then', async () => {
      const element = await render([node('windows-pc', { connected: false })]);
      expect(switchOf(element, 'windows-pc')!.disabled).toBe(false);
      expect(element.querySelector('[id="queue-jobs-reason-windows-pc"]')).toBeNull();
    });

    it('offers jobs at once from 1 to 8, starting at the saved number, and saves a change', async () => {
      queueIpc.getQueueJobs.mockResolvedValue({ ok: true, view: queueView({ 'windows-pc': { takesJobs: true, jobsAtOnce: 3 } }) });
      const element = await render([capable('windows-pc')]);
      const select = element.querySelector('#queue-jobs-at-once-windows-pc') as HTMLSelectElement;
      expect([...select.options].map(option => option.textContent!.trim())).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
      expect(select.value).toBe('3');
      select.value = '5';
      select.dispatchEvent(new Event('change'));
      await fixture.whenStable();
      expect(queueIpc.changeQueueJobs).toHaveBeenLastCalledWith('windows-pc', { jobsAtOnce: 5 });
    });

    it('says in words which projects passed the check, which failed and why, and which have not been checked', async () => {
      const recent = Date.now();
      queueIpc.getQueueJobs.mockResolvedValue({ ok: true, view: {
        projects: [REPO, OTHER, { key: 'third-cccccccc', name: 'third', repoRoot: '/work/third' }],
        computers: [queueComputer('windows-pc', { takesJobs: true, projects: {
          [REPO.key]: { ok: true, checkedAt: recent, problem: null, summary: 'Checks took 43 s.' },
          [OTHER.key]: { ok: false, checkedAt: recent, problem: 'Linting failed on Windows: a path is too long.', summary: '' },
        } })],
      } });
      const element = await render([capable('windows-pc')]);
      const lines = rows(element);
      expect(lines[0]).toMatch(/^repo: Passed the check today at \d\d:\d\d\. Checks took 43 s\.$/);
      expect(lines[1]).toMatch(/^other: Failed the check today at \d\d:\d\d: Linting failed on Windows: a path is too long\.$/);
      expect(lines[2]).toBe('third: Not checked there yet.');
      expect([...element.querySelectorAll('.project-line button')].map(button => button.textContent!.trim())).toEqual(['Check again', 'Check again', 'Check']);
    });

    it('says when the queue has no projects yet', async () => {
      queueIpc.getQueueJobs.mockResolvedValue({ ok: true, view: { projects: [], computers: [queueComputer('windows-pc', { takesJobs: true })] } });
      const element = await render([capable('windows-pc')]);
      expect(element.querySelector('.queue-projects')!.textContent).toContain('No projects yet.');
    });

    it('checks a project on the computer, shows Checking while it runs, and then shows the result', async () => {
      queueIpc.getQueueJobs.mockResolvedValue({ ok: true, view: queueView({ 'windows-pc': { takesJobs: true } }) });
      let finish!: (outcome: QueueOutcome) => void;
      queueIpc.checkQueueProject.mockImplementationOnce(() => new Promise<QueueOutcome>(resolve => { finish = resolve; }));
      const element = await render([capable('windows-pc')]);
      const button = element.querySelector('.project-line button') as HTMLButtonElement;
      expect(button.textContent!.trim()).toBe('Check');
      button.click();
      fixture.detectChanges();
      expect(queueIpc.checkQueueProject).toHaveBeenCalledWith('windows-pc', '/work/repo');
      expect(button.textContent!.trim()).toBe('Checking…');
      expect(button.disabled).toBe(true);
      button.click();
      expect(queueIpc.checkQueueProject).toHaveBeenCalledTimes(1);
      finish({ ok: true, computers: queueView({ 'windows-pc': { takesJobs: true, projects: { [REPO.key]: PASSED } } }).computers });
      await fixture.whenStable();
      fixture.detectChanges();
      expect(rows(element)[0]).toContain('Passed the check today at');
      expect(button.textContent!.trim()).toBe('Check again');
      expect(button.disabled).toBe(false);
    });

    it('says in a plain sentence when a check could not run, with the detail folded away and no earlier result lost', async () => {
      queueIpc.getQueueJobs.mockResolvedValue({ ok: true, view: queueView({ 'windows-pc': { takesJobs: true, projects: { [REPO.key]: PASSED } } }) });
      queueIpc.checkQueueProject.mockResolvedValueOnce({ ok: false, error: { code: 'COMPUTERS_CHECK_QUEUE_PROJECT_FAILED', message: 'The computer did not answer.' } });
      const element = await render([capable('windows-pc')]);
      (element.querySelector('.project-line button') as HTMLButtonElement).click();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(element.querySelector('.project-line + [role="alert"]')?.textContent).toBe('Couldn\'t check repo on windows-pc.');
      expect(element.querySelector('.project-line + [role="alert"] + details')?.textContent).toContain('The computer did not answer.');
      expect(rows(element)[0]).toContain('Passed the check');
      (element.querySelector('.project-line button') as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(element.querySelector('.project-line + [role="alert"]')).toBeNull();
    });

    it('offers no check while the computer is away, and says why', async () => {
      queueIpc.getQueueJobs.mockResolvedValue({ ok: true, view: queueView({ 'windows-pc': { takesJobs: true } }) });
      const element = await render([node('windows-pc', { connected: false })]);
      expect(element.querySelector('.project-line button')).toBeNull();
      expect(element.querySelector('.queue-projects')!.textContent).toContain('It\'s away, so projects can\'t be checked until it\'s back.');
      expect(rows(element)).toHaveLength(2);
    });

    it('says in the read-only list that a computer takes Plan Queue jobs, and nothing for one that does not', async () => {
      queueIpc.getQueueJobs.mockResolvedValue({ ok: true, view: queueView({ 'windows-pc': { takesJobs: true, jobsAtOnce: 4 } }) });
      const element = await render([capable('windows-pc'), capable('laptop')], true);
      const text = element.textContent!.replace(/\s+/g, ' ');
      expect(text).toContain('Also takes Plan Queue jobs, 4 at once.');
      expect(text.match(/Plan Queue jobs/g)).toHaveLength(1);
    });

    it('says when the settings can not be read, shows no switches for them, and still lists the computers', async () => {
      queueIpc.getQueueJobs.mockResolvedValue({ ok: false, error: { message: 'The Plan Queue computers file can\'t be read.' } });
      const element = await render([capable('windows-pc')]);
      expect(element.querySelector('[role="alert"]')?.textContent).toContain('Plan Queue settings for your computers couldn\'t be read');
      expect(element.querySelector('[role="alert"] + details')?.textContent).toContain('file can\'t be read');
      expect(switchOf(element, 'windows-pc')).toBeNull();
      expect(names(element)).toEqual(['windows-pc', 'This Mac']);
    });
  });
});
