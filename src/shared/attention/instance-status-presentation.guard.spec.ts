/**
 * Guard for step 5 of the Oct-2 calm-screen plan: one status presenter.
 *
 * Five places used to describe one session state in five vocabularies. The
 * words and colours now come from `instance-status-presentation.ts`. This spec
 * reads the production source and fails when a NEW local map of session-status
 * words, colours or dot flags appears, or when an old status word comes back as
 * a string. The detector is `scripts/test-utils/status-label-maps.ts` (what
 * counts as a map is described there).
 *
 * Like the provider-name guard it is a ratchet with an honest baseline: the
 * files below still carry such a map or word, each with the reason. The lists
 * can only go down.
 */

import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  listProductionSources,
  parseSource,
  readSource,
} from '../../../scripts/test-utils/source-scan';
import { SESSION_ONLY_STATUSES, findLocalStatusMaps } from '../../../scripts/test-utils/status-label-maps';

/** Files that may map a session status to something other than the shared words. */
const ALLOWED_STATUS_MAPS: Record<string, { count: number; reason: string }> = {
  'src/shared/attention/attention-level.ts': {
    count: 1,
    reason: 'Maps a status to an urgency level (blocked, failed, working...), which orders surfaces; it is not words or a colour.',
  },
  'src/shared/types/workflow-lifecycle.types.ts': {
    count: 1,
    reason: 'Maps a status to a workflow phase name used by the workflow engine, not shown as words.',
  },

};

/** Old status words that must not come back as whole strings, and where they still are. */
const BANNED_STATUS_WORDS: ReadonlySet<string> = new Set([
  'Waiting for input', 'Waiting for permission', 'Awaiting input', 'Thinking deeply', 'Thinking deeply...',
  'Hibernating...', 'Hibernated', 'Recovering session', 'Recovering session...', 'Escalating interrupt',
  'Escalating interrupt...', 'Processing...', 'Needs approval', 'Awaiting approval',
]);
const REMAINING_OLD_WORDS: Record<string, { count: number; reason: string }> = {
  'src/renderer/app/features/instance-detail/instance-detail.component.ts': {
    count: 1,
    reason: 'The composer placeholder while a turn runs ("Processing..."); it belongs with the composer workstream.',
  },
};

interface Scan {
  maps: Map<string, number>;
  words: Map<string, number>;
}

function scanProduction(): Scan {
  const maps = new Map<string, number>();
  const words = new Map<string, number>();
  for (const path of listProductionSources(['src', 'packages', 'apps/mobile/src'])) {
    const text = readSource(path);
    const namesStatus = [...SESSION_ONLY_STATUSES].filter((name) => text.includes(name)).length >= 3
      || text.includes('InstanceStatus');
    const mentionsOldWord = [...BANNED_STATUS_WORDS].some((word) => text.includes(word));
    if (!namesStatus && !mentionsOldWord) continue;
    const file = parseSource(path, text);
    if (namesStatus) {
      const hits = findLocalStatusMaps(file).length;
      if (hits > 0) maps.set(path, hits);
    }
    if (mentionsOldWord) {
      let found = 0;
      const visit = (node: ts.Node): void => {
        if (ts.isStringLiteralLike(node) && BANNED_STATUS_WORDS.has(node.text)) found += 1;
        ts.forEachChild(node, visit);
      };
      visit(file);
      if (found > 0) words.set(path, found);
    }
  }
  return { maps, words };
}

function overBudget(found: Map<string, number>, allowed: Record<string, { count: number }>, what: string): string[] {
  return [...found]
    .filter(([path, count]) => count > (allowed[path]?.count ?? 0))
    .map(([path, count]) => `${path}: ${count} ${what} (allowed ${allowed[path]?.count ?? 0}). `
      + 'Use presentInstanceStatus() from src/shared/attention/instance-status-presentation.ts.');
}

function staleEntries(found: Map<string, number>, allowed: Record<string, { count: number }>): string[] {
  return Object.entries(allowed)
    .filter(([path, { count }]) => (found.get(path) ?? 0) < count)
    .map(([path, { count }]) => `${path}: baseline says ${count}, source has ${found.get(path) ?? 0}. Lower or remove the entry.`);
}

