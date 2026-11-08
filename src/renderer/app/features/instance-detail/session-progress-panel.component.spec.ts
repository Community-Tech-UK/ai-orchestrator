import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STRIP_EXPANDED_FIELD,
  SessionProgressPanelComponent,
} from './session-progress-panel.component';
import type { Instance } from '../../core/state/instance/instance.types';
import { TodoStore } from '../../core/state/todo.store';
import { FileIpcService } from '../../core/services/ipc/file-ipc.service';
import { readStorage, writeStorage } from '../../shared/utils/typed-storage';
import type { TodoItem } from '../../../../shared/types/todo.types';
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
function overrideInputs(component: SessionProgressPanelComponent, diffStats: Instance['diffStats'] | null = null): void {
  const writable = component as unknown as {
    sessionId: () => string | null;
    diffStats: () => Instance['diffStats'] | null;
    workingDirectory: () => string | null;
  };
  writable.sessionId = () => 'sess-1';
  writable.diffStats = () => diffStats;
  writable.workingDirectory = () => '/repo';
}

function documents(...names: string[]): Instance['diffStats'] {
  return {
    totalAdded: names.length,
    totalDeleted: 0,
    files: Object.fromEntries(names.map((name) => [`docs/${name}`, { path: `docs/${name}`, status: 'added' as const, added: 1, deleted: 0 }])),
  };
}

describe('SessionProgressPanelComponent', () => {
  let fixture: ComponentFixture<SessionProgressPanelComponent>;

  function createPanel(diffStats: Instance['diffStats'] | null = null): void {
    fixture = TestBed.createComponent(SessionProgressPanelComponent);
    document.body.appendChild(fixture.nativeElement);
    overrideInputs(fixture.componentInstance, diffStats);
    fixture.detectChanges();
  }

  const query = (selector: string) => fixture.nativeElement.querySelector(selector) as HTMLElement | null;
  const queryAll = (selector: string) => [...fixture.nativeElement.querySelectorAll(selector)] as HTMLElement[];

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

  it('shows the running sixth task, opens every task, and can fold again', () => {
    const tasks = Array.from({ length: 7 }, (_, i) => ({ id: String(i), content: `Task ${i + 1}`, status: i === 5 ? 'in_progress' : i < 5 ? 'completed' : 'pending' } as TodoItem));
    TestBed.overrideProvider(TodoStore, { useValue: { ...todoStoreStub, todos: () => tasks } });
    writeStorage(STRIP_EXPANDED_FIELD, true);
    createPanel();
    expect(fixture.nativeElement.textContent).toContain('Task 6');
    expect(queryAll('.task-row')).toHaveLength(5);
    const more = query('button.more-row') as HTMLButtonElement;
    expect(more?.textContent).toContain('2 earlier'); more.click(); fixture.detectChanges();
    expect(queryAll('.task-row')).toHaveLength(7);
    const fewer = query('button.more-row') as HTMLButtonElement;
    expect(fewer).toBe(more);
    expect(fewer.textContent).toContain('Show fewer'); fewer.click(); fixture.detectChanges();
    expect(queryAll('.task-row')).toHaveLength(5);
  });

  it('starts folded to one line that names the current task', () => {
    const tasks = [
      { id: '1', content: 'Write the plan', status: 'completed' },
      { id: '2', content: 'Fix the list', activeForm: 'Fixing the list', status: 'in_progress' },
    ] as TodoItem[];
    TestBed.overrideProvider(TodoStore, { useValue: { ...todoStoreStub, todos: () => tasks, stats: () => ({ ...todoStoreStub.stats(), total: 2, completed: 1, percentComplete: 50 }) } });
    createPanel();
    const toggle = query('.strip-toggle') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain('1 of 2 done');
    expect(toggle.textContent).toContain('Now: Fixing the list');
    expect(query('.strip-detail')).toBeNull();
  });

  it('unfolds in place, keeps the choice, and has no native titles', () => {
    createPanel();
    const toggle = fixture.debugElement.query(By.css('.strip-toggle'));
    expect(toggle.injector.get(AioTooltipDirective, null)?.appTooltip()).toBe('Show the task list');
    expect(queryAll('[title]')).toHaveLength(0);

    toggle.nativeElement.click();
    fixture.detectChanges();
    expect(query('.strip-detail')).toBeTruthy();
    expect(toggle.nativeElement.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.injector.get(AioTooltipDirective, null)?.appTooltip()).toBe('Hide the task list');
    expect(readStorage(STRIP_EXPANDED_FIELD)).toBe(true);

    toggle.nativeElement.click();
    fixture.detectChanges();
    expect(query('.strip-detail')).toBeNull();
    expect(readStorage(STRIP_EXPANDED_FIELD)).toBe(false);
  });

  it('starts unfolded when that was the last choice', () => {
    writeStorage(STRIP_EXPANDED_FIELD, true);
    createPanel();
    expect(query('.strip-detail')).toBeTruthy();
  });

  it('names the first documents on the folded line and opens the rest in place', () => {
    TestBed.overrideProvider(TodoStore, { useValue: { ...todoStoreStub, hasTodos: () => false } });
    createPanel(documents('a.md', 'b.md', 'c.md', 'd.md', 'e.md'));
    expect(query('.strip-toggle')?.textContent).toContain('5 documents');
    expect(queryAll('.strip-documents .doc-chip').map((chip) => chip.textContent?.trim())).toEqual(['a.md', 'b.md', 'c.md']);

    (query('.doc-more') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(queryAll('.document-list .doc-chip')).toHaveLength(5);
    expect(document.activeElement).toBe(query('.strip-toggle'));
    expect(query('.strip-toggle')?.getAttribute('aria-controls')).toBe('session-work-strip-detail');
    expect(query('.strip-documents')).toBeNull();
  });

  it('opens a document from its chip', () => {
    TestBed.overrideProvider(TodoStore, { useValue: { ...todoStoreStub, hasTodos: () => false } });
    createPanel(documents('report.md'));
    expect(query('.strip-toggle')?.textContent).toContain('1 document');
    (query('.strip-documents .doc-chip') as HTMLButtonElement).click();
    expect(fileIpcStub.editorOpen).toHaveBeenCalledWith('/repo/docs/report.md', { line: 1 });
  });

  it('renders nothing when there are no tasks or documents', () => {
    TestBed.overrideProvider(TodoStore, { useValue: { ...todoStoreStub, hasTodos: () => false } });
    createPanel();
    expect(query('.work-strip')).toBeNull();
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
