import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import { HistoryStore } from '../../core/state/history.store';
import { InstanceStore } from '../../core/state/instance.store';
import { ChatSearchPageComponent } from './chat-search-page.component';

describe('ChatSearchPageComponent', () => {
  it('describes the fields searched without promising message search', () => {
    TestBed.configureTestingModule({ imports: [ChatSearchPageComponent], providers: [
      { provide: HistoryStore, useValue: { entries: signal([]), loading: signal(false), loadHistory: vi.fn() } },
      { provide: InstanceStore, useValue: { instances: signal([]) } },
      { provide: Router, useValue: { navigate: vi.fn() } },
    ] });
    const fixture = TestBed.createComponent(ChatSearchPageComponent);
    try {
      fixture.detectChanges();
      const input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
      expect(input.placeholder).toBe('Search session names, prompts and folders…');
      expect(input.placeholder.toLowerCase()).not.toContain('messages');
    } finally { fixture.destroy(); }
  });
});
