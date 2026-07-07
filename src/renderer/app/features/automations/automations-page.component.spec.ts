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
import type { Automation } from '../../../../shared/types/automation.types';
import { AutomationStore } from '../../core/state/automation.store';
import { InstanceStore } from '../../core/state/instance/instance.store';
import { AutomationsPageComponent } from './automations-page.component';

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
  @Input() title = '';
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

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'automation-1',
    name: 'Daily check',
    description: 'Keep the repo healthy',
    enabled: true,
    active: true,
    workspaceId: '/repo',
    schedule: { type: 'cron', expression: '0 9 * * *', timezone: 'UTC' },
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

  it('requires row-level confirmation before deleting an automation', async () => {
    findButton('Delete Daily check').click();
    fixture.detectChanges();

    expect(store.delete).not.toHaveBeenCalled();

    findButton('Confirm delete Daily check').click();
    await fixture.whenStable();

    expect(store.delete).toHaveBeenCalledWith('automation-1');
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
    expect(templateSource).toContain('title="Automations"');
    expect(templateSource).not.toContain('backRoute="/"');
    expect(templateSource).not.toContain('<header class="toolbar">');
  });
});
