import { describe, expect, it } from 'vitest';
import {
  CLEANUP_TIMEOUT_MS,
  TERMINATE_INSTANCES_BUDGET_MS,
} from './shutdown-timeouts';

describe('shutdown timeouts', () => {
  it('gives shutdown up to a minute before force-quit', () => {
    expect(CLEANUP_TIMEOUT_MS).toBe(60_000);
  });

  it('gives instance terminate/archive most of that minute', () => {
    expect(TERMINATE_INSTANCES_BUDGET_MS).toBe(50_000);
    expect(TERMINATE_INSTANCES_BUDGET_MS).toBeLessThan(CLEANUP_TIMEOUT_MS);
  });
});
