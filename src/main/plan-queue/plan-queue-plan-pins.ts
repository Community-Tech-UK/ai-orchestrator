/**
 * Pinned criteria (T1 item 4): when a job starts, the plan's SHA-256 and its
 * unchecked `- [ ]` items are recorded once, so a worker cannot silently
 * delete or reword a criterion. The checker's "Document changes since this
 * job started" block compares the pin against the current document — the
 * authoritative signal when git has no baseline for an untracked document.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { PlanQueueItem } from './plan-queue.types';

export interface PlanQueueItemPin {
  itemId: string;
  /** SHA-256 of the document's bytes when the job started. */
  documentSha256: string;
  documentBytes: number;
  unchecked: string[];
  recordedAt: number;
}

const UNCHECKED_RE = /^\s*[-*]\s+\[ \]\s+(\S.*)$/;
const CHECKLIST_RE = /^\s*[-*]\s+\[[ xX]\]\s+(\S.*)$/;

/** Every unchecked `- [ ]` item in the document, in document order. */
export function extractChecklistItems(content: string, scope: 'unchecked' | 'all'): string[] {
  const pattern = scope === 'unchecked' ? UNCHECKED_RE : CHECKLIST_RE;
  return content
    .split('\n')
    .map((line) => pattern.exec(line)?.[1]?.trim())
    .filter((item): item is string => Boolean(item));
}

/** The pin recorded at job start from the document's bytes. */
export function pinFromContent(itemId: string, content: string, recordedAt: number): PlanQueueItemPin {
  return {
    itemId,
    documentSha256: createHash('sha256').update(content).digest('hex'),
    documentBytes: Buffer.byteLength(content, 'utf-8'),
    unchecked: extractChecklistItems(content, 'unchecked'),
    recordedAt,
  };
}

/** The pin for a job's document as it is now; null when it cannot be read. */
export async function readPlanPin(
  item: Pick<PlanQueueItem, 'id' | 'documentPath'>,
  recordedAt = Date.now(),
): Promise<PlanQueueItemPin | null> {
  try {
    return pinFromContent(item.id, await readFile(item.documentPath, 'utf-8'), recordedAt);
  } catch {
    return null;
  }
}

export interface PinnedItemChange {
  item: string;
  status: 'missing' | 'reworded';
}

function normalizeItem(item: string): string {
  return item.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Pinned unchecked items against the document's current ones: unchanged items
 * are omitted; an un-matched pinned item is "reworded" when a still-unmatched
 * current item shares at least its first three normalised words (all of them
 * when it has fewer), and "missing" otherwise.
 */
export function comparePinnedUnchecked(
  pinned: readonly string[],
  current: readonly string[],
): PinnedItemChange[] {
  const unmatched = current.map(normalizeItem);
  const changes: PinnedItemChange[] = [];
  for (const item of pinned) {
    const normalized = normalizeItem(item);
    const exact = unmatched.indexOf(normalized);
    if (exact >= 0) {
      unmatched[exact] = '';
      continue;
    }
    const opening = normalized.split(' ').slice(0, 3).join(' ');
    const reworded = unmatched.findIndex((candidate) => candidate !== ''
      && (candidate === normalized || candidate.startsWith(`${opening} `) || candidate === opening));
    if (reworded >= 0) {
      unmatched[reworded] = '';
      changes.push({ item, status: 'reworded' });
    } else {
      changes.push({ item, status: 'missing' });
    }
  }
  return changes;
}
