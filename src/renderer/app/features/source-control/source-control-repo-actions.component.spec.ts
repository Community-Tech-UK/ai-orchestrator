/**
 * LT-138 focus: the per-repo "Allow PR creation" checkbox this component
 * adds. Also covers enough of the pre-existing sign-off checkbox to prove
 * the two independent checkboxes are not cross-wired.
 */

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../../../../shared/types/settings.types';
import { SourceControlStore } from '../../core/state/source-control.store';
import { SettingsStore } from '../../core/state/settings.store';
import { VcsIpcService } from '../../core/services/ipc/vcs-ipc.service';
import { KeybindingService } from '../../core/services/keybinding.service';
import { SourceControlRepoActionsComponent } from './source-control-repo-actions.component';
import type { RepoState } from './source-control.types';

const REPO_A = '/repo/project-a';
const REPO_B = '/repo/project-b';

function repoState(absolutePath: string): RepoState {
  return {
    absolutePath,
    name: absolutePath.split('/').pop() ?? absolutePath,
    relativePath: '',
    status: {
      branch: 'main',
      ahead: 0,
      behind: 0,
      staged: [{ path: 'src/a.ts', status: 'modified', staged: true }],
      unstaged: [],
      untracked: [],
      hasChanges: true,
      isClean: false,
    },
    error: null,
    loading: false,
  };
}

