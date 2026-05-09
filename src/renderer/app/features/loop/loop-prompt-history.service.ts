import { Injectable, computed, signal } from '@angular/core';

/** Legacy global key — kept so prompts saved before the per-workspace
 *  rollout still surface (we migrate them lazily into the global bucket
 *  on first read and let them get pruned naturally as workspace-specific
 *  ones get written). */
const LEGACY_GLOBAL_KEY = 'loop:recent-prompts';
const STORAGE_PREFIX = 'loop:recent-prompts:';
const GLOBAL_BUCKET = 'global';
const MAX_ENTRIES = 3;

/**
 * Distillation of the user's manual loop instructions — used as the starting
 * default when there is no typed text and no recall history.
 */
export const DEFAULT_LOOP_PROMPT =
  "Continue toward the user's goal. Read relevant files before changing code, " +
  'choose the maintainable architecture, and make concrete progress this turn.\n\n' +
  'If implementing a plan, update the code and tests until the plan is fully implemented. ' +
  'Verify with the appropriate checks. If a plan file is fully implemented and verified, ' +
  'rename it with _completed.\n\n' +
  'Before stopping, review your own work with fresh eyes. Fix any issues you find. ' +
  'If blocked, explain the blocker clearly and stop.';

const LEGACY_DEFAULT_LOOP_PROMPTS = [
  "Please continue. Choose the best architectural decision — don't be lazy, don't take shortcuts. " +
  'Re-review your work with completely fresh eyes after each stage and fix any issues. ' +
  'When a plan file is fully implemented, rename it with `_Completed`.',
  "Continue toward the user's goal. Read relevant files before changing code, " +
  'choose the maintainable architecture, and make concrete progress this turn. ' +
  'If implementing a plan, update the code and tests until the plan is fully implemented. ' +
  'Verify with the appropriate checks. If a plan file is fully implemented and verified, ' +
  'rename it with _completed. Before stopping, review your own work with fresh eyes. ' +
  'Fix any issues you find. If blocked, explain the blocker clearly and stop.',
  "Continue toward the user's goal.\n\n" +
  'Investigation: be thorough, read relevant files in full, and do not take shortcuts.\n\n' +
  'Planning: choose the best architecture even when it takes longer. Review the plan, ' +
  'fix issues, then re-review it with fresh eyes.\n\n' +
  'Implementation: implement the plan with the right architecture. Update code and tests ' +
  'until the plan is fully implemented. Verify with appropriate checks. Before stopping, ' +
  're-review your work with fresh eyes and fix any issues. If a plan file is fully ' +
  'implemented and verified, rename it with _completed. If blocked, explain the blocker clearly and stop.',
];

/**
 * Hash a workspace path into a short, opaque bucket id. Filesystem-friendly
 * (no slashes), stable across runs, and avoids leaking the full path into
 * localStorage keys. Uses a simple FNV-1a 32-bit hash — collisions are fine
 * since the worst case is two workspaces sharing 3 prompts.
 */
function bucketFor(workspaceCwd: string | null): string {
  if (!workspaceCwd) return GLOBAL_BUCKET;
  let hash = 0x811c9dc5;
  for (let i = 0; i < workspaceCwd.length; i++) {
    hash ^= workspaceCwd.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function normalizeStoredPrompt(prompt: string): string | null {
  const trimmed = prompt.trim();
  if (!trimmed) return null;
  if (LEGACY_DEFAULT_LOOP_PROMPTS.includes(trimmed)) {
    return DEFAULT_LOOP_PROMPT;
  }
  return trimmed;
}

@Injectable({ providedIn: 'root' })
export class LoopPromptHistoryService {
  /** The active workspace bucket. Writers should call `setWorkspace()` before
   *  reading or remembering — components do this in their constructor based
   *  on their own workspaceCwd input. */
  private activeBucket = signal<string>(GLOBAL_BUCKET);

  /** Cache of bucket → entries so changes in one workspace don't blow away
   *  the in-memory state of another. */
  private cache = new Map<string, string[]>();

  recent = computed<string[]>(() => {
    const bucket = this.activeBucket();
    if (!this.cache.has(bucket)) {
      this.cache.set(bucket, this.load(bucket));
    }
    return this.cache.get(bucket)!;
  });

  /** Switch the active workspace bucket. Called by the loop config panel
   *  when its `workspaceCwd` input changes. */
  setWorkspace(workspaceCwd: string | null): void {
    this.activeBucket.set(bucketFor(workspaceCwd));
  }

  /** Push a prompt to the front of the active bucket, dedupe, cap at 3. */
  remember(prompt: string): void {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    const bucket = this.activeBucket();
    const current = this.cache.get(bucket) ?? this.load(bucket);
    const next = [trimmed, ...current.filter((p) => p !== trimmed)].slice(0, MAX_ENTRIES);
    this.cache.set(bucket, next);
    this.save(bucket, next);
    // Trigger recomputation of `recent`.
    this.activeBucket.set(bucket);
  }

  forget(prompt: string): void {
    const bucket = this.activeBucket();
    const current = this.cache.get(bucket) ?? this.load(bucket);
    const next = current.filter((p) => p !== prompt);
    if (next.length === current.length) return;
    this.cache.set(bucket, next);
    this.save(bucket, next);
    this.activeBucket.set(bucket);
  }

  private load(bucket: string): string[] {
    try {
      const key = bucket === GLOBAL_BUCKET ? LEGACY_GLOBAL_KEY : `${STORAGE_PREFIX}${bucket}`;
      const raw = localStorage.getItem(key);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const next: string[] = [];
      for (const value of parsed) {
        if (typeof value !== 'string') continue;
        const prompt = normalizeStoredPrompt(value);
        if (!prompt || next.includes(prompt)) continue;
        next.push(prompt);
        if (next.length >= MAX_ENTRIES) break;
      }
      return next;
    } catch {
      return [];
    }
  }

  private save(bucket: string, entries: string[]): void {
    try {
      const key = bucket === GLOBAL_BUCKET ? LEGACY_GLOBAL_KEY : `${STORAGE_PREFIX}${bucket}`;
      localStorage.setItem(key, JSON.stringify(entries));
    } catch {
      // best-effort; if storage is full or unavailable, drop silently
    }
  }
}
