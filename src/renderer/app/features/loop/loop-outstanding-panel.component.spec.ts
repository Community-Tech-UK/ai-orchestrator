import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import type { LoopOutstandingItemPayload } from '@contracts/schemas/loop';
import { LoopStore } from '../../core/state/loop.store';
import { LoopIpcService } from '../../core/services/ipc/loop-ipc.service';
import {
  LoopOutstandingPanelComponent,
  buildOutstandingQuery,
  outstandingHasAnswer,
  outstandingItemInScope,
  outstandingUnsavedAnswer,
} from './loop-outstanding-panel.component';

await resolveComponentResources(url => Promise.resolve(url.endsWith('.html')
  ? readFileSync(join(__dirname, url.split('/').pop()!), 'utf8')
  : ''));

/**
 * Tests for the pure answer-detection helpers behind the "Resume with answers (N)"
 * count. Regression guard for the bug where a typed-but-unsaved answer showed
 * "Resume with answers (0)" — the count must reflect a draft the user has typed
 * (it is flushed to the DB on resume), but NOT a pre-filled recommendation the
 * user hasn't touched.
 *
 * The pure helpers are tested directly (same pattern as `deriveReattemptSeed`);
 * the render gate below covers the component's visibility rule.
 */
describe('outstandingUnsavedAnswer', () => {
  it('returns undefined when there is no draft (just a persisted value or recommendation)', () => {
    expect(outstandingUnsavedAnswer(null, undefined)).toBeUndefined();
    expect(outstandingUnsavedAnswer('saved answer', undefined)).toBeUndefined();
  });

  it('returns the draft text when the user typed something new', () => {
    expect(outstandingUnsavedAnswer(null, 'my decision')).toBe('my decision');
    expect(outstandingUnsavedAnswer('', 'my decision')).toBe('my decision');
  });

  it('returns the edited draft when it differs from the persisted answer', () => {
    expect(outstandingUnsavedAnswer('old', 'new')).toBe('new');
  });

  it('returns undefined when the draft equals the persisted answer (no pending edit)', () => {
    expect(outstandingUnsavedAnswer('same', 'same')).toBeUndefined();
  });

  it('returns undefined for a whitespace-only / cleared draft', () => {
    expect(outstandingUnsavedAnswer(null, '   ')).toBeUndefined();
    expect(outstandingUnsavedAnswer(null, '')).toBeUndefined();
  });
});

describe('outstandingHasAnswer', () => {
  it('counts a persisted answer', () => {
    expect(outstandingHasAnswer('saved', undefined)).toBe(true);
  });

  it('counts a typed-but-unsaved answer (the bug fix)', () => {
    expect(outstandingHasAnswer(null, 'typed but not saved')).toBe(true);
    expect(outstandingHasAnswer('', 'typed but not saved')).toBe(true);
  });

  it('does NOT count an item with no persisted answer and no draft', () => {
    expect(outstandingHasAnswer(null, undefined)).toBe(false);
    expect(outstandingHasAnswer('', undefined)).toBe(false);
  });

  it('does NOT count a whitespace-only persisted value or draft', () => {
    expect(outstandingHasAnswer('   ', undefined)).toBe(false);
    expect(outstandingHasAnswer(null, '   ')).toBe(false);
  });

  it('still counts a persisted answer even if the draft was cleared to match it', () => {
    // draft === persisted → no pending edit, but the persisted value still counts.
    expect(outstandingHasAnswer('keep me', 'keep me')).toBe(true);
  });
});

describe('outstandingItemInScope', () => {
  const item = {
    chatId: 'chat-1',
    workspaceCwd: '/repo/target',
  };

  it('requires both chat and workspace to match when both scopes are known', () => {
    expect(outstandingItemInScope(item, 'chat-1', '/repo/target')).toBe(true);
    expect(outstandingItemInScope(item, 'chat-1', '/repo/other')).toBe(false);
    expect(outstandingItemInScope(item, 'chat-2', '/repo/target')).toBe(false);
  });

  it('keeps chat-only and workspace-only scopes available', () => {
    expect(outstandingItemInScope(item, 'chat-1', null)).toBe(true);
    expect(outstandingItemInScope(item, null, '/repo/target')).toBe(true);
    expect(outstandingItemInScope(item, null, '/repo/other')).toBe(false);
  });
});

describe('buildOutstandingQuery', () => {
  it('includes workspaceCwd when loading an outstanding panel scoped to a chat and workspace', () => {
    expect(buildOutstandingQuery('chat-1', '/repo/target', 'open')).toEqual({
      chatId: 'chat-1',
      workspaceCwd: '/repo/target',
      status: 'open',
    });
  });

  it('supports the existing single-scope queries', () => {
    expect(buildOutstandingQuery('chat-1', null, 'all')).toEqual({ chatId: 'chat-1', status: 'all' });
    expect(buildOutstandingQuery(null, '/repo/target', 'open')).toEqual({
      workspaceCwd: '/repo/target',
      status: 'open',
    });
    expect(buildOutstandingQuery(null, null, 'open')).toBeNull();
  });
});

describe('loop-outstanding-panel decision-surface gate', () => {
  const questionItem = {
    id: 'q-1', loopRunId: 'loop-1', chatId: 'chat-1', workspaceCwd: '/repo',
    kind: 'needs-human', text: 'Ship the rename?', userResponse: null, recommendedAnswer: 'Ship it',
    status: 'open', loopStatus: 'completed', createdAt: 1, updatedAt: 1, resolvedAt: null,
    riskClass: null, firstSeenRound: 2, outcome: null, answerSentAt: null,
  } as unknown as LoopOutstandingItemPayload;

  function mountPanel(items: LoopOutstandingItemPayload[]) {
    const outstanding = signal(items);
    TestBed.configureTestingModule({
      imports: [LoopOutstandingPanelComponent],
      providers: [
        {
          provide: LoopStore,
          useValue: {
            ensureWired: vi.fn(), loadOutstanding: vi.fn(() => Promise.resolve()),
            outstanding: outstanding.asReadonly(), outstandingIsLoading: signal(false),
            setOutstandingStatus: vi.fn(() => Promise.resolve(true)),
          },
        },
        { provide: LoopIpcService, useValue: { answerOutstanding: vi.fn() } },
      ],
    });
    const fixture = TestBed.createComponent(LoopOutstandingPanelComponent);
    fixture.componentRef.setInput('chatId', 'chat-1');
    fixture.componentRef.setInput('workspaceCwd', '/repo');
    fixture.detectChanges();
    return fixture;
  }

  it('renders nothing while it has no items (never a standing empty decision box)', () => {
    const fixture = mountPanel([]);
    expect(fixture.nativeElement.querySelector('.outstanding')).toBeNull();
    expect(fixture.nativeElement.textContent.trim()).toBe('');
  });

  it('renders the live question surface when an open question exists', async () => {
    const fixture = mountPanel([questionItem]);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-loop-question-row')).toBeTruthy();
    expect(fixture.nativeElement.textContent).toContain('Waiting for you');
  });
});
