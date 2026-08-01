/**
 * SourceControlDiffViewComponent JIT-render spec — covers WS-C4 line-range
 * selection (click / shift-click), the comment editor, annotation markers,
 * and "Send review" composing+dispatching through the instance send path.
 *
 * Uses the REAL `DiffReviewDraftStore` (pure signal state, no IO) and a
 * lightweight stub `InstanceStore` (per the repo's established pattern —
 * see compact-model-picker.component.spec.ts).
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SourceControlDiffViewComponent } from './source-control-diff-view.component';
import { DiffLoader } from './diff-loader';
import { DiffReviewDraftStore } from './diff-review-draft.store';
import { InstanceStore } from '../../core/state/instance.store';
import type { VcsIpcService } from '../../core/services/ipc/vcs-ipc.service';
import type { DiffResult } from './source-control.types';

// Vitest does not run Angular CLI's resource inliner, so resolve the
// component's external styleUrl before TestBed compiles it (same pattern as
// source-control.component.spec.ts).
const specDirectory = dirname(fileURLToPath(import.meta.url));
const componentStyles = readFileSync(
  resolve(specDirectory, './source-control-diff-view.component.scss'),
  'utf8',
);

await resolveComponentResources((url) => {
  if (url.endsWith('source-control-diff-view.component.scss')) return Promise.resolve(componentStyles);
  return Promise.reject(new Error(`Unexpected component resource: ${url}`));
});

function makeVcsStub(): VcsIpcService {
  return { vcsGetDiff: vi.fn() } as unknown as VcsIpcService;
}

function makeDiffResult(hunkContent: string, opts: { path?: string; oldStart?: number; newStart?: number } = {}): DiffResult {
  return {
    files: [
      {
        path: opts.path ?? 'src/x.ts',
        status: 'modified',
        additions: 0,
        deletions: 0,
        hunks: [
          {
            oldStart: opts.oldStart ?? 1,
            oldLines: 4,
            newStart: opts.newStart ?? 1,
            newLines: 4,
            content: hunkContent,
          },
        ],
      },
    ],
    totalAdditions: 0,
    totalDeletions: 0,
  };
}

const BASE_HUNK = [
  '@@ -1,4 +1,4 @@',
  ' context-a',
  '-removed-line',
  '+added-line',
  ' context-b',
].join('\n');

describe('SourceControlDiffViewComponent (WS-C4 diff review comments)', () => {
  let draftStore: DiffReviewDraftStore;
  let sendInput: ReturnType<typeof vi.fn>;
  let selectedInstanceId: ReturnType<typeof signal<string | null>>;

  beforeEach(async () => {
    selectedInstanceId = signal<string | null>('inst-1');
    sendInput = vi.fn().mockResolvedValue(undefined);

    TestBed.configureTestingModule({
      imports: [SourceControlDiffViewComponent],
      providers: [
        {
          provide: InstanceStore,
          useValue: { selectedInstanceId, sendInput },
        },
      ],
    });

    draftStore = TestBed.inject(DiffReviewDraftStore);
    draftStore._resetForTesting();
  });

  async function render(hunkContent = BASE_HUNK, opts?: Parameters<typeof makeDiffResult>[1]) {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(SourceControlDiffViewComponent);
    const loader = new DiffLoader(makeVcsStub());
    loader.diffResult.set(makeDiffResult(hunkContent, opts));
    fixture.componentRef.setInput('loader', loader);
    fixture.detectChanges();
    return { fixture, loader };
  }

  function rows(fixture: ComponentFixture<SourceControlDiffViewComponent>): HTMLElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('.diff-row')) as HTMLElement[];
  }

  it('renders one selectable .diff-row per add/remove/context line, with gutter line numbers', async () => {
    const { fixture } = await render();
    const r = rows(fixture);
    expect(r.length).toBe(4);
    expect(r[0].textContent).toContain('context-a');
    expect(r[1].textContent).toContain('removed-line');
    expect(r[2].textContent).toContain('added-line');
    expect(r[3].textContent).toContain('context-b');
  });

  it('click selects a single row', async () => {
    const { fixture } = await render();
    const r = rows(fixture);
    r[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();
    expect(r[0].classList.contains('selected')).toBe(true);
    expect(r[1].classList.contains('selected')).toBe(false);
  });

  it('shift-click extends a same-side, same-hunk selection, skipping a different-side row in between', async () => {
    const { fixture } = await render();
    const r = rows(fixture);
    // row 0 = context-a (side "new"), row 2 = added-line (side "new"); row 1
    // (removed-line) is side "old" and sits between them visually.
    r[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();
    r[2].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    fixture.detectChanges();

    expect(r[0].classList.contains('selected')).toBe(true);
    expect(r[2].classList.contains('selected')).toBe(true);
    // The differently-sided row in between is not swept into the selection.
    expect(r[1].classList.contains('selected')).toBe(false);
  });

  it('shift-click on a different-side row starts a new single-row selection instead of extending', async () => {
    const { fixture } = await render();
    const r = rows(fixture);
    r[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();
    r[1].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    fixture.detectChanges();

    expect(r[0].classList.contains('selected')).toBe(false);
    expect(r[1].classList.contains('selected')).toBe(true);
  });

  it('Enter opens the comment editor with the exact selected excerpt', async () => {
    const { fixture } = await render();
    const r = rows(fixture);
    r[3].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();
    r[3].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();

    const editor = fixture.nativeElement.querySelector('.diff-anno-editor');
    expect(editor).toBeTruthy();
    const excerpt = fixture.nativeElement.querySelector('.diff-anno-editor-excerpt');
    expect(excerpt?.textContent).toContain('context-b');
  });

  it('saving a comment creates a draft annotation and renders a marker on the annotated row', async () => {
    const { fixture } = await render();
    const r = rows(fixture);
    r[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();
    r[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();

    const textarea = fixture.nativeElement.querySelector('.diff-anno-editor-textarea') as HTMLTextAreaElement;
    textarea.value = 'please rename this';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();

    const saveBtn = fixture.nativeElement.querySelector('.diff-anno-editor-save') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);
    saveBtn.click();
    fixture.detectChanges();

    const draft = draftStore.annotationsFor('inst-1');
    expect(draft.length).toBe(1);
    expect(draft[0]).toMatchObject({
      path: 'src/x.ts',
      side: 'new',
      lineRange: { start: 1, end: 1 },
      comment: 'please rename this',
      state: 'fresh',
    });

    // The editor closes and a marker renders on the annotated row.
    expect(fixture.nativeElement.querySelector('.diff-anno-editor')).toBeFalsy();
    expect(fixture.nativeElement.querySelector('.diff-anno-marker')).toBeTruthy();
  });

  it('Send review composes a packet, sends it through InstanceStore.sendInput, and clears the draft', async () => {
    const { fixture } = await render();
    draftStore.add('inst-1', {
      path: 'src/x.ts',
      side: 'new',
      lineRange: { start: 1, end: 1 },
      excerpt: ' context-a',
      comment: 'name this better',
    });
    fixture.detectChanges();

    const sendBtn = fixture.nativeElement.querySelector('.diff-review-send') as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(false);
    sendBtn.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(sendInput).toHaveBeenCalledTimes(1);
    const [instanceId, packet] = sendInput.mock.calls[0];
    expect(instanceId).toBe('inst-1');
    expect(packet).toContain('<REVIEW_COMMENT path="src/x.ts" side="new" lines="1">');
    expect(packet).toContain('name this better');

    expect(draftStore.annotationsFor('inst-1')).toEqual([]);
  });

  it('autofocuses the comment editor textarea when it opens (keyboard UX)', async () => {
    const { fixture } = await render();
    document.body.appendChild(fixture.nativeElement);
    try {
      const r = rows(fixture);
      r[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      fixture.detectChanges();
      r[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      fixture.detectChanges();

      const textarea = fixture.nativeElement.querySelector('.diff-anno-editor-textarea');
      expect(document.activeElement).toBe(textarea);
    } finally {
      fixture.nativeElement.remove();
    }
  });

  describe('Send review — stale-draft confirm (fresh-eyes CRITICAL fix)', () => {
    function seedStaleAndFreshAnnotations(fixture: ComponentFixture<SourceControlDiffViewComponent>) {
      draftStore.add('inst-1', {
        path: 'src/x.ts',
        side: 'new',
        lineRange: { start: 1, end: 1 },
        excerpt: ' context-a',
        comment: 'this one is fine',
      });
      const staleTarget = draftStore.add('inst-1', {
        path: 'src/x.ts',
        side: 'new',
        lineRange: { start: 3, end: 3 },
        excerpt: ' context-b',
        comment: 'is this still here?',
      });
      // Force ONLY the second annotation stale via the same reconcile path
      // production code uses: these "current lines" still contain the first
      // annotation's excerpt (so it stays fresh at the same range) but not
      // the second's, so it has no match anywhere.
      draftStore.reconcile('inst-1', 'src/x.ts', 'new', [{ lineNumber: 1, text: ' context-a' }]);
      fixture.detectChanges();
      return staleTarget.id;
    }

    it('blocks the send and shows a confirm banner instead of sending immediately', async () => {
      const { fixture } = await render();
      seedStaleAndFreshAnnotations(fixture);

      const sendBtn = fixture.nativeElement.querySelector('.diff-review-send') as HTMLButtonElement;
      sendBtn.click();
      fixture.detectChanges();

      expect(sendInput).not.toHaveBeenCalled();
      const confirm = fixture.nativeElement.querySelector('.diff-review-confirm');
      expect(confirm).toBeTruthy();
      expect(confirm.textContent).toContain('1 stale comment');
      // The primary button is disabled while the banner is up.
      expect(sendBtn.disabled).toBe(true);
    });

    it('"Send anyway" sends the full draft, including the stale annotation with state="stale"', async () => {
      const { fixture } = await render();
      seedStaleAndFreshAnnotations(fixture);

      (fixture.nativeElement.querySelector('.diff-review-send') as HTMLButtonElement).click();
      fixture.detectChanges();
      (fixture.nativeElement.querySelector('.diff-review-confirm-send') as HTMLButtonElement).click();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(sendInput).toHaveBeenCalledTimes(1);
      const [, packet] = sendInput.mock.calls[0];
      expect(packet).toContain('state="stale"');
      expect(packet).toContain('this one is fine');
      expect(packet).toContain('is this still here?');
      expect(draftStore.annotationsFor('inst-1')).toEqual([]);
      expect(fixture.nativeElement.querySelector('.diff-review-confirm')).toBeFalsy();
    });

    it('"Remove stale first" drops only the stale annotation(s), keeps the rest, and does not send', async () => {
      const { fixture } = await render();
      const staleId = seedStaleAndFreshAnnotations(fixture);

      (fixture.nativeElement.querySelector('.diff-review-send') as HTMLButtonElement).click();
      fixture.detectChanges();
      (fixture.nativeElement.querySelector('.diff-review-confirm-remove') as HTMLButtonElement).click();
      fixture.detectChanges();

      expect(sendInput).not.toHaveBeenCalled();
      const remaining = draftStore.annotationsFor('inst-1');
      expect(remaining.map((a) => a.id)).not.toContain(staleId);
      expect(remaining.length).toBe(1);
      expect(remaining[0].comment).toBe('this one is fine');
      expect(fixture.nativeElement.querySelector('.diff-review-confirm')).toBeFalsy();
    });
  });

  it('a failed send preserves the draft and surfaces the error (fresh-eyes WARNING 2)', async () => {
    const { fixture } = await render();
    sendInput.mockRejectedValueOnce(new Error('network down'));
    draftStore.add('inst-1', {
      path: 'src/x.ts',
      side: 'new',
      lineRange: { start: 1, end: 1 },
      excerpt: ' context-a',
      comment: 'name this better',
    });
    fixture.detectChanges();

    (fixture.nativeElement.querySelector('.diff-review-send') as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(draftStore.annotationsFor('inst-1').length).toBe(1);
    const err = fixture.nativeElement.querySelector('.diff-review-error');
    expect(err).toBeTruthy();
    expect(err.textContent).toContain('network down');
  });

  it('re-anchors a draft annotation when the diff reloads with the excerpt shifted to a new line', async () => {
    const { fixture, loader } = await render();
    draftStore.add('inst-1', {
      path: 'src/x.ts',
      side: 'new',
      lineRange: { start: 3, end: 3 },
      excerpt: ' context-b',
      comment: 'still valid?',
    });
    fixture.detectChanges();

    // Reload with two new lines inserted above — "context-b" now lands
    // further down but is still uniquely present.
    const shiftedHunk = [
      '@@ -1,6 +1,6 @@',
      ' context-a',
      '+inserted-1',
      '+inserted-2',
      '-removed-line',
      '+added-line',
      ' context-b',
    ].join('\n');
    loader.diffResult.set(makeDiffResult(shiftedHunk));
    fixture.detectChanges();

    const updated = draftStore.annotationsFor('inst-1')[0];
    expect(updated.state).toBe('re-anchored');
    expect(updated.lineRange).toEqual({ start: 5, end: 5 });
  });
});
