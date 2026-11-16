/** The wording rules applied to the strings `extract-ui-text.ts` finds (Phase 3, step 8a). */
import { APP_NAME_PATTERN } from '../../src/shared/copy/ui-vocabulary';
import type { UiString } from './extract-ui-text';

export type UiTextRule = 'app-name' | 'instance-thread' | 'status-word';

export interface UiTextHit {
  rule: UiTextRule;
  file: string;
  line: number;
  text: string;
  /** The exact words that broke the rule. */
  match: string;
}

const INSTANCE_THREAD = /\b(?:instances?|threads?)\b/gi;
/** Old session-status phrases. Capitalised on purpose: the lower-case forms are status values and prose. */
const STATUS_WORDS = /\b(?:Waiting for input|Waiting for permission|Thinking deeply|Awaiting input|Needs approval|Hibernating|Hibernated)\b/;
/** A one-word string is data (a provider id) unless it is one of the capitalised names. */
const SINGLE_WORD_NAME = /^(?:Orchestrator|AIO)$/;

export function appNameHits(strings: readonly UiString[]): UiTextHit[] {
  return strings.flatMap((s) => {
    if (!/\s/.test(s.text.trim()) && !SINGLE_WORD_NAME.test(s.text.trim())) return [];
    const match = APP_NAME_PATTERN.exec(s.text);
    return match ? [{ rule: 'app-name' as const, file: s.file, line: s.line, text: s.text, match: match[0] }] : [];
  });
}

/** Counted in renderer and shared copy only; main's internal errors are out of scope. */
export function instanceThreadHits(strings: readonly UiString[]): UiTextHit[] {
  return strings.flatMap((s) => {
    if (!/^src\/(?:renderer|shared)\//.test(s.file) || !/\s/.test(s.text.trim())) return [];
    return [...s.text.matchAll(INSTANCE_THREAD)].map((m) => ({ rule: 'instance-thread' as const, file: s.file, line: s.line, text: s.text, match: m[0] }));
  });
}

export function statusWordHits(strings: readonly UiString[]): UiTextHit[] {
  return strings.flatMap((s) => {
    const match = STATUS_WORDS.exec(s.text);
    return match ? [{ rule: 'status-word' as const, file: s.file, line: s.line, text: s.text, match: match[0] }] : [];
  });
}

export function countByFile(hits: readonly UiTextHit[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const hit of hits) counts[hit.file] = (counts[hit.file] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}
