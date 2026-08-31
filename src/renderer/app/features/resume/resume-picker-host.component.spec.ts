import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationHistoryEntry } from '../../../../shared/types/history.types';
import type { SessionRecoveryCandidate } from '../../../../shared/types/session-recovery.types';
import { KeybindingService } from '../../core/services/keybinding.service';
import { ToastService } from '../../core/services/toast.service';
import { HistoryStore } from '../../core/state/history.store';
import { InstanceStore } from '../../core/state/instance.store';
import type { Instance } from '../../core/state/instance/instance.types';
import { SessionRecoveryStore } from '../../core/state/session-recovery.store';
import { UsageStore } from '../../core/state/usage.store';
import { ResumeActionsService, type ResumeActionResponse } from './resume-actions.service';
import { ResumePickerController } from './resume-picker.controller';
import { ResumePickerHostComponent } from './resume-picker-host.component';
import type { ResumePickerAction, ResumePickerItem } from './resume-picker.types';

function recoveryItem(): ResumePickerItem {
  return {
    id: 'recovery:claude:key',
    kind: 'recovery',
    title: 'Autosaved auth fix',
    subtitle: 'Newer than history',
    projectPath: '/repo',
    provider: 'claude',
    lastActivity: 1_700_000_000_000,
    availableActions: ['recoverAutosave'],
  };
}

function historyItem(): ResumePickerItem {
  return {
    id: 'entry-1',
    kind: 'history',
    title: 'Archived auth fix',
    subtitle: 'claude · /repo',
    projectPath: '/repo',
    provider: 'claude',
    lastActivity: 1_600_000_000_000,
    availableActions: ['resumeById', 'forkNew'],
  };
}

function candidate(overrides: Partial<SessionRecoveryCandidate> = {}): SessionRecoveryCandidate {
  return {
    recoveryKey: 'recovery:claude:key',
    sourceInstanceId: 'source-1',
    historyThreadId: 'thread-1',
    provider: 'claude',
    modelId: 'sonnet',
    displayName: 'Autosaved auth fix',
    workingDirectory: '/repo',
    lastActivityAt: 1_700_000_000_000,
    historyCoveredThrough: 1_699_999_990_000,
    recoveredMessageCount: 7,
    reason: 'newer-than-history',
    nativeResumeAvailable: true,
    ...overrides,
  };
}

function historyEntry(overrides: Partial<ConversationHistoryEntry> = {}): ConversationHistoryEntry {
  return {
    id: 'entry-1',
    displayName: 'Archived auth fix',
    createdAt: 1_600_000_000_000,
    endedAt: 1_600_000_060_000,
    workingDirectory: '/repo',
    messageCount: 2,
    firstUserMessage: 'Review auth',
    lastUserMessage: 'Fix auth',
    status: 'completed',
    originalInstanceId: 'old-1',
    parentId: null,
    sessionId: 'session-1',
    provider: 'claude',
    ...overrides,
  };
}

function liveInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'live-1',
    displayName: 'Live auth fix',
    createdAt: 1_690_000_000_000,
    historyThreadId: 'thread-live',
    parentId: null,
    childrenIds: [],
    agentId: 'build',
    agentMode: 'build',
    provider: 'claude',
    status: 'idle',
    contextUsage: { used: 0, total: 200_000, percentage: 0 },
    lastActivity: 1_690_000_060_000,
    providerSessionId: 'provider-session-1',
    sessionId: 'session-live',
    restartEpoch: 0,
    workingDirectory: '/repo',
    yoloMode: false,
    launchMode: 'orchestrated',
    outputBuffer: [],
    ...overrides,
  };
}

function actionLabel(action: ResumePickerAction): string {
  switch (action) {
    case 'recoverAutosave':
      return 'Recover';
    case 'resumeById':
      return 'Resume';
    case 'forkNew':
      return 'Fork';
    case 'resumeLatest':
      return 'Latest';
    case 'switchToLive':
      return 'Live';
    case 'restoreFromFallback':
      return 'Fallback';
  }
}

function dispatchBrowserKeyboardActivation(button: HTMLButtonElement, key: 'Enter' | ' '): void {
  button.focus();
  button.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  button.click();
  button.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
}

