import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { DeferDecisionStore } from '../defer-decision-store';

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('DeferDecisionStore', () => {
  beforeEach(() => {
    DeferDecisionStore._resetForTesting();
  });

  afterEach(() => {
    DeferDecisionStore._resetForTesting();
  });

  it('writes a decision file with the expected payload', () => {
    const store = DeferDecisionStore.getInstance();
    const decisionDir = store.getDecisionDir();

    store.writeDecision('tool-use-1', 'allow');

    const filePath = join(decisionDir, 'tool-use-1.json');
    expect(existsSync(filePath)).toBe(true);

    const contents = JSON.parse(readFileSync(filePath, 'utf-8')) as {
      permissionDecision: string;
      reason: string;
      timestamp: number;
    };

    expect(contents.permissionDecision).toBe('allow');
    expect(contents.reason).toBe('User approved');
    expect(contents.timestamp).toBeTypeOf('number');
  });

  it('cleans up the decision directory', () => {
    const store = DeferDecisionStore.getInstance();
    const decisionDir = store.getDecisionDir();

    store.writeDecision('tool-use-2', 'deny', 'Not approved');
    expect(existsSync(join(decisionDir, 'tool-use-2.json'))).toBe(true);

    store.cleanup();

    expect(existsSync(decisionDir)).toBe(false);
  });
});
