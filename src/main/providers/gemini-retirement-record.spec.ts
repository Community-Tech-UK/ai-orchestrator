import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { reportGeminiSignInOutcome, setGeminiSignInObserver } from '../cli/adapters/gemini-client-retired';
import {
  canChooseProviderHere,
  GeminiRetirementRecord,
  getGeminiRetirementRecord,
  observeGeminiSignIn,
  type RetirementStore,
} from './gemini-retirement-record';

function memoryStore(saved?: number): RetirementStore & { value: number | undefined } {
  const store = {
    value: saved,
    get: () => store.value,
    set: (_key: 'retiredAt', value: number) => { store.value = value; },
    delete: () => { store.value = undefined; },
  };
  return store;
}

describe('GeminiRetirementRecord', () => {
  it('is not retired until a session shows Google\'s message, then keeps the first time it did', () => {
    const store = memoryStore();
    const record = new GeminiRetirementRecord(store);
    expect(record.isRetired()).toBe(false);

    record.recordRetired(1_000);
    record.recordRetired(2_000);

    expect(record.isRetired()).toBe(true);
    expect(store.value).toBe(1_000);
  });

  it('is still retired after Harness restarts', () => {
    expect(new GeminiRetirementRecord(memoryStore(1_000)).isRetired()).toBe(true);
  });

  it('ignores a saved value that is not a time', () => {
    const store = memoryStore();
    (store as { value: unknown }).value = 'yes';
    expect(new GeminiRetirementRecord(store).isRetired()).toBe(false);
  });

  it('ends when a Gemini session here replies, which is what happens once Gemini is set up another way', () => {
    const store = memoryStore(1_000);
    const record = new GeminiRetirementRecord(store);

    record.recordReplied();

    expect(record.isRetired()).toBe(false);
    expect(store.value).toBeUndefined();
  });
});

describe('the record kept from what Gemini runs report', () => {
  beforeEach(() => {
    GeminiRetirementRecord._resetForTesting();
    observeGeminiSignIn();
  });
  afterEach(() => {
    setGeminiSignInObserver(undefined);
    vi.restoreAllMocks();
  });

  it('starts when a run shows Google\'s message and ends when a run replies', () => {
    expect(canChooseProviderHere('gemini')).toBe(true);

    reportGeminiSignInOutcome('retired');
    expect(getGeminiRetirementRecord().isRetired()).toBe(true);
    expect(canChooseProviderHere('gemini')).toBe(false);
    expect(canChooseProviderHere('antigravity')).toBe(true);

    reportGeminiSignInOutcome('replied');
    expect(canChooseProviderHere('gemini')).toBe(true);
  });

  it('never lets a record it cannot save stop the run\'s own error or reply', () => {
    vi.spyOn(GeminiRetirementRecord, 'getInstance').mockImplementation(() => { throw new Error('store is corrupt'); });

    expect(() => reportGeminiSignInOutcome('retired')).not.toThrow();
    expect(() => reportGeminiSignInOutcome('replied')).not.toThrow();
  });
});
