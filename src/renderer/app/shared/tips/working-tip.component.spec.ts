import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeybindingService } from '../../core/services/keybinding.service';
import { WorkingTipComponent } from './working-tip.component';
import { FeatureUsageService } from './feature-usage.service';
import type { WorkingTipRuntime } from './working-tip.service';

describe('waiting-time tip line', () => {
  let fixture: ComponentFixture<WorkingTipComponent>;
  let usage: FeatureUsageService;
  const shortcut = signal('Ctrl+K');
  let runtime: WorkingTipRuntime;
  beforeEach(async () => {
    TestBed.resetTestingModule(); localStorage.removeItem('working-tips:v1');
    vi.useFakeTimers(); vi.setSystemTime(1_000_000); shortcut.set('Ctrl+K');
    await TestBed.configureTestingModule({ imports: [WorkingTipComponent], providers: [
      { provide: KeybindingService, useValue: { formatBindingByAction: () => shortcut() } },
    ] }).compileComponents();
    fixture = TestBed.createComponent(WorkingTipComponent); usage = TestBed.inject(FeatureUsageService);
    runtime = { sessionId: 'session-1', busySince: Date.now(), enabled: true, composerText: '',
      queuedCount: 0, activeLoop: false, sessionCount: 4, hasReply: true, contextPercentage: 70,
      compactPreviewAvailable: false };
    fixture.componentRef.setInput('context', runtime); fixture.detectChanges();
  });
  afterEach(() => { fixture.destroy(); TestBed.resetTestingModule(); vi.useRealTimers(); });

  async function wait(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms); fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(20); fixture.detectChanges();
  }
  function change(patch: Partial<WorkingTipRuntime>): void {
    runtime = { ...runtime, ...patch }; fixture.componentRef.setInput('context', runtime); fixture.detectChanges();
  }

  it('renders one muted non-live line at thirty seconds and counts it only after rendering', async () => {
    await wait(29_000); expect(fixture.nativeElement.textContent).not.toContain('Tip:');
    expect(usage.shownCounts()['steer']).toBeUndefined();
    await wait(1_000); expect(fixture.nativeElement.textContent).toContain('Tip:');
    expect(fixture.nativeElement.querySelector('[role="note"]').getAttribute('aria-live')).toBeNull();
    expect(usage.shownCounts()['steer']).toBe(1);
    await wait(30_000); expect(usage.shownCounts()['steer']).toBe(1);
  });

  it('hides immediately on typing and never replaces a painted tip during the same busy period', async () => {
    await wait(30_000); change({ composerText: 'a' });
    expect(fixture.nativeElement.textContent).not.toContain('Tip:');
    change({ composerText: '' }); await wait(6_000);
    expect(fixture.nativeElement.textContent).not.toContain('Tip:');
  });

  it('hides on leaving busy or disabling tips and stops the timer', async () => {
    await wait(30_000); change({ enabled: false });
    expect(fixture.nativeElement.textContent).not.toContain('Tip:');
    expect(vi.getTimerCount()).toBe(0);
    change({ enabled: true, busySince: null });
    expect(fixture.nativeElement.textContent).not.toContain('Tip:');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retires Got it permanently and reacts to feature use', async () => {
    await wait(30_000); fixture.nativeElement.querySelector('button').click(); fixture.detectChanges();
    expect(usage.shownCounts()['steer']).toBe(3);
    expect(fixture.nativeElement.textContent).not.toContain('Tip:');
    change({ sessionId: 'session-2', busySince: Date.now() }); await wait(600_000);
    expect(fixture.nativeElement.textContent).toContain('side chat');
    usage.record('toggle-side-chat'); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('Tip:');
  });

  it('uses a live shortcut and hides an unbound shortcut without advertising another tip that turn', async () => {
    usage.record('steer'); await wait(30_000);
    expect(fixture.nativeElement.textContent).toContain('Ctrl+K');
    shortcut.set('Alt+S'); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Alt+S');
    shortcut.set(''); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('Tip:');
  });

  it('suppresses keystrokes and dialogs before a tip appears', async () => {
    await wait(28_000); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' }));
    await wait(2_000); expect(fixture.nativeElement.textContent).not.toContain('Tip:');
    const modal = document.createElement('div'); modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
    document.body.appendChild(modal);
    try { await wait(6_000); expect(fixture.nativeElement.textContent).not.toContain('Tip:'); }
    finally { modal.remove(); }
    await wait(1_000); expect(fixture.nativeElement.textContent).toContain('Tip:');
  });

  it('allows keyboard navigation to Got it without hiding the tip', async () => {
    await wait(30_000);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' })); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('button')?.textContent).toBe('Got it');
  });

  it('keeps a painted tip visible through streaming scrolls and transcript mutations', async () => {
    await wait(30_000);
    const formatShortcut = vi.spyOn(TestBed.inject(KeybindingService), 'formatBindingByAction');
    const transcript = document.createElement('div');
    document.body.appendChild(transcript);
    try {
      transcript.textContent = 'Streaming reply';
      transcript.dispatchEvent(new Event('scroll'));
      await Promise.resolve(); fixture.detectChanges();
      expect(formatShortcut).not.toHaveBeenCalled();
      expect(fixture.nativeElement.textContent).toContain('Tip:');
      expect(usage.shownCounts()['steer']).toBe(1);
      await wait(6_000);
      expect(fixture.nativeElement.textContent).toContain('Tip:');
      expect(usage.shownCounts()['steer']).toBe(1);
    } finally { transcript.remove(); formatShortcut.mockRestore(); }
  });

  it('hides immediately when a dialog opens between timer ticks', async () => {
    await wait(30_000);
    const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
    document.body.appendChild(dialog);
    try {
      await Promise.resolve(); fixture.detectChanges();
      expect(fixture.nativeElement.textContent).not.toContain('Tip:');
    } finally { dialog.remove(); }
  });

  it('keeps the launch cap and cooldown across session changes and never repeats the previous tip', async () => {
    await wait(30_000); expect(fixture.nativeElement.textContent).toContain('Steer');
    change({ sessionId: 'session-2', busySince: Date.now() });
    await wait(30_000); expect(fixture.nativeElement.textContent).not.toContain('Tip:');
    await wait(570_000); expect(fixture.nativeElement.textContent).toContain('side chat');
    change({ sessionId: 'session-3', busySince: Date.now() });
    await wait(600_000); expect(fixture.nativeElement.textContent).not.toContain('Tip:');
  });
});
