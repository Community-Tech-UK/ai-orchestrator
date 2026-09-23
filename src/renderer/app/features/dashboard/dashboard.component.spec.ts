import { CUSTOM_ELEMENTS_SCHEMA, signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { NgTemplateOutlet } from '@angular/common';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UiActionRegistration } from '../../core/services/action-dispatch.service';
import { ActionDispatchService } from '../../core/services/action-dispatch.service';
import { ElectronIpcService } from '../../core/services/ipc/electron-ipc.service';
import { KeybindingService } from '../../core/services/keybinding.service';
import { ModelPickerFocusService } from '../models/model-picker-focus.service';
import { NewSessionDraftService } from '../../core/services/new-session-draft.service';
import { ScratchDirectoryService } from '../../core/services/scratch-directory.service';
import { ViewLayoutService, type WorkspacePreset } from '../../core/services/view-layout.service';
import { VisibleInstanceResolver } from '../../core/services/visible-instance-resolver.service';
import { ChatStore } from '../../core/state/chat.store';
import { CliStore } from '../../core/state/cli.store';
import { HistoryStore } from '../../core/state/history.store';
import { InstanceStore } from '../../core/state/instance.store';
import { RemoteNodeStore } from '../../core/state/remote-node.store';
import { SettingsStore } from '../../core/state/settings.store';
import { SourceControlStore } from '../../core/state/source-control.store';
import { SessionRecoveryStore } from '../../core/state/session-recovery.store';
import { SessionRecoveryBannerComponent } from '../../shared/components/session-recovery-banner/session-recovery-banner.component';
import { ResumePickerController } from '../resume/resume-picker.controller';
import { DashboardComponent } from './dashboard.component';

