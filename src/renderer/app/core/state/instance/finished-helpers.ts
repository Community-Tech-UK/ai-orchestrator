/**
 * Helpers that have finished and left the instance list (LT-1199).
 *
 * A short helper (a research scout) reports back and is removed within seconds, so the lead's
 * header chip, which counts the helpers below it, forgot a fan-out as soon as it ended. This keeps
 * the little the chip needs about each removed helper (who started it and the cost it reported) for
 * as long as its lead is still listed. It lives in this window only; a restart starts it empty.
 */

import { signal } from '@angular/core';

export interface FinishedHelper {
  id: string;
  parentId: string;
  contextUsage: { costEstimate?: number };
}

export class FinishedHelpers {
  private readonly records = signal<readonly FinishedHelper[]>([]);
  readonly list = this.records.asReadonly();

  /** Remember a helper that is leaving the list; a session with no parent is not a helper. */
  retain(leaving: { id: string; parentId?: string | null; contextUsage?: { costEstimate?: number } }): void {
    const { id, parentId } = leaving;
    if (!parentId) return;
    const costEstimate = leaving.contextUsage?.costEstimate;
    const helper: FinishedHelper = { id, parentId, contextUsage: costEstimate === undefined ? {} : { costEstimate } };
    this.records.update(current => [...current.filter(existing => existing.id !== id), helper]);
  }

  /** Whether this session is a remembered finished helper, so something below it can still be shown. */
  has(id: string): boolean {
    return this.records().some(helper => helper.id === id);
  }

  /** Drop everything below a session that has itself left the list. */
  forgetBelow(rootId: string): void {
    this.records.update(current => {
      const doomed = new Set<string>([rootId]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const helper of current) {
          if (!doomed.has(helper.id) && doomed.has(helper.parentId)) { doomed.add(helper.id); grew = true; }
        }
      }
      const kept = current.filter(helper => !doomed.has(helper.id));
      return kept.length === current.length ? current : kept;
    });
  }
}
