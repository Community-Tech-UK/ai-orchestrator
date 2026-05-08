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
  "Please continue. Choose the best architectural decision — don't be lazy, don't take shortcuts. " +
  'Re-review your work with completely fresh eyes after each stage and fix any issues. ' +
  'When a plan file is fully implemented, rename it with `_Completed`.';

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
      return parsed.filter((v): v is string => typeof v === 'string').slice(0, MAX_ENTRIES);
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
