import { signal } from '@angular/core';
import type { DestroyRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { NoticeSlotService } from './notice-slot.service';
import { NoticeOverflowComponent } from './notice-overflow.component';

describe('NoticeOverflowComponent', () => {
  it('names hidden notices and exposes expansion through a real button', () => {
    TestBed.configureTestingModule({ imports: [NoticeOverflowComponent] });
    const service = TestBed.inject(NoticeSlotService);
    const ref = { onDestroy: vi.fn() } as unknown as DestroyRef;
    service.register('pause', signal(true), ref);
    service.register('app-update', signal(true), ref);
    service.register('getting-started', signal(true), ref);
    const fixture = TestBed.createComponent(NoticeOverflowComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('2 more notices: App update, Getting started');
    const button = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    expect(button.getAttribute('aria-expanded')).toBe('false');
    button.click(); fixture.detectChanges();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.textContent).toContain('Show fewer');
  });
});
