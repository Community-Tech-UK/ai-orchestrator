import { describe, expect, it } from 'vitest';
import { resolveContextCeilingTokens } from '../../cli/adapters/context-ceiling';
import { applyInstanceSpawnPolicy } from '../../instance/lifecycle/instance-spawn-policy';
import { evaluateRecallEvidence } from '../../context/recall-replay/recall-evidence';
import type { RecallChatResult, RecallEvidence, RecallTally } from '../../context/recall-replay/recall-types';
import { OWN_CHAT_CEILING_RECALL_EVIDENCE } from './own-chat-ceiling-recall-evidence';
import {
  OWN_CHAT_CEILING_MIGRATION_KEY,
  OWN_CHAT_CEILING_TOKENS,
  migrateOwnChatContextCeiling,
} from './settings-migrations-own-chat-ceiling';
import type { SettingsMigrationStore } from './settings-migrations';

const NOW = new Date('2026-11-01T00:00:00Z');
const tally = (correct: number, partial = 0, wrong = 0, unknown = 0): RecallTally => ({ correct, partial, wrong, unknown });
const chat = (before: RecallTally, after: RecallTally, index: number): RecallChatResult => ({
  chatKey: `k${index}`, conversationKey: `c${index}`, contextTokensAtCut: 290_000, humanPrompts: 40, questionCount: 12, before, after,
  compaction: { boundaries: 1, preTokens: 292_000, postTokens: 20_000 }, costUsd: 1,
});
const evidence = (before: RecallTally, after: RecallTally): RecallEvidence => ({
  schema: 1, generatedAt: '2026-10-25T00:00:00Z', method: 'cli-replay', model: 'claude-sonnet-5-5', targetTokens: 300_000,
  chats: [0, 1, 2].map(index => chat(before, after, index)),
});
const passing = evidence(tally(10, 1, 1), tally(10, 1, 1));

function fakeStore(initial: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>(Object.entries(initial));
  const writes: Array<[string, unknown]> = [];
  const store: SettingsMigrationStore = {
    get: key => values.get(key),
    persistSetting: (key, value) => { values.set(key, value); writes.push([key, value]); },
    persistRawSetting: (key, value) => { values.set(key, value); writes.push([key, value]); },
  };
  return { store, values, writes };
}

