import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DocReviewIpcService } from '../../core/services/ipc/doc-review-ipc.service';
import { DocReviewPageComponent } from './doc-review-page.component';
import { DocReviewDraftService } from './doc-review-draft.service';
import type { DocReviewItemInfo, DocReviewSession } from './doc-review.types';

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
    deliveryAttempts: [],
    ...overrides,
  };
}

const ITEM_A: DocReviewItemInfo = {
  id: 'd1',
  title: 'Decision 1',
  decisionId: '1',
  options: [
    { id: 'a', label: 'Option A', multi: false, isDefault: false },
    { id: 'b', label: 'Option B', multi: false, isDefault: false },
  ],
};

/**
 * LT-003: pre-submit doc-review draft state (decisions, comments, choices, overall, general
 * feedback) must survive route-away/route-back and a full renderer reload for the same pending
 * review, stay isolated per review id, and never resurface after a successful submit/dismiss.
 * DocReviewDraftService is `providedIn: 'root'`, so both the component under test and the
 * assertions below resolve the same singleton from this TestBed injector.
 */
describe('DocReviewPageComponent draft persistence', () => {
  let ipc: {
    list: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    readArtifact: ReturnType<typeof vi.fn>;
    submitDecision: ReturnType<typeof vi.fn>;
    dismiss: ReturnType<typeof vi.fn>;
    retryDelivery: ReturnType<typeof vi.fn>;
    openExternal: ReturnType<typeof vi.fn>;
    onChanged: ReturnType<typeof vi.fn>;
  };

  function setup(sessions: DocReviewSession[]) {
    TestBed.resetTestingModule();
    window.localStorage.clear();
    ipc = {
      list: vi.fn(async () => ({ success: true, data: sessions })),
      get: vi.fn(),
      readArtifact: vi.fn(async () => ({ success: true, data: { html: '<!doctype html>' } })),
      submitDecision: vi.fn(async () => ({ success: true, data: sessions[0] })),
      dismiss: vi.fn(async () => ({ success: true, data: undefined })),
      retryDelivery: vi.fn(),
      openExternal: vi.fn(),
      onChanged: vi.fn(() => () => undefined),
    };
    TestBed.configureTestingModule({
      imports: [DocReviewPageComponent],
      providers: [{ provide: DocReviewIpcService, useValue: ipc }],
    });
    const fixture = TestBed.createComponent(DocReviewPageComponent);
    fixture.detectChanges();
    return fixture;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('seeds itemStates from a persisted draft when the artifact reports ready for the same review', async () => {
    const fixture = setup([makeSession({ id: 'dr_1' })]);
    await fixture.whenStable();
    fixture.detectChanges();
    const draftService = TestBed.inject(DocReviewDraftService);
    draftService.save('dr_1', {
      overall: 'changes_requested',
      general: 'please revisit',
      items: [{ itemId: 'd1', decision: 'reject', comment: 'needs work', choice: 'b', choices: [] }],
    });

    // Re-select to re-trigger the effect that consults the persisted draft (mirrors
    // navigating back to this pending review after the effect already ran once on load).
    fixture.componentInstance.store.select(null);
    fixture.detectChanges();
    fixture.componentInstance.store.select('dr_1');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.componentInstance.onReady([ITEM_A]);

    const [state] = fixture.componentInstance.itemStates();
    expect(state.decision).toBe('reject');
    expect(state.comment).toBe('needs work');
    expect(state.choice).toBe('b');
    expect(fixture.componentInstance.overall()).toBe('changes_requested');
    expect(fixture.componentInstance.general()).toBe('please revisit');
  });

  it('persists every mutation isolated by review id, and clears the draft after a successful submit', async () => {
    const fixture = setup([makeSession({ id: 'dr_1' }), makeSession({ id: 'dr_2', title: 'Other' })]);
    await fixture.whenStable();
    fixture.detectChanges();
    const draftService = TestBed.inject(DocReviewDraftService);
    const component = fixture.componentInstance;

    component.onReady([ITEM_A]);
    component.onDecision({ itemId: 'd1', decision: 'approve' });
    component.onChoice({ itemId: 'd1', choice: 'a', choices: [] });
    component.onComment({ itemId: 'd1', comment: 'lgtm' });
    component.onOverallChange('approved');
    component.onGeneralChange('ship it');

    const draft = draftService.load('dr_1');
    expect(draft?.overall).toBe('approved');
    expect(draft?.general).toBe('ship it');
    expect(draft?.items).toEqual([
      { itemId: 'd1', decision: 'approve', comment: 'lgtm', choice: 'a', choices: [] },
    ]);
    // The other pending review's draft slot must remain untouched.
    expect(draftService.load('dr_2')).toBeNull();

    await component.onSubmit(makeSession({ id: 'dr_1' }));

    expect(ipc.submitDecision).toHaveBeenCalledWith(expect.objectContaining({ reviewId: 'dr_1', overall: 'approved' }));
    expect(draftService.load('dr_1')).toBeNull();
  });

  it('clears the draft after an explicit dismiss', async () => {
    const fixture = setup([makeSession({ id: 'dr_1' })]);
    await fixture.whenStable();
    fixture.detectChanges();
    const draftService = TestBed.inject(DocReviewDraftService);
    const component = fixture.componentInstance;

    component.onReady([ITEM_A]);
    component.onDecision({ itemId: 'd1', decision: 'reject' });
    expect(draftService.load('dr_1')).not.toBeNull();

    await component.onDismiss(makeSession({ id: 'dr_1' }));

    expect(ipc.dismiss).toHaveBeenCalledWith('dr_1');
    expect(draftService.load('dr_1')).toBeNull();
  });

  it('does not resurrect a stale draft for an already-decided review', async () => {
    const decided = makeSession({ id: 'dr_1', status: 'approved', decidedAt: 5 });
    const fixture = setup([decided]);
    await fixture.whenStable();
    fixture.detectChanges();
    const draftService = TestBed.inject(DocReviewDraftService);
    draftService.save('dr_1', {
      overall: 'rejected',
      general: 'stale',
      items: [{ itemId: 'd1', decision: 'reject', comment: 'stale comment', choice: null, choices: [] }],
    });

    fixture.componentInstance.store.select(null);
    fixture.componentInstance.store.select('dr_1');
    fixture.componentInstance.onReady([ITEM_A]);

    const [state] = fixture.componentInstance.itemStates();
    expect(state.decision).toBeNull();
    expect(state.comment).toBe('');
    expect(fixture.componentInstance.overall()).toBeNull();
    expect(fixture.componentInstance.general()).toBe('');
  });
});
