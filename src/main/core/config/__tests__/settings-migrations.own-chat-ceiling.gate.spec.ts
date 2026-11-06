import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveContextCeilingTokens } from '../../../cli/adapters/context-ceiling';
import type { RecallChatResult, RecallEvidence, RecallTally } from '../../../context/recall-replay/recall-types';
import { MACHINE_SESSION_REASONS, machineSessionReasonOf } from '../../../../shared/utils/machine-session';
import type { SettingsMigrationStore } from '../settings-migrations';

/**
 * The strict gate, driven through the real `runSettingsMigrations` seam with SYNTHETIC evidence that exists only in
 * this file (the evidence module is replaced per test). No real transcript, score, setting or database is involved;
 * the shipped evidence is `null` and is covered by the sibling "shipped" spec.
 */
vi.mock('electron', () => ({ app: { getPath: () => join(tmpdir(), 'aio-own-chat-ceiling-no-user-data') } }));
vi.mock('../../../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock('../../../cli/adapters/adapter-spawn-helpers', () => ({ getCopilotOrchestratorHome: () => join(tmpdir(), 'aio-own-chat-ceiling-no-copilot-home') }));
vi.mock('../settings-migrations-provider-accounts', () => ({ migrateProviderAccountLegacyProfiles: () => false, migrateOpenCodeLegacyProfile: () => false }));

const KEY = '__migration_own_chat_context_ceiling_300k_20261021';
const tally = (correct: number, partial = 0, wrong = 0, unknown = 0): RecallTally => ({ correct, partial, wrong, unknown });
const chat = (index: number, before: RecallTally, after: RecallTally): RecallChatResult => ({
  chatKey: `synthetic-${index}`, conversationKey: `synthetic-conversation-${index}`, contextTokensAtCut: 290_000, humanPrompts: 40, questionCount: 12,
  before, after, compaction: { boundaries: 1, preTokens: 292_000, postTokens: 20_000 }, costUsd: 1,
});
const evidence = (before: RecallTally, after: RecallTally, over: Partial<RecallEvidence> = {}): RecallEvidence => ({
  schema: 1, generatedAt: new Date().toISOString(), method: 'cli-replay', model: 'synthetic-test-model', targetTokens: 300_000,
  chats: [0, 1, 2].map(index => chat(index, before, after)), ...over,
});
const passing = (): RecallEvidence => evidence(tally(10, 1, 1), tally(10, 1, 1));

async function seam(fixture: unknown): Promise<typeof import('../settings-migrations')> {
  vi.resetModules();
  vi.doMock('../own-chat-ceiling-recall-evidence', () => ({ OWN_CHAT_CEILING_RECALL_EVIDENCE: fixture }));
  return import('../settings-migrations');
}

function createStore(initial: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = { ...initial };
  const writes: string[] = [];
  const store: SettingsMigrationStore = {
    get: key => values[key],
    persistSetting: (key, value) => { values[key] = value; writes.push(key); },
    persistRawSetting: (key, value) => { values[key] = value; writes.push(key); },
  };
  return { store, values, writes };
}
const ours = (writes: string[]): string[] => writes.filter(key => ['ownChatContextCeilingTokens', 'machineContextCeilingTokens', KEY].includes(key));

describe('strict own-chat ceiling gate through runSettingsMigrations (synthetic evidence only)', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.doUnmock('../own-chat-ceiling-recall-evidence'); });

  it('with passing evidence sets 300,000 for chats once, writes the marker, and never touches the helper ceiling', async () => {
    const { runSettingsMigrations } = await seam(passing());
    const { store, values, writes } = createStore({ ownChatContextCeilingTokens: 0, machineContextCeilingTokens: 0 });
    runSettingsMigrations(store);
    expect(values['ownChatContextCeilingTokens']).toBe(300_000);
    expect(values[KEY]).toBe(true);
    expect(values['machineContextCeilingTokens']).toBe(0);
    expect(ours(writes)).toEqual(['ownChatContextCeilingTokens', KEY]);
    runSettingsMigrations(store);
    runSettingsMigrations(store);
    expect(ours(writes)).toEqual(['ownChatContextCeilingTokens', KEY]);
  });

  it('with passing evidence also applies where the setting was never stored', async () => {
    const { runSettingsMigrations } = await seam(passing());
    const { store, values } = createStore();
    runSettingsMigrations(store);
    expect(values['ownChatContextCeilingTokens']).toBe(300_000);
    expect(values['machineContextCeilingTokens']).toBeUndefined();
  });

  it('with passing evidence keeps a cap the user chose for chats, and the helper cap, and only records that it has looked', async () => {
    const { runSettingsMigrations } = await seam(passing());
    const { store, values, writes } = createStore({ ownChatContextCeilingTokens: 450_000, machineContextCeilingTokens: 200_000 });
    runSettingsMigrations(store);
    expect(values['ownChatContextCeilingTokens']).toBe(450_000);
    expect(values['machineContextCeilingTokens']).toBe(200_000);
    expect(ours(writes)).toEqual([KEY]);
  });

  it('with passing evidence the cap reaches the user\'s own chats and no helper, loop, queue, automation or other machine session', async () => {
    const { runSettingsMigrations } = await seam(passing());
    const { store, values } = createStore({ ownChatContextCeilingTokens: 0, machineContextCeilingTokens: 0 });
    runSettingsMigrations(store);
    const read = (key: string): unknown => values[key];
    // A chat of his own has no machine reason; everything the app starts by itself, including any child, has one.
    expect(machineSessionReasonOf({ metadata: {} })).toBeNull();
    expect(resolveContextCeilingTokens(Boolean(machineSessionReasonOf({ metadata: {} })), read)).toBe(300_000);
    for (const reason of MACHINE_SESSION_REASONS) expect(resolveContextCeilingTokens(Boolean(reason), read), reason).toBeUndefined();
    for (const session of [{ parentId: 'parent' }, { metadata: { planQueueRole: 'worker' } }, { metadata: { automationId: 'a' } }, { metadata: { spawnParentInstanceId: 'x' } }]) {
      expect(machineSessionReasonOf(session), JSON.stringify(session)).not.toBeNull();
      expect(resolveContextCeilingTokens(Boolean(machineSessionReasonOf(session)), read), JSON.stringify(session)).toBeUndefined();
    }
  });

  const unusable: Array<[string, () => unknown]> = [
    ['no evidence', () => null],
    ['clearly worse recall', () => evidence(tally(11, 0, 1), tally(5, 0, 7))],
    ['a chat that lost more than the single-chat limit even though the pool looks fine', () => ({
      ...passing(), chats: [chat(0, tally(12), tally(12)), chat(1, tally(12), tally(12)), chat(2, tally(12), tally(8, 0, 4))],
    })],
    ['evidence that is two years old', () => evidence(tally(10, 1, 1), tally(10, 1, 1), { generatedAt: new Date(Date.now() - 800 * 86_400_000).toISOString() })],
    ['evidence dated in the future', () => evidence(tally(10, 1, 1), tally(10, 1, 1), { generatedAt: new Date(Date.now() + 7 * 86_400_000).toISOString() })],
    ['only two chats', () => ({ ...passing(), chats: passing().chats.slice(0, 2) })],
    ['one conversation counted three times', () => ({ ...passing(), chats: passing().chats.map(item => ({ ...item, conversationKey: 'same' })) })],
    ['a run summarised with wording the app does not send', () => evidence(tally(10, 1, 1), tally(10, 1, 1), { method: 'cli-replay-custom-compact' })],
    ['a smoke run at a small size', () => evidence(tally(10, 1, 1), tally(10, 1, 1), { targetTokens: 60_000 })],
    ['impossible numbers', () => ({ ...passing(), chats: passing().chats.map(item => ({ ...item, compaction: { boundaries: 1, preTokens: Number.NaN, postTokens: 20_000 } })) })],
    ['garbage', () => ({ schema: 7 })],
  ];
  const stored: Array<[string, Record<string, unknown>]> = [
    ['untouched zero', { ownChatContextCeilingTokens: 0, machineContextCeilingTokens: 0 }],
    ['never stored', {}],
    ['a cap the user chose', { ownChatContextCeilingTokens: 450_000, machineContextCeilingTokens: 200_000 }],
  ];
  for (const [name, make] of unusable) {
    it(`writes nothing for chats, helpers or the marker with ${name}`, async () => {
      const { runSettingsMigrations } = await seam(make());
      for (const [storedName, initial] of stored) {
        const { store, values, writes } = createStore(initial);
        runSettingsMigrations(store);
        runSettingsMigrations(store);
        expect(ours(writes), storedName).toEqual([]);
        expect(values[KEY], storedName).toBeUndefined();
        expect(values['ownChatContextCeilingTokens'], storedName).toBe(initial['ownChatContextCeilingTokens']);
        expect(values['machineContextCeilingTokens'], storedName).toBe(initial['machineContextCeilingTokens']);
      }
    });
  }
});
