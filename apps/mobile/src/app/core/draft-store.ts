import { Injectable } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';

const KEY = 'aio.drafts';
/** Drafts older than this are dropped on load (exported for tests). */
export const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Keep only the most recent N drafts (one per session, plus new-session). */
const MAX_ENTRIES = 20;
/** Coalesce per-keystroke saves into one Preferences write. */
const WRITE_DELAY_MS = 400;

interface DraftEntry {
  text: string;
  at: number;
}

/**
 * Persists unsent composer text so a draft survives iOS evicting the
 * backgrounded app (the transcript re-syncs from the Mac; the half-typed
 * message otherwise wouldn't). Text only — image attachments are large
 * base64 blobs that don't belong in UserDefaults; they're still lost on
 * eviction.
 *
 * Writes are debounced per keystroke and force-flushed when the app
 * backgrounds (the moment before any eviction can happen).
 */
@Injectable({ providedIn: 'root' })
export class DraftStore {
  private drafts = new Map<string, DraftEntry>();
  private ready: Promise<void> | null = null;
  private writeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    if (Capacitor.isNativePlatform()) {
      // Flush pending writes the moment the app leaves the foreground.
      void import('@capacitor/app').then(({ App }) =>
        App.addListener('appStateChange', ({ isActive }) => {
          if (!isActive) {
            clearTimeout(this.writeTimer);
            void this.flush();
          }
        }),
      );
    }
  }

  async load(key: string): Promise<string> {
    await this.ensureLoaded();
    return this.drafts.get(key)?.text ?? '';
  }

  /** Save (or clear, with blank text) a draft. Debounced; safe per keystroke. */
  save(key: string, text: string): void {
    void this.ensureLoaded().then(() => {
      const existing = this.drafts.get(key)?.text ?? '';
      const next = text.trim() ? text : '';
      if (existing === next || (!existing && !next)) return;
      if (next) {
        this.drafts.set(key, { text: next, at: Date.now() });
      } else {
        this.drafts.delete(key);
      }
      clearTimeout(this.writeTimer);
      this.writeTimer = setTimeout(() => void this.flush(), WRITE_DELAY_MS);
    });
  }

  clear(key: string): void {
    this.save(key, '');
  }

  private ensureLoaded(): Promise<void> {
    this.ready ??= (async () => {
      try {
        const { value } = await Preferences.get({ key: KEY });
        if (!value) return;
        const parsed = JSON.parse(value) as Record<string, Partial<DraftEntry>>;
        const now = Date.now();
        for (const [key, entry] of Object.entries(parsed)) {
          if (
            entry &&
            typeof entry.text === 'string' &&
            typeof entry.at === 'number' &&
            now - entry.at <= DRAFT_MAX_AGE_MS
          ) {
            this.drafts.set(key, { text: entry.text, at: entry.at });
          }
        }
      } catch {
        /* corrupted store — start fresh */
      }
    })();
    return this.ready;
  }

  private async flush(): Promise<void> {
    const entries = [...this.drafts.entries()]
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, MAX_ENTRIES);
    this.drafts = new Map(entries);
    try {
      await Preferences.set({ key: KEY, value: JSON.stringify(Object.fromEntries(entries)) });
    } catch {
      /* storage full/unavailable — drafts stay in memory for this run */
    }
  }
}
