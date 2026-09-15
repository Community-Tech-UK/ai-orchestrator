import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { MobileSessionRowComponent, type MobileSessionRowView } from './mobile-session-row.component';

describe('session row accessible completion state', () => {
  it('announces unread completion in the parent button name and removes it after reading', () => {
    TestBed.overrideComponent(MobileSessionRowComponent, { set: { imports: [], schemas: [NO_ERRORS_SCHEMA] } });
    const fixture = TestBed.createComponent(MobileSessionRowComponent);
    const row = signal<MobileSessionRowView>({ id: 'session-a', title: 'Example task', statusLabel: 'idle', tone: 'idle', unread: true, live: true, lastActivity: 1 });
    (fixture.componentInstance as unknown as { row: () => MobileSessionRowView }).row = row;
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector('button');
    expect(button.getAttribute('aria-label')).toBe('Open Example task, idle, unread completion');
    expect(fixture.nativeElement.querySelector('.session-row__unread').getAttribute('aria-hidden')).toBe('true');
    expect(fixture.nativeElement.querySelector('.session-row__title .session-row__unread')).toBeNull();
    row.update((value) => ({ ...value, unread: false })); fixture.detectChanges();
    expect(button.getAttribute('aria-label')).toBe('Open Example task, idle');
    expect(fixture.nativeElement.querySelector('.session-row__unread')).toBeNull();
  });
});
