/**
 * DiffLoader — per-instance loader for a single file's unified diff.
 *
 * Both the modal viewer and the inline-expansion row use this. Each
 * consumer creates its own instance (the modal lives once at a time;
 * inline rows live per expanded file). When the consumer component
 * is destroyed, the loader is dropped — no global cleanup needed.
 *
 * Owns:
 *   - the loading/error/result signals
 *   - the parsed `renderedLines` computed (split + classified hunk lines)
 *   - a `load(workingDirectory, filePath, staged)` method that fans
 *     out to `vcs.vcsGetDiff` and resolves the signals
 *
 * Stale-protected via a per-instance sequence counter so the modal can
 * survive rapid re-keying (user clicks file A, then file B before A's
 * response lands → A's late response is dropped silently).
 */

import { computed, signal } from '@angular/core';
import type { VcsIpcService } from '../../core/services/ipc/vcs-ipc.service';
import type {
  DiffFile,
  DiffResult,
  RenderedDiffLine,
} from './source-control.types';

export class DiffLoader {
  private vcs: VcsIpcService;
  /** Per-loader sequence counter for stale-response protection. */
  private requestSeq = 0;

  readonly isLoading = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly diffResult = signal<DiffResult | null>(null);

  /** First (and usually only) file in the diff result. */
  readonly file = computed<DiffFile | null>(() => {
    const r = this.diffResult();
    return r && r.files.length > 0 ? r.files[0] : null;
  });

  /** Classified lines for rendering. Empty for binary or no-result. */
  readonly renderedLines = computed<RenderedDiffLine[]>(() => {
    const f = this.file();
    if (!f || f.isBinary) return [];
    return classifyHunks(f);
  });

  constructor(vcs: VcsIpcService) {
    this.vcs = vcs;
  }

  /**
   * Fetch the diff for one file. Idempotent — safe to call multiple
   * times for the same (workingDirectory, filePath, staged) tuple; the
   * sequence counter ensures only the most recent call's result lands.
   */
  async load(workingDirectory: string, filePath: string, staged: boolean): Promise<void> {
    const reqId = ++this.requestSeq;
    this.isLoading.set(true);
    this.errorMessage.set(null);

    try {
      const response = await this.vcs.vcsGetDiff({
        workingDirectory,
        type: staged ? 'staged' : 'unstaged',
        filePath,
      });
      if (reqId !== this.requestSeq) return; // stale
      if (!response.success) {
        this.errorMessage.set(response.error?.message || 'Failed to load diff');
        this.diffResult.set(null);
        return;
      }
      const payload = response.data as { diff: DiffResult };
      this.diffResult.set(payload.diff);
    } catch (err) {
      if (reqId !== this.requestSeq) return; // stale
      this.errorMessage.set((err as Error).message || 'Failed to load diff');
      this.diffResult.set(null);
    } finally {
      if (reqId === this.requestSeq) {
        this.isLoading.set(false);
      }
    }
  }

  /**
   * Returns the line number (1-based) the editor should jump to when
   * the user clicks "Open file". Strategy: first hunk's `newStart`
   * if any, else 1 (top of file). See Phase 2 plan item 6.
   */
  jumpLine(): number {
    const f = this.file();
    if (!f || f.hunks.length === 0) return 1;
    return f.hunks[0].newStart || 1;
  }
}

// ---------------------------------------------------------------------------
// Pure helper — exported for tests
// ---------------------------------------------------------------------------

export function classifyHunks(file: DiffFile): RenderedDiffLine[] {
  const out: RenderedDiffLine[] = [];
  for (const hunk of file.hunks) {
    const lines = hunk.content.split('\n');
    for (const line of lines) {
      if (line.length === 0) continue;
      if (line.startsWith('@@')) {
        out.push({ kind: 'header', text: line });
      } else if (line.startsWith('+++') || line.startsWith('---')) {
        out.push({ kind: 'meta', text: line });
      } else if (line.startsWith('+')) {
        out.push({ kind: 'add', text: line });
      } else if (line.startsWith('-')) {
        out.push({ kind: 'remove', text: line });
      } else {
        out.push({ kind: 'context', text: line });
      }
    }
  }
  return out;
}
