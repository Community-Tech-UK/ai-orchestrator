import { Injectable, signal } from '@angular/core';

const STORAGE_KEY = 'loop:recent-prompts';
const MAX_ENTRIES = 3;

/**
 * Distillation of the user's manual loop instructions — used as the starting
 * default when there is no typed text and no recall history.
 */
export const DEFAULT_LOOP_PROMPT =
  "Please continue. Choose the best architectural decision — don't be lazy, don't take shortcuts. " +
  'Re-review your work with completely fresh eyes after each stage and fix any issues. ' +
  'When a plan file is fully implemented, rename it with `_Completed`.';

@Injectable({ providedIn: 'root' })
export class LoopPromptHistoryService {
  private state = signal<string[]>(this.load());

  recent = this.state.asReadonly();

  /** Push a prompt to the front, dedupe, cap at MAX_ENTRIES. */
  remember(prompt: string): void {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    const next = [trimmed, ...this.state().filter((p) => p !== trimmed)].slice(0, MAX_ENTRIES);
    this.state.set(next);
    this.save(next);
  }

  private load(): string[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((v): v is string => typeof v === 'string').slice(0, MAX_ENTRIES);
    } catch {
      return [];
    }
  }

  private save(entries: string[]): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch {
      // best-effort; if storage is full or unavailable, drop silently
    }
  }
}
