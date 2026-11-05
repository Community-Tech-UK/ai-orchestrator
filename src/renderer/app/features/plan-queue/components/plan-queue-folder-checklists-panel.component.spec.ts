import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { PlanQueueFolderChecklist } from '@contracts/schemas/plan-queue';
import { InstanceStore } from '../../../core/state/instance.store';
import { SettingsStore } from '../../../core/state/settings.store';
import { PlanQueueFolderChecklistsPanelComponent } from './plan-queue-folder-checklists-panel.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(resolve(specDirectory, './plan-queue-folder-checklists-panel.component.html'), 'utf8');
const styles = readFileSync(resolve(specDirectory, './plan-queue-folder-checklists-panel.component.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('plan-queue-folder-checklists-panel.component.html')) return Promise.resolve(template);
  if (url.endsWith('plan-queue-folder-checklists-panel.component.scss')) return Promise.resolve(styles);
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

const SHOP: PlanQueueFolderChecklist = { folder: '/work/shop', verifierGates: ['make check', 'make lint'], postMergeGate: ['make types'] };

describe('PlanQueueFolderChecklistsPanelComponent', () => {
  let fixture: ComponentFixture<PlanQueueFolderChecklistsPanelComponent>;
  let settings: ReturnType<typeof signal<{ planQueueFolderChecklists?: PlanQueueFolderChecklist[] }>>;
  let storeError: ReturnType<typeof signal<string | null>>;
  let setSetting: Mock;

  async function flush(): Promise<void> {
    await new Promise((done) => setTimeout(done, 0));
    fixture.detectChanges();
    await fixture.whenStable();
  }

  async function mount(saved?: PlanQueueFolderChecklist[]): Promise<void> {
    settings.set(saved ? { planQueueFolderChecklists: saved } : {});
    fixture = TestBed.createComponent(PlanQueueFolderChecklistsPanelComponent);
    fixture.detectChanges();
    await flush();
  }

  const root = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const qa = <T extends Element>(selector: string): T[] => Array.from(root().querySelectorAll(selector)) as T[];
  const saveButton = (): HTMLButtonElement => root().querySelector('.pq-folder-checks-save') as HTMLButtonElement;
  const addButton = (): HTMLButtonElement => root().querySelector('.pq-folder-checks-add-button') as HTMLButtonElement;
  const statusText = (): string => root().querySelector('.pq-folder-checks-status')?.textContent?.trim() ?? '';

  async function type(selector: string, value: string, index = 0): Promise<void> {
    const element = qa<HTMLInputElement | HTMLTextAreaElement>(selector)[index];
    element.value = value;
    element.dispatchEvent(new Event('input'));
    await flush();
  }

  async function addFolder(folder: string): Promise<void> {
    await type('.pq-folder-checks-new', folder);
    addButton().click();
    await flush();
  }

  beforeEach(async () => {
    settings = signal({});
    storeError = signal<string | null>(null);
    setSetting = vi.fn().mockImplementation(async (_key: string, value: PlanQueueFolderChecklist[]) => {
      settings.set({ planQueueFolderChecklists: value });
    });

    await TestBed.configureTestingModule({
      imports: [PlanQueueFolderChecklistsPanelComponent],
      providers: [
        { provide: SettingsStore, useValue: { settings, error: storeError, clearError: vi.fn(() => storeError.set(null)), set: setSetting } },
        { provide: InstanceStore, useValue: { rootInstances: signal([
          { id: 'a', workingDirectory: '/work/shop' }, { id: 'b', workingDirectory: '/work/blog' }, { id: 'c', workingDirectory: '/work/blog' },
        ]) } },
      ],
    }).compileComponents();
  });

  it('says what happens in a folder with no saved checks, and offers nothing to save', async () => {
    await mount();
    expect(root().textContent).toContain('uses the checks the project documents for itself');
    expect(qa('.pq-folder-checks-folder')).toHaveLength(0);
    expect(saveButton().disabled).toBe(true);
  });

  it('shows each saved folder with its commands, one per line', async () => {
    await mount([SHOP]);
    expect(qa('.pq-folder-checks-path').map((h) => h.textContent?.trim())).toEqual(['/work/shop']);
    expect(qa<HTMLTextAreaElement>('.pq-folder-checks-verifier')[0].value).toBe('make check\nmake lint');
    expect(qa<HTMLTextAreaElement>('.pq-folder-checks-post-merge')[0].value).toBe('make types');
    expect(saveButton().disabled).toBe(true);
  });

  it('offers the folders of open sessions that are not listed yet, once each', async () => {
    await mount([SHOP]);
    expect(qa<HTMLOptionElement>('#pq-folder-checks-suggestions option').map((o) => o.value)).toEqual(['/work/blog']);
  });

  it('adds a folder, drops blank lines and saves it', async () => {
    await mount();
    await addFolder(' /work/blog ');
    expect(qa('.pq-folder-checks-path').map((h) => h.textContent?.trim())).toEqual(['/work/blog']);
    // A folder with no command cannot be saved.
    expect(saveButton().disabled).toBe(true);
    expect(root().querySelector('.pq-folder-checks-error')?.textContent).toContain('at least one command');

    await type('.pq-folder-checks-verifier', '  npm test \n\n npm run lint\n');
    expect(saveButton().disabled).toBe(false);
    expect(statusText()).toContain('Not saved yet');

    saveButton().click();
    await flush();

    expect(setSetting).toHaveBeenCalledWith('planQueueFolderChecklists', [
      { folder: '/work/blog', verifierGates: ['npm test', 'npm run lint'], postMergeGate: [] },
    ]);
    expect(statusText()).toContain('Saved');
    expect(saveButton().disabled).toBe(true);
  });

  it('will not add the same folder twice', async () => {
    await mount([SHOP]);
    await type('.pq-folder-checks-new', '/work/shop');
    expect(addButton().disabled).toBe(true);
    await type('.pq-folder-checks-new', '/work/base/../shop/');
    expect(addButton().disabled).toBe(true);
  });

  it('will not add a folder that is not a full path, and says why', async () => {
    await mount([]);
    for (const typed of ['docs', '../shop', 'work/shop', '\\shop']) {
      await type('.pq-folder-checks-new', typed);
      expect(addButton().disabled).toBe(true);
      expect(root().querySelector('.pq-folder-checks-new-error')?.textContent).toContain('full path');
    }
    await type('.pq-folder-checks-new', '/work/shop');
    expect(addButton().disabled).toBe(false);
    expect(root().querySelector('.pq-folder-checks-new-error')).toBeNull();
  });

  it('removes a folder only once Save is pressed', async () => {
    await mount([SHOP, { folder: '/work/blog', verifierGates: ['npm test'], postMergeGate: [] }]);
    (root().querySelector('[aria-label="Remove the checks for /work/blog"]') as HTMLButtonElement).click();
    await flush();
    expect(qa('.pq-folder-checks-path').map((h) => h.textContent?.trim())).toEqual(['/work/shop']);
    expect(setSetting).not.toHaveBeenCalled();

    saveButton().click();
    await flush();
    expect(setSetting).toHaveBeenCalledWith('planQueueFolderChecklists', [SHOP]);
  });

  it('shows the real error and keeps the edits when the save fails', async () => {
    setSetting.mockImplementation(async () => { storeError.set('Disk is full'); });
    await mount([SHOP]);
    await type('.pq-folder-checks-post-merge', 'make types\nmake docs');

    saveButton().click();
    await flush();

    expect(statusText()).toBe('Could not save: Disk is full');
    expect(qa<HTMLTextAreaElement>('.pq-folder-checks-post-merge')[0].value).toBe('make types\nmake docs');
    expect(saveButton().disabled).toBe(false);
  });

  it('puts the saved value back with Reset to saved', async () => {
    await mount([SHOP]);
    await type('.pq-folder-checks-verifier', 'something else');
    (root().querySelector('.pq-folder-checks-reset') as HTMLButtonElement).click();
    await flush();
    expect(qa<HTMLTextAreaElement>('.pq-folder-checks-verifier')[0].value).toBe('make check\nmake lint');
  });

  it('follows a change to the saved list while there are no unsaved edits, and keeps unsaved edits otherwise', async () => {
    await mount([SHOP]);
    settings.set({ planQueueFolderChecklists: [{ ...SHOP, verifierGates: ['make all'] }] });
    await flush();
    expect(qa<HTMLTextAreaElement>('.pq-folder-checks-verifier')[0].value).toBe('make all');

    await type('.pq-folder-checks-verifier', 'my edit');
    settings.set({ planQueueFolderChecklists: [{ ...SHOP, verifierGates: ['make later'] }] });
    await flush();
    expect(qa<HTMLTextAreaElement>('.pq-folder-checks-verifier')[0].value).toBe('my edit');
  });
});
