/**
 * Diff Review Draft Store (WS-C4)
 *
 * Per-instance draft of `DiffAnnotation`s created in the diff viewer. Pure
 * signal state — no IPC, no persistence. The draft for an instance is
 * cleared once its packet is successfully sent (see
 * `SourceControlDiffViewComponent.sendReview()`).
 *
 * Re-anchoring: `reconcile()` re-locates every draft annotation for a given
 * (instance, path, side) against the CURRENT rendered lines whenever a diff
 * is (re)loaded — see `diff-annotation-anchor.ts` for the exact-match
 * algorithm. It is a no-op (and does not touch the signal) when nothing
 * actually changed, so it is safe to call on every diff load.
 */

import { Injectable, signal } from '@angular/core';
import type {
  DiffAnnotation,
  DiffAnnotationDraft,
  DiffAnnotationSide,
} from '../../../../shared/types/diff-annotation.types';
import { reanchorAnnotation, type AnchorLine } from './diff-annotation-anchor';

let annotationIdCounter = 0;

/** Exported for tests that need deterministic ids; production code should not call this. */
export function createAnnotationId(): string {
  annotationIdCounter += 1;
  return `diffanno_${Date.now().toString(36)}_${annotationIdCounter}`;
}

@Injectable({ providedIn: 'root' })
export class DiffReviewDraftStore {
  private readonly drafts = signal(new Map<string, DiffAnnotation[]>());

  /** All draft annotations for an instance, across every file. */
  annotationsFor(instanceId: string): DiffAnnotation[] {
    return this.drafts().get(instanceId) ?? [];
  }

  /** Draft annotations for one file within an instance's draft. */
  annotationsForFile(instanceId: string, path: string): DiffAnnotation[] {
    return this.annotationsFor(instanceId).filter((a) => a.path === path);
  }

  add(instanceId: string, draft: DiffAnnotationDraft): DiffAnnotation {
    const now = Date.now();
    const annotation: DiffAnnotation = {
      id: createAnnotationId(),
      ...draft,
      state: 'fresh',
      createdAt: now,
      updatedAt: now,
    };
    this.drafts.update((map) => {
      const next = new Map(map);
      next.set(instanceId, [...(map.get(instanceId) ?? []), annotation]);
      return next;
    });
    return annotation;
  }

  updateComment(instanceId: string, id: string, comment: string): void {
    this.drafts.update((map) => {
      const list = map.get(instanceId);
      if (!list) return map;
      const next = new Map(map);
      next.set(
        instanceId,
        list.map((a) => (a.id === id ? { ...a, comment, updatedAt: Date.now() } : a)),
      );
      return next;
    });
  }

  remove(instanceId: string, id: string): void {
    this.drafts.update((map) => {
      const list = map.get(instanceId);
      if (!list) return map;
      const next = new Map(map);
      next.set(instanceId, list.filter((a) => a.id !== id));
      return next;
    });
  }

  /** Clears the whole draft for an instance — called after a successful send. */
  clear(instanceId: string): void {
    this.drafts.update((map) => {
      if (!map.has(instanceId)) return map;
      const next = new Map(map);
      next.delete(instanceId);
      return next;
    });
  }

  /**
   * Re-anchors every draft annotation for (instanceId, path, side) against
   * the diff currently on screen. Skips the write entirely if the instance
   * has no draft, or if nothing about any annotation's state/range actually
   * changed — so effects can call this on every diff load without churning
   * downstream signals.
   */
  reconcile(instanceId: string, path: string, side: DiffAnnotationSide, currentLines: AnchorLine[]): void {
    this.drafts.update((map) => {
      const list = map.get(instanceId);
      if (!list || list.length === 0) return map;

      let changed = false;
      const next = list.map((a) => {
        if (a.path !== path || a.side !== side) return a;
        const reanchored = reanchorAnnotation(a, currentLines);
        const same =
          reanchored.state === a.state &&
          reanchored.lineRange.start === a.lineRange.start &&
          reanchored.lineRange.end === a.lineRange.end;
        if (same) return a;
        changed = true;
        return reanchored;
      });

      if (!changed) return map;
      const nextMap = new Map(map);
      nextMap.set(instanceId, next);
      return nextMap;
    });
  }

  /** Test-only reset. */
  _resetForTesting(): void {
    this.drafts.set(new Map());
    annotationIdCounter = 0;
  }
}
