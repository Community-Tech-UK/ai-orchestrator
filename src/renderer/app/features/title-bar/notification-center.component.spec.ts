import { By } from '@angular/platform-browser';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationRecord } from '../../../../shared/types/notification.types';
import { SessionNavigator } from '../../core/services/session-navigator.service';
import { NotificationCenterStore } from '../../core/state/notification-center.store';
import { NotificationCenterComponent } from './notification-center.component';
import { ToolLoopAlertStore } from '../../core/state/tool-loop-alert.store';
import { SettingsStore } from '../../core/state/settings.store';

const RECORD: NotificationRecord = {
  id: 'notification-1',
  kind: 'agent-finished',
  title: 'Agent finished',
  body: 'Codex has completed its task',
  urgency: 'normal',
  fingerprint: 'fingerprint',
  createdAt: 1,
  delivery: 'desktop',
};

describe('NotificationCenterComponent', () => {
  const openSession = vi.fn();
  let fixture: ComponentFixture<NotificationCenterComponent>;
  const records = signal<readonly NotificationRecord[]>([RECORD]);
  const store = {
    records: records.asReadonly(),
    count: () => records().length,
    init: vi.fn(),
    dismiss: vi.fn(),
    clearAll: vi.fn(),
    markSeen: vi.fn(),
    markSessionSeen: vi.fn(),
  };

  beforeEach(() => {
    records.set([RECORD]);
    store.init.mockClear();
    store.markSeen.mockClear();
    openSession.mockClear();
    store.dismiss.mockClear();
    store.clearAll.mockClear();
    TestBed.configureTestingModule({
      imports: [NotificationCenterComponent],
      providers: [{ provide: NotificationCenterStore, useValue: store }, { provide: SessionNavigator, useValue: { openSession } }],
    });
    fixture = TestBed.createComponent(NotificationCenterComponent);
    fixture.detectChanges();
  });

  it('shows a badge and opens a compact list of retained notifications', () => {
    expect(store.init).toHaveBeenCalledOnce();
    const trigger = fixture.nativeElement.querySelector('.notification-center-trigger') as HTMLButtonElement;
    expect(trigger.textContent).toContain('1');

    trigger.click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.notification-center-panel')?.textContent)
      .toContain('Codex has completed its task');
  });

  it('names dismiss separately from its hint and makes clearing notifications explicit', () => {
    fixture.nativeElement.querySelector('.notification-center-trigger').click(); fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('[title]')).toHaveLength(0);
    const dismiss = fixture.debugElement.query(By.css('.notification-center-dismiss'));
    expect(dismiss.nativeElement.getAttribute('aria-label')).toBe('Dismiss Agent finished');
    expect(dismiss.injector.get(AioTooltipDirective).appTooltip()).toBe('Dismiss');
    const clear = fixture.debugElement.query(By.css('.notification-center-clear'));
    expect(clear.nativeElement.textContent).toContain('Clear all notifications');
    expect(clear.injector.get(AioTooltipDirective).appTooltip()).toBe('Clear all notifications');
  });

  it('marks only the first ten rendered rows seen and opens a session row', () => {
    records.set(Array.from({ length: 12 }, (_, i) => ({ ...RECORD, id: `n-${i}`, instanceId: 'a', resolvedAt: 2, repeatCount: 3 })));
    fixture.nativeElement.querySelector('.notification-center-trigger').click(); fixture.detectChanges();
    expect(store.markSeen).toHaveBeenLastCalledWith({ ids: Array.from({ length: 10 }, (_, i) => `n-${i}`) });
    expect(fixture.nativeElement.querySelectorAll('li')).toHaveLength(10);
    expect(fixture.nativeElement.textContent).toContain('Resolved');
    expect(fixture.nativeElement.textContent).toContain('×3');
    fixture.nativeElement.querySelector('button.notification-session').click();
    expect(openSession).toHaveBeenCalledWith('a');
  });

  it('dismisses a single record and clears the whole center from the panel', () => {
    const trigger = fixture.nativeElement.querySelector('.notification-center-trigger') as HTMLButtonElement;
    trigger.click();
    fixture.detectChanges();

    const dismiss = fixture.nativeElement.querySelector('.notification-center-dismiss') as HTMLButtonElement;
    dismiss.click();
    expect(store.dismiss).toHaveBeenCalledWith(RECORD.id);

    const clear = fixture.nativeElement.querySelector('.notification-center-clear') as HTMLButtonElement;
    clear.click();
    expect(store.clearAll).toHaveBeenCalledOnce();
  });

  it('hides the clear-all control when the center is empty', () => {
    records.set([]);
    const trigger = fixture.nativeElement.querySelector('.notification-center-trigger') as HTMLButtonElement;
    trigger.click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.notification-center-clear')).toBeNull();
    expect(fixture.nativeElement.querySelector('.notification-center-panel')?.textContent)
      .toContain('No notifications yet.');
  });

  it('keeps the panel open for inside clicks and closes it for outside clicks', () => {
    const host = fixture.nativeElement as HTMLElement;
    const trigger = host.querySelector('.notification-center-trigger') as HTMLButtonElement;
    trigger.click();
    fixture.detectChanges();

    const panel = host.querySelector('.notification-center-panel') as HTMLElement;
    panel.click();
    fixture.detectChanges();

    expect(host.querySelector('.notification-center-panel')).not.toBeNull();

    document.body.click();
    fixture.detectChanges();

    expect(host.querySelector('.notification-center-panel')).toBeNull();
  });
});

