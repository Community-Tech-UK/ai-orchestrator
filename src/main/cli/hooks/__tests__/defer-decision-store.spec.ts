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

  it('writes modify as permissionDecision=allow and includes updatedInput in the file', () => {
    const store = DeferDecisionStore.getInstance();
    const decisionDir = store.getDecisionDir();
    const replacement = { command: 'echo safe' };

    store.writeDecision('tool-use-3', 'modify', 'Approved with modified command', replacement);

    const filePath = join(decisionDir, 'tool-use-3.json');
    expect(existsSync(filePath)).toBe(true);

    const contents = JSON.parse(readFileSync(filePath, 'utf-8')) as {
      permissionDecision: string;
      reason: string;
      timestamp: number;
      updatedInput: Record<string, unknown>;
    };

    // 'modify' must be stored as 'allow' so the hook emits an allow decision
    expect(contents.permissionDecision).toBe('allow');
    expect(contents.reason).toBe('Approved with modified command');
    expect(contents.timestamp).toBeTypeOf('number');
    // updatedInput must be persisted for the hook to forward
    expect(contents.updatedInput).toEqual(replacement);
  });

  it('allow without updatedInput produces a file identical in shape to the original behavior', () => {
    const store = DeferDecisionStore.getInstance();
    const decisionDir = store.getDecisionDir();

    store.writeDecision('tool-use-4', 'allow', 'User approved');

    const contents = JSON.parse(
      readFileSync(join(decisionDir, 'tool-use-4.json'), 'utf-8'),
    ) as Record<string, unknown>;

    expect(contents['permissionDecision']).toBe('allow');
    expect(contents['reason']).toBe('User approved');
    expect(contents['updatedInput']).toBeUndefined();
  });

  it('deny without updatedInput produces a file identical in shape to the original behavior', () => {
    const store = DeferDecisionStore.getInstance();
    const decisionDir = store.getDecisionDir();

    store.writeDecision('tool-use-5', 'deny', 'Rejected by policy');

    const contents = JSON.parse(
      readFileSync(join(decisionDir, 'tool-use-5.json'), 'utf-8'),
    ) as Record<string, unknown>;

    expect(contents['permissionDecision']).toBe('deny');
    expect(contents['reason']).toBe('Rejected by policy');
    expect(contents['updatedInput']).toBeUndefined();
  });
});