describe('instance-status-presentation guard: one status vocabulary', () => {
  const { maps, words } = scanProduction();

  it('reads the whole source tree, so a silent scan of nothing cannot pass', () => {
    expect(listProductionSources(['src']).length).toBeGreaterThan(1500);
    // The detector must still see the legitimate non-presentation maps, or it has stopped working.
    expect([...maps.keys()].sort()).toEqual(Object.keys(ALLOWED_STATUS_MAPS).sort());
  });

  it('has no local map of session-status words, colours or dot flags outside the baseline', () => {
    expect(overBudget(maps, ALLOWED_STATUS_MAPS, 'local session-status map(s)')).toEqual([]);
    expect(staleEntries(maps, ALLOWED_STATUS_MAPS)).toEqual([]);
  });

  it('does not bring the old status words back as strings', () => {
    expect(overBudget(words, REMAINING_OLD_WORDS, 'old status word(s)')).toEqual([]);
    expect(staleEntries(words, REMAINING_OLD_WORDS)).toEqual([]);
  });

  it('gives every baseline entry a reason', () => {
    for (const [path, { reason }] of [...Object.entries(ALLOWED_STATUS_MAPS), ...Object.entries(REMAINING_OLD_WORDS)]) {
      expect(reason.trim().length, path).toBeGreaterThan(20);
    }
  });

  it('keeps the live sites on the presenter (the fifth, status-colors.ts, is deleted)', () => {
    const importsPresenter = (path: string): boolean =>
      /instance-status-presentation['"]/.test(readSource(path));
    for (const path of [
      'src/renderer/app/features/instance-list/status-indicator.component.ts',
      'src/renderer/app/features/instance-list/instance-row.component.ts',
      'src/renderer/app/features/instance-detail/child-instances-panel.component.ts',
      'src/main/mobile-gateway/mobile-gateway-push.ts',
      'apps/mobile/src/app/core/status.ts',
    ]) {
      expect(importsPresenter(path), `${path} must ask the status presenter`).toBe(true);
    }
  });
});

describe('findLocalStatusMaps (the detector itself)', () => {
  const scan = (source: string) => findLocalStatusMaps(parseSource('sample.ts', source)).map((hit) => hit.kind);

  it('finds a Record declaration, an object of words and a switch that returns words', () => {
    expect(scan(`const a: Record<InstanceStatus, string> = {} as never;`)).toEqual(['record']);
    expect(scan(`const b = { thinking_deeply: 'Thinking deeply...', respawning: 'Recovering', hibernated: 'Hibernated' };`)).toEqual(['object']);
    expect(scan(`const p = { respawning: true, hibernating: true, waking: true, busy: false };`)).toEqual(['object']);
    expect(scan(`function f(s: string) { switch (s) { case 'respawning': return 'recovering'; case 'hibernating': return 'sleeping'; case 'waking': return 'waking'; default: return ''; } }`))
      .toEqual(['switch']);
  });

  it('counts stacked cases that share one returned word', () => {
    expect(scan(`function f(s: string) { switch (s) { case 'respawning': case 'hibernating': case 'waking': return 'x'; default: return ''; } }`))
      .toEqual(['switch']);
  });

  it('ignores generic status names, non-text returns and records of other shapes', () => {
    expect(scan(`const loops = { running: 'Running', failed: 'Failed', cancelled: 'Cancelled', idle: 'Idle' };`)).toEqual([]);
    expect(scan(`function f(s: string) { switch (s) { case 'respawning': return 1; case 'hibernating': return 2; case 'waking': return 3; default: return 0; } }`)).toEqual([]);
    expect(scan(`const t: Readonly<Record<InstanceStatus, readonly InstanceStatus[]>> = {} as never;`)).toEqual([]);
    expect(scan(`function f(s: string) { switch (s) { case 'respawning': return true; case 'hibernating': return true; case 'waking': return true; default: return false; } }`)).toEqual([]);
  });
});
