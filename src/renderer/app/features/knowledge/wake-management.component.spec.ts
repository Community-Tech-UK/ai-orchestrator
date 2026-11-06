import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { By } from '@angular/platform-browser';
import { KnowledgeStore } from '../../core/state/knowledge.store';
import { UndoService } from '../../core/services/undo.service';
import { ToastService } from '../../core/services/toast.service';
import type { WakeContext, WakeHint } from '../../../../shared/types/wake-context.types';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { WakeManagementComponent } from './wake-management.component';

const addedAt = new Date('2026-10-01T12:00:00Z').getTime();
function note(overrides: Partial<WakeHint> = {}): WakeHint {
  return { id: 'note-a', content: 'Read the architecture before changing services.', importance: 7,
    room: 'architecture', createdAt: addedAt, lastUsed: addedAt + 86_400_000, usageCount: 12, ...overrides };
}

describe('WakeManagementComponent project notes', () => {
  let fixture: ComponentFixture<WakeManagementComponent>;
  let hints: ReturnType<typeof signal<WakeHint[]>>;
  let selectedProjectKey: ReturnType<typeof signal<string>>;
  let store: {
    loading: ReturnType<typeof signal<boolean>>;
    wakeHints: typeof hints;
    selectedProjectKey: typeof selectedProjectKey;
    wakeIdentity: ReturnType<typeof signal<string>>;
    wakeContext: ReturnType<typeof signal<WakeContext | null>>;
    hintCount: () => number;
    loadIdentity: ReturnType<typeof vi.fn>;
    listHints: ReturnType<typeof vi.fn>;
    loadWakeContext: ReturnType<typeof vi.fn>;
    setIdentity: ReturnType<typeof vi.fn>;
    removeHint: ReturnType<typeof vi.fn>;
    addHint: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    hints = signal([note({ sourceReflectionId: 'lesson-a' }), note({ id: 'note-b', content: 'Check errors before retrying.', sourceSessionId: 'session-a' }), note({ id: 'note-c', content: 'Keep functions short.', lastUsed: 0 })]);
    selectedProjectKey = signal('');
    store = {
      loading: signal(false), wakeHints: hints, selectedProjectKey, wakeIdentity: signal('Project description'),
      wakeContext: signal<WakeContext | null>({ identity: { level: 'L0', content: 'About the project', tokenEstimate: 20, generatedAt: addedAt },
        essentialStory: { level: 'L1', content: '## L1 — ESSENTIAL STORY\nBackground', tokenEstimate: 40, generatedAt: addedAt }, totalTokens: 60, generatedAt: addedAt }),
      hintCount: () => hints().length,
      loadIdentity: vi.fn(async () => undefined), listHints: vi.fn(async () => undefined), loadWakeContext: vi.fn(async () => undefined),
      setIdentity: vi.fn(async () => true),
      removeHint: vi.fn(async (id: string) => { hints.update((notes) => notes.filter((item) => item.id !== id)); return true; }),
      addHint: vi.fn(async (content: string, importance: number, room: string) => {
        hints.update((notes) => [...notes, note({ id: 'restored', content, importance, room, createdAt: Date.now(), lastUsed: 0, usageCount: 0 })]);
        return true;
      }),
    };
    await TestBed.configureTestingModule({ imports: [WakeManagementComponent], providers: [{ provide: KnowledgeStore, useValue: store }] }).compileComponents();
    fixture = TestBed.createComponent(WakeManagementComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });
  afterEach(() => { fixture.destroy(); vi.useRealTimers(); });

  function button(label: string): HTMLButtonElement {
    return Array.from(fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>)
      .find((item) => item.textContent?.trim() === label)!;
  }

  it('uses plain labels, priority, shown count and note provenance', () => {
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('About this project');
    expect(text).toContain('Rebuild starting notes');
    expect(text).toContain('Project (optional)');
    expect(text).toContain('Key background');
    expect(text).toContain('Project notes (3)');
    expect(text).toContain('Shown 12 times');
    expect(text).toContain('priority 7');
    expect(text).toContain('from a lesson');
    expect(text).toContain('from a past session');
    expect(text).toContain('added by you');
    expect(text).toContain('Added');
    expect(text).toContain('Last shown');
    hints.set([note({ usageCount: 1 })]); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Shown 1 time');
    expect(text).not.toMatch(/\b(Wing|Room|L0|L1|Importance|Wake Hints)\b/);
    button('+ Add note').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Priority (0-10)');
    expect(fixture.nativeElement.textContent).toContain('Topic');
  });

  it('shows a visible reason and guards rebuild until a project is available', async () => {
    expect(button('Rebuild starting notes').disabled).toBe(true);
    expect(fixture.nativeElement.textContent).toContain('Pick a project first.');
    store.loadWakeContext.mockClear();
    await fixture.componentInstance.regenerate();
    expect(store.loadWakeContext).not.toHaveBeenCalled();
    selectedProjectKey.set('/project');
    fixture.detectChanges();
    expect(button('Rebuild starting notes').disabled).toBe(false);
    button('Rebuild starting notes').click();
    await fixture.whenStable();
    expect(store.loadWakeContext).toHaveBeenCalledWith('/project');
    expect(fixture.nativeElement.textContent).not.toContain('Pick a project first.');
  });

  it('puts useful hover help on every note control and the source of a lesson', () => {
    button('+ Add note').click();
    button('Edit').click();
    fixture.detectChanges();
    const hosts = fixture.debugElement.queryAll(By.directive(AioTooltipDirective));
    const controls = fixture.nativeElement.querySelectorAll('button, input, textarea');
    for (const control of controls) expect(hosts.some((host) => host.nativeElement === control)).toBe(true);
    const tips = hosts.map((host) => host.injector.get(AioTooltipDirective).appTooltip());
    expect(tips).toContain('Higher numbers are included first when there is not enough room.');
    expect(tips.some((tip) => tip?.includes('until you approve it'))).toBe(true);
  });

  it('removes a note, offers Undo for five seconds, and restores only the original editable fields', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T12:00:00Z'));
    await fixture.componentInstance.removeHint('note-a');
    fixture.detectChanges();
    const toast = TestBed.inject(ToastService).toasts()[0];
    expect(toast.text).toBe('Removed note ‘Read the architecture before changing se’');
    expect(toast.action?.label).toBe('Undo');
    expect(hints().some((item) => item.id === 'note-a')).toBe(false);
    await TestBed.inject(UndoService).undoLast();
    fixture.detectChanges();
    expect(store.addHint).toHaveBeenCalledWith(note().content, 7, 'architecture');
    const restored = hints().find((item) => item.id === 'restored')!;
    expect(restored.sourceReflectionId).toBeUndefined();
    expect(restored.sourceSessionId).toBeUndefined();
    expect(restored.createdAt).toBe(Date.now());
    const row = Array.from(fixture.nativeElement.querySelectorAll('.hint-item') as NodeListOf<HTMLElement>)
      .find((item) => item.textContent?.includes('Shown 0 times'))!;
    expect(row.textContent).toContain('added by you');
    expect(row.textContent).toContain('Shown 0 times');

    await fixture.componentInstance.removeHint('note-b');
    await vi.advanceTimersByTimeAsync(5000);
    await TestBed.inject(UndoService).undoLast();
    expect(store.addHint).toHaveBeenCalledTimes(1);
  });

  it('does not offer Undo when deletion fails or the note is no longer listed', async () => {
    store.removeHint.mockResolvedValueOnce(false);
    await fixture.componentInstance.removeHint('note-a');
    expect(TestBed.inject(ToastService).toasts()).toEqual([]);
    await fixture.componentInstance.removeHint('missing');
    expect(store.removeHint).toHaveBeenCalledTimes(1);
  });
});

