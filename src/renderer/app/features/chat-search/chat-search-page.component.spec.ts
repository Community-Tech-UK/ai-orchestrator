import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import { HistoryStore } from '../../core/state/history.store';
import { InstanceStore } from '../../core/state/instance.store';
import { ChatSearchPageComponent } from './chat-search-page.component';

describe('ChatSearchPageComponent', () => {
  it('excludes hidden sidechat runtimes and history from search results and the searchable count', () => {
    TestBed.configureTestingModule({ providers: [
      { provide: HistoryStore, useValue: { entries: signal([
        { id: 'history', displayName: 'Release history', firstUserMessage: '', lastUserMessage: '', workingDirectory: '/work', endedAt: 1 },
        { id: 'sidechat-history', displayName: 'Release sidechat history', firstUserMessage: '', lastUserMessage: '', workingDirectory: '/work', endedAt: 1, hideFromProjectRail: true },
      ]), loading: signal(false) } },
      { provide: InstanceStore, useValue: { instances: signal([
        { id: 'session', displayName: 'Release session', workingDirectory: '/work', lastActivity: 2 },
        { id: 'sidechat-runtime', displayName: 'Release sidechat', metadata: { hideFromProjectRail: true, sideChatId: 'sidechat' } },
      ]) } },
      { provide: Router, useValue: {} },
    ] });
    const component = TestBed.runInInjectionContext(() => new ChatSearchPageComponent());
    component.query.set('Release');

    expect(component.totalSearchable()).toBe(2);
    expect(component.results().map(result => result.id)).toEqual(['live:session', 'history']);
    TestBed.resetTestingModule();
  });

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
