import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
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
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Automation, AutomationAction } from '../../../../shared/types/automation.types';
import { AutomationStore } from '../../core/state/automation.store';
import { InstanceStore } from '../../core/state/instance/instance.store';
import { AutomationsPageComponent } from './automations-page.component';
import { emptyForm, formToPreCheck } from './automation-form-model';

const specDirectory = dirname(fileURLToPath(import.meta.url));
// The REAL template, so typing in the check field and pressing Save is the path under test.
const templateSource = readFileSync(resolve(specDirectory, './automations-page.component.html'), 'utf8');
const styles = readFileSync(resolve(specDirectory, './automations-page.component.css'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('automations-page.component.html')) return Promise.resolve(templateSource);
  if (url.endsWith('automations-page.component.css')) return Promise.resolve(styles);
  if (url.endsWith('.html') || url.endsWith('.css') || url.endsWith('.scss')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

@Component({ selector: 'app-page-header', standalone: true, template: '<ng-content select="[actions]"></ng-content>' })
class PageHeaderStubComponent {
  @Input() title = '';
  @Input() subtitle: string | null = null;
}
@Component({ selector: 'app-compact-model-picker', standalone: true, template: '' })
class CompactModelPickerStubComponent {
  @Input() mode: unknown;
  @Input() providers: unknown;
  @Input() selection: unknown;
  @Output() selectionChange = new EventEmitter<unknown>();
}
@Component({ selector: 'app-automation-webhooks-panel', standalone: true, template: '' })
class AutomationWebhooksPanelStubComponent { @Input() automations: unknown; }
@Component({ selector: 'app-automation-authority-panel', standalone: true, template: '' })
class AutomationAuthorityPanelStubComponent {
  @Input() authorityInput: unknown;
  @Input() templates: unknown;
  @Output() templateApplied = new EventEmitter<unknown>();
}
@Component({ selector: 'app-automation-execution-profile-selector', standalone: true, template: '' })
class AutomationExecutionProfileSelectorStubComponent {
  @Input() value: unknown;
  @Input() resolvedProvider: unknown;
  @Output() valueChange = new EventEmitter<unknown>();
}

function makeAutomation(action: Partial<AutomationAction> = {}): Automation {
  return {
    id: 'automation-1', name: 'Daily check', description: 'Keep the repo healthy', enabled: true, active: true,
    workspaceId: '/repo', schedule: { type: 'cron', expression: '0 9 * * *', timezone: 'UTC' },
    trigger: { kind: 'schedule' }, missedRunPolicy: 'notify', concurrencyPolicy: 'skip',
    destination: { kind: 'newInstance' },
    action: { prompt: 'Check the repo', workingDirectory: '/repo', ...action },
    nextFireAt: 1_900_000_000_000, lastFiredAt: null, lastRunId: null,
    createdAt: 1_800_000_000_000, updatedAt: 1_800_000_000_000,
    unreadRunCount: 0, consecutiveFailures: 0, lastFailureAt: null, lastFailureReason: null,
  };
}

describe('formToPreCheck shape (R6N4)', () => {
  const form = (patch: Partial<ReturnType<typeof emptyForm>>) => ({ ...emptyForm(), ...patch });

  it('is undefined without a command, including a blank one', () => {
    expect(formToPreCheck(form({ preCheckCommand: '' }))).toBeUndefined();
    expect(formToPreCheck(form({ preCheckCommand: '  \n ' }))).toBeUndefined();
  });

  it('carries the trimmed command and the error rule, defaulting to run-anyway', () => {
    expect(formToPreCheck(form({ preCheckCommand: '  ls -t ~/Maildir/new | head -1 \n' })))
      .toEqual({ command: 'ls -t ~/Maildir/new | head -1', onError: 'run-anyway' });
    expect(formToPreCheck(form({ preCheckCommand: 'check-news', preCheckOnError: 'stop' })))
      .toEqual({ command: 'check-news', onError: 'stop' });
  });

  it('omits a leftover check for webhook jobs, which always start the AI', () => {
    expect(formToPreCheck(form({ triggerKind: 'webhook', preCheckCommand: 'check-news' }))).toBeUndefined();
  });
});

describe('AutomationsPageComponent saves the check in the action (R6N4)', () => {
  let fixture: ComponentFixture<AutomationsPageComponent>;
  const store = {
    automations: signal<Automation[]>([]),
    runs: signal<unknown[]>([]),
    templates: signal<unknown[]>([]),
    preflight: signal<unknown | null>(null),
    loading: signal(false),
    preflightLoading: signal(false),
    error: signal<string | null>(null),
    loadTemplates: vi.fn(),
    clearPreflight: vi.fn(),
    refresh: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    runNow: vi.fn(),
    cancelPending: vi.fn(),
    markSeen: vi.fn(),
    runPreflight: vi.fn(),
    create: vi.fn(),
  };

  beforeEach(async () => {
    store.automations.set([]);
    store.runs.set([]);
    store.loadTemplates.mockReset().mockResolvedValue([]);
    store.refresh.mockReset().mockResolvedValue(undefined);
    store.markSeen.mockReset().mockResolvedValue(undefined);
    store.runPreflight.mockReset().mockResolvedValue({ okToSave: true, warnings: [], blockers: [] });
    store.create.mockReset().mockResolvedValue(true);
    store.update.mockReset().mockResolvedValue(true);

    TestBed.overrideComponent(AutomationsPageComponent, {
      set: {
        template: templateSource, templateUrl: undefined, styles: [styles], styleUrl: undefined, styleUrls: [],
        imports: [
          CommonModule, FormsModule, AioTooltipDirective, CompactModelPickerStubComponent, PageHeaderStubComponent,
          AutomationWebhooksPanelStubComponent, AutomationAuthorityPanelStubComponent,
          AutomationExecutionProfileSelectorStubComponent,
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

  const root = () => fixture.nativeElement as HTMLElement;

  async function type(selector: string, value: string): Promise<void> {
    const el = root().querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    expect(el, `${selector} is on the form`).toBeTruthy();
    el.value = value;
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input'));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  async function pressSave(): Promise<void> {
    const save = Array.from(root().querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Save')!;
    expect(save.disabled, 'Save is enabled once the required fields are filled').toBe(false);
    save.click();
    await vi.waitFor(() => expect(store.create.mock.calls.length + store.update.mock.calls.length).toBe(1));
  }

  async function fillRequiredFields(): Promise<void> {
    fixture.componentInstance.startCreate();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    await type('input[name="name"]', 'Mail watcher');
    await type('input[name="workingDirectory"]', '/repo');
    await type('textarea[name="prompt"]', 'Summarise the new mail');
  }

  it('sends the typed check, trimmed, with the chosen error rule', async () => {
    await fillRequiredFields();
    await type('input[name="preCheckCommand"]', '  ls -t ~/Maildir/new | head -1  ');
    await type('select[name="preCheckOnError"]', 'stop');

    await pressSave();

    expect(store.create).toHaveBeenCalledTimes(1);
    const action = store.create.mock.calls[0][0].action as AutomationAction;
    expect(action.preCheck).toEqual({ command: 'ls -t ~/Maildir/new | head -1', onError: 'stop' });
    expect(action.prompt).toBe('Summarise the new mail');
  });

  it('defaults the error rule to run-anyway when only a command is typed', async () => {
    await fillRequiredFields();
    await type('input[name="preCheckCommand"]', 'check-news');

    await pressSave();

    expect((store.create.mock.calls[0][0].action as AutomationAction).preCheck)
      .toEqual({ command: 'check-news', onError: 'run-anyway' });
  });

  it('sends no check at all when the field is left empty', async () => {
    await fillRequiredFields();

    await pressSave();

    expect((store.create.mock.calls[0][0].action as AutomationAction).preCheck).toBeUndefined();
  });

  it('keeps a worker-pinned check visible but blocks save until the check is removed', async () => {
    const automation = makeAutomation({ forceNodeId: '11111111-2222-4333-8444-555555555555',
      preCheck: { command: 'check-news' } });
    store.automations.set([automation]);
    fixture.componentInstance.select(automation);
    fixture.componentInstance.editSelected();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(root().querySelector('input[name="preCheckCommand"]')).toBeTruthy();
    expect(root().textContent).toContain('Checks run on this computer only');
    const save = Array.from(root().querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Save')!;
    // Save stays focusable and says why (aria-disabled plus its reason) rather than using the disabled attribute.
    expect(save.getAttribute('aria-disabled')).toBe('true');
    await fixture.componentInstance.save();
    expect(store.runPreflight).not.toHaveBeenCalled();
    expect(store.update).not.toHaveBeenCalled();

    await type('input[name="preCheckCommand"]', '');
    await pressSave();
    expect((store.update.mock.calls[0][1].action as AutomationAction).forceNodeId).toBe(automation.action.forceNodeId);
    expect((store.update.mock.calls[0][1].action as AutomationAction).preCheck).toBeUndefined();
  });

  it('removes the check and its automatic model suggestion when switching to a webhook', async () => {
    await fillRequiredFields();
    await type('input[name="preCheckCommand"]', 'check-news');
    fixture.componentInstance.webhookRoutes.set([{
      id: 'route-1', path: '/test', enabled: true, secretHash: '', allowUnsignedDev: true,
      maxBodyBytes: 1_024, allowedAutomationIds: [], allowedEvents: [], createdAt: 1, updatedAt: 1,
    }]);
    await type('select[name="triggerKind"]', 'webhook');
    await type('select[name="webhookRouteId"]', 'route-1');

    expect(root().querySelector('input[name="preCheckCommand"]')).toBeNull();
    expect(root().querySelector('select[name="preCheckOnError"]')).toBeNull();
    expect(root().textContent).toContain('Webhooks always start the AI');
    expect(fixture.componentInstance.form().preCheckCommand).toBe('');
    expect(fixture.componentInstance.form().model).toBe(emptyForm().model);
    await pressSave();
    expect(store.create.mock.calls[0][0].trigger).toMatchObject({ kind: 'webhook', routeId: 'route-1' });
    expect((store.create.mock.calls[0][0].action as AutomationAction).preCheck).toBeUndefined();
  });

  it('hides and removes an ignored check when editing a saved webhook job', async () => {
    const automation = { ...makeAutomation({ preCheck: { command: 'check-news' } }),
      trigger: { kind: 'webhook' as const, routeId: 'route-1', filters: [] } };
    store.automations.set([automation]);
    fixture.componentInstance.select(automation);
    fixture.componentInstance.editSelected();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(root().querySelector('input[name="preCheckCommand"]')).toBeNull();
    await pressSave();
    expect((store.update.mock.calls[0][1].action as AutomationAction).preCheck).toBeUndefined();
  });

  it('keeps an existing job\'s check when it is edited and saved, and drops it when cleared', async () => {
    const automation = makeAutomation({ preCheck: { command: 'check-news', onError: 'stop' } });
    store.automations.set([automation]);
    fixture.componentInstance.select(automation);
    fixture.componentInstance.editSelected();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect((root().querySelector('input[name="preCheckCommand"]') as HTMLInputElement).value).toBe('check-news');

    await pressSave();
    expect(store.update.mock.calls[0][0]).toBe('automation-1');
    expect((store.update.mock.calls[0][1].action as AutomationAction).preCheck)
      .toEqual({ command: 'check-news', onError: 'stop' });

    store.update.mockClear();
    fixture.componentInstance.editSelected();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    await type('input[name="preCheckCommand"]', '');
    await pressSave();
    expect((store.update.mock.calls[0][1].action as AutomationAction).preCheck).toBeUndefined();
  });
});
