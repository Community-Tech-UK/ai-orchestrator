import {
  Component,
  EventEmitter,
  Input,
  Output,
  signal,
  ɵresolveComponentResources as resolveComponentResources,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { By } from '@angular/platform-browser';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Automation, AutomationExecutionProfile, AutomationRun } from '../../../../shared/types/automation.types';
import type { InstanceProvider } from '../../../../shared/types/instance.types';
import { CLAUDE_MODELS } from '../../../../shared/types/provider.types';
import type { PendingSelection } from '../models/compact-model-picker.types';
import { AutomationStore } from '../../core/state/automation.store';
import { InstanceStore } from '../../core/state/instance/instance.store';
import { AutomationsPageComponent } from './automations-page.component';
import { estimateDailyRuns } from '../../../../shared/automations/automation-cadence';

// Pass-through spy: the real estimate runs, but its calls can be counted.
vi.mock('../../../../shared/automations/automation-cadence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../shared/automations/automation-cadence')>();
  return { ...actual, estimateDailyRuns: vi.fn(actual.estimateDailyRuns) };
});
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { AppIconButtonDirective } from '../../shared/tooltip/icon-button.directive';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const componentSource = readFileSync(resolve(specDirectory, './automations-page.component.ts'), 'utf8');
const templateSource = readFileSync(resolve(specDirectory, './automations-page.component.html'), 'utf8');
const styles = readFileSync(resolve(specDirectory, './automations-page.component.css'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('automations-page.component.html')) return Promise.resolve(templateSource);
  if (url.endsWith('automations-page.component.css')) return Promise.resolve(styles);
  if (url.endsWith('.html') || url.endsWith('.css') || url.endsWith('.scss')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

@Component({
  selector: 'app-page-header',
  standalone: true,
  template: '<ng-content select="[actions]"></ng-content>',
})
class PageHeaderStubComponent {
  @Input() heading = '';
  @Input() subtitle: string | null = null;
}

@Component({
  selector: 'app-compact-model-picker',
  standalone: true,
  template: '',
})
class CompactModelPickerStubComponent {
  @Input() mode: unknown;
  @Input() providers: unknown;
  @Input() selection: unknown;
  @Output() selectionChange = new EventEmitter<unknown>();
}

@Component({
  selector: 'app-automation-webhooks-panel',
  standalone: true,
  template: '',
})
class AutomationWebhooksPanelStubComponent {
  @Input() automations: unknown;
}

@Component({
  selector: 'app-automation-authority-panel',
  standalone: true,
  template: '',
})
class AutomationAuthorityPanelStubComponent {
  @Input() authorityInput: unknown;
  @Input() templates: unknown;
  @Output() templateApplied = new EventEmitter<unknown>();
}

@Component({ selector: 'app-automation-execution-profile-selector', standalone: true, template: '' })
class AutomationExecutionProfileSelectorStubComponent {
  @Input() value: AutomationExecutionProfile = 'standard';
  @Input() resolvedProvider: InstanceProvider | undefined;
  @Output() valueChange = new EventEmitter<AutomationExecutionProfile>();
}

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'automation-1',
    name: 'Daily check',
    description: 'Keep the repo healthy',
    enabled: true,
    active: true,
    workspaceId: '/repo',
    schedule: { type: 'cron', expression: '0 9 * * *', timezone: 'UTC' },
    trigger: { kind: 'schedule' },
    missedRunPolicy: 'notify',
    concurrencyPolicy: 'skip',
    destination: { kind: 'newInstance' },
    action: {
      prompt: 'Check the repo',
      workingDirectory: '/repo',
    },
    nextFireAt: 1_900_000_000_000,
    lastFiredAt: null,
    lastRunId: null,
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_000,
    unreadRunCount: 0,
    consecutiveFailures: 0,
    lastFailureAt: null,
    lastFailureReason: null,
    ...overrides,
  };
}

