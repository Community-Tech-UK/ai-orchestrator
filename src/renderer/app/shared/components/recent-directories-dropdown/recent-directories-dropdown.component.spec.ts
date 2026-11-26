import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { RecentDirectoriesIpcService } from '../../../core/services/ipc/recent-directories-ipc.service';
import { RecentDirectoriesDropdownComponent } from './recent-directories-dropdown.component';

describe('RecentDirectoriesDropdownComponent dismissal', () => {
  it('skips the backdrop and preserves Escape dismissal from the dropdown search', () => {
    TestBed.configureTestingModule({ providers: [{ provide: RecentDirectoriesIpcService, useValue: { getDirectories: vi.fn(async () => []) } }] });
    const fixture = TestBed.createComponent(RecentDirectoriesDropdownComponent);
    fixture.componentInstance.isOpen.set(true);
    fixture.detectChanges();
    const backdrop = fixture.nativeElement.querySelector('.backdrop') as HTMLButtonElement;
    expect(backdrop.tabIndex).toBe(-1);
    expect(backdrop.getAttribute('aria-hidden')).toBe('true');
    fixture.nativeElement.querySelector('.search-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(fixture.componentInstance.isOpen()).toBe(false);
    fixture.destroy();
  });
});