/**
 * N2 — inline actions on a tool-loop notification.
 *
 * The gating is the interesting part and is what these mostly cover: the record
 * carries frozen text, so the actions read the LIVE alert instead. A resolved
 * loop must stop offering "Stop this turn", because the record's own promise
 * ("it will keep going") is no longer true and the turn it referred to is over.
 */
describe('NotificationCenterComponent — tool-loop actions (N2)', () => {
  const TOOL_LOOP: NotificationRecord = {
    id: 'notification-loop',
    kind: 'tool-loop',
    instanceId: 'inst-1',
    title: 'A session may be stuck',
    body: 'It has run Read 9 times in a row and got the same result each time. It keeps going until you stop it.',
    urgency: 'critical',
    fingerprint: 'fp-loop',
    createdAt: 2,
    delivery: 'desktop',
  };

  const records = signal<readonly NotificationRecord[]>([TOOL_LOOP]);
  const store = {
    records: records.asReadonly(),
    count: () => records().length,
    init: vi.fn(),
    dismiss: vi.fn(),
    clearAll: vi.fn(),
    markSeen: vi.fn(),
    markSessionSeen: vi.fn(),
  };

  let fixture: ComponentFixture<NotificationCenterComponent>;
  let live: boolean;
  let autoInterrupt: boolean;
  const stopTurn = vi.fn<(id: string) => Promise<boolean>>();
  let stopping = false;
  let detectedAt = 1;
  const update = vi.fn();
  const letContinue = vi.fn();

  function mount(): void {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [NotificationCenterComponent],
      providers: [
        { provide: NotificationCenterStore, useValue: store },
        {
          provide: ToolLoopAlertStore,
          useValue: {
            hasCriticalAlert: () => live, letContinue, stopTurn, isStopping: () => stopping,
            alertFor: (id: string | undefined) => (live && id === 'inst-1' ? { instanceId: id, detectedAt } : null),
          },
        },
        {
          provide: SettingsStore,
          useValue: { settings: () => ({ toolLoopAutoInterrupt: autoInterrupt }), update },
        },
      ],
    });
    fixture = TestBed.createComponent(NotificationCenterComponent);
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.notification-center-trigger') as HTMLButtonElement).click();
    fixture.detectChanges();
  }

  function actions(): HTMLButtonElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('.notification-center-action'));
  }

  beforeEach(() => {
    records.set([TOOL_LOOP]);
    live = true;
    autoInterrupt = false;
    stopTurn.mockReset().mockResolvedValue(true);
    stopping = false;
    detectedAt = 1;
    update.mockClear();
    letContinue.mockClear();
  });

  it('offers both actions while the loop is live and auto-interrupt is off', () => {
    mount();
    expect(actions().map((b) => b.textContent?.trim()))
      .toEqual(['Stop this turn', 'Let it continue', 'Turn on auto-interrupt']);
  });

  it('offers nothing once the loop has resolved, even though the record still says it will keep going', () => {
    live = false;
    mount();
    expect(actions()).toHaveLength(0);
  });

  it('still offers the decision when auto-interrupt is on, since it does not stop every repeat', () => {
    autoInterrupt = true;
    mount();
    expect(actions().map((b) => b.textContent?.trim())).toEqual(['Stop this turn', 'Let it continue']);
  });

  it('offers the choice only on the newest entry for the session, not on older detections', () => {
    const older: NotificationRecord = { ...TOOL_LOOP, id: 'notification-loop-old', fingerprint: 'fp-old', createdAt: 1 };
    records.set([TOOL_LOOP, older]);
    mount();
    const items = Array.from(fixture.nativeElement.querySelectorAll('li')) as HTMLElement[];
    expect(items.map((item) => item.querySelectorAll('.notification-center-action').length)).toEqual([3, 0]);
  });

  it('ties each choice to its entry text, which names the session', () => {
    mount();
    const body = fixture.nativeElement.querySelector('#notification-body-notification-loop') as HTMLElement;
    expect(body.textContent).toContain('It has run Read 9 times');
    expect(actions().slice(0, 2).map((b) => b.getAttribute('aria-describedby')))
      .toEqual(['notification-body-notification-loop', 'notification-body-notification-loop']);
  });

  it('offers nothing on a notification of another kind', () => {
    records.set([RECORD]);
    mount();
    expect(actions()).toHaveLength(0);
  });

  it('"Stop this turn" stops that session the same way the Stop button does', () => {
    mount();
    actions()[0]!.click();
    expect(stopTurn).toHaveBeenCalledWith('inst-1');
    expect(letContinue).not.toHaveBeenCalled();
  });

  it('says so when the turn will not stop, and when the stop itself fails', async () => {
    stopTurn.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('ipc down'));
    mount();
    for (let attempt = 0; attempt < 2; attempt++) {
      actions()[0]!.click();
      await fixture.whenStable(); fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[role="alert"]')?.textContent?.trim())
        .toBe('Could not stop this turn. Open the session and use Stop.');
    }
  });

  it('does not show an old failure on a later alert for the same session', async () => {
    stopTurn.mockResolvedValueOnce(false);
    mount();
    actions()[0]!.click();
    await fixture.whenStable(); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="alert"]')).not.toBeNull();
    detectedAt = 2;
    // Reopen so the template re-reads the (plain-object) alert mock.
    (fixture.nativeElement.querySelector('.notification-center-trigger') as HTMLButtonElement).click(); fixture.detectChanges();
    (fixture.nativeElement.querySelector('.notification-center-trigger') as HTMLButtonElement).click(); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="alert"]')).toBeNull();
  });

  it('disables the choices while a stop is running and says what continuing means', () => {
    stopping = true;
    mount();
    expect(actions().map((b) => [b.textContent?.trim(), b.disabled]))
      .toEqual([['Stopping…', true], ['Let it continue', true], ['Turn on auto-interrupt', false]]);
    expect(fixture.nativeElement.textContent).toContain("If you let it continue, it keeps working and you won't be asked about this again this turn.");
  });

  it('"Let it continue" clears the alert without stopping anything', () => {
    mount();
    actions()[1]!.click();
    expect(letContinue).toHaveBeenCalledWith('inst-1');
    expect(stopTurn).not.toHaveBeenCalled();
  });

  it('"Turn on auto-interrupt" writes the setting and nothing else', () => {
    mount();
    actions()[2]!.click();
    expect(update).toHaveBeenCalledWith({ toolLoopAutoInterrupt: true });
    expect(stopTurn).not.toHaveBeenCalled();
  });
});
