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
  };

  beforeEach(() => {
    records.set([RECORD]);
    store.init.mockClear();
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
});