describe('AutomationsPageComponent row actions', () => {
  let fixture: ComponentFixture<AutomationsPageComponent>;
  let automations: ReturnType<typeof signal<Automation[]>>;
  let store: {
    automations: ReturnType<typeof signal<Automation[]>>;
    runs: ReturnType<typeof signal<unknown[]>>;
    templates: ReturnType<typeof signal<unknown[]>>;
    preflight: ReturnType<typeof signal<unknown | null>>;
    loading: ReturnType<typeof signal<boolean>>;
    preflightLoading: ReturnType<typeof signal<boolean>>;
    error: ReturnType<typeof signal<string | null>>;
    loadTemplates: ReturnType<typeof vi.fn>;
    clearPreflight: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    runNow: ReturnType<typeof vi.fn>;
    cancelPending: ReturnType<typeof vi.fn>;
    markSeen: ReturnType<typeof vi.fn>;
    runPreflight: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    automations = signal([makeAutomation()]);
    store = {
      automations,
      runs: signal([]),
      templates: signal([]),
      preflight: signal(null),
      loading: signal(false),
      preflightLoading: signal(false),
      error: signal(null),
      loadTemplates: vi.fn().mockResolvedValue([]),
      clearPreflight: vi.fn(),
      refresh: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(true),
      delete: vi.fn().mockResolvedValue(undefined),
      runNow: vi.fn().mockResolvedValue(undefined),
      cancelPending: vi.fn().mockResolvedValue(undefined),
      markSeen: vi.fn().mockResolvedValue(undefined),
      runPreflight: vi.fn().mockResolvedValue({
        okToSave: true,
        warnings: [],
        blockers: [],
      }),
      create: vi.fn().mockResolvedValue(true),
    };

    TestBed.overrideComponent(AutomationsPageComponent, {
      set: {
        template: templateSource,
        templateUrl: undefined,
        styles: [styles],
        styleUrl: undefined,
        styleUrls: [],
        imports: [
          CommonModule,
          FormsModule,
          CompactModelPickerStubComponent,
          PageHeaderStubComponent,
          AutomationWebhooksPanelStubComponent,
          AutomationAuthorityPanelStubComponent,
          AutomationExecutionProfileSelectorStubComponent,
          AioTooltipDirective,
          AppIconButtonDirective,
        ],
      },
    });
    await TestBed.configureTestingModule({
      imports: [AutomationsPageComponent],
      providers: [
        { provide: AutomationStore, useValue: store },
        { provide: InstanceStore, useValue: { selectedInstance: signal(null) } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(AutomationsPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  afterEach(() => vi.useRealTimers());

  it('shows the Hidden explanation over its label and on checkbox focus', () => {
    const component = fixture.componentInstance;
    component.select(automations()[0]);
    component.editSelected();
    fixture.detectChanges();
    vi.useFakeTimers();
    const input = fixture.nativeElement.querySelector('input[name="hidden"]') as HTMLInputElement;
    const label = input.labels![0];
    label.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(500);
    fixture.detectChanges();
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("Keeps this automation's sessions out of the project rail.");
    label.dispatchEvent(new MouseEvent('mouseleave'));
    const matches = input.matches.bind(input);
    vi.spyOn(input, 'matches').mockImplementation(selector => selector === ':focus-visible' || matches(selector));
    input.dispatchEvent(new FocusEvent('focus'));
    fixture.detectChanges();
    expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1);
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Runs still appear here with their full output');
  });

  it('spaces the primary create action from its dropdown trigger', () => {
    const createControls = fixture.nativeElement.querySelector('.create') as HTMLElement;

    expect(getComputedStyle(createControls).gap).toBe('var(--spacing-xs)');
  });

  it('pauses an active automation from the row action', async () => {
    const pauseButton = findButton('Pause Daily check');

    pauseButton.click();
    await fixture.whenStable();

    expect(store.update).toHaveBeenCalledWith('automation-1', { enabled: false });
  });

  it('resumes a paused automation from the row action', async () => {
    automations.set([makeAutomation({ enabled: false, nextFireAt: null })]);
    fixture.detectChanges();

    const resumeButton = findButton('Resume Daily check');
    resumeButton.click();
    await fixture.whenStable();

    expect(store.update).toHaveBeenCalledWith('automation-1', { enabled: true });
  });

  it('dims paused rows via the row--paused class', () => {
    expect(fixture.nativeElement.querySelector('.row.row--paused')).toBeNull();

    automations.set([makeAutomation({ enabled: false, nextFireAt: null })]);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.row.row--paused')).not.toBeNull();
  });

  it('shows checked-run outcomes in plain words with the raw details and counts', () => {
    const automation = makeAutomation({ action: {
      prompt: 'Check the repo', workingDirectory: '/repo',
      preCheck: { command: 'check-news', onError: 'stop' },
    } });
    automations.set([automation]);
    const run = (id: string, outcome: AutomationRun['outcome'], outputSummary: string): AutomationRun => ({
      id, automationId: automation.id, status: 'succeeded', trigger: 'scheduled',
      scheduledAt: 1_900_000_000_000, startedAt: null, finishedAt: null,
      instanceId: outcome === 'quiet' ? 'actually-attached-instance' : null, loopRunId: null, error: null, outputSummary,
      outputFullRef: null, idempotencyKey: null, triggerSource: null,
      deliveryMode: 'notify', seenAt: null, createdAt: 1_900_000_000_000,
      updatedAt: 1_900_000_000_000, configSnapshot: automation,
      outcome, attempt: 1, maxAttempts: 1,
    });
    store.runs.set([run('one', 'no-change', 'same hash'), run('two', 'quiet', 'no update')]);
    fixture.componentInstance.select(automation);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelectorAll('.run-row--quiet')).toHaveLength(2);
    expect(root.textContent).toContain('Nothing changed');
    expect(root.textContent).toContain('Quiet');
    expect(root.textContent).toContain('Details same hash');
    expect(root.textContent).toContain('checked 2 times, started the AI 1 time');
  });

  it('keeps the schedule cadence and optional check visible in the form', () => {
    fixture.componentInstance.startCreate();
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('Starts the AI about 1 time a day');
    expect(root.textContent).toContain('Check before starting the AI (optional)');
    fixture.componentInstance.onPreCheckCommandChange('check-news');
    fixture.detectChanges();
    expect(root.textContent).toContain('If the check fails');
    expect(root.textContent).toContain('Run now ignores the check');
    const profile = fixture.debugElement.query(By.directive(AutomationExecutionProfileSelectorStubComponent))
      .componentInstance as AutomationExecutionProfileSelectorStubComponent;
    expect(profile.value).toBe('standard');
    expect(profile.resolvedProvider).toBe('claude');
    profile.valueChange.emit('contained');
    expect(fixture.componentInstance.form().executionProfile).toBe('contained');
  });

  it('works out the schedule line once per schedule change, not on every render or unrelated edit', () => {
    const component = fixture.componentInstance;
    const root = fixture.nativeElement as HTMLElement;
    component.startCreate();
    fixture.detectChanges();
    const estimate = vi.mocked(estimateDailyRuns);
    estimate.mockClear();

    fixture.detectChanges();
    fixture.detectChanges();
    component.patchForm({ prompt: 'a different prompt' });
    component.patchForm({ name: 'Another name' });
    fixture.detectChanges();
    expect(estimate).not.toHaveBeenCalled();

    component.patchForm({ cronExpression: '*/5 * * * *' });
    fixture.detectChanges();
    fixture.detectChanges();
    expect(estimate).toHaveBeenCalledTimes(1);
    expect(root.textContent).toContain('Starts the AI about 288 times a day');
  });

  it('gives a check example that prints state, so its output changes when the state does', () => {
    fixture.componentInstance.startCreate();
    fixture.detectChanges();
    const input = fixture.nativeElement.querySelector('input[name="preCheckCommand"]') as HTMLInputElement;
    const placeholder = input.getAttribute('placeholder') ?? '';
    expect(placeholder).toContain('ls -t ~/Maildir/new | head -1');
    // An exit-status test such as `test -s file` prints nothing, so it never changes the output.
    expect(placeholder).not.toMatch(/\btest -[a-z]\b/);
  });

  it('keeps an explicit Opus choice when a new check command is edited', () => {
    const component = fixture.componentInstance;
    component.startCreate();
    component.onModelPicked({ provider: 'claude', model: CLAUDE_MODELS.OPUS, reasoning: null });
    component.onPreCheckCommandChange('check-news');
    expect(component.form().model).toBe(CLAUDE_MODELS.OPUS);
    expect(component.checkModelSuggestionVisible()).toBe(false);
  });

  it('requires row-level confirmation before deleting an automation', async () => {
    findButton('Delete Daily check').click();
    fixture.detectChanges();

    expect(store.delete).not.toHaveBeenCalled();

    findButton('Confirm delete Daily check').click();
    await fixture.whenStable();

    expect(store.delete).toHaveBeenCalledWith('automation-1');
  });

  it('saves a selected model even when preflight returns advisory warnings', async () => {
    store.runPreflight.mockResolvedValue({
      okToSave: true,
      warnings: ['This unattended automation may require network access.'],
      blockers: [],
    });
    const component = fixture.componentInstance;
    const automation = makeAutomation({
      action: {
        prompt: 'Check the repo',
        workingDirectory: '/repo',
        provider: 'claude',
        model: 'claude-fable-5-1',
      },
    });
    automations.set([automation]);
    component.select(automation);
    component.editSelected();
    component.onModelPicked({
      provider: 'claude',
      model: 'opus[1m]',
      reasoning: null,
    });

    await component.save();

    expect(store.update).toHaveBeenCalledWith(
      'automation-1',
      expect.objectContaining({
        action: expect.objectContaining({
          provider: 'claude',
          model: 'opus[1m]',
        }),
      }),
    );
  });

  it('closes the edit window before preflight finishes', async () => {
    let resolvePreflight: ((report: {
      okToSave: boolean;
      warnings: string[];
      blockers: string[];
    }) => void) | undefined;
    store.runPreflight.mockImplementation(() => new Promise((resolve) => {
      resolvePreflight = resolve;
    }));
    const component = fixture.componentInstance;
    const automation = makeAutomation();
    component.select(automation);
    component.editSelected();

    const savePromise = component.save();

    expect(component.overlay()).toBeNull();

    resolvePreflight?.({ okToSave: true, warnings: [], blockers: [] });
    await savePromise;
    expect(store.update).toHaveBeenCalledOnce();
  });

  it('still blocks saving when preflight reports a real blocker', async () => {
    store.runPreflight.mockResolvedValue({
      okToSave: false,
      warnings: [],
      blockers: ['Working directory does not exist.'],
    });
    const component = fixture.componentInstance;
    const automation = makeAutomation();
    component.select(automation);
    component.editSelected();

    await component.save();

    expect(store.update).not.toHaveBeenCalled();
    expect(component.overlay()).toBe('form');
  });

  it('restores the edit window when persistence reports a failure', async () => {
    store.update.mockResolvedValue(false);
    const component = fixture.componentInstance;
    const automation = makeAutomation();
    component.select(automation);
    component.editSelected();

    await component.save();

    expect(component.overlay()).toBe('form');
  });

  it('restores the edit window and propagates an unexpected save error', async () => {
    store.runPreflight.mockRejectedValue(new Error('Preflight unavailable'));
    const component = fixture.componentInstance;
    const automation = makeAutomation();
    component.select(automation);
    component.editSelected();

    await expect(component.save()).rejects.toThrow('Preflight unavailable');

    expect(component.overlay()).toBe('form');
  });

  it('uses the full session provider list and adopts provider changes from the model picker', () => {
    const component = fixture.componentInstance;
    const automation = makeAutomation({
      action: {
        prompt: 'Check the repo',
        workingDirectory: '/repo',
        provider: 'claude',
        model: 'opus[1m]',
      },
    });
    automations.set([automation]);
    component.select(automation);
    component.editSelected();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-compact-model-picker')).not.toBeNull();
    expect(component.modelPickerProviders()).toEqual([
      'claude',
      'codex',
      'gemini',
      'antigravity',
      'copilot',
      'cursor',
      'grok',
      'opencode',
    ]);
    expect(fixture.nativeElement.querySelector('select[name="provider"]')).toBeNull();

    component.onModelPicked({
      provider: 'codex',
      model: 'gpt-5.6-sol',
      reasoning: 'high',
    } satisfies PendingSelection);

    expect(component.form().provider).toBe('codex');
    expect(component.form().model).toBe('gpt-5.6-sol');
    expect(component.form().reasoningEffort).toBe('high');
  });

  it('pins the model shown by default instead of saving an empty model override', () => {
    const component = fixture.componentInstance;
    component.startCreate();

    expect(component.form().provider).toBe('claude');
    expect(component.form().model).toBe(CLAUDE_MODELS.OPUS);
  });

  it.each([undefined, 'auto', 'claude'] as const)(
    'defaults a generated check to Sonnet and low effort for provider %s',
    (provider) => {
      const component = fixture.componentInstance;
      component.startChat();
      component.chatWorkingDir.set('/repo');
      component.chatDraft.set({
        name: 'Daily check',
        scheduleType: 'cron',
        cronExpression: '0 9 * * *',
        prompt: 'Check the repo',
        provider,
      });

      component.useDraft();

      expect(component.form().provider).toBe('claude');
      expect(component.form().model).toBe(CLAUDE_MODELS.SONNET);
      expect(component.form().reasoningEffort).toBe('low');
    },
  );

  it('leaves an explicitly non-Claude generated draft unpinned', () => {
    const component = fixture.componentInstance;
    component.startChat();
    component.chatWorkingDir.set('/repo');
    component.chatDraft.set({
      name: 'Daily check',
      scheduleType: 'cron',
      cronExpression: '0 9 * * *',
      prompt: 'Check the repo',
      provider: 'codex',
    });

    component.useDraft();

    expect(component.form().provider).toBe('codex');
    expect(component.form().model).toBe('');
  });

  it('shows a concrete-provider + empty-model automation as Auto (not Pinned), never a phantom pinned model', () => {
    const component = fixture.componentInstance;
    const automation = makeAutomation({
      action: { prompt: 'Check the repo', workingDirectory: '/repo', provider: 'claude' },
    });
    automations.set([automation]);
    component.select(automation);
    component.editSelected();
    fixture.detectChanges();

    // The split is on whether a MODEL is pinned, not the provider. A concrete
    // provider with no model is Auto (honest preview), not Pinned-with-phantom.
    expect(component.isModelPinned()).toBe(false);
    expect(fixture.nativeElement.querySelector('.model-choice .hint')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('app-compact-model-picker')).toBeNull();
  });

  it('preserves provider and leaves the model unpinned when saving an untouched claude+empty automation', async () => {
    const component = fixture.componentInstance;
    const automation = makeAutomation({
      action: { prompt: 'Check the repo', workingDirectory: '/repo', provider: 'claude' },
    });
    automations.set([automation]);
    component.select(automation);
    component.editSelected();

    await component.save();

    expect(store.update).toHaveBeenCalledTimes(1);
    const action = store.update.mock.calls[0][1].action as { provider?: string; model?: string };
    expect(action.provider).toBe('claude');
    expect(action.model).toBeUndefined();
  });

  it('greys semantic quiet runs and gives a dismissible model suggestion after ten quiet runs', async () => {
    const a = { ...makeAutomation(), nextFireAt: Date.now() + 40 * 60_000, monitorState: { quietRuns: 10, modelHintDismissed: false, unchangedChecks: 3, intervalMultiplier: 4 } };
    automations.set([a]);
    store.runs.set([{ id: 'run-quiet', automationId: a.id, status: 'succeeded', trigger: 'manual', scheduledAt: 1000,
      result: { outcome: 'no_change', notify: false } }]);
    fixture.componentInstance.select(a); fixture.detectChanges();
    const row = fixture.nativeElement.querySelector('.run-row--quiet') as HTMLElement;
    expect(row).not.toBeNull();
    expect(getComputedStyle(row).color).toBe('var(--text-muted)');
    expect(fixture.nativeElement.textContent).toContain('Nothing needed action');
    expect(fixture.nativeElement.textContent).toContain('Next check in 40 min (no change for 3 checks)');
    expect(fixture.nativeElement.textContent).toContain('Sonnet at low effort');
    const dismiss = [...fixture.nativeElement.querySelectorAll('button')].find((button: unknown) => (button as HTMLButtonElement).textContent?.trim() === 'Dismiss suggestion') as HTMLButtonElement;
    expect(dismiss).toBeDefined(); dismiss.click(); await fixture.whenStable(); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('Sonnet at low effort');
    expect(store.update).toHaveBeenCalledWith(a.id, { dismissModelHint: true });
  });
  it('shows the actual pending retry on an interrupted run and removes the promise when it clears', () => {
    const automation = automations()[0];
    const run = { id: 'interrupted', automationId: automation.id, status: 'failed', trigger: 'scheduled',
      scheduledAt: 1000, error: 'Interrupted by an app restart', nextRetryAt: 1_900_000_015_000 };
    store.runs.set([run]); fixture.componentInstance.select(automation); fixture.detectChanges();
    const row = fixture.nativeElement.querySelector('.run-row') as HTMLElement;
    expect(row.textContent).toContain('Interrupted by an app restart');
    expect(row.querySelector('.run-retry')?.textContent).toContain('Will run again');
    expect(getComputedStyle(row.querySelector('.run-retry')!).gridColumn).toBe('1 / -1');
    expect(row.querySelector('.run-retry')?.textContent).toContain(fixture.componentInstance.formatTime(run.nextRetryAt));
    store.runs.set([{ ...run, nextRetryAt: null }]); fixture.detectChanges();
    expect(row.querySelector('.run-retry')).toBeNull();
    store.runs.set([{ ...run, nextRetryAt: undefined }]); fixture.detectChanges();
    expect(row.querySelector('.run-retry')).toBeNull();
  });
  it('saves run limits and opting in to fewer unchanged checks from the human form', async () => {
    const component = fixture.componentInstance;
    component.select(automations()[0]); component.editSelected();
    component.patchForm({ maxRunMinutes: 120, maxProcessedTokens: 50_000_000, slowWhenUnchanged: true });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('input[name="maxRunMinutes"]')).not.toBeNull();
    await component.save();
    expect(store.update).toHaveBeenCalledWith('automation-1', expect.objectContaining({ action: expect.objectContaining({ maxRunMinutes: 120, maxProcessedTokens: 50_000_000, slowWhenUnchanged: true }) }));
  });

  it('refuses to save run limits outside the allowed range', async () => {
    const component = fixture.componentInstance;
    component.select(automations()[0]); component.editSelected();
    for (const limits of [{ maxRunMinutes: 0 }, { maxRunMinutes: 1.5 }, { maxProcessedTokens: 0 }, { maxProcessedTokens: 2_000_000_000 }]) {
      component.patchForm({ maxRunMinutes: 120, maxProcessedTokens: 50_000_000, ...limits });
      expect(component.canSave()).toBe(false);
      await component.save();
    }
    expect(store.update).not.toHaveBeenCalled();
  });

  it('defaults new manual checks to Sonnet low and preserves a deliberate human model choice', () => {
    const component = fixture.componentInstance;
    component.startCreate(); component.patchForm({ name: 'Server monitor', prompt: 'Check server health' });
    expect(component.form()).toMatchObject({ model: 'sonnet', reasoningEffort: 'low' });
    component.onModelPicked({ provider: 'claude', model: 'opus', reasoning: 'ultra' });
    component.patchForm({ prompt: 'Check the server again' });
    expect(component.form()).toMatchObject({ model: 'opus', reasoningEffort: 'ultra' });
  });

  function findButton(label: string): HTMLButtonElement {
    const button = fixture.nativeElement.querySelector(
      `button[aria-label="${label}"]`,
    ) as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    return button!;
  }
});

describe('AutomationsPageComponent route header', () => {
  it('uses the shared PageHeaderComponent for the page title while shell owns Back navigation', () => {
    expect(componentSource).toContain('PageHeaderComponent');
    expect(templateSource).toContain('<app-page-header');
    expect(templateSource).toContain('heading="Automations"');
    expect(templateSource).not.toContain('backRoute="/"');
    expect(templateSource).not.toContain('<header class="toolbar">');
  });
});