describe('ResumePickerHostComponent recovery accessibility', () => {
  let fixture: ComponentFixture<ResumePickerHostComponent>;
  let opener: HTMLButtonElement;
  const query = signal('');
  const lastError = signal<string | null>(null);
  const actionLoading = signal(false);
  const groups = signal([
    {
      id: 'recovery',
      label: 'Autosave recovery',
      items: [{
        id: 'recovery:recovery:claude:key',
        label: 'Autosaved auth fix',
        description: 'Newer than history',
        badge: 'Autosave',
        activationMode: 'manual',
        value: recoveryItem(),
      }],
    },
    {
      id: 'history',
      label: 'History',
      items: [{
        id: 'history:entry-1',
        label: 'Archived auth fix',
        description: 'claude · /repo',
        badge: 'History',
        activationMode: 'manual',
        value: historyItem(),
      }],
    },
  ]);
  const controller = {
    title: 'Resume',
    placeholder: 'Search resumable sessions...',
    emptyLabel: 'No resumable sessions found',
    query: query.asReadonly(),
    groups: groups.asReadonly(),
    lastError: lastError.asReadonly(),
    setQuery: vi.fn((value: string) => query.set(value)),
    actionLabel: vi.fn(actionLabel),
    actionAriaLabel: vi.fn((item: ResumePickerItem, action: ResumePickerAction) =>
      action === 'recoverAutosave'
        ? `Recover autosaved session ${item.title}`
        : `${actionLabel(action)} ${item.title}`
    ),
    actionProgressLabel: vi.fn((action: ResumePickerAction) =>
      action === 'recoverAutosave' ? 'Recovering...' : actionLabel(action)
    ),
    isActionLoading: vi.fn(() => actionLoading()),
    run: vi.fn(),
    executeAction: vi.fn(),
  };
  const keybindingService = {
    getContext: vi.fn(() => 'global'),
    setContext: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    query.set('');
    lastError.set(null);
    actionLoading.set(false);
    controller.actionLabel.mockImplementation(actionLabel);
    controller.actionAriaLabel.mockImplementation((item: ResumePickerItem, action: ResumePickerAction) =>
      action === 'recoverAutosave'
        ? `Recover autosaved session ${item.title}`
        : `${actionLabel(action)} ${item.title}`
    );
    controller.actionProgressLabel.mockImplementation((action: ResumePickerAction) =>
      action === 'recoverAutosave' ? 'Recovering...' : actionLabel(action)
    );
    controller.isActionLoading.mockImplementation(() => actionLoading());
    controller.executeAction.mockResolvedValue(false);

    opener = document.createElement('button');
    opener.textContent = 'Open resume picker';
    document.body.append(opener);
    opener.focus();

    await TestBed.configureTestingModule({
      imports: [ResumePickerHostComponent],
      providers: [
        { provide: ResumePickerController, useValue: controller },
        { provide: KeybindingService, useValue: keybindingService },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(ResumePickerHostComponent);
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    opener.remove();
  });

  it('renders recovery actions as named native buttons in logical tab order', () => {
    const actions = allActions();
    const action = actions[0];

    expect(actions.map(button => button.textContent?.trim())).toEqual(['Recover', 'Resume', 'Fork']);
    expect(action?.tagName).toBe('BUTTON');
    expect(action?.type).toBe('button');
    expect(action?.getAttribute('aria-label')).toBe('Recover autosaved session Autosaved auth fix');
    expect(action?.disabled).toBe(false);
  });

  it('does not nest native action buttons inside focusable button-like overlay rows', () => {
    for (const action of allActions()) {
      const buttonLikeAncestor = action.parentElement?.closest('[role="button"][tabindex="0"]');
      expect(buttonLikeAncestor).toBeNull();
    }
  });

  it('shows an announced retryable error from the controller', () => {
    lastError.set('Recovery provider is unavailable');
    fixture.detectChanges();

    const alert = fixture.nativeElement.querySelector('[role="alert"]') as HTMLElement | null;
    expect(alert?.getAttribute('aria-live')).toBe('assertive');
    expect(alert?.textContent).toContain('Recovery provider is unavailable');
  });

  it('disables externally reflected recovery actions without active busy progress copy', () => {
    actionLoading.set(true);
    fixture.detectChanges();

    const action = fixture.nativeElement.querySelector('.resume-action') as HTMLButtonElement;
    expect(action.disabled).toBe(true);
    expect(action.getAttribute('aria-busy')).toBeNull();
    expect(action.textContent).toContain('Recover');
  });

  it('activates native action buttons from Enter and Space browser click sequences exactly once', async () => {
    controller.executeAction.mockResolvedValue(false);
    const action = allActions()[0];

    dispatchBrowserKeyboardActivation(action, 'Enter');
    await fixture.whenStable();
    dispatchBrowserKeyboardActivation(action, ' ');
    await fixture.whenStable();

    expect(controller.executeAction).toHaveBeenCalledTimes(2);
  });

  it('suppresses duplicate activation while an action is already pending', async () => {
    let resolveAction!: (value: boolean) => void;
    controller.executeAction.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveAction = resolve;
      }),
    );
    const action = fixture.nativeElement.querySelector('.resume-action') as HTMLButtonElement;

    action.click();
    action.click();

    expect(controller.executeAction).toHaveBeenCalledOnce();
    resolveAction(false);
    await fixture.whenStable();
  });

  it('disables all picker action controls while one action is pending and marks only the active action busy', async () => {
    let resolveAction!: (value: boolean) => void;
    controller.executeAction.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveAction = resolve;
      }),
    );
    const [recover, resume, fork] = allActions();

    recover.click();
    fixture.detectChanges();

    expect(allActions().map(button => button.disabled)).toEqual([true, true, true]);
    expect(recover.getAttribute('aria-busy')).toBe('true');
    expect(recover.textContent).toContain('Recovering...');
    expect(resume.getAttribute('aria-busy')).toBeNull();
    expect(resume.textContent).toContain('Resume');
    expect(fork.getAttribute('aria-busy')).toBeNull();
    expect(fork.textContent).toContain('Fork');

    dispatchBrowserKeyboardActivation(resume, 'Enter');
    expect(controller.executeAction).toHaveBeenCalledOnce();

    resolveAction(false);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(allActions().map(button => button.disabled)).toEqual([false, false, false]);
  });

  it('emits close on successful recovery and restores focus to the picker trigger when destroyed', async () => {
    controller.executeAction.mockResolvedValueOnce(true);
    let closed = false;
    fixture.componentInstance.closeRequested.subscribe(() => {
      closed = true;
      fixture.destroy();
    });
    const action = fixture.nativeElement.querySelector('.resume-action') as HTMLButtonElement;

    action.click();
    await fixture.whenStable();

    expect(closed).toBe(true);
    expect(document.activeElement).toBe(opener);
  });

  function allActions(): HTMLButtonElement[] {
    return Array.from(
      fixture.nativeElement.querySelectorAll('.resume-action') as NodeListOf<HTMLButtonElement>,
    );
  }
});

