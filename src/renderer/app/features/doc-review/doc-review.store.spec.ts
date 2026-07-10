import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DocReviewIpcService } from '../../core/services/ipc/doc-review-ipc.service';
import { DocReviewStore } from './doc-review.store';
import type { DocReviewSession } from './doc-review.types';

function makeSession(overrides: Partial<DocReviewSession> = {}): DocReviewSession {
  return {
    id: 'dr_1',
    instanceId: 'inst-1',
    workspacePath: '/ws',
    title: 'Plan',
    artifactPath: '/ws/.aio-review/plan.html',
    status: 'pending',
    decisions: [],
    createdAt: 1,
    ...overrides,
  };
}

describe('DocReviewStore', () => {
  let changedCallback: ((event: unknown) => void) | null = null;
  const ipc = {
    list: vi.fn(),
    get: vi.fn(),
    readArtifact: vi.fn(),
    submitDecision: vi.fn(),
    dismiss: vi.fn(),
    openExternal: vi.fn(),
    onChanged: vi.fn((cb: (event: unknown) => void) => {
      changedCallback = cb;
      return () => undefined;
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    changedCallback = null;
    ipc.list.mockResolvedValue({ success: true, data: [makeSession()] });
    TestBed.configureTestingModule({
      providers: [DocReviewStore, { provide: DocReviewIpcService, useValue: ipc }],
    });
  });

  it('loads pending sessions and tracks the pending count', async () => {
    const store = TestBed.inject(DocReviewStore);
    await store.refresh();
    expect(store.sessions()).toHaveLength(1);
    expect(store.pendingCount()).toBe(1);
    expect(store.selectedId()).toBe('dr_1');
  });

  it('upserts a decided session from a change event and moves it to decided', async () => {
    const store = TestBed.inject(DocReviewStore);
    await store.refresh();
    changedCallback?.({
      kind: 'decided',
      reviewId: 'dr_1',
      session: makeSession({ status: 'approved', decidedAt: 2 }),
    });
    expect(store.pendingCount()).toBe(0);
    expect(store.decided()).toHaveLength(1);
  });

  it('removes a session on a dismissed event', async () => {
    const store = TestBed.inject(DocReviewStore);
    await store.refresh();
    changedCallback?.({ kind: 'dismissed', reviewId: 'dr_1' });
    expect(store.sessions()).toHaveLength(0);
  });

  it('ignores malformed change events', async () => {
    const store = TestBed.inject(DocReviewStore);
    await store.refresh();
    changedCallback?.({ kind: 'not-a-kind', reviewId: 123 });
    expect(store.sessions()).toHaveLength(1);
  });

  it('surfaces an error when submit fails', async () => {
    ipc.submitDecision.mockResolvedValue({ success: false, error: { message: 'boom' } });
    const store = TestBed.inject(DocReviewStore);
    await store.refresh();
    const ok = await store.submit('dr_1', 'approved', []);
    expect(ok).toBe(false);
    expect(store.error()).toBe('boom');
  });

  it('upserts the returned session on successful submit', async () => {
    ipc.submitDecision.mockResolvedValue({
      success: true,
      data: makeSession({ status: 'approved', decidedAt: 5 }),
    });
    const store = TestBed.inject(DocReviewStore);
    await store.refresh();
    const ok = await store.submit('dr_1', 'approved', []);
    expect(ok).toBe(true);
    expect(store.pendingCount()).toBe(0);
  });
});
