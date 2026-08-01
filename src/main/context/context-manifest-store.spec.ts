import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  _resetAllContextManifestsForTesting,
  buildContextManifestEntries,
  deleteContextManifest,
  getContextManifestHistory,
  getLatestContextManifest,
  recordContextManifest,
} from './context-manifest-store';
import { SYSTEM_PROMPT_BLOCK_ORDER, type SystemPromptBlockManifestEntry } from './prompt-injection-contract';

describe('context-manifest-store (WS-C6)', () => {
  beforeEach(() => {
    _resetAllContextManifestsForTesting();
  });

  describe('buildContextManifestEntries', () => {
    it('produces exactly one entry per SYSTEM_PROMPT_BLOCK_ORDER kind', () => {
      const entries = buildContextManifestEntries([]);
      expect(entries.map((entry) => entry.kind)).toEqual([...SYSTEM_PROMPT_BLOCK_ORDER]);
      expect(entries.every((entry) => entry.status === 'skipped-empty')).toBe(true);
    });

    it('marks composed blocks as supplied with hash/length/position, never content', () => {
      const manifest: SystemPromptBlockManifestEntry[] = [
        { kind: 'instructions', contentHash: 'abc123', charLength: 42, position: 0 },
      ];
      const entries = buildContextManifestEntries(manifest);
      const instructions = entries.find((entry) => entry.kind === 'instructions');
      expect(instructions).toEqual({
        kind: 'instructions',
        status: 'supplied',
        contentHash: 'abc123',
        charLength: 42,
        position: 0,
      });
      // No entry object anywhere carries anything beyond kind/status/hash/length/position.
      for (const entry of entries) {
        expect(Object.keys(entry).sort()).toEqual(
          expect.arrayContaining(['kind', 'status']),
        );
      }
    });

    it('distinguishes unavailable (real failure) from skipped-empty (no content)', () => {
      const entries = buildContextManifestEntries([], new Set(['wake-context']));
      expect(entries.find((entry) => entry.kind === 'wake-context')?.status).toBe('unavailable');
      expect(entries.find((entry) => entry.kind === 'lessons')?.status).toBe('skipped-empty');
    });
  });

  describe('recordContextManifest', () => {
    it('advances the epoch counter per instance, starting at 0', () => {
      const first = recordContextManifest('inst-1', 'spawn', []);
      const second = recordContextManifest('inst-1', 'respawn', []);
      expect(first.epoch).toBe(0);
      expect(second.epoch).toBe(1);
    });

    it('keeps separate epoch counters per instance', () => {
      recordContextManifest('inst-1', 'spawn', []);
      const otherFirst = recordContextManifest('inst-2', 'spawn', []);
      expect(otherFirst.epoch).toBe(0);
    });

    it('records the trigger, timestamp, and optional note', () => {
      const snapshot = recordContextManifest('inst-1', 'restart-compact', [], {
        note: 'no blocks re-injected',
        now: 12345,
      });
      expect(snapshot).toMatchObject({ trigger: 'restart-compact', at: 12345, note: 'no blocks re-injected' });
    });

    it('omits the note field entirely when none is given', () => {
      const snapshot = recordContextManifest('inst-1', 'spawn', []);
      expect('note' in snapshot).toBe(false);
    });

    it('bounds history to the most recent 20 epochs per instance', () => {
      for (let i = 0; i < 25; i++) {
        recordContextManifest('inst-1', 'spawn', []);
      }
      const history = getContextManifestHistory('inst-1');
      expect(history).toHaveLength(20);
      expect(history[0].epoch).toBe(5); // epochs 0-4 evicted
      expect(history[19].epoch).toBe(24);
    });
  });

  describe('getLatestContextManifest', () => {
    it('returns undefined for an instance with no history', () => {
      expect(getLatestContextManifest('unknown')).toBeUndefined();
    });

    it('returns the most recently recorded snapshot', () => {
      recordContextManifest('inst-1', 'spawn', []);
      const latest = recordContextManifest('inst-1', 'respawn', []);
      expect(getLatestContextManifest('inst-1')).toEqual(latest);
    });
  });

  describe('deleteContextManifest', () => {
    it('drops all recorded history for an instance', () => {
      recordContextManifest('inst-1', 'spawn', []);
      deleteContextManifest('inst-1');
      expect(getContextManifestHistory('inst-1')).toEqual([]);
    });
  });
});
