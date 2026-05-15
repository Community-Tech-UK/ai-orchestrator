import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  PANEL_COLLAPSED_FIELD,
  SessionProgressPanelComponent,
} from './session-progress-panel.component';
import { TodoStore } from '../../core/state/todo.store';
import { FileIpcService } from '../../core/services/ipc/file-ipc.service';
import { readStorage, writeStorage } from '../../shared/utils/typed-storage';

const todoStoreStub = {
  currentSessionId: () => 'sess-1',
  hasTodos: () => true,
  stats: () => ({
    total: 0,
    pending: 0,
    inProgress: 0,
    completed: 0,
    cancelled: 0,
    percentComplete: 0,
  }),
  todos: () => [],
  setSession: () => Promise.resolve(),
};

const fileIpcStub = {
  openPath: () => Promise.resolve(),
  editorOpen: () => Promise.resolve(),
};

/**
 * The vitest config omits the Angular compiler plugin, so signal `input()`
 * metadata isn't generated and `setInput()` wiring fails. Override the input
 * getters directly — same workaround used by child-instances-panel.spec.
 */
function overrideInputs(component: SessionProgressPanelComponent): void {
  const writable = component as unknown as {
    sessionId: () => string | null;
    diffStats: () => null;
    workingDirectory: () => string | null;
  };
  writable.sessionId = () => 'sess-1';
  writable.diffStats = () => null;
  writable.workingDirectory = () => '/repo';
}

describe('SessionProgressPanelComponent', () => {
  let fixture: ComponentFixture<SessionProgressPanelComponent>;

  function createPanel(): void {
    fixture = TestBed.createComponent(SessionProgressPanelComponent);
    overrideInputs(fixture.componentInstance);
    fixture.detectChanges();
  }

  beforeEach(async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [SessionProgressPanelComponent],
      providers: [
        { provide: TodoStore, useValue: todoStoreStub },
        { provide: FileIpcService, useValue: fileIpcStub },
      ],
    }).compileComponents();
  });

  it('renders the expanded panel by default', () => {
    createPanel();
    expect(fixture.nativeElement.querySelector('.progress-panel')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.progress-tab')).toBeNull();
  });

  it('minimises to a restorable pill and persists the choice', () => {
    createPanel();

    const minimise = fixture.nativeElement.querySelector(
      '.panel-header .icon-button',
    ) as HTMLButtonElement;
    expect(minimise.getAttribute('aria-label')).toBe('Minimize progress panel');

    minimise.click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.progress-panel')).toBeNull();
    expect(fixture.nativeElement.querySelector('.progress-tab')).toBeTruthy();
    expect(readStorage(PANEL_COLLAPSED_FIELD)).toBe(true);
  });

  it('restores the panel when the collapsed pill is clicked', () => {
    createPanel();
    fixture.componentInstance.collapsePanel();
    fixture.detectChanges();

    const pill = fixture.nativeElement.querySelector(
      '.progress-tab',
    ) as HTMLButtonElement;
    pill.click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.progress-panel')).toBeTruthy();
    expect(readStorage(PANEL_COLLAPSED_FIELD)).toBe(false);
  });

  it('starts minimised when a collapsed state was persisted', () => {
    writeStorage(PANEL_COLLAPSED_FIELD, true);
    createPanel();

    expect(fixture.nativeElement.querySelector('.progress-tab')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.progress-panel')).toBeNull();
  });
});
