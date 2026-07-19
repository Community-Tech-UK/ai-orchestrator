import { Injectable } from '@angular/core';
import type { DocReviewItemVerdict, DocReviewOverall } from './doc-review.types';

export interface DocReviewDraftItem {
  itemId: string;
  decision: DocReviewItemVerdict;
  comment: string;
  choice: string | null;
  choices: string[];
}

export interface DocReviewDraft {
  overall: DocReviewOverall | null;
  general: string;
  items: DocReviewDraftItem[];
  updatedAt: number;
}

const STORAGE_KEY = 'doc-review-drafts:v1';
const PERSIST_DEBOUNCE_MS = 200;

/**
 * Persists in-progress (not-yet-submitted) Doc Review decisions/comments/choices per review id
 * so they survive navigating away and back, or a full renderer reload, for the same pending
 * review — the sandboxed artifact iframe holds no state of its own once torn down, and
 * DocReviewPageComponent otherwise only keeps this in component-scoped signals. Cleared on
 * successful submission or explicit dismissal (see doc-review-page.component.ts).
 */
@Injectable({ providedIn: 'root' })
export class DocReviewDraftService {
  private drafts: Record<string, DocReviewDraft> = this.loadAll();
  private persistHandle: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => this.flush());
    }
  }

  load(reviewId: string): DocReviewDraft | null {
    return this.drafts[reviewId] ?? null;
  }

  save(reviewId: string, draft: Omit<DocReviewDraft, 'updatedAt'>): void {
    this.drafts = { ...this.drafts, [reviewId]: { ...draft, updatedAt: Date.now() } };
    this.schedulePersist();
  }

  /** Isolation by review id: only this review's draft is removed. */
  clear(reviewId: string): void {
    if (!(reviewId in this.drafts)) return;
    const next = { ...this.drafts };
    delete next[reviewId];
    this.drafts = next;
    this.schedulePersist();
  }

  private loadAll(): Record<string, DocReviewDraft> {
    if (typeof window === 'undefined') return {};
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed: unknown = JSON.parse(raw);
      if (!this.isRecord(parsed) || parsed['version'] !== 1 || !this.isRecord(parsed['drafts'])) {
        return {};
      }
      const result: Record<string, DocReviewDraft> = {};
      for (const [reviewId, value] of Object.entries(parsed['drafts'])) {
        const draft = this.hydrateDraft(value);
        if (draft) result[reviewId] = draft;
      }
      return result;
    } catch {
      return {};
    }
  }

  private hydrateDraft(value: unknown): DocReviewDraft | null {
    if (!this.isRecord(value) || !Array.isArray(value['items'])) return null;
    const items: DocReviewDraftItem[] = value['items']
      .filter((item): item is Record<string, unknown> => this.isRecord(item))
      .map((item) => ({
        itemId: typeof item['itemId'] === 'string' ? item['itemId'] : '',
        decision: this.isVerdict(item['decision']) ? item['decision'] : null,
        comment: typeof item['comment'] === 'string' ? item['comment'] : '',
        choice: typeof item['choice'] === 'string' ? item['choice'] : null,
        choices: Array.isArray(item['choices'])
          ? item['choices'].filter((c): c is string => typeof c === 'string')
          : [],
      }))
      .filter((item) => item.itemId.length > 0);
    return {
      overall: this.isOverall(value['overall']) ? value['overall'] : null,
      general: typeof value['general'] === 'string' ? value['general'] : '',
      items,
      updatedAt: typeof value['updatedAt'] === 'number' ? value['updatedAt'] : 0,
    };
  }

  private schedulePersist(): void {
    if (typeof window === 'undefined') return;
    if (this.persistHandle !== null) clearTimeout(this.persistHandle);
    this.persistHandle = setTimeout(() => {
      this.persistHandle = null;
      this.flush();
    }, PERSIST_DEBOUNCE_MS);
  }

  private flush(): void {
    if (typeof window === 'undefined') return;
    if (this.persistHandle !== null) {
      clearTimeout(this.persistHandle);
      this.persistHandle = null;
    }
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, drafts: this.drafts }));
    } catch {
      // Ignore storage errors (quota/private mode); the in-memory draft still works this session.
    }
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  private isVerdict(value: unknown): value is DocReviewItemVerdict {
    return value === 'approve' || value === 'reject' || value === null;
  }

  private isOverall(value: unknown): value is DocReviewOverall {
    return value === 'approved' || value === 'changes_requested' || value === 'rejected';
  }
}
