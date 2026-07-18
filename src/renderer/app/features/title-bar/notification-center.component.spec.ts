import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationRecord } from '../../../../shared/types/notification.types';
import { NotificationCenterStore } from '../../core/state/notification-center.store';
import { NotificationCenterComponent } from './notification-center.component';

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
