import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type {
  PlanQueueLinearConnectionSnapshot,
  PlanQueueLinearFolderLink,
  PlanQueueLinearLinkReading,
  PlanQueueLinearProject,
  PlanQueueLinearTeamProjects,
} from '@contracts/schemas/plan-queue';
import { PlanQueueIpcService } from '../../../core/services/ipc/plan-queue-ipc.service';
import { InstanceStore } from '../../../core/state/instance.store';
import { SettingsStore } from '../../../core/state/settings.store';
import { PlanQueueLinearFolderLinksPanelComponent } from './plan-queue-linear-folder-links-panel.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(resolve(specDirectory, './plan-queue-linear-folder-links-panel.component.html'), 'utf8');
const styles = readFileSync(resolve(specDirectory, './plan-queue-linear-folder-links-panel.component.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('plan-queue-linear-folder-links-panel.component.html')) return Promise.resolve(template);
  if (url.endsWith('plan-queue-linear-folder-links-panel.component.scss')) return Promise.resolve(styles);
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

const TEAMS: PlanQueueLinearTeamProjects[] = [
  { teamId: 'team-COM', teamKey: 'COM', teamName: 'Community Tech', projects: [{ id: 'P-COM-1', name: 'Shop site' }, { id: 'P-COM-2', name: 'Shop app' }] },
  { teamId: 'team-JAM', teamKey: 'JAM', teamName: 'James', projects: [{ id: 'P-JAM-1', name: 'Shop private' }] },
];
const project = (id: string, name: string, teamKey: string): PlanQueueLinearProject => ({ id, name, teamId: `team-${teamKey}`, teamKey });
const SHOP: PlanQueueLinearFolderLink = {
  folder: '/work/shop',
  privateProject: project('P-JAM-1', 'Shop private', 'JAM'),
  clientProjects: [project('P-COM-1', 'Shop site', 'COM')],
};

describe('PlanQueueLinearFolderLinksPanelComponent', () => {
  let fixture: ComponentFixture<PlanQueueLinearFolderLinksPanelComponent>;
  let settings: ReturnType<typeof signal<{ planQueueLinearFolderLinks?: PlanQueueLinearFolderLink[]; planQueueLinearConnection?: unknown }>>;
  let ipc: Record<'linearList' | 'linearLinks' | 'linearLinksSave' | 'linearProjects' | 'linearCheck', Mock>;
  const settingsSet = vi.fn();

  async function flush(): Promise<void> {
    await new Promise((done) => setTimeout(done, 0));
    fixture.detectChanges();
    await fixture.whenStable();
  }

  async function mount(options: {
    saved?: PlanQueueLinearFolderLink[];
    state?: PlanQueueLinearConnectionSnapshot;
    readings?: PlanQueueLinearLinkReading[];
  } = {}): Promise<void> {
    const saved = options.saved ?? [];
    settings.set({ planQueueLinearFolderLinks: saved });
    ipc.linearList.mockResolvedValue(ok({ connectors: [], connection: options.state ?? connection() }));
    ipc.linearLinks.mockResolvedValue(ok({ links: options.readings ?? saved.map((link) => ({ link, broken: null })) }));
    fixture = TestBed.createComponent(PlanQueueLinearFolderLinksPanelComponent);
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
  const rowPaths = (): string[] => texts('.pq-links-rows:not(.pq-links-readonly) .pq-links-path');
  const saveButton = (): HTMLButtonElement => q<HTMLButtonElement>('.pq-links-save') as HTMLButtonElement;

  async function type(value: string): Promise<void> {
    const input = q<HTMLInputElement>('.pq-links-new') as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await flush();
  }

  async function pick(selector: string, optionText: string, row = 0): Promise<void> {
    const select = qa<HTMLSelectElement>(selector)[row];
    const option = Array.from(select.options).find((candidate) => candidate.textContent?.trim() === optionText);
    if (!option) throw new Error(`No option "${optionText}" in ${selector}`);
    select.value = option.value;
    select.dispatchEvent(new Event('change'));
    await flush();
  }

  beforeEach(async () => {
    settings = signal({});
    settingsSet.mockReset();
    ipc = {
      linearList: vi.fn(),
      linearLinks: vi.fn(),
      linearLinksSave: vi.fn(),
      linearProjects: vi.fn().mockResolvedValue(ok({ teams: TEAMS })),
      linearCheck: vi.fn().mockResolvedValue(ok(connection())),
    };
    await TestBed.configureTestingModule({
      imports: [PlanQueueLinearFolderLinksPanelComponent],
      providers: [
        { provide: PlanQueueIpcService, useValue: ipc },
        { provide: SettingsStore, useValue: { settings, set: settingsSet } },
        { provide: InstanceStore, useValue: { rootInstances: signal([{ id: 'a', workingDirectory: '/work/shop' }, { id: 'b', workingDirectory: '/work/blog' }]) } },
      ],
    }).compileComponents();
  });

  describe('with a usable connection', () => {
    it('shows each saved folder with its private project and client projects, and offers open sessions\' folders', async () => {
      await mount({ saved: [SHOP] });
      expect(rowPaths()).toEqual(['/work/shop']);
      expect(texts('.pq-links-project')).toEqual(['JAM · Shop private Remove', 'COM · Shop site Remove']);
      expect(qa<HTMLOptionElement>('#pq-links-suggestions option').map((option) => option.value)).toEqual(['/work/blog']);
      expect(saveButton().disabled).toBe(true);
    });

    it('says no folder is linked when nothing is saved', async () => {
      await mount();
      expect(text('.pq-links-empty')).toContain('No folders are linked to Linear projects.');
    });

    it('adds a folder, picks a private and a client project from the lists, and sends the whole list on Save', async () => {
      ipc.linearLinksSave.mockImplementation(async (links: PlanQueueLinearFolderLink[]) => ok({ saved: true, links }));
      await mount();
      await type(' /work/shop ');
      await click('.pq-links-add-button');
      expect(rowPaths()).toEqual(['/work/shop']);
      // A row with no project cannot be saved, and says why.
      expect(text('.pq-links-row-error')).toBe('Link at least one Linear project to the folder.');
      expect(saveButton().disabled).toBe(true);

      await pick('.pq-links-pick-private', 'Shop private');
      await pick('.pq-links-pick-client', 'Shop site');
      await pick('.pq-links-pick-client', 'Shop app');
      expect(q('.pq-links-row-error')).toBeNull();
      expect(saveButton().disabled).toBe(false);

      await click('.pq-links-save');
      expect(ipc.linearLinksSave).toHaveBeenCalledTimes(1);
      expect(ipc.linearLinksSave).toHaveBeenCalledWith([{
        folder: '/work/shop',
        privateProject: project('P-JAM-1', 'Shop private', 'JAM'),
        clientProjects: [project('P-COM-1', 'Shop site', 'COM'), project('P-COM-2', 'Shop app', 'COM')],
      }]);
      expect(text('.pq-links-status-ok')).toBe('Saved. A session can now start a run in any linked folder.');
      expect(settingsSet).not.toHaveBeenCalled();
    });

    it('offers each project once: one already linked to a folder is not offered again', async () => {
      await mount({ saved: [SHOP] });
      await type('/work/blog');
      await click('.pq-links-add-button');
      const offered = Array.from((qa<HTMLSelectElement>('.pq-links-pick-client')[1]).options).map((option) => option.textContent?.trim());
      expect(offered).toEqual(['Add a client project', 'Shop app']);
    });

    it('does not add a folder twice, in another spelling, or a path that is not a full path', async () => {
      await mount({ saved: [SHOP] });
      await type('/work//shop/');
      expect(qa<HTMLButtonElement>('.pq-links-add-button')[0].disabled).toBe(true);
      await type('shop');
      expect(text('.pq-links-new-error')).toContain('Give the full path of the folder');
      expect(qa<HTMLButtonElement>('.pq-links-add-button')[0].disabled).toBe(true);
    });

    it('removes a project and a folder, and Save then sends the shorter list', async () => {
      ipc.linearLinksSave.mockImplementation(async (links: PlanQueueLinearFolderLink[]) => ok({ saved: true, links }));
      await mount({ saved: [SHOP, { folder: '/work/blog', privateProject: null, clientProjects: [project('P-COM-2', 'Shop app', 'COM')] }] });
      await click('.pq-links-remove-project', 1); // the client project of the first folder
      await click('.pq-links-remove-folder', 1); // the second folder
      expect(rowPaths()).toEqual(['/work/shop']);
      await click('.pq-links-save');
      expect(ipc.linearLinksSave).toHaveBeenCalledWith([{ ...SHOP, clientProjects: [] }]);
    });

    it('Reset to saved drops the edits', async () => {
      await mount({ saved: [SHOP] });
      await click('.pq-links-remove-folder');
      expect(rowPaths()).toEqual([]);
      expect(text('.pq-links-status')).toContain('Not saved yet');
      await click('.pq-links-reset');
      expect(rowPaths()).toEqual(['/work/shop']);
      expect(saveButton().disabled).toBe(true);
    });

    it('a refused save keeps every edit on screen and puts each reason beside its row', async () => {
      ipc.linearLinksSave.mockResolvedValue(ok({
        saved: false,
        refused: [{ index: 1, reason: 'There is no folder at /work/gone on this computer.' }, { index: null, reason: 'The list is too long: at most 100 folders can be linked.' }],
      }));
      await mount({ saved: [SHOP] });
      await type('/work/gone');
      await click('.pq-links-add-button');
      await pick('.pq-links-pick-client', 'Shop app', 1);
      await click('.pq-links-save');

      expect(rowPaths()).toEqual(['/work/shop', '/work/gone']);
      const rows = qa('.pq-links-row');
      expect(rows[0].querySelector('.pq-links-row-error')).toBeNull();
      expect(rows[1].querySelector('.pq-links-row-error')?.textContent?.trim()).toBe('There is no folder at /work/gone on this computer.');
      expect(rows[1].querySelector('.pq-links-row-error')?.getAttribute('role')).toBe('alert');
      expect(text('.pq-links-list-refusal')).toContain('at most 100 folders');
      expect(text('.pq-links-status-error')).toBe('Nothing was saved. The rows below say what to fix.');
      expect(texts('.pq-links-row:nth-child(2) .pq-links-project')).toEqual(['COM · Shop app Remove']);
    });

    it('editing a refused row clears its reason, and removing a row above moves the reasons of the rows below up with their rows', async () => {
      ipc.linearLinksSave.mockResolvedValue(ok({
        saved: false,
        refused: [{ index: 1, reason: 'Row b problem.' }, { index: 2, reason: 'Row c problem.' }],
      }));
      await mount();
      for (const [folder, selector, name] of [['/work/a', '.pq-links-pick-private', 'Shop private'], ['/work/b', '.pq-links-pick-client', 'Shop site'], ['/work/c', '.pq-links-pick-client', 'Shop app']] as const) {
        await type(folder);
        await click('.pq-links-add-button');
        await pick(selector, name, qa('.pq-links-row').length - 1);
      }
      await click('.pq-links-save');
      expect(texts('.pq-links-row').map((row) => (/problem\./.exec(row) ?? [''])[0])).toEqual(['', 'problem.', 'problem.']);

      await click('.pq-links-remove-folder', 0);
      expect(rowPaths()).toEqual(['/work/b', '/work/c']);
      expect(qa('.pq-links-row').map((row) => row.querySelector('.pq-links-row-error')?.textContent?.trim())).toEqual(['Row b problem.', 'Row c problem.']);

      // Changing the second row clears only its own reason.
      await click('.pq-links-remove-project', 1);
      await pick('.pq-links-pick-client', 'Shop app', 1);
      expect(qa('.pq-links-row').map((row) => row.querySelector('.pq-links-row-error')?.textContent?.trim())).toEqual(['Row b problem.', undefined]);
    });

    it('shows a save failure in words and keeps the edits', async () => {
      ipc.linearLinksSave.mockResolvedValue(failed('The settings file could not be written.'));
      await mount({ saved: [SHOP] });
      await click('.pq-links-remove-folder');
      await click('.pq-links-save');
      expect(text('.pq-links-status-error')).toBe('Could not save: The settings file could not be written.');
      expect(rowPaths()).toEqual([]);
    });

    it('shows a broken link with its reason, on the row of its folder', async () => {
      await mount({
        saved: [SHOP],
        readings: [{ link: SHOP, broken: '/work/shop is not part of a Git project, so no runs can start there.' }],
      });
      expect(text('.pq-links-broken')).toBe('This link is not used. /work/shop is not part of a Git project, so no runs can start there.');
      expect(q('.pq-links-broken')?.getAttribute('role')).toBe('alert');
    });

    it('says when Linear\'s projects could not be read, and still lets a folder be removed', async () => {
      ipc.linearProjects.mockResolvedValue(failed('Linear could not be reached.'));
      await mount({ saved: [SHOP] });
      expect(text('.pq-links-projects-error')).toBe('Could not read Linear\'s projects: Linear could not be reached.');
      expect(qa<HTMLSelectElement>('.pq-links-pick-client')[0].options).toHaveLength(1);
      await click('.pq-links-remove-folder');
      expect(rowPaths()).toEqual([]);
    });

    it('shows plain text for names from Linear, never markup', async () => {
      await mount({ saved: [{ ...SHOP, privateProject: project('P-JAM-9', '<b>Bold</b>', 'JAM') }] });
      expect(texts('.pq-links-project')[0]).toContain('<b>Bold</b>');
      expect(q('.pq-links-project b')).toBeNull();
    });
  });

  describe('without a usable connection', () => {
    it('says so with the reason, shows the saved links read-only, and offers no editor', async () => {
      await mount({ saved: [SHOP], state: NOT_USABLE });
      expect(text('.pq-links-no-connection')).toContain('Linear work is paused: sign in to "linear" again in Settings → Connectors.');
      expect(texts('.pq-links-readonly .pq-links-path')).toEqual(['/work/shop']);
      expect(texts('.pq-links-readonly .pq-links-project')).toEqual(['Private: JAM · Shop private', 'Client: COM · Shop site']);
      expect(q('.pq-links-new')).toBeNull();
      expect(q('.pq-links-save')).toBeNull();
      expect(q('.pq-links-pick-client')).toBeNull();
      expect(ipc.linearProjects).not.toHaveBeenCalled();
    });

    it('still shows a broken link\'s reason in the read-only list', async () => {
      await mount({ saved: [SHOP], state: NOT_USABLE, readings: [{ link: SHOP, broken: 'There is no folder at /work/shop on this computer.' }] });
      expect(text('.pq-links-readonly .pq-links-broken')).toContain('There is no folder at /work/shop on this computer.');
    });

    it('checks the connection again on request and opens the editor once it works', async () => {
      await mount({ saved: [SHOP], state: NOT_USABLE });
      await click('.pq-links-recheck');
      expect(ipc.linearCheck).toHaveBeenCalledTimes(1);
      expect(q('.pq-links-new')).not.toBeNull();
      expect(ipc.linearProjects).toHaveBeenCalledTimes(1);
    });

    it('waits for the first check after a restart instead of staying read-only', async () => {
      await mount({ saved: [SHOP], state: connection({ state: 'checking', usable: false, reason: 'Linear is being checked.' }) });
      expect(ipc.linearCheck).toHaveBeenCalledTimes(1);
      expect(q('.pq-links-new')).not.toBeNull();
    });

    it('reads a connection that cannot be read as a visible error', async () => {
      ipc.linearList.mockResolvedValue(failed('No answer from the main process.'));
      ipc.linearLinks.mockResolvedValue(ok({ links: [] }));
      fixture = TestBed.createComponent(PlanQueueLinearFolderLinksPanelComponent);
      fixture.detectChanges();
      await flush();
      expect(text('.pq-links-status-error')).toContain('Could not read the Linear connection: No answer from the main process.');
      expect(q('.pq-links-save')).toBeNull();
    });
  });

  it('follows the saved links when they change elsewhere and nothing here is unsaved', async () => {
    await mount({ saved: [SHOP] });
    settings.set({ planQueueLinearFolderLinks: [] });
    await flush();
    expect(rowPaths()).toEqual([]);
    expect(ipc.linearLinks.mock.calls.length).toBeGreaterThan(1);
  });
});