describe('SourceControlRepoActionsComponent — LT-138 PR-creation opt-in', () => {
  const sourceControlStore = {
    longOpState: vi.fn(() => null),
    getCommitMessage: vi.fn(() => ''),
    isWriting: vi.fn(() => false),
    setCommitMessage: vi.fn(),
    fetch: vi.fn(async () => undefined),
    pull: vi.fn(async () => undefined),
    push: vi.fn(async () => undefined),
    cancelLongRunningOp: vi.fn(async () => undefined),
    commit: vi.fn(async () => undefined),
    checkoutBranch: vi.fn(async () => ({ success: true })),
  };
  const vcs = {
    vcsGetBranches: vi.fn(async () => ({ success: true, data: { branches: [] } })),
  };
  const settingsStore = {
    settings: vi.fn((): Pick<AppSettings, 'allowPrCreation'> => ({ allowPrCreation: {} })),
    set: vi.fn(async () => undefined),
  };
  let fixture: ComponentFixture<SourceControlRepoActionsComponent>;

  beforeEach(() => {
    vi.clearAllMocks();
    sourceControlStore.getCommitMessage.mockReturnValue('');
    sourceControlStore.isWriting.mockReturnValue(false);
    settingsStore.settings.mockReturnValue({ allowPrCreation: {} });
    TestBed.configureTestingModule({
      imports: [SourceControlRepoActionsComponent],
      providers: [
        { provide: SourceControlStore, useValue: sourceControlStore },
        { provide: VcsIpcService, useValue: vcs },
        { provide: SettingsStore, useValue: settingsStore },
        { provide: KeybindingService, useValue: { onAction: vi.fn(() => vi.fn()), formatBindingByAction: vi.fn(() => 'Enter'), ariaShortcutsByAction: vi.fn(() => 'Enter') } },
      ],
    });
    fixture = TestBed.createComponent(SourceControlRepoActionsComponent);
    fixture.componentRef.setInput('repo', repoState(REPO_A));
    fixture.detectChanges();
  });

  function prCheckbox(): HTMLInputElement {
    const box = fixture.nativeElement.querySelector('.pr-creation-toggle input[type="checkbox"]');
    if (!box) throw new Error('PR creation checkbox not found');
    return box as HTMLInputElement;
  }

  function signoffCheckbox(): HTMLInputElement {
    const box = fixture.nativeElement.querySelector('.commit-signoff input[type="checkbox"]');
    if (!box) throw new Error('Sign-off checkbox not found');
    return box as HTMLInputElement;
  }

  it('keeps Pull and Push available when cached counts show no commits', () => {
    const buttons = fixture.debugElement.queryAll(By.css('.sync-row > .action-btn'));
    const pull = buttons[1];
    const push = buttons[2];
    expect((pull.nativeElement as HTMLButtonElement).disabled).toBe(false);
    expect(pull.nativeElement.getAttribute('aria-disabled')).toBeNull();
    expect(pull.injector.get(AioTooltipDirective).appTooltip()).toBe('Pull from upstream (fast-forward only)');
    expect(push.injector.get(AioTooltipDirective).appTooltip()).toBe('Push to upstream');
    pull.nativeElement.click();
    push.nativeElement.click();
    expect(sourceControlStore.pull).toHaveBeenCalledExactlyOnceWith(REPO_A);
    expect(sourceControlStore.push).toHaveBeenCalledExactlyOnceWith(REPO_A);
  });

  it('shows upstream synchronization consequences beside the buttons', () => {
    const repo = repoState(REPO_A);
    fixture.componentRef.setInput('repo', { ...repo, status: { ...repo.status!, ahead: 1, behind: 2 } });
    fixture.detectChanges();
    const text = fixture.nativeElement.querySelector('.sync-hint')?.textContent;
    expect(text).toContain('Pull 2 commit(s) from upstream (fast-forward only)');
    expect(text).toContain('Push 1 commit(s) to upstream');
  });

  it('renders unchecked by default and labels the control "Allow PR creation"', () => {
    expect(fixture.nativeElement.textContent).toContain('Allow PR creation');
    expect(prCheckbox().checked).toBe(false);
  });

  it('renders checked when the current repo is already opted in', () => {
    settingsStore.settings.mockReturnValue({ allowPrCreation: { [REPO_A]: true } });
    fixture = TestBed.createComponent(SourceControlRepoActionsComponent);
    fixture.componentRef.setInput('repo', repoState(REPO_A));
    fixture.detectChanges();
    expect(prCheckbox().checked).toBe(true);
  });

  it('does not read another repo\'s opt-in as this repo\'s state', () => {
    settingsStore.settings.mockReturnValue({ allowPrCreation: { [REPO_B]: true } });
    fixture = TestBed.createComponent(SourceControlRepoActionsComponent);
    fixture.componentRef.setInput('repo', repoState(REPO_A));
    fixture.detectChanges();
    expect(prCheckbox().checked).toBe(false);
  });

  it('LT-138: checking the box writes allowPrCreation keyed by this repo\'s absolute path, true', () => {
    const box = prCheckbox();
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(settingsStore.set).toHaveBeenCalledWith('allowPrCreation', { [REPO_A]: true });
  });

  it('unchecking an opted-in repo writes false, not a deletion', () => {
    settingsStore.settings.mockReturnValue({ allowPrCreation: { [REPO_A]: true } });
    fixture = TestBed.createComponent(SourceControlRepoActionsComponent);
    fixture.componentRef.setInput('repo', repoState(REPO_A));
    fixture.detectChanges();

    const box = prCheckbox();
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(settingsStore.set).toHaveBeenCalledWith('allowPrCreation', { [REPO_A]: false });
  });

  it('toggling the PR-creation checkbox never touches the commit sign-off checkbox or vice versa', () => {
    expect(signoffCheckbox().checked).toBe(false);

    const prBox = prCheckbox();
    prBox.checked = true;
    prBox.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    // Sign-off must be untouched by the PR-creation toggle.
    expect(signoffCheckbox().checked).toBe(false);
    expect(sourceControlStore.setCommitMessage).not.toHaveBeenCalled();

    const signoffBox = signoffCheckbox();
    signoffBox.checked = true;
    signoffBox.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    // Sign-off toggling must not write allowPrCreation again beyond the one
    // earlier PR-creation change.
    expect(settingsStore.set).toHaveBeenCalledTimes(1);
    expect(prCheckbox().checked).toBe(true);
  });
  it.each([
    ['Commit', 'Enter a commit message first.', 'commit'],
  ] as const)('keeps blocked %s focusable, explains the cause, blocks activation and recovers', (label, reason, action) => {
    const button = (Array.from(fixture.nativeElement.querySelectorAll('button')) as HTMLButtonElement[])
      .find(item => item.textContent?.trim().startsWith(label))!;
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    // jsdom needs the keyboard-focus selector supplied explicitly.
    vi.spyOn(button, 'matches').mockImplementation(selector => selector === ':focus-visible');
    button.focus();
    fixture.detectChanges();
    expect(document.activeElement).toBe(button);
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(reason);
    button.click();
    expect(sourceControlStore[action]).not.toHaveBeenCalled();
    sourceControlStore.getCommitMessage.mockReturnValue('Save changes');
    const repo = repoState(REPO_A);
    repo.status = { ...repo.status!, ahead: 1, behind: 1 };
    fixture.componentRef.setInput('repo', repo);
    fixture.detectChanges();
    expect(button.hasAttribute('aria-disabled')).toBe(false);
    button.click();
    expect(sourceControlStore[action]).toHaveBeenCalledOnce();
  });

  it('keeps a short repository write natively disabled', () => {
    sourceControlStore.isWriting.mockReturnValue(true);
    fixture.componentRef.setInput('repo', repoState(REPO_A));
    fixture.detectChanges();
    const buttons = Array.from(fixture.nativeElement.querySelectorAll('.action-btn')) as HTMLButtonElement[];
    expect(buttons.every(button => button.disabled)).toBe(true);
  });

  it('lets Pull and Push use the existing operation and error path even when the last reported counts are zero', () => {
    for (const label of ['Pull', 'Push'] as const) {
      const button = (Array.from(fixture.nativeElement.querySelectorAll('button')) as HTMLButtonElement[])
        .find(item => item.textContent?.trim() === label)!;
      expect(button.disabled).toBe(false);
      expect(button.hasAttribute('aria-disabled')).toBe(false);
      button.click();
      expect(sourceControlStore[label === 'Pull' ? 'pull' : 'push']).toHaveBeenCalledWith(REPO_A);
    }
  });

});
