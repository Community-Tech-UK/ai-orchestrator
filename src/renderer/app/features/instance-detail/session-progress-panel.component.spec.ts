import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PANEL_COLLAPSED_FIELD,
  SessionProgressPanelComponent,
} from './session-progress-panel.component';
import { TodoStore } from '../../core/state/todo.store';
import { FileIpcService } from '../../core/services/ipc/file-ipc.service';
import { readStorage, writeStorage } from '../../shared/utils/typed-storage';
import type { ArtifactEntry } from '../chats/session-artifacts.util';

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
  openPath: vi.fn(() => Promise.resolve(true)),
  editorOpen: vi.fn(() => Promise.resolve(true)),
  revealFile: vi.fn(() => Promise.resolve({ success: true })),
  copyFileToClipboard: vi.fn(() => Promise.resolve(true)),
};

function makeEntry(overrides: Partial<ArtifactEntry> = {}): ArtifactEntry {
  return {
    relPath: 'docs/spec.md',
    absPath: '/repo/docs/spec.md',
    basename: 'spec.md',
    status: 'modified',
    category: 'doc',
    added: 1,
    deleted: 0,
    outsideCwd: false,
    ...overrides,
  };
}

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
    vi.clearAllMocks();
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

  describe('output context menu', () => {
    it('opens the context menu at the cursor position on right-click', () => {
      createPanel();
      const entry = makeEntry();
      const event = {
        preventDefault: vi.fn(),
        clientX: 120,
        clientY: 240,
      } as unknown as MouseEvent;

      fixture.componentInstance.onOutputContextMenu(event, entry);

      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(fixture.componentInstance.outputMenu()).toEqual({
        entry,
        x: 120,
        y: 240,
      });
    });

    it('opens the file with the preferred program', async () => {
      createPanel();
      await fixture.componentInstance.openWithDefault(makeEntry());
      expect(fileIpcStub.openPath).toHaveBeenCalledWith('/repo/docs/spec.md');
    });

    it('reveals the file in Finder', async () => {
      createPanel();
      await fixture.componentInstance.revealInFinder(makeEntry());
      expect(fileIpcStub.revealFile).toHaveBeenCalledWith('/repo/docs/spec.md');
    });

    it('copies the absolute path via the Clipboard API when available', async () => {
      createPanel();
      const writeText = vi.fn(() => Promise.resolve());
      vi.stubGlobal('navigator', { clipboard: { writeText } });

      await fixture.componentInstance.copyPath(makeEntry());

      expect(writeText).toHaveBeenCalledWith('/repo/docs/spec.md');
      expect(fileIpcStub.copyFileToClipboard).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it('falls back to file-clipboard IPC when the Clipboard API is blocked', async () => {
      createPanel();
      const writeText = vi.fn(() => Promise.reject(new Error('blocked')));
      vi.stubGlobal('navigator', { clipboard: { writeText } });

      await fixture.componentInstance.copyPath(makeEntry());

      expect(fileIpcStub.copyFileToClipboard).toHaveBeenCalledWith('/repo/docs/spec.md');
      vi.unstubAllGlobals();
    });
  });
});