describe('own-chat context ceiling migration', () => {
  it('changes nothing and writes no marker when no recall check is recorded, so a later release can still apply it', () => {
    const { store, writes } = fakeStore({ ownChatContextCeilingTokens: 0 });
    expect(migrateOwnChatContextCeiling(store, { evidence: null, now: () => NOW })).toEqual({ result: 'not-eligible', reason: 'no-evidence' });
    expect(writes).toEqual([]);
  });

  it('writes nothing at all, not even the marker, without a passing check, whatever the stored value is', () => {
    const worse = evidence(tally(11, 0, 1), tally(6, 0, 6));
    const stale = { ...passing, generatedAt: '2025-01-01T00:00:00Z' };
    const malformed = { ...passing, chats: passing.chats.slice(0, 2) };
    const unusable: Array<[string, unknown]> = [['none recorded', null], ['worse recall', worse], ['stale', stale], ['too few chats', malformed], ['garbage', { schema: 9 }]];
    const stored: Array<[string, Record<string, unknown>]> = [
      ['untouched zero', { ownChatContextCeilingTokens: 0 }],
      ['never stored', {}],
      ['the user\'s own cap', { ownChatContextCeilingTokens: 450_000 }],
      ['the user\'s own cap and a machine cap', { ownChatContextCeilingTokens: 450_000, machineContextCeilingTokens: 200_000 }],
    ];
    for (const [evidenceName, record] of unusable) {
      for (const [storedName, initial] of stored) {
        const { store, writes, values } = fakeStore(initial);
        const outcome = migrateOwnChatContextCeiling(store, { evidence: record, now: () => NOW });
        expect(outcome.result, `${evidenceName} / ${storedName}`).toBe('not-eligible');
        expect(writes, `${evidenceName} / ${storedName}`).toEqual([]);
        expect(values.has(OWN_CHAT_CEILING_MIGRATION_KEY)).toBe(false);
      }
    }
  });

  it('changes nothing when recall after the summary is clearly worse', () => {
    const { store, writes } = fakeStore({ ownChatContextCeilingTokens: 0 });
    const outcome = migrateOwnChatContextCeiling(store, { evidence: evidence(tally(11, 0, 1), tally(6, 0, 6)), now: () => NOW });
    expect(outcome).toEqual({ result: 'not-eligible', reason: 'recall-worse' });
    expect(writes).toEqual([]);
  });

  it('changes nothing when the recall check has gone stale', () => {
    const { store, writes } = fakeStore({ ownChatContextCeilingTokens: 0 });
    expect(migrateOwnChatContextCeiling(store, { evidence: passing, now: () => new Date('2027-03-01T00:00:00Z') })).toMatchObject({ reason: 'stale' });
    expect(writes).toEqual([]);
  });

  it('sets 300,000 once when the stored value is the untouched 0 and the check passed', () => {
    const { store, values, writes } = fakeStore({ ownChatContextCeilingTokens: 0, machineContextCeilingTokens: 0 });
    expect(migrateOwnChatContextCeiling(store, { evidence: passing, now: () => NOW })).toEqual({ result: 'applied' });
    expect(values.get('ownChatContextCeilingTokens')).toBe(OWN_CHAT_CEILING_TOKENS);
    expect(values.get(OWN_CHAT_CEILING_MIGRATION_KEY)).toBe(true);
    expect(values.get('machineContextCeilingTokens')).toBe(0);
    expect(writes.map(([key]) => key)).toEqual(['ownChatContextCeilingTokens', OWN_CHAT_CEILING_MIGRATION_KEY]);
    expect(migrateOwnChatContextCeiling(store, { evidence: passing, now: () => NOW })).toEqual({ result: 'already-done' });
    expect(writes).toHaveLength(2);
  });

  it('gives the cap to James\'s own chats only: helper children and queue, loop and automation sessions keep the machine ceiling of 0', () => {
    const { store, values } = fakeStore({ ownChatContextCeilingTokens: 0, machineContextCeilingTokens: 0 });
    expect(migrateOwnChatContextCeiling(store, { evidence: passing, now: () => NOW })).toEqual({ result: 'applied' });
    const read = (key: string): unknown => values.get(key);
    const ceilingFor = (instance: Parameters<typeof applyInstanceSpawnPolicy>[1]): number | undefined =>
      resolveContextCeilingTokens(Boolean(applyInstanceSpawnPolicy('claude', instance, {}).machineSession), read);
    // The real spawn path: the instance decides machineSession, the adapter factory picks the ceiling key from it.
    expect(ceilingFor({ depth: 0, metadata: {}, additionalDirectories: [] } as never)).toBe(300_000);
    expect(ceilingFor({ depth: 1, parentId: 'parent', metadata: {}, additionalDirectories: [] } as never)).toBeUndefined();
    expect(ceilingFor({ depth: 0, metadata: { planQueueRole: 'worker' }, additionalDirectories: [] } as never)).toBeUndefined();
    expect(ceilingFor({ depth: 0, metadata: { loopRunId: 'l', spendPurpose: 'automation' }, additionalDirectories: [] } as never)).toBeUndefined();
    expect(ceilingFor({ depth: 0, metadata: { spawnParentInstanceId: 'x' }, additionalDirectories: [] } as never)).toBeUndefined();
  });

  it('also applies when the setting was never stored', () => {
    const { store, values } = fakeStore();
    expect(migrateOwnChatContextCeiling(store, { evidence: passing, now: () => NOW })).toEqual({ result: 'applied' });
    expect(values.get('ownChatContextCeilingTokens')).toBe(300_000);
  });

  it('never overrides a value the user chose, and stops looking at it', () => {
    const { store, values, writes } = fakeStore({ ownChatContextCeilingTokens: 450_000 });
    expect(migrateOwnChatContextCeiling(store, { evidence: passing, now: () => NOW })).toEqual({ result: 'user-value-kept', value: 450_000 });
    expect(values.get('ownChatContextCeilingTokens')).toBe(450_000);
    expect(writes).toEqual([[OWN_CHAT_CEILING_MIGRATION_KEY, true]]);
  });

  it('uses the evidence compiled into the app unless told otherwise', () => {
    const { store, writes } = fakeStore({ ownChatContextCeilingTokens: 0 });
    const outcome = migrateOwnChatContextCeiling(store, { now: () => NOW });
    if (OWN_CHAT_CEILING_RECALL_EVIDENCE === null) {
      expect(outcome).toEqual({ result: 'not-eligible', reason: 'no-evidence' });
      expect(writes).toEqual([]);
    } else {
      expect(outcome.result).toBeOneOf(['applied', 'not-eligible']);
    }
  });

  it('only ships recall evidence that passed the rule on the day it was recorded', () => {
    if (OWN_CHAT_CEILING_RECALL_EVIDENCE === null) return;
    expect(evaluateRecallEvidence(OWN_CHAT_CEILING_RECALL_EVIDENCE, new Date(OWN_CHAT_CEILING_RECALL_EVIDENCE.generatedAt))).toMatchObject({ eligible: true });
  });
});
