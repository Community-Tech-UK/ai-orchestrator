import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type {
  PlanQueueLinearConnectionSnapshot,
  PlanQueueLinearFolderLink,
  PlanQueueLinearStatus,
  PlanQueueLinearTeam,
  PlanQueueLinearTeamCheck,
  PlanQueueLinearTeamChoice,
  PlanQueueLinearTeamChoices,
} from '@contracts/schemas/plan-queue';
import { PlanQueueIpcService } from '../../../core/services/ipc/plan-queue-ipc.service';
import { SettingsStore } from '../../../core/state/settings.store';
import { PlanQueueLinearTeamsPanelComponent } from './plan-queue-linear-teams-panel.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(resolve(specDirectory, './plan-queue-linear-teams-panel.component.html'), 'utf8');
const styles = readFileSync(resolve(specDirectory, './plan-queue-linear-teams-panel.component.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('plan-queue-linear-teams-panel.component.html')) return Promise.resolve(template);
  if (url.endsWith('plan-queue-linear-teams-panel.component.scss')) return Promise.resolve(styles);
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

const ok = <T>(data: T) => ({ success: true, data });
const failed = (message: string) => ({ success: false, error: { message } });

function connection(overrides: Partial<PlanQueueLinearConnectionSnapshot> = {}): PlanQueueLinearConnectionSnapshot {
  return {
    state: 'ready', usable: true, reason: null, connectorId: 'c1', connectorName: 'linear', userName: 'Pat Example',
    workspaceName: 'Example Workspace', checkedAt: 1, connectorProblem: null, unreachableCause: null, retryAt: null,
    ...overrides,
  };
}
const NOT_USABLE = connection({
  state: 'needs-sign-in', usable: false, reason: 'Linear work is paused: sign in to "linear" again in Settings → Connectors.',
});

const status = (id: string, name: string, kind: string): PlanQueueLinearStatus => ({ id, name, kind });
const COM_STATUSES = [status('com-todo', 'Todo', 'unstarted'), status('com-progress', 'In Progress', 'started'),
  status('com-review', 'In Review', 'started'), status('com-done', 'Done', 'completed')];
const ORC_STATUSES = [...COM_STATUSES.map((entry) => ({ ...entry, id: entry.id.replace('com', 'orc') })), status('orc-qa', 'Ready for QA/Test', 'started')];

const offered = (statuses: PlanQueueLinearStatus[], landed: string): PlanQueueLinearTeamChoice['offered'] => ({
  startedStatus: statuses.find((entry) => entry.name === 'In Progress') ?? null,
  handBackStatus: statuses.find((entry) => entry.name === 'Todo') ?? null,
  landedStatus: statuses.find((entry) => entry.name === landed) ?? null,
  doneStatus: statuses.find((entry) => entry.name === 'Done') ?? null,
});
const COM_CHOICE: PlanQueueLinearTeamChoice = { teamId: 't-com', teamKey: 'COM', teamName: 'Community Tech', exists: true, statuses: COM_STATUSES, offered: offered(COM_STATUSES, 'In Review') };
const ORC_CHOICE: PlanQueueLinearTeamChoice = { teamId: 't-orc', teamKey: 'ORC', teamName: 'orchestrat0r', exists: true, statuses: ORC_STATUSES, offered: offered(ORC_STATUSES, 'Ready for QA/Test') };
const CHOICES: PlanQueueLinearTeamChoices = {
  teams: [COM_CHOICE, ORC_CHOICE],
  providers: [{ id: 'claude', label: 'Claude' }, { id: 'codex', label: 'Codex' }],
  routingProviders: ['codex'],
};

const link = (...teams: [string, string][]): PlanQueueLinearFolderLink => ({
  folder: '/work/shop', privateProject: null,
  clientProjects: teams.map(([teamId, teamKey]) => ({ id: `p-${teamKey}`, name: `Project ${teamKey}`, teamId, teamKey })),
});
const LINKS = [link(['t-com', 'COM'], ['t-orc', 'ORC'])];

const COM_SAVED: PlanQueueLinearTeam = {
  teamId: 't-com', teamKey: 'COM', teamName: 'Community Tech', ownership: 'client',
  startedStatus: COM_STATUSES[1], handBackStatus: COM_STATUSES[0], landedStatus: COM_STATUSES[2], doneStatus: null, providers: ['claude'],
};
const ORC_SAVED: PlanQueueLinearTeam = {
  teamId: 't-orc', teamKey: 'ORC', teamName: 'orchestrat0r', ownership: 'own',
  startedStatus: ORC_STATUSES[1], handBackStatus: ORC_STATUSES[0], landedStatus: ORC_STATUSES[4], doneStatus: ORC_STATUSES[3], providers: ['codex'],
};

const healthy = (teamId: string): PlanQueueLinearTeamCheck => ({
  teamId, ready: true, reasons: [], lines: [{ id: 'team', result: 'ok', text: `${teamId} is still in Linear.` }],
});

describe('PlanQueueLinearTeamsPanelComponent', () => {
  let fixture: ComponentFixture<PlanQueueLinearTeamsPanelComponent>;
  let settings: ReturnType<typeof signal<{ planQueueLinearTeams?: PlanQueueLinearTeam[]; planQueueLinearFolderLinks?: PlanQueueLinearFolderLink[]; planQueueLinearConnection?: unknown }>>;
  let ipc: Record<'linearList' | 'linearCheck' | 'linearTeamChoices' | 'linearTeamsCheck' | 'linearTeamsSave', Mock>;

  async function flush(): Promise<void> {
    await new Promise((done) => setTimeout(done, 0));
    fixture.detectChanges();
    await fixture.whenStable();
  }

  async function mount(options: {
    saved?: PlanQueueLinearTeam[];
    links?: PlanQueueLinearFolderLink[];
    state?: PlanQueueLinearConnectionSnapshot;
    choices?: PlanQueueLinearTeamChoices;
    checks?: PlanQueueLinearTeamCheck[];
  } = {}): Promise<void> {
    settings.set({ planQueueLinearTeams: options.saved ?? [], planQueueLinearFolderLinks: options.links ?? LINKS });
    ipc.linearList.mockResolvedValue(ok({ connectors: [], connection: options.state ?? connection() }));
    ipc.linearTeamChoices.mockResolvedValue(ok(options.choices ?? CHOICES));
    ipc.linearTeamsCheck.mockResolvedValue(ok({ checkedAt: 1, teams: options.checks ?? (options.saved ?? []).map((team) => healthy(team.teamId)) }));
    fixture = TestBed.createComponent(PlanQueueLinearTeamsPanelComponent);
    fixture.detectChanges();
    await flush();
  }

  const root = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const q = <T extends Element>(selector: string): T | null => root().querySelector(selector) as T | null;
  const qa = <T extends Element>(selector: string): T[] => Array.from(root().querySelectorAll(selector)) as T[];
  const text = (selector: string): string => q(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const texts = (selector: string): string[] => qa(selector).map((element) => element.textContent?.replace(/\s+/g, ' ').trim() ?? '');
  const click = async (selector: string, index = 0): Promise<void> => {
    qa<HTMLButtonElement>(selector)[index].click();
    await flush();
  };
  const saveButton = (): HTMLButtonElement => q<HTMLButtonElement>('.pq-teams-save') as HTMLButtonElement;
  const rowNames = (): string[] => texts('.pq-teams-rows:not(.pq-teams-readonly) .pq-teams-name');
  /** The names shown in a row's status box, read from the chosen option. */
  const chosen = (field: string, row = 0): string => {
    const select = qa<HTMLSelectElement>(`.pq-teams-pick-${field}`)[row];
    return select.selectedOptions[0]?.textContent?.trim() ?? '';
  };

  async function pick(field: string, optionText: string, row = 0): Promise<void> {
    const select = qa<HTMLSelectElement>(`.pq-teams-pick-${field}`)[row];
    const option = Array.from(select.options).find((candidate) => candidate.textContent?.trim() === optionText);
    if (!option) throw new Error(`No option "${optionText}" in ${field}`);
    select.value = option.value;
    select.dispatchEvent(new Event('change'));
    await flush();
  }

  async function tick(label: string, row = 0): Promise<void> {
    const box = qa<HTMLLabelElement>('.pq-teams-row')[row].querySelectorAll<HTMLLabelElement>('label.pq-teams-choice');
    const target = Array.from(box).find((candidate) => candidate.textContent?.trim() === label);
    if (!target) throw new Error(`No box "${label}"`);
    (target.querySelector('input') as HTMLInputElement).click();
    await flush();
  }

  const ticked = (row = 0): string[] => qa<HTMLInputElement>('.pq-teams-row')[row] === undefined ? [] : Array.from(qa<HTMLElement>('.pq-teams-row')[row].querySelectorAll<HTMLInputElement>('input.pq-teams-provider'))
    .filter((input) => input.checked).map((input) => input.value);

  beforeEach(async () => {
    settings = signal({});
    ipc = {
      linearList: vi.fn(),
      linearCheck: vi.fn().mockResolvedValue(ok(connection())),
      linearTeamChoices: vi.fn(),
      linearTeamsCheck: vi.fn(),
      linearTeamsSave: vi.fn(),
    };
    await TestBed.configureTestingModule({
      imports: [PlanQueueLinearTeamsPanelComponent],
      providers: [
        { provide: PlanQueueIpcService, useValue: ipc },
        { provide: SettingsStore, useValue: { settings, set: vi.fn() } },
      ],
    }).compileComponents();
  });

  describe('with a usable connection', () => {
    it('shows each saved team with its owner, statuses with their kind in plain words, and ticked providers', async () => {
      await mount({ saved: [COM_SAVED, ORC_SAVED] });
      expect(rowNames()).toEqual(['COM · Community Tech', 'ORC · orchestrat0r']);
      expect(chosen('startedStatus', 0)).toBe('In Progress (in progress)');
      expect(chosen('handBackStatus', 0)).toBe('Todo (not started)');
      expect(chosen('landedStatus', 1)).toBe('Ready for QA/Test (in progress)');
      expect(ticked(0)).toEqual(['claude']);
      expect(ticked(1)).toEqual(['codex']);
      expect(saveButton().disabled).toBe(true);
    });

    it('gives a client team no done choice, and an own team one', async () => {
      await mount({ saved: [COM_SAVED, ORC_SAVED] });
      expect(qa('.pq-teams-pick-doneStatus')).toHaveLength(1);
      expect(chosen('doneStatus', 0)).toBe('Done (done)');
    });

    it('says what a ticked provider means, beside the boxes', async () => {
      await mount({ saved: [COM_SAVED] });
      expect(text('.pq-teams-provider-note')).toContain('Sessions on these providers will be sent this team\'s ticket text.');
    });

    it('says an empty list means no provider, so the team is not ready', async () => {
      await mount({ saved: [{ ...COM_SAVED, providers: [] }] });
      expect(text('.pq-teams-provider-note')).toContain('With none ticked, no provider is sent it');
    });

    it('offers each linked team with no rules, and starts a new row as a client team with the offered statuses', async () => {
      await mount();
      expect(texts('.pq-teams-setup')).toEqual(['Set up COM', 'Set up ORC']);
      await click('.pq-teams-setup', 0);
      expect(rowNames()).toEqual(['COM · Community Tech']);
      expect(q<HTMLInputElement>('.pq-teams-client')?.checked).toBe(true);
      expect(chosen('startedStatus')).toBe('In Progress (in progress)');
      expect(chosen('handBackStatus')).toBe('Todo (not started)');
      expect(chosen('landedStatus')).toBe('In Review (in progress)');
      expect(qa('.pq-teams-pick-doneStatus')).toHaveLength(0);
      expect(texts('.pq-teams-setup')).toEqual(['Set up ORC']);
      expect(saveButton().disabled).toBe(false);
    });

    it('offers Ready for QA/Test as landed for the team that has it', async () => {
      await mount();
      await click('.pq-teams-setup', 1);
      expect(chosen('landedStatus')).toBe('Ready for QA/Test (in progress)');
    });

    it('offers done and the saved routing\'s providers, as a starting point only, when a team is made one of his own', async () => {
      await mount();
      await click('.pq-teams-setup', 1);
      expect(ticked()).toEqual([]);
      q<HTMLInputElement>('.pq-teams-own')?.click();
      await flush();
      expect(chosen('doneStatus')).toBe('Done (done)');
      expect(ticked()).toEqual(['codex']);
      expect(ipc.linearTeamsSave).not.toHaveBeenCalled();
      expect(text('.pq-teams-status-line')).toContain('Not saved yet');
    });

    it('drops the done status again when a team is made a client team', async () => {
      await mount({ saved: [ORC_SAVED] });
      q<HTMLInputElement>('.pq-teams-client')?.click();
      await flush();
      expect(qa('.pq-teams-pick-doneStatus')).toHaveLength(0);
      ipc.linearTeamsSave.mockResolvedValue(ok({ saved: true, teams: [] }));
      await click('.pq-teams-save');
      const sent = ipc.linearTeamsSave.mock.calls[0][0] as PlanQueueLinearTeam[];
      expect(sent[0]).toMatchObject({ ownership: 'client', doneStatus: null });
    });

    it('cannot be saved while a status is missing, and says which', async () => {
      const noTodo = { ...COM_CHOICE, statuses: COM_STATUSES.slice(1), offered: { ...COM_CHOICE.offered, handBackStatus: null } };
      await mount({ choices: { ...CHOICES, teams: [noTodo, ORC_CHOICE] } });
      await click('.pq-teams-setup', 0);
      expect(saveButton().disabled).toBe(true);
      expect(text('.pq-teams-row-error')).toContain('Choose a status for: when a ticket is handed back.');
      await pick('handBackStatus', 'Done (done)');
      // The schema's own words: a handed-back status must be of the not-started kind.
      expect(text('.pq-teams-row-error')).toContain('unstarted kind');
      expect(saveButton().disabled).toBe(true);
    });

    it('lets a status be chosen from Linear\'s list and ticks follow the boxes', async () => {
      await mount({ saved: [COM_SAVED] });
      await pick('landedStatus', 'In Progress (in progress)');
      await tick('Codex');
      await tick('Claude');
      expect(ticked()).toEqual(['codex']);
      expect(saveButton().disabled).toBe(false);
    });

    it('saves the whole list and shows it saved', async () => {
      await mount({ saved: [COM_SAVED] });
      await tick('Codex');
      ipc.linearTeamsSave.mockImplementation(async (teams: PlanQueueLinearTeam[]) => ok({ saved: true, teams }));
      await click('.pq-teams-save');
      const sent = ipc.linearTeamsSave.mock.calls[0][0] as PlanQueueLinearTeam[];
      expect(sent).toHaveLength(1);
      expect(sent[0].providers).toEqual(['claude', 'codex']);
      expect(text('.pq-teams-status-ok')).toContain('Saved.');
    });

    it('keeps the edits on screen and puts each reason on its row when a save is refused', async () => {
      await mount({ saved: [COM_SAVED, ORC_SAVED] });
      await tick('Codex', 0);
      ipc.linearTeamsSave.mockResolvedValue(ok({ saved: false, refused: [
        { index: 1, reason: 'The "done" status "Done" is not one of ORC\'s statuses.' },
        { index: null, reason: 'A reason about the whole list.' },
      ] }));
      await click('.pq-teams-save');
      const rows = qa('.pq-teams-row');
      expect(rows[0].textContent).not.toContain('is not one of ORC');
      expect(rows[1].textContent).toContain('The "done" status "Done" is not one of ORC\'s statuses.');
      expect(text('.pq-teams-list-refusal')).toBe('A reason about the whole list.');
      expect(text('.pq-teams-status-error')).toContain('Nothing was saved.');
      expect(ticked(0)).toEqual(['claude', 'codex']);
    });

    it('clears a row\'s reason when that row is edited, and moves reasons up when a row above is removed', async () => {
      await mount({ saved: [COM_SAVED, ORC_SAVED] });
      await tick('Codex', 1);
      ipc.linearTeamsSave.mockResolvedValue(ok({ saved: false, refused: [{ index: 1, reason: 'Row two is wrong.' }] }));
      await click('.pq-teams-save');
      await click('.pq-teams-remove', 0);
      expect(rowNames()).toEqual(['ORC · orchestrat0r']);
      expect(text('.pq-teams-row-error')).toBe('Row two is wrong.');
      await tick('Claude', 0);
      expect(qa('.pq-teams-row-error')).toHaveLength(0);
    });

    it('shows the error and keeps the edits when the save itself fails', async () => {
      await mount({ saved: [COM_SAVED] });
      await tick('Codex');
      ipc.linearTeamsSave.mockResolvedValue(failed('The connection dropped.'));
      await click('.pq-teams-save');
      expect(text('.pq-teams-status-error')).toContain('Could not save: The connection dropped.');
      expect(ticked()).toEqual(['claude', 'codex']);
    });

    it('resets the edits to the saved rules', async () => {
      await mount({ saved: [COM_SAVED] });
      await tick('Codex');
      await click('.pq-teams-reset');
      expect(ticked()).toEqual(['claude']);
      expect(saveButton().disabled).toBe(true);
    });

    it('removes a team\'s rules from the draft, and the team is offered again to set up', async () => {
      await mount({ saved: [COM_SAVED] });
      await click('.pq-teams-remove');
      expect(rowNames()).toEqual([]);
      expect(texts('.pq-teams-setup')).toEqual(['Set up COM', 'Set up ORC']);
      expect(saveButton().disabled).toBe(false);
    });

    it('shows a status Linear no longer lists, so the box is never blank', async () => {
      const gone = { ...COM_CHOICE, statuses: COM_STATUSES.filter((entry) => entry.id !== 'com-review') };
      await mount({ saved: [COM_SAVED], choices: { ...CHOICES, teams: [gone] } });
      expect(chosen('landedStatus')).toBe('In Review (no longer in Linear)');
    });

    it('says when Linear does not list a team any more', async () => {
      const gone = { ...COM_CHOICE, exists: false, statuses: [] };
      await mount({ saved: [COM_SAVED], choices: { ...CHOICES, teams: [gone] } });
      expect(text('.pq-teams-gone')).toContain('Linear does not list this team any more.');
    });

    it('shows the checks of a saved team, open and with the reason when it is not ready', async () => {
      const bad: PlanQueueLinearTeamCheck = {
        teamId: 't-orc', ready: false, reasons: ['Linear reports this team as open to the whole workspace, but it is saved as one of your own private teams.'],
        lines: [{ id: 'team', result: 'ok', text: 'ORC is still in Linear.' }, { id: 'private', result: 'problem', text: 'Linear reports this team as open to the whole workspace, but it is saved as one of your own private teams.' }],
      };
      await mount({ saved: [COM_SAVED, ORC_SAVED], checks: [healthy('t-com'), bad] });
      const rows = qa('.pq-teams-row');
      expect(rows[1].querySelector('.pq-teams-not-ready')?.textContent).toContain('Not ready for Linear runs: Linear reports this team as open');
      expect(rows[1].querySelector('details')?.open).toBe(true);
      expect(rows[1].querySelector('.pq-teams-check-lines')?.textContent).toContain('Problem:');
      expect(rows[0].querySelector('.pq-teams-not-ready')).toBeNull();
      expect(rows[0].querySelector('details')?.open).toBe(false);
    });

    it('hides the checks of a row being edited, because they are about what is saved', async () => {
      await mount({ saved: [COM_SAVED] });
      expect(qa('.pq-teams-check-line')).toHaveLength(1);
      await tick('Codex');
      expect(qa('.pq-teams-check-line')).toHaveLength(0);
      expect(text('.pq-teams-no-checks')).toContain('Checks run on the saved rules.');
    });

    it('checks the teams again on request, and shows the answer', async () => {
      await mount({ saved: [COM_SAVED] });
      ipc.linearTeamsCheck.mockResolvedValue(ok({ checkedAt: 2, teams: [{ teamId: 't-com', ready: false, reasons: ['COM is no longer in Linear.'], lines: [{ id: 'team', result: 'problem', text: 'COM is no longer in Linear.' }] }] }));
      await click('.pq-teams-check');
      expect(text('.pq-teams-not-ready')).toContain('COM is no longer in Linear.');
    });

    it('shows a failed read of the teams and of the checks, in words', async () => {
      await mount({ saved: [COM_SAVED] });
      ipc.linearTeamsCheck.mockResolvedValue(failed('Linear could not be reached.'));
      await click('.pq-teams-check');
      expect(text('.pq-teams-checks-error')).toContain('Could not check the teams: Linear could not be reached.');
      ipc.linearTeamChoices.mockResolvedValue(failed('Linear could not be reached.'));
      settings.set({ planQueueLinearTeams: [COM_SAVED], planQueueLinearFolderLinks: [] });
      await flush();
      expect(text('.pq-teams-choices-error')).toContain('Could not read Linear\'s teams: Linear could not be reached.');
    });

    it('says no team has a linked project when there is nothing to set up', async () => {
      await mount({ links: [] });
      expect(text('.pq-teams-empty')).toContain('No team has a linked project yet.');
    });

    it('follows the saved rules while there are no unsaved edits, and keeps unsaved edits when another change arrives', async () => {
      await mount({ saved: [COM_SAVED] });
      settings.set({ planQueueLinearTeams: [COM_SAVED, ORC_SAVED], planQueueLinearFolderLinks: LINKS });
      await flush();
      expect(rowNames()).toEqual(['COM · Community Tech', 'ORC · orchestrat0r']);
      await tick('Codex', 0);
      settings.set({ planQueueLinearTeams: [COM_SAVED, { ...ORC_SAVED, providers: ['claude'] }], planQueueLinearFolderLinks: LINKS });
      await flush();
      expect(ticked(0)).toEqual(['claude', 'codex']);
    });
  });

  describe('without a usable connection', () => {
    it('gives the connection\'s reason, shows the saved rules read-only and offers to check again', async () => {
      await mount({ saved: [COM_SAVED, ORC_SAVED], state: NOT_USABLE });
      expect(text('.pq-teams-no-connection')).toContain('sign in to "linear" again');
      expect(rowNames()).toEqual([]);
      expect(texts('.pq-teams-readonly .pq-teams-name')).toEqual(['COM · Community Tech', 'ORC · orchestrat0r']);
      expect(texts('.pq-teams-readonly .pq-teams-row')[0]).toContain('A client team.');
      expect(qa('.pq-teams-save')).toHaveLength(0);
      expect(ipc.linearTeamChoices).not.toHaveBeenCalled();
      expect(ipc.linearTeamsCheck).not.toHaveBeenCalled();
    });

    it('reads again once the connection is fixed', async () => {
      await mount({ saved: [COM_SAVED], state: NOT_USABLE });
      ipc.linearCheck.mockResolvedValue(ok(connection()));
      await click('.pq-teams-recheck');
      expect(ipc.linearTeamChoices).toHaveBeenCalled();
      expect(qa('.pq-teams-save')).toHaveLength(1);
    });

    it('says no team has rules when nothing is saved', async () => {
      await mount({ state: NOT_USABLE });
      expect(text('.pq-teams-empty')).toBe('No team has rules yet.');
    });

    it('waits for the first check after a restart instead of staying read-only', async () => {
      ipc.linearCheck.mockResolvedValue(ok(connection()));
      await mount({ saved: [COM_SAVED], state: connection({ state: 'checking', usable: false, reason: 'Checking.' }) });
      expect(ipc.linearCheck).toHaveBeenCalled();
      expect(rowNames()).toEqual(['COM · Community Tech']);
    });
  });
});
