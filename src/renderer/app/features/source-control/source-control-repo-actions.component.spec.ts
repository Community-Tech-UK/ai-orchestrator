/**
 * LT-138 focus: the per-repo "Allow PR creation" checkbox this component
 * adds. Also covers enough of the pre-existing sign-off checkbox to prove
 * the two independent checkboxes are not cross-wired.
 */

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../../../../shared/types/settings.types';
import { SourceControlStore } from '../../core/state/source-control.store';
import { SettingsStore } from '../../core/state/settings.store';
import { VcsIpcService } from '../../core/services/ipc/vcs-ipc.service';
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
    settingsStore.settings.mockReturnValue({ allowPrCreation: {} });
    TestBed.configureTestingModule({
      imports: [SourceControlRepoActionsComponent],
      providers: [
        { provide: SourceControlStore, useValue: sourceControlStore },
        { provide: VcsIpcService, useValue: vcs },
        { provide: SettingsStore, useValue: settingsStore },
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
});
