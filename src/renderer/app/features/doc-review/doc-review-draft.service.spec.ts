import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DocReviewDraftService } from './doc-review-draft.service';

function makeService(): DocReviewDraftService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [DocReviewDraftService] });
  return TestBed.inject(DocReviewDraftService);
}

describe('DocReviewDraftService', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('returns null for a review with no saved draft', () => {
    const service = makeService();
    expect(service.load('dr_missing')).toBeNull();
  });

  it('round-trips a saved draft for its own review id', () => {
    const service = makeService();
    service.save('dr_1', {
      overall: 'approved',
      general: 'looks good',
      items: [{ itemId: 'd1', decision: 'approve', comment: 'ship it', choice: 'b', choices: [] }],
    });

    const draft = service.load('dr_1');
    expect(draft).not.toBeNull();
    expect(draft?.overall).toBe('approved');
    expect(draft?.general).toBe('looks good');
    expect(draft?.items).toEqual([
      { itemId: 'd1', decision: 'approve', comment: 'ship it', choice: 'b', choices: [] },
    ]);
  });

  it('isolates drafts by review id — saving one review never leaks into another', () => {
    const service = makeService();
    service.save('dr_1', { overall: 'approved', general: 'a', items: [] });
    service.save('dr_2', { overall: 'rejected', general: 'b', items: [] });

    expect(service.load('dr_1')?.general).toBe('a');
    expect(service.load('dr_2')?.general).toBe('b');
  });

  it('clears only the targeted review id', () => {
    const service = makeService();
    service.save('dr_1', { overall: 'approved', general: 'a', items: [] });
    service.save('dr_2', { overall: 'rejected', general: 'b', items: [] });

    service.clear('dr_1');

    expect(service.load('dr_1')).toBeNull();
    expect(service.load('dr_2')?.general).toBe('b');
  });

  it('persists to localStorage (debounced) and a fresh service instance reloads it', async () => {
    vi.useFakeTimers();
    const service = makeService();
    service.save('dr_1', {
      overall: 'changes_requested',
      general: 'note',
      items: [{ itemId: 'd1', decision: 'reject', comment: '', choice: null, choices: ['a', 'b'] }],
    });
    await vi.runAllTimersAsync();
    vi.useRealTimers();

    const reloaded = makeService();
    const draft = reloaded.load('dr_1');
    expect(draft?.overall).toBe('changes_requested');
    expect(draft?.items).toEqual([
      { itemId: 'd1', decision: 'reject', comment: '', choice: null, choices: ['a', 'b'] },
    ]);
  });

  it('flushes pending persistence on beforeunload without waiting for the debounce', () => {
    const service = makeService();
    service.save('dr_1', { overall: 'approved', general: '', items: [] });

    window.dispatchEvent(new Event('beforeunload'));

    const raw = window.localStorage.getItem('doc-review-drafts:v1');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw ?? '{}').drafts.dr_1.overall).toBe('approved');
  });

  it('ignores corrupt localStorage content instead of throwing', () => {
    window.localStorage.setItem('doc-review-drafts:v1', '{not json');
    expect(() => makeService()).not.toThrow();
    expect(makeService().load('dr_1')).toBeNull();
  });

  it('drops malformed persisted entries (non-string itemId) instead of surfacing garbage', () => {
    window.localStorage.setItem(
      'doc-review-drafts:v1',
      JSON.stringify({
        version: 1,
        drafts: {
          dr_1: {
            overall: 'approved',
            general: '',
            items: [{ itemId: 42, decision: 'approve', comment: '', choice: null, choices: [] }],
            updatedAt: 1,
          },
        },
      }),
    );

    const service = makeService();
    expect(service.load('dr_1')?.items).toEqual([]);
  });
});
