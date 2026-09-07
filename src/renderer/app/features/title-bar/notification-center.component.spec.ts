import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationRecord } from '../../../../shared/types/notification.types';
import { NotificationCenterStore } from '../../core/state/notification-center.store';
import { NotificationCenterComponent } from './notification-center.component';
import { ToolLoopAlertStore } from '../../core/state/tool-loop-alert.store';
import { InstanceStore } from '../../core/state/instance.store';
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
  let fixture: ComponentFixture<NotificationCenterComponent>;
  const records = signal<readonly NotificationRecord[]>([RECORD]);
  const store = {
    records: records.asReadonly(),
    count: () => records().length,
    init: vi.fn(),
    dismiss: vi.fn(),
    clearAll: vi.fn(),
  };

  beforeEach(() => {
    records.set([RECORD]);
    store.init.mockClear();
    store.dismiss.mockClear();
    store.clearAll.mockClear();
    TestBed.configureTestingModule({
      imports: [NotificationCenterComponent],
      providers: [{ provide: NotificationCenterStore, useValue: store }],
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
 * loop must stop offering "Interrupt now", because the record's own promise
 * ("it will keep going") is no longer true and the turn it referred to is over.
 */
describe('NotificationCenterComponent — tool-loop actions (N2)', () => {
  const TOOL_LOOP: NotificationRecord = {
    id: 'notification-loop',
    kind: 'tool-loop',
    instanceId: 'inst-1',
    title: 'Agent stuck in a tool loop',
    body: 'repeating Read (9 calls in 2 minutes). It will keep going until you stop it — auto-interrupt is off.',
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
  };

  let fixture: ComponentFixture<NotificationCenterComponent>;
  let live: boolean;
  let autoInterrupt: boolean;
  const interruptInstance = vi.fn();
  const update = vi.fn();
  const acknowledge = vi.fn();

  function mount(): void {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [NotificationCenterComponent],
      providers: [
        { provide: NotificationCenterStore, useValue: store },
        {
          provide: ToolLoopAlertStore,
          useValue: { hasCriticalAlert: () => live, acknowledge },
        },
        { provide: InstanceStore, useValue: { interruptInstance } },
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
    interruptInstance.mockClear();
    update.mockClear();
    acknowledge.mockClear();
  });

  it('offers both actions while the loop is live and auto-interrupt is off', () => {
    mount();
    expect(actions().map((b) => b.textContent?.trim()))
      .toEqual(['Interrupt now', 'Turn on auto-interrupt']);
  });

  it('offers nothing once the loop has resolved, even though the record still says it will keep going', () => {
    live = false;
    mount();
    expect(actions()).toHaveLength(0);
  });

  it('offers nothing when auto-interrupt is already on', () => {
    autoInterrupt = true;
    mount();
    expect(actions()).toHaveLength(0);
  });

  it('offers nothing on a notification of another kind', () => {
    records.set([RECORD]);
    mount();
    expect(actions()).toHaveLength(0);
  });

  it('"Interrupt now" interrupts that instance and stops re-offering the action', () => {
    mount();
    actions()[0]!.click();
    expect(interruptInstance).toHaveBeenCalledWith('inst-1');
    expect(acknowledge).toHaveBeenCalledWith('inst-1');
  });

  it('"Turn on auto-interrupt" writes the setting and nothing else', () => {
    mount();
    actions()[1]!.click();
    expect(update).toHaveBeenCalledWith({ toolLoopAutoInterrupt: true });
    expect(interruptInstance).not.toHaveBeenCalled();
  });
});
