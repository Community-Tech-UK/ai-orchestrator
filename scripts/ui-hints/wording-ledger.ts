import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { normalizePath, SHORTCUT_SOURCE, SHORTCUT_PATTERN, type Analysis } from './types';

export interface LedgerEntry { id: string; owner: string; text: string; why: 'consequence' | 'long'; retired?: string }
export type Ledger = LedgerEntry[];
const shortcutGroups = /\((?:[^)]*[⌘⌥⇧⌃][^)]*|[^)]*(?:Cmd|Ctrl|Alt|Shift)\+[^)]*|Esc|Enter)\)|[⌘⌥⇧⌃]+\s*[\p{L}\p{N}]+|(?:Cmd|Ctrl|Alt|Shift)(?:\+(?:Cmd|Ctrl|Alt|Shift))*\+[\p{L}\p{N}]+|\+Enter|-click/giu;
// Shared H5 pattern is exported so parity tests detect additions needing token stripping too.
export const ledgerShortcutSource = SHORTCUT_SOURCE;
export function tokens(text: string): string[] { return text.normalize('NFKC').replace(/\([^)]*\)/g, group => SHORTCUT_PATTERN.test(group) ? '' : group).replace(shortcutGroups, '').toLocaleLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []; }
const consequences = /\b(?:delet\w*|discard\w*|revert\w*|remov\w*|terminat\w*|kill\w*|force\w*|overwrit\w*|reset\w*|wipe\w*|los[et]\w*|irreversible|permanent\w*|yolo|auto.approv\w*|bypass\w*|unsaved|not saved|crash\w*|revok\w*|disconnect\w*|archiv\w*|restart\w*|clear\w*|send\w*|sent|replac\w*|empty|sign out|stop\w*|cancel\w*|clos\w*|cost\w*|spend\w*|never|cannot|expir\w*)\b/i;
export function classify(text: string): LedgerEntry['why'] | null {
  const count = tokens(text).length;
  return count < 3 ? null : consequences.test(text) ? 'consequence' : count >= 7 ? 'long' : null;
}
function carries(needle: string[], stream: string[]): boolean {
  return stream.some((_, start) => needle.every((word, index) => stream[start + index] === word));
}
export function validateLedger(ledger: Ledger): string[] {
  const errors: string[] = []; const ids = new Set<string>(); const reasons = new Set<string>();
  for (const entry of ledger) {
    if (ids.has(entry.id) || !entry.id || !tokens(entry.text).length || !['consequence', 'long'].includes(entry.why) || !normalizePath(entry.owner).startsWith('src/renderer/') || entry.owner.includes('../')) errors.push('H12 invalid ledger entry ' + entry.id);
    ids.add(entry.id);
    if (entry.retired !== undefined) {
      if (entry.retired.trim().length < 20 || reasons.has(entry.retired.trim())) errors.push('H12 retirement reason must be unique and at least 20 characters: ' + entry.id);
      reasons.add(entry.retired.trim());
    }
  }
  return errors;
}
export function checkLedger(analysis: Analysis, ledger: Ledger): string[] {
  return [...validateLedger(ledger), ...ledger.filter(entry => !entry.retired).flatMap(entry => {
    const old = tokens(entry.text); const stream = (analysis.streams[normalizePath(entry.owner)] ?? []).flatMap(tokens);
    if (carries(old, stream)) return [];
    const missing = old.filter(word => !stream.includes(word));
    return [`H9 hover wording lost: ${entry.id} ${entry.owner}; lost words: ${(missing.length ? missing : old).join(' ')}. Keep the words in a tooltip or visible text of that component, or --retire ${entry.id} --reason "...". See docs/screen-and-wording-guide.md, section 5.`];
  })];
}
export function qualifying(analysis: Analysis): Ledger {
  const unique = new Map<string, LedgerEntry>();
  for (const fact of analysis.facts) for (const hover of fact.hover) for (const text of hover.fragments) {
    const why = classify(text); if (!why) continue;
    const owner = normalizePath(fact.ownerFile); const key = owner + '\0' + tokens(text).join(' ');
    unique.set(key, { id: createHash('sha256').update(key).digest('hex').slice(0, 16), owner, text, why });
  }
  return [...unique.values()].sort((a, b) => a.owner.localeCompare(b.owner) || a.id.localeCompare(b.id));
}
export function recordNew(analysis: Analysis, ledger: Ledger): Ledger {
  const existing = new Set(ledger.map(entry => normalizePath(entry.owner) + '\0' + tokens(entry.text).join(' ')));
  return [...ledger, ...qualifying(analysis).filter(entry => !existing.has(entry.owner + '\0' + tokens(entry.text).join(' ')))];
}
export function retire(ledger: Ledger, id: string, reason: string): Ledger {
  if (reason.trim().length < 20 || ledger.some(entry => entry.retired?.trim() === reason.trim())) throw new Error('Retirement needs a unique reason of at least 20 characters');
  const entry = ledger.find(entry => entry.id === id); if (!entry) throw new Error('Unknown ledger id: ' + id);
  if (entry.retired) throw new Error('Entry is already retired');
  return ledger.map(entry => entry.id === id ? { ...entry, retired: reason.trim() } : entry);
}
export function compareLedgers(previous: Ledger, next: Ledger): { errors: string[]; retirements: string[] } {
  const errors = validateLedger(next); const retirements: string[] = [];
  for (const old of previous) {
    const current = next.find(entry => entry.id === old.id);
    if (!current) errors.push('H9 ledger entry removed: ' + old.id);
    else {
      if (normalizePath(current.owner) !== normalizePath(old.owner) || current.text !== old.text || current.why !== old.why) errors.push('H9 ledger words edited: ' + old.id);
      if (old.retired && current.retired !== old.retired) errors.push('H9 retirement audit trail edited: ' + old.id);
      if (!old.retired && current.retired) retirements.push(`${current.id}: ${current.retired}`);
    }
  }
  return { errors, retirements };
}
export const readLedger = (file: string): Ledger => {
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(value) || value.some(entry => !entry || typeof entry !== 'object' || typeof entry.id !== 'string' || typeof entry.owner !== 'string' || typeof entry.text !== 'string' || typeof entry.why !== 'string' || entry.retired !== undefined && typeof entry.retired !== 'string')) throw new Error('H12 malformed wording ledger');
  return value as Ledger;
};
export const writeLedger = (file: string, ledger: Ledger): void => { writeFileSync(file, JSON.stringify(ledger, null, 2) + '\n'); };
