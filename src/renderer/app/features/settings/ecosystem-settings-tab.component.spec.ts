import { ɵresolveComponentResources as resolveComponentResources, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { EcosystemSettingsTabComponent } from './ecosystem-settings-tab.component';
import { IpcFacadeService } from '../../core/services/ipc';
import { RecentDirectoriesIpcService } from '../../core/services/ipc/recent-directories-ipc.service';
import { SettingsStore } from '../../core/state/settings.store';
import { DEFAULT_SETTINGS, type AppSettings } from '../../../../shared/types/settings.types';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(resolve(specDirectory, './ecosystem-settings-tab.component.html'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('ecosystem-settings-tab.component.html')) {
    return Promise.resolve(template);
  }
  if (url.endsWith('.html') || url.endsWith('.scss')) {
    return Promise.resolve('');
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

const WD = '/wd';

function ecosystemPayload() {
  return {
    workingDirectory: WD,
    commands: {
      commands: [{ name: 'greet', description: 'Say hi', filePath: `${WD}/.orchestrator/commands/greet.md` }],
      candidatesByName: {},
      scanDirs: [`${WD}/.orchestrator/commands`],
    },
    agents: {
      agents: [
        {
          source: 'built-in',
          profile: { id: 'reviewer', name: 'Reviewer', description: 'Built-in reviewer', mode: 'review' },
        },
        {
          source: 'file',
          filePath: `${WD}/.orchestrator/agents/helper.md`,
          profile: { id: 'helper', name: 'Helper', description: 'Custom helper', mode: 'custom' },
        },
      ],
      scanDirs: [`${WD}/.orchestrator/agents`],
    },
    tools: {
      tools: [{ id: 'lookup', description: 'Look things up', filePath: `${WD}/.orchestrator/tools/lookup.js` }],
      candidatesById: {},
      scanDirs: [`${WD}/.orchestrator/tools`],
      errors: [],
    },
    plugins: {
      plugins: [{ filePath: `${WD}/.orchestrator/plugins/logger.js`, hookKeys: ['instance.created'] }],
      scanDirs: [`${WD}/.orchestrator/plugins`],
      errors: [],
    },
    outputStyles: {
      styles: [{ name: 'concise', label: 'Concise', description: 'Short replies', mode: 'append' as const, filePath: `${WD}/.orchestrator/output-styles/concise.md` }],
      scanDirs: [`${WD}/.orchestrator/output-styles`],
    },
    builtInOutputStyles: [{ name: 'default', label: 'Default' }],
  };
}

describe('EcosystemSettingsTabComponent', () => {
  let fixture: ComponentFixture<EcosystemSettingsTabComponent>;
  let settings: ReturnType<typeof signal<AppSettings>>;
  let api: {
    ecosystemList: ReturnType<typeof vi.fn>;
    onEcosystemChanged: ReturnType<typeof vi.fn>;
    ecosystemWatchStart: ReturnType<typeof vi.fn>;
    ecosystemWatchStop: ReturnType<typeof vi.fn>;
    readTextFile: ReturnType<typeof vi.fn>;
    writeTextFile: ReturnType<typeof vi.fn>;
    openPath: ReturnType<typeof vi.fn>;
  };
  let confirmSpy: MockInstance<Window['confirm']>;

  function render(): ComponentFixture<EcosystemSettingsTabComponent> {
    const f = TestBed.createComponent(EcosystemSettingsTabComponent);
    f.detectChanges();
    return f;
  }

  async function settle(f: ComponentFixture<EcosystemSettingsTabComponent>): Promise<void> {
    // The initial load is a constructor `effect()` reacting to a fire-and-forget
    // `loadRecentDirectories()` promise chain (working directory -> watch ->
    // reload -> ecosystemList), not an awaited lifecycle hook, so `whenStable()`
    // alone is not reliable here (see permissions-settings-tab.component.spec.ts
    // for the same caveat). Drain several microtask turns before it.
    for (let i = 0; i < 8; i += 1) {
      await Promise.resolve();
    }
    f.detectChanges();
    await f.whenStable();
    f.detectChanges();
  }

  function itemButtons(f: ComponentFixture<EcosystemSettingsTabComponent>): HTMLButtonElement[] {
    return Array.from(f.nativeElement.querySelectorAll('.list-pane .item'));
  }

  function findByText(buttons: HTMLButtonElement[], text: string): HTMLButtonElement | undefined {
    return buttons.find((b) => b.textContent?.includes(text));
  }

  function categoryTab(f: ComponentFixture<EcosystemSettingsTabComponent>, label: string): HTMLButtonElement | undefined {
    const tabs = Array.from(f.nativeElement.querySelectorAll('.section-tab')) as HTMLButtonElement[];
    return tabs.find((t) => t.textContent?.includes(label));
  }

  beforeEach(async () => {
    settings = signal<AppSettings>({ ...DEFAULT_SETTINGS, outputStyle: 'default' });
    api = {
      ecosystemList: vi.fn(async () => ({ success: true, data: ecosystemPayload() })),
      onEcosystemChanged: vi.fn(() => () => undefined),
      ecosystemWatchStart: vi.fn(async () => ({ success: true })),
      ecosystemWatchStop: vi.fn(async () => ({ success: true })),
      readTextFile: vi.fn(async (path: string) => ({
        success: true,
        data: { path, content: `content of ${path}`, truncated: false, size: 10 },
      })),
      writeTextFile: vi.fn(async () => ({ success: true, data: { ok: true } })),
      openPath: vi.fn(async () => ({ success: true })),
    };
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    await TestBed.configureTestingModule({
      imports: [EcosystemSettingsTabComponent],
      providers: [
        { provide: IpcFacadeService, useValue: { getApi: () => api } },
        {
          provide: RecentDirectoriesIpcService,
          useValue: {
            getDirectories: vi.fn(async () => [{ path: WD }, { path: '/other' }]),
            selectFolderAndTrack: vi.fn(async () => null),
          },
        },
        {
          provide: SettingsStore,
          useValue: {
            settings,
            defaultWorkingDirectory: () => WD,
            set: vi.fn(async (key: keyof AppSettings, value: unknown) => {
              settings.update((s) => ({ ...s, [key]: value }) as AppSettings);
            }),
          },
        },
      ],
    }).compileComponents();
  });

  afterEach(() => {
    confirmSpy.mockRestore();
  });

  it('renders the instruction inspector for the current working directory', async () => {
    fixture = render();
    await settle(fixture);

    const inspector = fixture.nativeElement.querySelector('app-instruction-inspector');
    expect(inspector).not.toBeNull();
  });

  it('shows only the active category and reports live counts for every category', async () => {
    fixture = render();
    await settle(fixture);

    // Default category is 'command' — only the one command item is listed.
    const items = itemButtons(fixture);
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain('/greet');

    const commandsTab = categoryTab(fixture, 'Commands');
    const agentsTab = categoryTab(fixture, 'Agents');
    expect(commandsTab?.textContent).toContain('1');
    expect(agentsTab?.textContent).toContain('2');
  });

  it('switching category shows that category’s list and hides the others', async () => {
    fixture = render();
    await settle(fixture);

    categoryTab(fixture, 'Agents')!.click();
    await settle(fixture);

    const items = itemButtons(fixture);
    expect(items).toHaveLength(2);
    expect(items.some((b) => b.textContent?.includes('Reviewer'))).toBe(true);
    expect(items.some((b) => b.textContent?.includes('Helper'))).toBe(true);
  });

  it('shows a create action for file-backed categories and hides it for output styles', async () => {
    fixture = render();
    await settle(fixture);

    expect(findByText(
      Array.from(fixture.nativeElement.querySelectorAll('.list-pane-header .mini-btn')),
      'New command',
    )).not.toBeUndefined();

    categoryTab(fixture, 'Output style')!.click();
    await settle(fixture);

    const createButtons = fixture.nativeElement.querySelectorAll('.list-pane-header .mini-btn');
    expect(createButtons).toHaveLength(0);
  });

  it('selecting a file-backed item loads its content into the editor', async () => {
    fixture = render();
    await settle(fixture);

    itemButtons(fixture)[0].click();
    await settle(fixture);

    expect(api.readTextFile).toHaveBeenCalledWith(`${WD}/.orchestrator/commands/greet.md`);
    const textarea = fixture.nativeElement.querySelector('textarea.editor') as HTMLTextAreaElement;
    expect(textarea.value).toBe(`content of ${WD}/.orchestrator/commands/greet.md`);
  });

  it('selecting a built-in item shows the read-only placeholder with no editor or save banner', async () => {
    fixture = render();
    await settle(fixture);

    categoryTab(fixture, 'Agents')!.click();
    await settle(fixture);
    findByText(itemButtons(fixture), 'Reviewer')!.click();
    await settle(fixture);

    expect(fixture.nativeElement.textContent).toContain('built into the app and cannot be edited here');
    expect(fixture.nativeElement.querySelector('textarea.editor')).toBeNull();
    expect(fixture.nativeElement.querySelector('app-save-state-banner')).toBeNull();
  });

  it('activates an output style on selection without editing a file', async () => {
    fixture = render();
    await settle(fixture);

    categoryTab(fixture, 'Output style')!.click();
    await settle(fixture);
    findByText(itemButtons(fixture), 'Concise')!.click();
    await settle(fixture);

    const store = TestBed.inject(SettingsStore);
    expect(store.set).toHaveBeenCalledWith('outputStyle', 'concise');
    expect(settings().outputStyle).toBe('concise');
    expect(api.writeTextFile).not.toHaveBeenCalled();
  });

  it('changes the working directory and reloads the catalog', async () => {
    fixture = render();
    await settle(fixture);
    api.ecosystemList.mockClear();

    const select = fixture.nativeElement.querySelector('#ecosystem-wd-select') as HTMLSelectElement;
    select.value = '/other';
    select.dispatchEvent(new Event('change'));
    await settle(fixture);

    expect(api.ecosystemList).toHaveBeenCalledWith({ workingDirectory: '/other' });
  });

  it('saves edited content successfully and clears the dirty state', async () => {
    fixture = render();
    await settle(fixture);
    itemButtons(fixture)[0].click();
    await settle(fixture);

    const textarea = fixture.nativeElement.querySelector('textarea.editor') as HTMLTextAreaElement;
    textarea.value = 'edited content';
    textarea.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Unsaved changes');

    const applyButton = Array.from(
      fixture.nativeElement.querySelectorAll('app-save-state-banner button'),
    ).find((b) => (b as HTMLButtonElement).textContent?.includes('Apply changes')) as HTMLButtonElement;
    applyButton.click();
    await settle(fixture);

    expect(api.writeTextFile).toHaveBeenCalledWith({
      path: `${WD}/.orchestrator/commands/greet.md`,
      content: 'edited content',
      createDirs: false,
    });
    expect(fixture.nativeElement.textContent).toContain('All changes saved');
  });

  it('shows an explicit error state when saving fails', async () => {
    api.writeTextFile.mockResolvedValueOnce({ success: false, error: { message: 'disk full' } });
    fixture = render();
    await settle(fixture);
    itemButtons(fixture)[0].click();
    await settle(fixture);

    const textarea = fixture.nativeElement.querySelector('textarea.editor') as HTMLTextAreaElement;
    textarea.value = 'edited content';
    textarea.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    const applyButton = Array.from(
      fixture.nativeElement.querySelectorAll('app-save-state-banner button'),
    ).find((b) => (b as HTMLButtonElement).textContent?.includes('Apply changes')) as HTMLButtonElement;
    applyButton.click();
    await settle(fixture);

    expect(fixture.nativeElement.textContent).toContain('disk full');
  });

  describe('unsaved-change protection', () => {
    async function dirtyTheOpenCommand(f: ComponentFixture<EcosystemSettingsTabComponent>): Promise<void> {
      itemButtons(f)[0].click();
      await settle(f);
      const textarea = f.nativeElement.querySelector('textarea.editor') as HTMLTextAreaElement;
      textarea.value = 'unsaved edit';
      textarea.dispatchEvent(new Event('input'));
      f.detectChanges();
    }

    it('Cancel preserves the current selection and unsaved text when switching items', async () => {
      fixture = render();
      await settle(fixture);
      await dirtyTheOpenCommand(fixture);

      confirmSpy.mockReturnValue(false);
      categoryTab(fixture, 'Agents')!.click();
      await settle(fixture);

      expect(confirmSpy).toHaveBeenCalled();
      // Still on the command category with the edit intact.
      const textarea = fixture.nativeElement.querySelector('textarea.editor') as HTMLTextAreaElement;
      expect(textarea.value).toBe('unsaved edit');
      expect(itemButtons(fixture)).toHaveLength(1);
    });

    it('Discard performs the requested category switch', async () => {
      fixture = render();
      await settle(fixture);
      await dirtyTheOpenCommand(fixture);

      confirmSpy.mockReturnValue(true);
      categoryTab(fixture, 'Agents')!.click();
      await settle(fixture);

      expect(itemButtons(fixture)).toHaveLength(2);
      expect(fixture.nativeElement.querySelector('textarea.editor')).toBeNull();
    });

    it('confirms before changing the working directory and Cancel keeps it unchanged', async () => {
      fixture = render();
      await settle(fixture);
      await dirtyTheOpenCommand(fixture);
      api.ecosystemList.mockClear();

      confirmSpy.mockReturnValue(false);
      const select = fixture.nativeElement.querySelector('#ecosystem-wd-select') as HTMLSelectElement;
      select.value = '/other';
      select.dispatchEvent(new Event('change'));
      await settle(fixture);

      expect(confirmSpy).toHaveBeenCalled();
      expect(api.ecosystemList).not.toHaveBeenCalled();
      expect(select.value).toBe(WD);
    });

    it('confirms before an explicit reload and Cancel skips it', async () => {
      fixture = render();
      await settle(fixture);
      await dirtyTheOpenCommand(fixture);
      api.ecosystemList.mockClear();

      confirmSpy.mockReturnValue(false);
      const reloadButton = Array.from(fixture.nativeElement.querySelectorAll('.toolbar .btn'))
        .find((b) => (b as HTMLButtonElement).textContent?.trim() === 'Reload') as HTMLButtonElement;
      reloadButton.click();
      await settle(fixture);

      expect(api.ecosystemList).not.toHaveBeenCalled();
    });

    it('a successful save resets the dirty state so later navigation does not prompt', async () => {
      fixture = render();
      await settle(fixture);
      await dirtyTheOpenCommand(fixture);

      const applyButton = Array.from(
        fixture.nativeElement.querySelectorAll('app-save-state-banner button'),
      ).find((b) => (b as HTMLButtonElement).textContent?.includes('Apply changes')) as HTMLButtonElement;
      applyButton.click();
      await settle(fixture);
      confirmSpy.mockClear();

      categoryTab(fixture, 'Agents')!.click();
      await settle(fixture);

      expect(confirmSpy).not.toHaveBeenCalled();
      expect(itemButtons(fixture)).toHaveLength(2);
    });
  });
});
