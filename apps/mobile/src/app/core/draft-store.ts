import { Injectable } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import type { MobileAttachmentDto, MobileReasoningEffort } from './models';

export interface NewSessionDraft {
  text: string;
  directory: string;
  provider: string;
  model?: string;
  reasoningEffort?: MobileReasoningEffort;
}

function serializeNewSessionDraft(draft: NewSessionDraft): string {
  // Explicit fields keep native image blobs out of Preferences.
  const { text, directory, provider, model, reasoningEffort } = draft;
  return JSON.stringify({ text, directory, provider, model, reasoningEffort });
}

const REASONING_EFFORTS: MobileReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'workflow'];

export function parseNewSessionDraft(serialized: string): NewSessionDraft | null {
  try {
    const value: unknown = JSON.parse(serialized);
    if (!value || typeof value !== 'object') return null;
    const draft = value as Record<string, unknown>;
    if (typeof draft['text'] !== 'string' || typeof draft['directory'] !== 'string' || typeof draft['provider'] !== 'string') return null;
    return {
      text: draft['text'], directory: draft['directory'], provider: draft['provider'],
      model: typeof draft['model'] === 'string' ? draft['model'] : undefined,
      reasoningEffort: REASONING_EFFORTS.includes(draft['reasoningEffort'] as MobileReasoningEffort)
        ? draft['reasoningEffort'] as MobileReasoningEffort : undefined,
    };
  } catch {
    return null;
  }
}

/** Merge edits made before storage loaded; untouched settings remain those saved earlier. */
export function mergeEarlyNewSessionDraft(serialized: string, early: NewSessionDraft, initial: NewSessionDraft): string {
  const saved = parseNewSessionDraft(serialized);
  const configChanged = early.provider !== initial.provider || early.model !== initial.model
    || early.reasoningEffort !== initial.reasoningEffort;
  const config = !saved || configChanged ? early : saved;
  return serializeNewSessionDraft({
    text: [early.text.trimEnd(), saved?.text].filter(Boolean).join('\n\n'),
    directory: early.directory || saved?.directory || '',
    provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort,
  });
}

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
  private readonly attachmentDrafts = new Map<string, MobileAttachmentDto[]>();
  private readonly newSessionOwners = new Map<string, symbol>();
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
    this.saveText(key, text);
  }

  private saveText(key: string, text: string, stillOwned: () => boolean = () => true): void {
    void this.ensureLoaded().then(() => {
      if (!stillOwned()) return;
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

  /** Image drafts survive navigation in this process, never a Preferences write. */
  attachments(key: string): MobileAttachmentDto[] {
    return [...(this.attachmentDrafts.get(key) ?? [])];
  }

  saveAttachments(key: string, attachments: MobileAttachmentDto[], owner?: symbol): void {
    if (owner && this.newSessionOwners.get(key) !== owner) return;
    if (attachments.length) this.attachmentDrafts.set(key, [...attachments]);
    else this.attachmentDrafts.delete(key);
  }

  /** New Session configuration belongs to its paired host; attachments stay in memory. */
  async loadNewSession(hostId: string): Promise<NewSessionDraft | null> {
    if (!hostId) return null;
    return parseNewSessionDraft(await this.load(`new-session:${hostId}`));
  }

  saveNewSession(hostId: string, draft: NewSessionDraft, owner?: symbol): void {
    if (!hostId) return;
    const key = `new-session:${hostId}`;
    this.saveText(key, serializeNewSessionDraft(draft),
      () => !owner || this.newSessionOwners.get(key) === owner);
  }

  /** A recreated composer owns the draft even before its first edit or storage load. */
  claimNewSession(hostId: string): symbol {
    const owner = Symbol('New Session draft owner');
    this.newSessionOwners.set(`new-session:${hostId}`, owner);
    return owner;
  }

  /** Clear an acknowledged submission only if a newer composer has not taken ownership. */
  async completeNewSession(hostId: string, owner: symbol): Promise<boolean> {
    await this.ensureLoaded();
    const key = `new-session:${hostId}`;
    if (!hostId || this.newSessionOwners.get(key) !== owner) return false;
    this.drafts.delete(key);
    this.attachmentDrafts.delete(key);
    clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => void this.flush(), WRITE_DELAY_MS);
    return true;
  }

  /** Explicit recovery transfers legacy text only while this composer still owns its destination. */
  async recoverLegacyNewSession(hostId: string, owner: symbol, draft: NewSessionDraft, legacyText: string): Promise<boolean> {
    await this.ensureLoaded();
    const key = `new-session:${hostId}`;
    if (!hostId || this.newSessionOwners.get(key) !== owner || this.drafts.get('new-session')?.text !== legacyText) return false;
    this.drafts.set(key, { text: serializeNewSessionDraft(draft), at: Date.now() });
    this.drafts.delete('new-session');
    clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => void this.flush(), WRITE_DELAY_MS);
    return true;
  }

  clearNewSession(hostId: string): void {
    if (hostId) this.clear(`new-session:${hostId}`);
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