const now = Date.now();
const notes: WakeHint[] = [
  { id: 'active', content: 'Use const', importance: 8, room: 'general', createdAt: now, lastUsed: now, usageCount: 3 },
  { id: 'duplicate', content: 'use const', importance: 5, room: 'general', createdAt: now, lastUsed: now, usageCount: 0 },
  { id: 'legacy', content: 'Old note', importance: 5, room: 'general', createdAt: 1, lastUsed: 1, usageCount: 1 },
];
const removalStore = {
  wakeHints: signal(notes), hintCount: () => 3, wakeIdentity: signal('Identity'),
  wakeContext: signal(null), loading: signal(false), selectedProjectKey: signal(''),
  loadIdentity: vi.fn(), listHints: vi.fn(), loadWakeContext: vi.fn(), removeHint: vi.fn().mockResolvedValue(true),
};

describe('WakeManagementComponent', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await TestBed.configureTestingModule({ imports: [WakeManagementComponent], providers: [{ provide: KnowledgeStore, useValue: removalStore }] }).compileComponents();
  });
  it('shows current unique notes, a weekly summary, and exposes legacy/duplicate notes through Hidden', () => {
    const fixture = TestBed.createComponent(WakeManagementComponent);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('3 notes, 2 different, 1 shown this week');
    expect(root.querySelectorAll('.hint-item')).toHaveLength(1);
    expect(root.textContent).toContain('Shown 3 times');
    const hidden = [...root.querySelectorAll('button')].find(button => button.textContent?.includes('Hidden'))!;
    hidden.click(); fixture.detectChanges();
    expect(root.querySelectorAll('.hint-item')).toHaveLength(2);
    expect(root.textContent).toContain('Old note');
  });
  it('requires click-time confirmation with the note before removing it', async () => {
    const fixture = TestBed.createComponent(WakeManagementComponent);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    (root.querySelector('.hint-item button') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(removalStore.removeHint).not.toHaveBeenCalled();
    expect(root.querySelector('[role="alertdialog"]')?.textContent).toContain('Removes 1 note (9 characters)');
    (root.querySelector('[role="alertdialog"] .btn-danger') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(removalStore.removeHint).toHaveBeenCalledWith('active');
  });
});
