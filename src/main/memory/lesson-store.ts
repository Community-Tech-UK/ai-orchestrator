/**
 * Reinforced lessons store (claude2_todo #15).
 *
 * The structured half of durable, human-readable handovers: append-only
 * "lessons" with a `reinforcements` counter, a `supersedes` link, and an
 * active/deprecated status. The key behavior is **reinforce-don't-duplicate** —
 * re-capturing the same lesson (by normalized text) bumps its reinforcement
 * count instead of adding a near-duplicate — and a **ranked digest** to inject
 * at session start (most-reinforced, most-recent first).
 *
 * Pure and in-memory (`now` injectable); a `.story/`-style markdown/db backing
 * store can persist + rehydrate these records. Text normalization is exposed so
 * a persistence layer can key on it too.
 */

export type LessonStatus = 'active' | 'deprecated';

export interface Lesson {
  id: string;
  text: string;
  reinforcements: number;
  status: LessonStatus;
  /** Id of the lesson this one replaced, if any. */
  supersedes?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CaptureResult {
  lesson: Lesson;
  /** True when an existing lesson was reinforced rather than a new one created. */
  reinforced: boolean;
}

/** Normalize lesson text for dedup: lowercase, collapse whitespace, trim. */
export function normalizeLessonText(text: string): string {
  return (text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Small deterministic string hash (djb2) for content-derived ids. */
function hashText(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

export class LessonStore {
  private readonly lessons = new Map<string, Lesson>();

  /**
   * Capture a lesson. If an **active** lesson with the same normalized text
   * already exists, its reinforcement count is incremented (reinforce, don't
   * duplicate); otherwise a new active lesson is created.
   */
  capture(text: string, now: number = Date.now()): CaptureResult {
    const normalized = normalizeLessonText(text);
    if (!normalized) {
      throw new Error('Cannot capture an empty lesson');
    }

    for (const lesson of this.lessons.values()) {
      if (lesson.status === 'active' && normalizeLessonText(lesson.text) === normalized) {
        lesson.reinforcements += 1;
        lesson.updatedAt = now;
        return { lesson, reinforced: true };
      }
    }

    const id = `lesson-${hashText(normalized)}`;
    const lesson: Lesson = {
      id,
      text: text.trim(),
      reinforcements: 1,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    this.lessons.set(id, lesson);
    return { lesson, reinforced: false };
  }

  /**
   * Replace an existing lesson with a new one: the old lesson is deprecated and
   * the new lesson links back to it via `supersedes`. The new lesson inherits
   * the old reinforcement count + 1 (the act of superseding is itself a signal).
   */
  supersede(oldId: string, newText: string, now: number = Date.now()): Lesson {
    const old = this.lessons.get(oldId);
    if (!old) throw new Error(`Unknown lesson: ${oldId}`);
    old.status = 'deprecated';
    old.updatedAt = now;

    const normalized = normalizeLessonText(newText);
    const id = `lesson-${hashText(`${normalized}|supersedes:${oldId}`)}`;
    const lesson: Lesson = {
      id,
      text: newText.trim(),
      reinforcements: old.reinforcements + 1,
      status: 'active',
      supersedes: oldId,
      createdAt: now,
      updatedAt: now,
    };
    this.lessons.set(id, lesson);
    return lesson;
  }

  deprecate(id: string): boolean {
    const lesson = this.lessons.get(id);
    if (!lesson || lesson.status === 'deprecated') return false;
    lesson.status = 'deprecated';
    return true;
  }

  get(id: string): Lesson | undefined {
    return this.lessons.get(id);
  }

  all(): Lesson[] {
    return [...this.lessons.values()];
  }

  active(): Lesson[] {
    return this.all().filter((l) => l.status === 'active');
  }

  /**
   * Ranked digest of active lessons to inject at session start: most-reinforced
   * first, then most-recently-updated, then stable by id. Optionally limited.
   */
  digest(limit?: number): Lesson[] {
    const ranked = this.active().sort(
      (a, b) =>
        b.reinforcements - a.reinforcements ||
        b.updatedAt - a.updatedAt ||
        a.id.localeCompare(b.id),
    );
    return typeof limit === 'number' ? ranked.slice(0, Math.max(0, limit)) : ranked;
  }
}
