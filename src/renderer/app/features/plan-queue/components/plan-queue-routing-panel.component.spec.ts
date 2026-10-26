import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG, PlanQueueRunDtoSchema } from '@contracts/schemas/plan-queue';
import type { PlanQueueItemState, PlanQueueRouting, PlanQueueRunDto } from '@contracts/schemas/plan-queue';
import { CopilotAccountIpcService, type CopilotAccountView } from '../../../core/services/ipc/copilot-account-ipc.service';
import { ProviderAccountIpcService, type ProviderAccountView } from '../../../core/services/ipc/provider-account-ipc.service';
import { PlanQueueStore } from '../../../core/state/plan-queue.store';
import { SettingsStore } from '../../../core/state/settings.store';
import { PlanQueueRoutingPanelComponent } from './plan-queue-routing-panel.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(resolve(specDirectory, './plan-queue-routing-panel.component.html'), 'utf8');
const styles = readFileSync(resolve(specDirectory, './plan-queue-routing-panel.component.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('plan-queue-routing-panel.component.html')) return Promise.resolve(template);
  if (url.endsWith('plan-queue-routing-panel.component.scss')) return Promise.resolve(styles);
  if (url.endsWith('.html') || url.endsWith('.scss')) return Promise.resolve('');
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

function makeCopilot(overrides: Partial<CopilotAccountView> & Pick<CopilotAccountView, 'id' | 'label'>): CopilotAccountView {
  return {
    expectedLogin: null,
    host: 'github.com',
    accountKind: 'personal',
    scopePolicy: 'any',
    automationPolicy: 'allow-routed',
    isDefault: false,
    isLegacy: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as CopilotAccountView;
}

const PROFILES: ProviderAccountView[] = [
  makeProfile({ id: 'acc-ok', label: 'Work Claude' }),
  makeProfile({ id: 'acc-manual', label: 'Manual Claude', automationPolicy: 'manual-only' }),
  makeProfile({ id: 'acc-never', label: 'Never Claude', automationPolicy: 'disabled' }),
  makeProfile({ id: 'acc-off', label: 'Off Claude', enabled: false }),
  makeProfile({ id: 'cx-ok', label: 'Work Codex', provider: 'codex' }),
  makeProfile({ id: 'mimo-a', label: 'MiMo A', provider: 'opencode' }),
];

const COPILOTS: CopilotAccountView[] = [
  makeCopilot({ id: 'cp-ok', label: 'Personal Copilot' }),
  makeCopilot({ id: 'cp-manual', label: 'Work Copilot', automationPolicy: 'manual-only' }),
];

describe('PlanQueueRoutingPanelComponent', () => {
  let fixture: ComponentFixture<PlanQueueRoutingPanelComponent>;
  let settings: ReturnType<typeof signal<{ planQueueRouting: PlanQueueRouting; providersExcludedFromAutomation: string[] }>>;
  let storeError: ReturnType<typeof signal<string | null>>;
  let setSetting: Mock;
  let listProfiles: Mock;
  let listCopilot: Mock;
  let control: Mock;

  async function flush(): Promise<void> {
    await new Promise((done) => setTimeout(done, 0));
    fixture.detectChanges();
    await fixture.whenStable();
  }

  async function mount(saved: PlanQueueRouting = { workers: [], verifiers: [] }, excluded: string[] = []): Promise<void> {
    settings.set({ planQueueRouting: saved, providersExcludedFromAutomation: excluded });
    fixture = TestBed.createComponent(PlanQueueRoutingPanelComponent);
    fixture.detectChanges();
    await flush();
  }

  const root = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const q = <T extends Element>(selector: string, scope: ParentNode = root()): T => scope.querySelector(selector) as T;
  const qa = <T extends Element>(selector: string, scope: ParentNode = root()): T[] =>
    Array.from(scope.querySelectorAll(selector)) as T[];

  async function click(element: Element): Promise<void> {
    (element as HTMLElement).click();
    await flush();
  }

  async function choose(select: HTMLSelectElement, value: string): Promise<void> {
    select.value = value;
    select.dispatchEvent(new Event('change'));
    await flush();
  }

  async function type(input: HTMLInputElement, value: string): Promise<void> {
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await flush();
  }

  async function tick(checkbox: HTMLInputElement, checked: boolean): Promise<void> {
    checkbox.checked = checked;
    checkbox.dispatchEvent(new Event('change'));
    await flush();
  }

  const radio = (name: string, value: string): HTMLInputElement =>
    q<HTMLInputElement>(`input[type="radio"][name="${name}"][value="${value}"]`);
  const saveButton = (): HTMLButtonElement => q<HTMLButtonElement>('.pq-routing-save');
  const checkerRows = (): HTMLElement[] => qa<HTMLElement>('.pq-routing-checker');
  const providerSelect = (scope: ParentNode): HTMLSelectElement => qa<HTMLSelectElement>('select', scope)[0];
  const checkerProviders = (): string[] => checkerRows().map((row) => providerSelect(row).value);
  const workerRows = (): HTMLElement[] => qa<HTMLElement>('.pq-routing-worker');
  const workerProviders = (): string[] => workerRows().map((row) => providerSelect(row).value);

  beforeEach(async () => {
    settings = signal({ planQueueRouting: { workers: [], verifiers: [] } as PlanQueueRouting, providersExcludedFromAutomation: [] as string[] });
    control = vi.fn().mockResolvedValue({ success: true, data: null });
    storeError = signal<string | null>(null);
    setSetting = vi.fn().mockImplementation(async (_key: string, value: PlanQueueRouting) => {
      settings.update((current) => ({ ...current, planQueueRouting: value }));
    });
    listProfiles = vi.fn().mockResolvedValue({ profiles: PROFILES, pools: {} });
    listCopilot = vi.fn().mockResolvedValue(COPILOTS);

    await TestBed.configureTestingModule({
      imports: [PlanQueueRoutingPanelComponent],
      providers: [
        { provide: PlanQueueStore, useValue: { control: (...args: unknown[]) => control(...args) } },
        {
          provide: SettingsStore,
          useValue: { settings, error: storeError, clearError: vi.fn(() => storeError.set(null)), set: setSetting },
        },
        { provide: ProviderAccountIpcService, useValue: { list: listProfiles } },
        { provide: CopilotAccountIpcService, useValue: { list: listCopilot } },
      ],
    }).compileComponents();
  });

  it('opens on the saved default: same-as-session workers, automatic checkers, nothing to save', async () => {
    await mount();

    expect(radio('pqRoutingWorkerMode', 'same').checked).toBe(true);
    expect(radio('pqRoutingCheckerMode', 'auto').checked).toBe(true);
    expect(q('.pq-routing-workers select')).toBeNull();
    expect(checkerRows()).toHaveLength(0);
    expect(saveButton().disabled).toBe(true);
    expect(q<HTMLButtonElement>('.pq-routing-reset').disabled).toBe(true);
    // The page section around the saved editor carries its purpose line; a run's editor has its own.
    expect(q('.pq-routing-purpose')).toBeNull();
  });

  it('loads the saved workers and checkers into the form', async () => {
    await mount({
      workers: [{ provider: 'claude', model: 'opus', accountProfileIds: ['acc-ok'] }],
      verifiers: [{ provider: 'codex', model: 'big' }, { provider: 'copilot', copilotProfileId: 'cp-ok' }],
    });

    expect(radio('pqRoutingWorkerMode', 'list').checked).toBe(true);
    const workers = q('.pq-routing-workers');
    expect(providerSelect(workers).value).toBe('claude');
    expect(q<HTMLInputElement>('input[type="text"]', workers).value).toBe('opus');
    const boxes = qa<HTMLInputElement>('input[type="checkbox"]', workers);
    expect(boxes.map((box) => box.checked)).toEqual([true, false, false, false]);

    expect(radio('pqRoutingCheckerMode', 'manual').checked).toBe(true);
    expect(checkerProviders()).toEqual(['codex', 'copilot']);
    expect(q<HTMLInputElement>('input[type="text"]', checkerRows()[0]).value).toBe('big');
    expect(qa<HTMLSelectElement>('select', checkerRows()[1])[1].value).toBe('cp-ok');
    expect(saveButton().disabled).toBe(true);
  });

  it('shows a checker provider from the never-auto-pick list as disabled with the reason', async () => {
    await mount(undefined, ['codex']);
    await click(radio('pqRoutingCheckerMode', 'manual'));

    const options = qa<HTMLOptionElement>('option', providerSelect(checkerRows()[0]));
    const codex = options.find((option) => option.value === 'codex');
    expect(codex?.disabled).toBe(true);
    expect(codex?.textContent).toContain('on your never-auto-pick list');
    expect(options.find((option) => option.value === 'claude')?.disabled).toBe(false);
    // gemini is not a checker provider at all.
    expect(options.some((option) => option.value === 'gemini')).toBe(false);
  });

  it('blocks the Gemini CLI when antigravity, the CLI it runs as, is on the never-auto-pick list', async () => {
    await mount(undefined, ['antigravity']);
    await click(radio('pqRoutingWorkerMode', 'list'));
    const gemini = qa<HTMLOptionElement>('option', q<HTMLSelectElement>('.pq-routing-workers select')).find((option) => option.value === 'gemini');
    expect(gemini?.disabled).toBe(true);
  });

  it('applies the never-auto-pick list to workers too, starting the worker list on an allowed provider', async () => {
    await mount(undefined, ['claude']);
    await click(radio('pqRoutingWorkerMode', 'list'));

    const select = q<HTMLSelectElement>('.pq-routing-workers select');
    const claude = qa<HTMLOptionElement>('option', select).find((option) => option.value === 'claude');
    expect(claude?.disabled).toBe(true);
    expect(select.value).not.toBe('claude');
    expect(saveButton().disabled).toBe(false);
  });

  it('shows one error for several vanished accounts and explains what inheriting a session means', async () => {
    await mount();
    expect(q('.pq-routing-workers .pq-routing-note')?.textContent).toContain('stays on that one account');

    await mount({ workers: [{ provider: 'claude', accountProfileIds: ['gone-1', 'gone-2'] }], verifiers: [] });
    const errors = qa('.pq-routing-workers .pq-routing-error').map((error) => error.textContent?.trim());
    expect(errors.filter((text) => text?.includes('no longer exists'))).toHaveLength(1);
    expect(saveButton().disabled).toBe(true);
  });

  it('refuses OpenCode accounts without a MiMo Token Plan model', async () => {
    await mount({ workers: [{ provider: 'opencode', accountProfileIds: ['mimo-a'] }], verifiers: [] });
    expect(q('.pq-routing-workers .pq-routing-error')?.textContent).toContain('MiMo Token Plan');
    expect(saveButton().disabled).toBe(true);

    await type(q<HTMLInputElement>('.pq-routing-workers input[type="text"]'), 'xiaomi-token-plan/mimo-v2.6-pro');
    expect(q('.pq-routing-workers .pq-routing-error')).toBeNull();
  });

  it('refuses to save a saved checker that is now on the never-auto-pick list', async () => {
    await mount({ workers: [], verifiers: [{ provider: 'codex' }] }, ['codex']);
    await choose(q<HTMLSelectElement>('.pq-routing-checker select'), 'codex');
    await type(q<HTMLInputElement>('.pq-routing-checker input[type="text"]'), 'x');

    expect(q('.pq-routing-checker .pq-routing-error')?.textContent).toContain('never-auto-pick');
    expect(saveButton().disabled).toBe(true);
  });

  it('does not let manual-only, never-for-automatic or turned-off accounts be picked', async () => {
    await mount({ workers: [{ provider: 'claude' }], verifiers: [] });

    const rows = qa<HTMLElement>('.pq-routing-workers .pq-routing-account');
    const byLabel = (label: string): HTMLElement => rows.find((row) => row.textContent?.includes(label)) as HTMLElement;
    const box = (label: string): HTMLInputElement => q<HTMLInputElement>('input', byLabel(label));

    expect(box('Work Claude').disabled).toBe(false);
    expect(box('Manual Claude').disabled).toBe(true);
    expect(byLabel('Manual Claude').textContent).toContain('manual only');
    expect(box('Never Claude').disabled).toBe(true);
    expect(byLabel('Never Claude').textContent).toContain('never for automatic work');
    expect(box('Off Claude').disabled).toBe(true);
    expect(byLabel('Off Claude').textContent).toContain('turned off');
    // Only this provider's accounts are offered.
    expect(rows.some((row) => row.textContent?.includes('Work Codex'))).toBe(false);
  });

  it('flags a saved account that is no longer allowed and blocks saving until it is unticked', async () => {
    await mount({ workers: [{ provider: 'claude', accountProfileIds: ['acc-manual'] }], verifiers: [] });

    expect(q('.pq-routing-workers .pq-routing-error')?.textContent).toContain('manual only');
    expect(saveButton().disabled).toBe(true);

    const box = qa<HTMLInputElement>('.pq-routing-workers .pq-routing-account input').find((b) => b.checked) as HTMLInputElement;
    expect(box.disabled).toBe(false);
    await tick(box, false);
    expect(q('.pq-routing-workers .pq-routing-error')).toBeNull();
  });

  it('offers only automatic-friendly Copilot accounts, with the account rules as the default', async () => {
    await mount({ workers: [{ provider: 'copilot' }], verifiers: [] });

    const select = qa<HTMLSelectElement>('.pq-routing-workers select')[1];
    const options = qa<HTMLOptionElement>('option', select);
    expect(options[0].textContent).toContain('Let the Copilot account rules decide');
    expect(select.value).toBe('');
    expect(options.find((o) => o.value === 'cp-ok')?.disabled).toBe(false);
    const manual = options.find((o) => o.value === 'cp-manual');
    expect(manual?.disabled).toBe(true);
    expect(manual?.textContent).toContain('manual only');
    expect(q('.pq-routing-workers input[type="checkbox"]')).toBeNull();
  });

  it('saves a cleaned worker choice with empty optional fields stripped', async () => {
    await mount();
    await click(radio('pqRoutingWorkerMode', 'list'));
    expect(saveButton().disabled).toBe(false);

    const workers = q('.pq-routing-workers');
    await choose(providerSelect(workers), 'claude');
    await type(q<HTMLInputElement>('input[type="text"]', workers), '  opus  ');
    const boxes = qa<HTMLInputElement>('input[type="checkbox"]', workers);
    await tick(boxes[0], true);
    await click(saveButton());

    expect(setSetting).toHaveBeenCalledTimes(1);
    expect(setSetting).toHaveBeenCalledWith('planQueueRouting', {
      workers: [{ provider: 'claude', model: 'opus', accountProfileIds: ['acc-ok'] }],
      verifiers: [],
    });
    expect(q('.pq-routing-status-ok')?.textContent).toContain('Saved');
    expect(saveButton().disabled).toBe(true);
  });

  it('saves a bare provider with no model, accounts or Copilot account keys', async () => {
    await mount();
    await click(radio('pqRoutingWorkerMode', 'list'));
    await choose(providerSelect(q('.pq-routing-workers')), 'ollama');
    await click(saveButton());

    expect(setSetting).toHaveBeenCalledWith('planQueueRouting', { workers: [{ provider: 'ollama' }], verifiers: [] });
  });

  it('drops accounts and the Copilot account when the provider changes', async () => {
    await mount({ workers: [{ provider: 'claude', accountProfileIds: ['acc-ok'] }], verifiers: [] });
    await choose(providerSelect(q('.pq-routing-workers')), 'copilot');
    await choose(qa<HTMLSelectElement>('.pq-routing-workers select')[1], 'cp-ok');
    await choose(providerSelect(q('.pq-routing-workers')), 'codex');
    await click(saveButton());

    expect(setSetting).toHaveBeenCalledWith('planQueueRouting', { workers: [{ provider: 'codex' }], verifiers: [] });
  });

  it('saves a Copilot checker with its chosen account', async () => {
    await mount();
    await click(radio('pqRoutingCheckerMode', 'manual'));
    await choose(providerSelect(checkerRows()[0]), 'copilot');
    await choose(qa<HTMLSelectElement>('select', checkerRows()[0])[1], 'cp-ok');
    await click(saveButton());

    expect(setSetting).toHaveBeenCalledWith('planQueueRouting', {
      workers: [],
      verifiers: [{ provider: 'copilot', copilotProfileId: 'cp-ok' }],
    });
  });

  it('adds, removes and reorders checker rows, and saves them in that order', async () => {
    await mount();
    await click(radio('pqRoutingCheckerMode', 'manual'));
    expect(checkerRows()).toHaveLength(1);

    await click(q('.pq-routing-add'));
    await click(q('.pq-routing-add'));
    expect(checkerRows()).toHaveLength(3);
    await choose(providerSelect(checkerRows()[0]), 'claude');
    await choose(providerSelect(checkerRows()[1]), 'codex');
    await choose(providerSelect(checkerRows()[2]), 'grok');
    expect(checkerProviders()).toEqual(['claude', 'codex', 'grok']);

    expect(q<HTMLButtonElement>('.pq-routing-move-up', checkerRows()[0]).disabled).toBe(true);
    expect(q<HTMLButtonElement>('.pq-routing-move-down', checkerRows()[2]).disabled).toBe(true);

    await click(q('.pq-routing-move-up', checkerRows()[2]));
    expect(checkerProviders()).toEqual(['claude', 'grok', 'codex']);
    await click(q('.pq-routing-move-down', checkerRows()[0]));
    expect(checkerProviders()).toEqual(['grok', 'claude', 'codex']);

    await click(q('.pq-routing-remove', checkerRows()[1]));
    expect(checkerProviders()).toEqual(['grok', 'codex']);

    await click(saveButton());
    expect(setSetting).toHaveBeenCalledWith('planQueueRouting', {
      workers: [],
      verifiers: [{ provider: 'grok' }, { provider: 'codex' }],
    });
  });

  it('adds, reorders and removes worker choices, and saves them in that order', async () => {
    await mount();
    await click(radio('pqRoutingWorkerMode', 'list'));
    expect(workerRows()).toHaveLength(1);
    expect(q('.pq-routing-workers .pq-routing-note')?.textContent).toContain('first choice that has usage left');

    await click(q('.pq-routing-workers .pq-routing-add'));
    await click(q('.pq-routing-workers .pq-routing-add'));
    await choose(providerSelect(workerRows()[0]), 'claude');
    await choose(providerSelect(workerRows()[1]), 'codex');
    await type(q<HTMLInputElement>('input[type="text"]', workerRows()[1]), 'gpt-6.1-sol');
    await choose(providerSelect(workerRows()[2]), 'opencode');
    expect(workerProviders()).toEqual(['claude', 'codex', 'opencode']);
    expect(q('.pq-routing-rank-number', workerRows()[1])?.textContent?.trim()).toBe('Choice 2');
    expect(q('.pq-routing-move-up', workerRows()[1])?.getAttribute('aria-label')).toBe('Move worker choice 2 up');

    await click(q('.pq-routing-move-up', workerRows()[1]));
    expect(workerProviders()).toEqual(['codex', 'claude', 'opencode']);
    await click(q('.pq-routing-remove', workerRows()[2]));
    await click(saveButton());

    expect(setSetting).toHaveBeenCalledWith('planQueueRouting', {
      workers: [{ provider: 'codex', model: 'gpt-6.1-sol' }, { provider: 'claude' }],
      verifiers: [],
    });
  });

  it('will not save an empty worker list, and stops adding worker choices at ten', async () => {
    await mount({ workers: [{ provider: 'claude' }], verifiers: [] });
    await click(q('.pq-routing-workers .pq-routing-remove'));
    expect(workerRows()).toHaveLength(0);
    expect(root().textContent).toContain('Add at least one worker choice, or choose "Same as the session that starts the run".');
    expect(saveButton().disabled).toBe(true);

    for (let i = 0; i < 12; i += 1) {
      const add = q<HTMLButtonElement>('.pq-routing-workers .pq-routing-add');
      if (!add.disabled) await click(add);
    }
    expect(workerRows()).toHaveLength(10);
    expect(q('.pq-routing-workers')?.textContent).toContain('Up to 10 choices.');
  });

  it('needs a checker that can judge every worker choice, naming the one left without', async () => {
    await mount({ workers: [{ provider: 'codex' }, { provider: 'claude' }], verifiers: [{ provider: 'claude' }] });
    expect(q('.pq-routing-checkers .pq-routing-error')?.textContent).toContain('Every checker uses claude, like worker choice 2');
    expect(saveButton().disabled).toBe(true);

    await click(q('.pq-routing-checkers .pq-routing-add'));
    await choose(providerSelect(checkerRows()[1]), 'codex');
    expect(q('.pq-routing-checkers .pq-routing-error')).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });

  it('names the worker choice in a row error', async () => {
    await mount({ workers: [{ provider: 'codex' }, { provider: 'claude', accountProfileIds: ['acc-manual'] }], verifiers: [] });
    expect(q('.pq-routing-error', workerRows()[1])?.textContent).toContain('The worker choice 2 account "Manual Claude" is manual only');
    expect(q('.pq-routing-error', workerRows()[0])).toBeNull();
  });

  it('reads a saved value still in the old single-worker shape', async () => {
    await mount({ worker: { provider: 'codex', model: 'gpt-6.1-sol' }, verifiers: [] } as unknown as PlanQueueRouting);
    expect(radio('pqRoutingWorkerMode', 'list').checked).toBe(true);
    expect(workerProviders()).toEqual(['codex']);
    expect(saveButton().disabled).toBe(true);
  });

  it('keeps the rows, and focus in them, when an update brings the same saved value', async () => {
    await mount({ workers: [{ provider: 'claude' }, { provider: 'codex' }], verifiers: [] });
    const select = providerSelect(workerRows()[1]);
    select.focus();
    settings.update((current) => ({ ...current, planQueueRouting: { workers: [{ provider: 'claude' }, { provider: 'codex' }], verifiers: [] } }));
    await flush();
    expect(providerSelect(workerRows()[1])).toBe(select);
    expect(document.activeElement).toBe(select);
  });

  it('names each row\'s controls as a group', async () => {
    await mount({ workers: [{ provider: 'claude' }, { provider: 'codex' }], verifiers: [{ provider: 'cursor' }] });
    expect(qa('.pq-routing-route[role="group"]').map((group) => group.getAttribute('aria-label')))
      .toEqual(['Worker choice 1', 'Worker choice 2', 'Checker 1']);
  });

  it('stops adding checkers at ten', async () => {
    await mount();
    await click(radio('pqRoutingCheckerMode', 'manual'));
    for (let i = 0; i < 12; i += 1) {
      if (!q<HTMLButtonElement>('.pq-routing-add').disabled) await click(q('.pq-routing-add'));
    }

    expect(checkerRows()).toHaveLength(10);
    expect(q<HTMLButtonElement>('.pq-routing-add').disabled).toBe(true);
  });

  it('will not save the manual checker list with no rows', async () => {
    await mount({ workers: [], verifiers: [{ provider: 'claude' }] });
    await click(q('.pq-routing-remove'));

    expect(checkerRows()).toHaveLength(0);
    expect(root().textContent).toContain('Add at least one checker');
    expect(saveButton().disabled).toBe(true);
  });

  it('saves automatic checkers as an empty list when the manual list is switched off', async () => {
    await mount({ workers: [], verifiers: [{ provider: 'claude' }] });
    await click(radio('pqRoutingCheckerMode', 'auto'));
    await click(saveButton());

    expect(setSetting).toHaveBeenCalledWith('planQueueRouting', { workers: [], verifiers: [] });
  });

  it('resets the form back to the saved value', async () => {
    await mount({ workers: [{ provider: 'codex', model: 'big' }], verifiers: [] });
    await click(radio('pqRoutingWorkerMode', 'same'));
    await click(radio('pqRoutingCheckerMode', 'manual'));
    expect(saveButton().disabled).toBe(false);

    await click(q('.pq-routing-reset'));

    expect(radio('pqRoutingWorkerMode', 'list').checked).toBe(true);
    expect(q<HTMLInputElement>('.pq-routing-workers input[type="text"]').value).toBe('big');
    expect(radio('pqRoutingCheckerMode', 'auto').checked).toBe(true);
    expect(saveButton().disabled).toBe(true);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it('shows an error line when the settings store reports a failed save', async () => {
    setSetting.mockImplementation(async () => {
      storeError.set('Failed to save setting');
    });
    await mount();
    await click(radio('pqRoutingWorkerMode', 'list'));
    await click(saveButton());

    expect(q('.pq-routing-status-error')?.textContent).toContain('Failed to save setting');
    expect(q('.pq-routing-status-ok')).toBeNull();
  });

  it('keeps James\'s edits on screen when a save fails and the store reloads the old value', async () => {
    const original: PlanQueueRouting = { workers: [], verifiers: [] };
    setSetting.mockImplementation(async (_key: string, value: PlanQueueRouting) => {
      // SettingsStore.set: optimistic write, failed save, then reload of the stored value.
      settings.update((current) => ({ ...current, planQueueRouting: value }));
      await new Promise((done) => setTimeout(done, 0));
      storeError.set('Rejected by the main process');
      settings.update((current) => ({ ...current, planQueueRouting: original }));
    });
    await mount(original);
    await click(radio('pqRoutingWorkerMode', 'list'));
    await click(saveButton());

    expect(q('.pq-routing-status-error')?.textContent).toContain('Rejected by the main process');
    expect(radio('pqRoutingWorkerMode', 'list').checked).toBe(true);
    expect(saveButton().disabled).toBe(false);
  });

  it('refuses checkers that all share the workers\' provider without a different-maker model', async () => {
    await mount({ workers: [{ provider: 'claude' }], verifiers: [{ provider: 'claude' }] });
    expect(q('.pq-routing-checkers .pq-routing-error')?.textContent).toContain('Every checker uses claude');
    expect(saveButton().disabled).toBe(true);

    // Claude serves one maker's models, so even a named model cannot differ from the workers'.
    await type(q<HTMLInputElement>('.pq-routing-checker input[type="text"]'), 'claude-sonnet-5');
    expect(q('.pq-routing-checkers .pq-routing-error')?.textContent).toContain('Every checker uses claude');

    await choose(q<HTMLSelectElement>('.pq-routing-checker select'), 'codex');
    expect(q('.pq-routing-checkers .pq-routing-error')).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });

  it('accepts a different-maker checker on Antigravity, which serves several makers\' models', async () => {
    await mount({ workers: [{ provider: 'antigravity' }], verifiers: [{ provider: 'antigravity', model: 'Claude Opus 4.6 (Thinking)' }] });
    expect(q('.pq-routing-checkers .pq-routing-error')).toBeNull();
  });

  it('accepts a different-maker Copilot checker for unnamed Copilot workers, but asks OpenCode to name the workers\' model', async () => {
    await mount({ workers: [{ provider: 'copilot' }], verifiers: [{ provider: 'copilot', model: 'claude-opus-5' }] });
    expect(q('.pq-routing-checkers .pq-routing-error')).toBeNull();

    await mount({ workers: [{ provider: 'opencode' }], verifiers: [{ provider: 'opencode', model: 'anthropic/claude-opus-5' }] });
    expect(q('.pq-routing-checkers .pq-routing-error')?.textContent).toContain('on OpenCode, also name the workers');

    await type(q<HTMLInputElement>('.pq-routing-workers input[type="text"]'), 'openai/gpt-5.5');
    expect(q('.pq-routing-checkers .pq-routing-error')).toBeNull();
  });

  it('keeps working when the account lists cannot be loaded (not running in Electron)', async () => {
    listProfiles.mockRejectedValue(new Error('Not in Electron'));
    listCopilot.mockRejectedValue(new Error('Not in Electron'));
    await mount({ workers: [{ provider: 'claude', accountProfileIds: ['acc-ok'] }], verifiers: [] });

    expect(root().textContent).toContain('Account lists are unavailable');
    expect(root().textContent).toContain('Accounts could not be loaded.');
    // The saved choice is kept, and cannot be checked against lists that are not there.
    expect(q('.pq-routing-workers .pq-routing-error')).toBeNull();
    await type(q<HTMLInputElement>('.pq-routing-workers input[type="text"]'), 'opus');
    await click(saveButton());

    expect(setSetting).toHaveBeenCalledWith('planQueueRouting', {
      workers: [{ provider: 'claude', model: 'opus', accountProfileIds: ['acc-ok'] }],
      verifiers: [],
    });
  });
  async function mountRun(status: PlanQueueRunDto['status'] = 'running', states: readonly PlanQueueItemState[] = ['working'], relaxSettings = false): Promise<void> {
    fixture = TestBed.createComponent(PlanQueueRoutingPanelComponent);
    fixture.componentRef.setInput('mode', 'run');
    const run: PlanQueueRunDto = {
      id: 'run-edit', status,
      parentInstanceId: 'parent-edit', kind: 'plans', workspaceCwd: '/repo',
      workerProvider: 'claude', relaxedSettings: [], startedAt: 1, endedAt: null,
      config: { ...DEFAULT_PLAN_QUEUE_CONFIG.plans, relaxSettings, routing: { workers: [{ provider: 'claude', model: 'opus' }], verifiers: [] } },
      items: states.map((state, index) => ({
        id: `item-${index}`, runId: 'run-edit', documentPath: `/repo/${index}_plan.md`, state,
        round: 0, erroredRounds: 0, branchName: null, worktreePath: null,
        baseCommit: null, checkpointCommit: null, landedCommit: null,
        workerInstanceId: null, verifierInstanceId: null, question: null, answer: null,
        parkReason: null, detail: null, verdict: null, createdAt: 1, updatedAt: 1,
      })),
    };
    fixture.componentRef.setInput('run', run);
    fixture.detectChanges();
    await flush();
  }

  it('edits run routing with the shared validation and keeps edits after a refusal', async () => {
    await mountRun();
    expect(q<HTMLInputElement>('.pq-routing-workers input[type="text"]').value).toBe('opus');
    expect(root().textContent).toContain('Same as the session that started the run');
    await choose(q<HTMLSelectElement>('.pq-routing-workers select'), 'codex');
    control.mockResolvedValueOnce({ success: false, error: { message: 'Codex CLI is not installed' } });
    await click(saveButton());
    expect(control).toHaveBeenCalledWith({
      action: 'set-routing', runId: 'run-edit', routing: { workers: [{ provider: 'codex', model: 'opus' }], verifiers: [] },
    });
    expect(root().textContent).toContain('Codex CLI is not installed');
    expect(q<HTMLSelectElement>('.pq-routing-workers select').value).toBe('codex');
    expect(saveButton().disabled).toBe(false);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it.each([true, false])('honours run relaxSettings=%s for excluded worker and checker choices', async (relaxSettings) => {
    settings.update(current => ({ ...current, providersExcludedFromAutomation: ['codex', 'grok'] }));
    await mountRun('paused', [], relaxSettings);
    const workerSelect = q<HTMLSelectElement>('.pq-routing-workers select');
    expect(qa<HTMLOptionElement>('option', workerSelect).find(option => option.value === 'codex')?.disabled).toBe(!relaxSettings);
    await choose(workerSelect, 'codex');
    fixture.componentInstance.setCheckerMode('manual');
    await flush();
    const checkerSelect = q<HTMLSelectElement>('.pq-routing-checker select');
    expect(qa<HTMLOptionElement>('option', checkerSelect).find(option => option.value === 'grok')?.disabled).toBe(!relaxSettings);
    await choose(checkerSelect, 'grok');
    expect(saveButton().disabled).toBe(!relaxSettings);
    await click(saveButton());
    if (relaxSettings) {
      expect(control).toHaveBeenCalledWith({
        action: 'set-routing', runId: 'run-edit',
        routing: { workers: [{ provider: 'codex', model: 'opus' }], verifiers: [{ provider: 'grok' }] },
      });
    } else {
      expect(control).not.toHaveBeenCalled();
    }
    expect(setSetting).not.toHaveBeenCalled();
  });

  it('keeps a legacy run worker model when only its checker choice changes', async () => {
    await mountRun('paused', []);
    const legacy = PlanQueueRunDtoSchema.parse({
      ...fixture.componentInstance.run(),
      workerModel: 'opus-legacy',
      config: { ...DEFAULT_PLAN_QUEUE_CONFIG.plans },
    });
    fixture.componentRef.setInput('run', legacy);
    await flush();
    expect(q<HTMLInputElement>('.pq-routing-workers input[type="text"]').value).toBe('opus-legacy');
    fixture.componentInstance.setCheckerMode('manual');
    await flush();
    await choose(q<HTMLSelectElement>('.pq-routing-checker select'), 'codex');
    await click(saveButton());
    expect(control).toHaveBeenCalledWith({
      action: 'set-routing', runId: 'run-edit',
      routing: { workers: [{ provider: 'claude', model: 'opus-legacy' }], verifiers: [{ provider: 'codex' }] },
    });
  });

  it('moves current documents only when explicitly ticked on a running run, once per tick', async () => {
    await mountRun();
    const move = q<HTMLInputElement>('.pq-routing-move-progress input');
    expect(move.checked).toBe(false);
    await tick(move, true);
    await choose(q<HTMLSelectElement>('.pq-routing-workers select'), 'codex');
    await click(saveButton());
    expect(control.mock.calls[0][0].moveInProgress).toBe(true);
    // A later save in the same editor must not restart in-progress documents again.
    expect(q<HTMLInputElement>('.pq-routing-move-progress input').checked).toBe(false);
    await choose(q<HTMLSelectElement>('.pq-routing-workers select'), 'cursor');
    await click(saveButton());
    expect(control.mock.calls[1][0].moveInProgress).toBeUndefined();
  });

  it('shows what the run really stored after a save, e.g. "same as the session" resolved to that session\'s choice', async () => {
    await mountRun('paused', []);
    await click(radio('pqRoutingWorkerMode-run-edit', 'same'));
    await click(saveButton());
    expect(control).toHaveBeenCalledWith({ action: 'set-routing', runId: 'run-edit', routing: { workers: [], verifiers: [] } });
    // The main process stores the starting session's route and sends the run back.
    const stored = fixture.componentInstance.run()!;
    fixture.componentRef.setInput('run', { ...stored, config: { ...stored.config, routing: { workers: [{ provider: 'claude', model: 'parent-model' }], verifiers: [] } } });
    await flush();
    expect(radio('pqRoutingWorkerMode-run-edit', 'list').checked).toBe(true);
    expect(q<HTMLInputElement>('.pq-routing-workers input[type="text"]').value).toBe('parent-model');
    expect(saveButton().disabled).toBe(true);
  });

  it.each([['paused', ['queued']], ['running', []]] as const)(
    'does not offer moving documents for %s without work in progress', async (status, items) => {
      await mountRun(status, items);
      expect(q('.pq-routing-move-progress')).toBeNull();
    },
  );

});
