import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { PlanQueueAccountRules } from '@contracts/schemas/plan-queue';
import { CopilotAccountIpcService, type CopilotAccountView } from '../../../core/services/ipc/copilot-account-ipc.service';
import { ProviderAccountIpcService, type ProviderAccountView } from '../../../core/services/ipc/provider-account-ipc.service';
import { SettingsStore } from '../../../core/state/settings.store';
import { PlanQueueAccountRulesPanelComponent } from './plan-queue-account-rules-panel.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(resolve(specDirectory, './plan-queue-account-rules-panel.component.html'), 'utf8');
const styles = readFileSync(resolve(specDirectory, './plan-queue-account-rules-panel.component.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('plan-queue-account-rules-panel.component.html')) return Promise.resolve(template);
  if (url.endsWith('plan-queue-account-rules-panel.component.scss')) return Promise.resolve(styles);
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

function makeProfile(overrides: Partial<ProviderAccountView> & Pick<ProviderAccountView, 'id' | 'label'>): ProviderAccountView {
  return {
    provider: 'claude',
    expectedIdentity: null,
    expectedAccountKey: null,
    planLabel: null,
    priority: 0,
    enabled: true,
    automationPolicy: 'allow-routed',
    isLegacy: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const PROFILES: ProviderAccountView[] = [
  makeProfile({ id: 'cl-a', label: 'Work Claude' }),
  makeProfile({ id: 'cl-b', label: 'Home Claude' }),
  makeProfile({ id: 'cl-off', label: 'Off Claude', enabled: false }),
  makeProfile({ id: 'cx-a', label: 'Work Codex', provider: 'codex' }),
  makeProfile({ id: 'mimo-a', label: 'MiMo A', provider: 'opencode' }),
];
const COPILOTS = [{ id: 'cp-a', label: 'Personal Copilot' }] as CopilotAccountView[];

describe('PlanQueueAccountRulesPanelComponent', () => {
  let fixture: ComponentFixture<PlanQueueAccountRulesPanelComponent>;
  let settings: ReturnType<typeof signal<{ planQueueAccountRules?: PlanQueueAccountRules }>>;
  let storeError: ReturnType<typeof signal<string | null>>;
  let setSetting: Mock;
  let listProfiles: Mock;
  let listCopilot: Mock;

  async function flush(): Promise<void> {
    await new Promise((done) => setTimeout(done, 0));
    fixture.detectChanges();
    await fixture.whenStable();
  }

  async function mount(saved?: PlanQueueAccountRules): Promise<void> {
    settings.set(saved ? { planQueueAccountRules: saved } : {});
    fixture = TestBed.createComponent(PlanQueueAccountRulesPanelComponent);
    fixture.detectChanges();
    await flush();
  }

  const root = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const qa = <T extends Element>(selector: string): T[] => Array.from(root().querySelectorAll(selector)) as T[];
  const radio = (key: string, value: string): HTMLInputElement =>
    root().querySelector(`input[type="radio"][name="pqAccountRule-${key}"][value="${value}"]`) as HTMLInputElement;
  const saveButton = (): HTMLButtonElement => root().querySelector('.pq-account-rules-save') as HTMLButtonElement;
  const statusText = (): string => root().querySelector('.pq-account-rules-status')?.textContent?.trim() ?? '';

  async function pick(key: string, value: string): Promise<void> {
    radio(key, value).click();
    await flush();
  }

  beforeEach(async () => {
    settings = signal({});
    storeError = signal<string | null>(null);
    setSetting = vi.fn().mockImplementation(async (_key: string, value: PlanQueueAccountRules) => {
      settings.set({ planQueueAccountRules: value });
    });
    listProfiles = vi.fn().mockResolvedValue({ profiles: PROFILES, pools: {} });
    listCopilot = vi.fn().mockResolvedValue(COPILOTS);

    await TestBed.configureTestingModule({
      imports: [PlanQueueAccountRulesPanelComponent],
      providers: [
        { provide: SettingsStore, useValue: { settings, error: storeError, clearError: vi.fn(() => storeError.set(null)), set: setSetting } },
        { provide: ProviderAccountIpcService, useValue: { list: listProfiles } },
        { provide: CopilotAccountIpcService, useValue: { list: listCopilot } },
      ],
    }).compileComponents();
  });

  it('lists signed-in accounts by provider, all on "Use normally", and offers nothing to save', async () => {
    await mount();

    expect(qa('.pq-account-rules-group h3').map((h) => h.textContent?.trim())).toEqual(['Claude', 'Codex', 'MiMo', 'Copilot']);
    expect(qa('.pq-account-rules-label').map((l) => l.textContent?.trim())).toEqual(
      ['Work Claude', 'Home Claude', 'Work Codex', 'MiMo A', 'Personal Copilot'],
    );
    expect(radio('claude:cl-a', 'normal').checked).toBe(true);
    expect(qa('input[type="radio"]:checked')).toHaveLength(5);
    expect(saveButton().disabled).toBe(true);
  });

  it('does not offer a turned-off account', async () => {
    await mount();
    expect(radio('claude:cl-off', 'never')).toBeNull();
  });

  it('shows the saved rules and keeps a rule on an account that is turned off', async () => {
    await mount({ never: [{ provider: 'claude', accountId: 'cl-off' }], last: [{ provider: 'codex', accountId: 'cx-a' }] });

    expect(radio('codex:cx-a', 'last').checked).toBe(true);
    expect(radio('claude:cl-off', 'never').checked).toBe(true);
    expect(root().textContent).toContain('turned off');
    expect(saveButton().disabled).toBe(true);
  });

  it('saves never-use and use-last accounts as two lists', async () => {
    await mount();
    await pick('claude:cl-a', 'never');
    await pick('copilot:cp-a', 'last');
    await pick('opencode:mimo-a', 'last');
    expect(saveButton().disabled).toBe(false);

    saveButton().click();
    await flush();

    expect(setSetting).toHaveBeenCalledWith('planQueueAccountRules', {
      never: [{ provider: 'claude', accountId: 'cl-a' }],
      last: [{ provider: 'copilot', accountId: 'cp-a' }, { provider: 'opencode', accountId: 'mimo-a' }],
    });
    expect(statusText()).toContain('Saved');
    expect(saveButton().disabled).toBe(true);
  });

  it('says the rules are not saved until Save is pressed', async () => {
    await mount();
    expect(statusText()).toBe('');
    await pick('codex:cx-a', 'never');
    expect(statusText()).toBe('Not saved yet. New sessions follow the saved rules until you press Save.');

    saveButton().click();
    await flush();
    expect(statusText()).toContain('Saved');
  });

  it('moves an account between the lists and back to "Use normally"', async () => {
    await mount({ never: [{ provider: 'claude', accountId: 'cl-a' }], last: [] });
    await pick('claude:cl-a', 'last');
    saveButton().click();
    await flush();
    expect(setSetting).toHaveBeenLastCalledWith('planQueueAccountRules', { never: [], last: [{ provider: 'claude', accountId: 'cl-a' }] });

    await pick('claude:cl-a', 'normal');
    saveButton().click();
    await flush();
    expect(setSetting).toHaveBeenLastCalledWith('planQueueAccountRules', { never: [], last: [] });
  });

  it('shows a rule on a deleted account as no longer existing and drops it on the next save', async () => {
    await mount({ never: [{ provider: 'claude', accountId: 'gone' }], last: [{ provider: 'codex', accountId: 'cx-a' }] });

    expect(root().textContent).toContain('account no longer exists');
    expect(radio('claude:gone', 'never')).toBeNull();
    // Dropping it is a change, so Save is offered even though nothing was ticked.
    expect(saveButton().disabled).toBe(false);

    saveButton().click();
    await flush();

    expect(setSetting).toHaveBeenCalledWith('planQueueAccountRules', { never: [], last: [{ provider: 'codex', accountId: 'cx-a' }] });
    expect(root().textContent).not.toContain('account no longer exists');
    expect(saveButton().disabled).toBe(true);
  });

  it('shows the real error and keeps the edits when the save fails', async () => {
    setSetting.mockImplementation(async () => {
      storeError.set('Disk is full');
    });
    await mount();
    await pick('codex:cx-a', 'never');

    saveButton().click();
    await flush();

    expect(statusText()).toBe('Could not save: Disk is full');
    expect(radio('codex:cx-a', 'never').checked).toBe(true);
    expect(saveButton().disabled).toBe(false);
  });

  it('puts the saved value back with Reset to saved', async () => {
    await mount({ never: [], last: [{ provider: 'claude', accountId: 'cl-b' }] });
    await pick('claude:cl-b', 'never');
    (root().querySelector('.pq-account-rules-reset') as HTMLButtonElement).click();
    await flush();

    expect(radio('claude:cl-b', 'last').checked).toBe(true);
    expect(saveButton().disabled).toBe(true);
  });

  it('follows a change to the saved rules made elsewhere while there are no unsaved edits', async () => {
    await mount();
    settings.set({ planQueueAccountRules: { never: [{ provider: 'codex', accountId: 'cx-a' }], last: [] } });
    await flush();
    expect(radio('codex:cx-a', 'never').checked).toBe(true);
  });

  it('reports account lists that cannot be loaded and keeps the other lists', async () => {
    listCopilot.mockRejectedValue(new Error('no copilot'));
    await mount();

    expect(root().textContent).toContain('Account lists are unavailable (no copilot).');
    expect(radio('claude:cl-a', 'normal')).not.toBeNull();
    expect(radio('copilot:cp-a', 'normal')).toBeNull();
  });

  it('does not drop a rule on an account whose list could not be loaded', async () => {
    listCopilot.mockRejectedValue(new Error('no copilot'));
    await mount({ never: [{ provider: 'copilot', accountId: 'cp-a' }], last: [] });
    expect(root().textContent).not.toContain('account no longer exists');
    expect(saveButton().disabled).toBe(true);
  });
});