describe('ResumePickerHostComponent with real recovery controller rows', () => {
  let fixture: ComponentFixture<ResumePickerHostComponent>;
  let opener: HTMLButtonElement;
  const historyEntries = signal<ConversationHistoryEntry[]>([]);
  const instances = signal<Instance[]>([]);
  const selectedInstance = signal<Instance | null>(null);
  const recoveryCandidates = signal<SessionRecoveryCandidate[]>([]);
  const recoveryLoading = signal(false);
  const recoveringKey = signal<string | null>(null);
  const recoveryError = signal<string | null>(null);
  const actions = {
    resumeLatest: vi.fn(),
    resumeById: vi.fn(),
    switchToLive: vi.fn(),
    forkNew: vi.fn(),
    restoreFromFallback: vi.fn(),
    recoverAutosave: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    historyEntries.set([]);
    instances.set([]);
    selectedInstance.set(null);
    recoveryCandidates.set([candidate()]);
    recoveryLoading.set(false);
    recoveringKey.set(null);
    recoveryError.set(null);
    actions.resumeLatest.mockResolvedValue({ success: true, data: { instanceId: 'latest-1' } });
    actions.resumeById.mockResolvedValue({ success: true, data: { instanceId: 'history-1' } });
    actions.switchToLive.mockResolvedValue({ success: true, data: { instanceId: 'live-1' } });
    actions.forkNew.mockResolvedValue({ success: true, data: { instanceId: 'fork-1' } });
    actions.restoreFromFallback.mockResolvedValue({ success: true, data: { instanceId: 'fallback-1' } });
    actions.recoverAutosave.mockResolvedValue({
      success: true,
      source: 'recovery',
      recoveredMessageCount: 7,
      data: { success: true, instanceId: 'recovered-1' },
    } satisfies ResumeActionResponse);

    opener = document.createElement('button');
    opener.textContent = 'Open resume picker';
    document.body.append(opener);
    opener.focus();

    await TestBed.configureTestingModule({
      imports: [ResumePickerHostComponent],
      providers: [
        {
          provide: KeybindingService,
          useValue: {
            getContext: vi.fn(() => 'global'),
            setContext: vi.fn(),
          },
        },
        { provide: HistoryStore, useValue: { entries: historyEntries, loadHistory: vi.fn() } },
        {
          provide: InstanceStore,
          useValue: {
            instances,
            selectedInstance,
            setSelectedInstance: vi.fn(),
            refreshInstances: vi.fn(),
          },
        },
        {
          provide: SessionRecoveryStore,
          useValue: {
            candidates: recoveryCandidates.asReadonly(),
            loading: recoveryLoading.asReadonly(),
            recoveringKey: recoveringKey.asReadonly(),
            error: recoveryError.asReadonly(),
          },
        },
        {
          provide: UsageStore,
          useValue: {
            frecency: vi.fn().mockReturnValue(0),
            record: vi.fn().mockResolvedValue(undefined),
          },
        },
        { provide: ToastService, useValue: { show: vi.fn() } },
        { provide: ResumeActionsService, useValue: actions },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(ResumePickerHostComponent);
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    opener.remove();
  });

  it('keeps Quick and matching Recovery controls disabled while only the exact active action is busy', async () => {
    let resolveRecovery!: (value: ResumeActionResponse) => void;
    actions.recoverAutosave.mockReturnValue(
      new Promise<ResumeActionResponse>((resolve) => {
        resolveRecovery = resolve;
      }),
    );
    const [latest, recover] = allActions();

    expect(latest.textContent?.trim()).toBe('Latest');
    expect(recover.textContent?.trim()).toBe('Recover');

    recover.click();
    recoveringKey.set('recovery:claude:key');
    fixture.detectChanges();

    const [latestDuring, recoverDuring] = allActions();
    expect(latestDuring.disabled).toBe(true);
    expect(recoverDuring.disabled).toBe(true);
    expect(latestDuring.getAttribute('aria-busy')).toBeNull();
    expect(latestDuring.textContent).toContain('Latest');
    expect(recoverDuring.getAttribute('aria-busy')).toBe('true');
    expect(recoverDuring.textContent).toContain('Recovering...');

    latestDuring.click();
    expect(actions.recoverAutosave).toHaveBeenCalledOnce();

    resolveRecovery({
      success: true,
      source: 'recovery',
      recoveredMessageCount: 7,
      data: { success: true, instanceId: 'recovered-1' },
    });
    await fixture.whenStable();
  });

  it('disables every overlay row during externally reflected recovery and blocks row activation', async () => {
    instances.set([liveInstance()]);
    historyEntries.set([historyEntry()]);
    fixture.detectChanges();
    expect(rowLabels()).toEqual([
      'Resume latest',
      'Live auth fix',
      'Autosaved auth fix',
      'Archived auth fix',
    ]);
    expect(allRows().map(row => row.getAttribute('aria-disabled'))).toEqual([null, null, null, null]);

    recoveringKey.set('recovery:claude:key');
    fixture.detectChanges();

    expect(allRows().map(row => row.getAttribute('aria-disabled'))).toEqual(['true', 'true', 'true', 'true']);
    expect(allActions().every(button => button.disabled)).toBe(true);
    expect(allActions().map(button => button.getAttribute('aria-busy'))).toEqual([null, null, null, null, null]);

    for (const row of allRows()) {
      row.click();
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      row.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    }
    await fixture.whenStable();

    expect(actions.resumeLatest).not.toHaveBeenCalled();
    expect(actions.switchToLive).not.toHaveBeenCalled();
    expect(actions.recoverAutosave).not.toHaveBeenCalled();
    expect(actions.resumeById).not.toHaveBeenCalled();
    expect(actions.forkNew).not.toHaveBeenCalled();
  });

  function allActions(): HTMLButtonElement[] {
    return Array.from(
      fixture.nativeElement.querySelectorAll('.resume-action') as NodeListOf<HTMLButtonElement>,
    );
  }

  function allRows(): HTMLElement[] {
    return Array.from(
      fixture.nativeElement.querySelectorAll('.overlay-row') as NodeListOf<HTMLElement>,
    );
  }

  function rowLabels(): string[] {
    return allRows().map((row) =>
      row.querySelector('.overlay-row-label')?.textContent?.trim() ?? ''
    );
  }
});