const directory = dirname(fileURLToPath(import.meta.url));
const dashboardTemplate = readFileSync(resolve(directory, './dashboard.component.html'), 'utf8');
const recoveryTemplate = readFileSync(resolve(directory, '../../shared/components/session-recovery-banner/session-recovery-banner.component.html'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('dashboard.component.html')) return Promise.resolve(dashboardTemplate);
  if (url.endsWith('session-recovery-banner.component.html')) return Promise.resolve(recoveryTemplate);
  if (url.endsWith('.html') || url.endsWith('.scss')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

describe('DashboardComponent resume picker routing', () => {
  const selectedInstance = signal<unknown | null>(null);
  const instances = signal<unknown[]>([]);
  const previewConversation = signal<unknown | null>(null);
  const selectedChatId = signal<string | null>(null);
  const selectedChat = signal<{ currentCwd?: string | null } | null>(null);
  const effectiveSidebarStyle = signal('comfortable');
  const defaultSettings = signal({ defaultWorkingDirectory: null as string | null });
  const draftWorkingDirectory = signal<string | null>(null);
  const draftNodeId = signal<string | null>(null);
  const activePreset = signal(null);
  const controlPlanePinned = signal(false);
  const totalChangeCount = signal(0);
  const registeredActions: UiActionRegistration[] = [];
  const recoveryCandidates = signal([{ recoveryKey: 'recovery-1', sourceInstanceId: 'source-1',
    displayName: 'Autosaved session', recoveredMessageCount: 2, reason: 'unarchived' as const,
    lastActivityAt: 1 }]);
  const resumePickerController = {
    focusRecoveryContent: vi.fn(),
    resetTransientFocus: vi.fn(),
    ensureCandidatesLoaded: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    selectedInstance.set(null);
    instances.set([]);
    previewConversation.set(null);
    selectedChatId.set(null);
    selectedChat.set(null);
    draftWorkingDirectory.set(null);
    draftNodeId.set(null);
    registeredActions.length = 0;

    TestBed.overrideComponent(DashboardComponent, {
      set: {
        imports: [NgTemplateOutlet, SessionRecoveryBannerComponent],
        template: dashboardTemplate,
        templateUrl: undefined,
        styles: [],
        styleUrl: undefined,
        styleUrls: [],
        schemas: [CUSTOM_ELEMENTS_SCHEMA],
      },
    });

    TestBed.configureTestingModule({
      providers: [
        { provide: Router, useValue: { navigate: vi.fn().mockResolvedValue(true) } },
        {
          provide: InstanceStore,
          useValue: {
            selectedInstance: selectedInstance.asReadonly(),
            instances: instances.asReadonly(),
            setSelectedInstance: vi.fn(),
            terminateInstance: vi.fn(),
            terminateAllInstances: vi.fn(),
            restartInstance: vi.fn(),
            interruptInstance: vi.fn().mockResolvedValue(true),
          },
        },
        {
          provide: HistoryStore,
          useValue: {
            previewConversation: previewConversation.asReadonly(),
            clearSelection: vi.fn(),
          },
        },
        {
          provide: CliStore,
          useValue: {
            initialize: vi.fn(),
            refresh: vi.fn(),
            loading: signal(false),
            noClisError: signal(null),
          },
        },
        {
          provide: SettingsStore,
          useValue: {
            initialize: vi.fn().mockResolvedValue(undefined),
            effectiveSidebarStyle: effectiveSidebarStyle.asReadonly(),
            settings: defaultSettings.asReadonly(),
          },
        },
        {
          provide: ChatStore,
          useValue: {
            selectedChatId: selectedChatId.asReadonly(),
            selectedChat: selectedChat.asReadonly(),
            deselect: vi.fn(),
            selectFirstChat: vi.fn(),
          },
        },
        { provide: RemoteNodeStore, useValue: { initialize: vi.fn() } },
        { provide: ElectronIpcService, useValue: { isElectron: true } },
        {
          provide: ActionDispatchService,
          useValue: {
            register: vi.fn((action: UiActionRegistration) => {
              registeredActions.push(action);
              return vi.fn();
            }),
          },
        },
        { provide: KeybindingService, useValue: { setEligibilityState: vi.fn() } },
        {
          provide: ViewLayoutService,
          useValue: {
            sidebarWidth: 320,
            presets: [] satisfies WorkspacePreset[],
            activePreset: activePreset.asReadonly(),
            controlPlanePinned: controlPlanePinned.asReadonly(),
            setSidebarWidth: vi.fn(),
            setActivePreset: vi.fn(),
            setControlPlanePinned: vi.fn(),
            getPreset: vi.fn(),
          },
        },
        {
          provide: NewSessionDraftService,
          useValue: {
            workingDirectory: draftWorkingDirectory.asReadonly(),
            nodeId: draftNodeId.asReadonly(),
            open: vi.fn(),
          },
        },
        {
          provide: ScratchDirectoryService,
          useValue: {
            dir: signal<string | null>(null).asReadonly(),
            init: vi.fn().mockResolvedValue(undefined),
            isScratch: vi.fn(() => false),
          },
        },
        { provide: VisibleInstanceResolver, useValue: { selectVisibleInstance: vi.fn() } },
        { provide: ModelPickerFocusService, useValue: { requestOpen: vi.fn() } },
        { provide: ResumePickerController, useValue: resumePickerController },
        { provide: SessionRecoveryStore, useValue: {
          candidates: recoveryCandidates.asReadonly(), loading: signal(false), error: signal(null),
          refresh: vi.fn(),
        } },
        {
          provide: SourceControlStore,
          useValue: {
            totalChangeCount: totalChangeCount.asReadonly(),
            loadForRoot: vi.fn().mockResolvedValue(undefined),
          },
        },
      ],
    });
  });

  it('keeps banner-open recovery filtering scoped to the current picker lifetime', () => {
    const component = TestBed.runInInjectionContext(() => new DashboardComponent());

    component.openRecoveryPicker();
    expect(resumePickerController.focusRecoveryContent).toHaveBeenCalledOnce();
    expect(resumePickerController.resetTransientFocus).not.toHaveBeenCalled();
    expect(component.showResumePicker()).toBe(true);

    component.closeResumePicker();
    expect(resumePickerController.resetTransientFocus).toHaveBeenCalledOnce();
    expect(component.showResumePicker()).toBe(false);

    component.openResumePicker();
    expect(resumePickerController.resetTransientFocus).toHaveBeenCalledTimes(2);
    expect(component.showResumePicker()).toBe(true);

    component.ngOnDestroy();
  });

  it('routes the resume.openPicker keybinding through the normal unfiltered open path', () => {
    const component = TestBed.runInInjectionContext(() => new DashboardComponent());

    component.ngOnInit();
    expect(resumePickerController.ensureCandidatesLoaded).toHaveBeenCalledOnce();
    const openResume = registeredActions.find((action) => action.id === 'resume.openPicker');
    expect(openResume).toBeDefined();

    component.openRecoveryPicker();
    openResume?.run();

    expect(resumePickerController.focusRecoveryContent).toHaveBeenCalledOnce();
    expect(resumePickerController.resetTransientFocus).toHaveBeenCalledOnce();
    expect(component.showResumePicker()).toBe(true);

    component.ngOnDestroy();
  });

  it('renders the startup recovery notice and opens the recovery picker from its action', async () => {
    const fixture = TestBed.createComponent(DashboardComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const banner = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('[data-testid="session-recovery-banner"]');
    expect(banner?.textContent).toContain('Autosaved session');
    banner?.querySelector<HTMLButtonElement>('button')?.click();
    expect(fixture.componentInstance.showResumePicker()).toBe(true);
    fixture.destroy();
  });
});
