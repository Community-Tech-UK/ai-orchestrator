import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { InstanceStore } from '../../../core/state/instance.store';
import { SettingsStore } from '../../../core/state/settings.store';
import { PlanQueueFolderListPanelComponent } from './plan-queue-folder-list-panel.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(resolve(specDirectory, './plan-queue-folder-list-panel.component.html'), 'utf8');
const styles = readFileSync(resolve(specDirectory, './plan-queue-folder-list-panel.component.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('plan-queue-folder-list-panel.component.html')) return Promise.resolve(template);
  if (url.endsWith('plan-queue-folder-list-panel.component.scss')) return Promise.resolve(styles);
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

describe('PlanQueueFolderListPanelComponent', () => {
  let fixture: ComponentFixture<PlanQueueFolderListPanelComponent>;
  let settings: ReturnType<typeof signal<{ planQueueFolders?: string[] }>>;
  let storeError: ReturnType<typeof signal<string | null>>;
  let setSetting: Mock;

  async function flush(): Promise<void> {
    await new Promise((done) => setTimeout(done, 0));
    fixture.detectChanges();
    await fixture.whenStable();
  }

  async function mount(saved?: string[]): Promise<void> {
    settings.set(saved ? { planQueueFolders: saved } : {});
    fixture = TestBed.createComponent(PlanQueueFolderListPanelComponent);
    fixture.detectChanges();
    await flush();
  }

  const root = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const qa = <T extends Element>(selector: string): T[] => Array.from(root().querySelectorAll(selector)) as T[];
  const saveButton = (): HTMLButtonElement => root().querySelector('.pq-folder-list-save') as HTMLButtonElement;
  const addButton = (): HTMLButtonElement => root().querySelector('.pq-folder-list-add-button') as HTMLButtonElement;
  const statusText = (): string => root().querySelector('.pq-folder-list-status')?.textContent?.trim() ?? '';
  const listed = (): (string | undefined)[] => qa('.pq-folder-list-path').map((span) => span.textContent?.trim());

  async function type(value: string): Promise<void> {
    const element = qa<HTMLInputElement>('.pq-folder-list-new')[0];
    element.value = value;
    element.dispatchEvent(new Event('input'));
    await flush();
  }

  beforeEach(async () => {
    settings = signal({});
    storeError = signal<string | null>(null);
    setSetting = vi.fn().mockImplementation(async (_key: string, value: string[]) => { settings.set({ planQueueFolders: value }); });

    await TestBed.configureTestingModule({
      imports: [PlanQueueFolderListPanelComponent],
      providers: [
        { provide: SettingsStore, useValue: { settings, error: storeError, clearError: vi.fn(() => storeError.set(null)), set: setSetting } },
        { provide: InstanceStore, useValue: { rootInstances: signal([
          { id: 'a', workingDirectory: '/work/shop' }, { id: 'b', workingDirectory: '/work/blog' }, { id: 'c', workingDirectory: '/work/blog' },
        ]) } },
      ],
    }).compileComponents();
  });

  it('says that no folder is listed and offers nothing to save', async () => {
    await mount();
    expect(root().textContent).toContain('a session can start runs only in its own folder');
    expect(listed()).toEqual([]);
    expect(saveButton().disabled).toBe(true);
  });

  it('shows the saved folders and offers the folders of open sessions that are not listed, once each', async () => {
    await mount(['/work/shop']);
    expect(listed()).toEqual(['/work/shop']);
    expect(qa<HTMLOptionElement>('#pq-folder-list-suggestions option').map((o) => o.value)).toEqual(['/work/blog']);
  });

  it('adds a folder and saves it under the setting only James can change', async () => {
    await mount();
    await type(' /work/blog ');
    addButton().click();
    await flush();
    expect(listed()).toEqual(['/work/blog']);
    expect(statusText()).toContain('Not saved yet');

    saveButton().click();
    await flush();
    expect(setSetting).toHaveBeenCalledWith('planQueueFolders', ['/work/blog']);
    expect(statusText()).toContain('Saved');
    expect(saveButton().disabled).toBe(true);
  });

  it('will not add a folder twice, in any spelling', async () => {
    await mount(['/work/shop']);
    await type('/work/shop');
    expect(addButton().disabled).toBe(true);
    await type('/work/base/../shop/');
    expect(addButton().disabled).toBe(true);
  });

  it('will not add a folder that is not a full path, and says why', async () => {
    await mount([]);
    for (const typed of ['docs', '../shop', 'work/shop', '\\shop']) {
      await type(typed);
      expect(addButton().disabled).toBe(true);
      expect(root().querySelector('.pq-folder-list-new-error')?.textContent).toContain('full path');
    }
    await type('/work/shop');
    expect(addButton().disabled).toBe(false);
    expect(root().querySelector('.pq-folder-list-new-error')).toBeNull();
  });

  it('removes a folder only once Save is pressed', async () => {
    await mount(['/work/shop', '/work/blog']);
    (root().querySelector('[aria-label="Remove /work/blog from the list"]') as HTMLButtonElement).click();
    await flush();
    expect(listed()).toEqual(['/work/shop']);
    expect(setSetting).not.toHaveBeenCalled();

    saveButton().click();
    await flush();
    expect(setSetting).toHaveBeenCalledWith('planQueueFolders', ['/work/shop']);
  });

  it('shows the real error and keeps the edits when the save fails', async () => {
    setSetting.mockImplementation(async () => { storeError.set('Disk is full'); });
    await mount(['/work/shop']);
    await type('/work/blog');
    addButton().click();
    await flush();

    saveButton().click();
    await flush();

    expect(statusText()).toBe('Could not save: Disk is full');
    expect(listed()).toEqual(['/work/shop', '/work/blog']);
    expect(saveButton().disabled).toBe(false);
  });

  it('puts the saved list back with Reset to saved', async () => {
    await mount(['/work/shop']);
    (root().querySelector('[aria-label="Remove /work/shop from the list"]') as HTMLButtonElement).click();
    await flush();
    (root().querySelector('.pq-folder-list-reset') as HTMLButtonElement).click();
    await flush();
    expect(listed()).toEqual(['/work/shop']);
  });

  it('follows a change to the saved list while there are no unsaved edits, and keeps unsaved edits otherwise', async () => {
    await mount(['/work/shop']);
    settings.set({ planQueueFolders: ['/work/shop', '/work/blog'] });
    await flush();
    // The list is shown in path order, whatever order it was saved in.
    expect(listed()).toEqual(['/work/blog', '/work/shop']);

    (root().querySelector('[aria-label="Remove /work/blog from the list"]') as HTMLButtonElement).click();
    await flush();
    settings.set({ planQueueFolders: ['/work/shop', '/work/blog', '/work/docs'] });
    await flush();
    expect(listed()).toEqual(['/work/shop']);
  });
});
