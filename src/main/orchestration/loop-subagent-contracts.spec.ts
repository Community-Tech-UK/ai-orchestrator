import { describe, expect, it } from 'vitest';
import {
  buildSubagentResultPendingInput,
  parseLoopSubagentReturn,
  validateLoopTaskPackets,
  type LoopTaskPacket,
} from './loop-subagent-contracts';

const packet = (overrides: Partial<LoopTaskPacket> = {}): LoopTaskPacket => ({
  id: 'task-1',
  objective: 'Implement the API adapter',
  scope: {
    read: ['src/main/api'],
    write: ['src/main/api/adapter.ts'],
  },
  acceptanceCriteria: ['Adapter retries transient failures'],
  verificationPlan: ['npm run test:quiet -- src/main/api/adapter.spec.ts'],
  depth: 0,
  ...overrides,
});

describe('loop subagent contracts', () => {
  it('rejects task packets without objective, acceptance criteria, or verification plan', () => {
    const result = validateLoopTaskPackets([
      packet({ objective: '', acceptanceCriteria: [], verificationPlan: [] }),
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected validation failure');
    expect(result.errors.join('\n')).toContain('objective');
    expect(result.errors.join('\n')).toContain('acceptanceCriteria');
    expect(result.errors.join('\n')).toContain('verificationPlan');
  });

  it('rejects overlapping write scopes across packets', () => {
    const result = validateLoopTaskPackets([
      packet({ id: 'task-a', scope: { read: [], write: ['src/main/api'] } }),
      packet({ id: 'task-b', scope: { read: [], write: ['src/main/api/adapter.ts'] } }),
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected validation failure');
    expect(result.errors.join('\n')).toContain('overlap');
  });

  it('returns validation errors instead of throwing when scope.write is malformed', () => {
    const malformed = packet({
      id: 'task-malformed',
      scope: { read: [], write: undefined as unknown as string[] },
    });

    expect(() => validateLoopTaskPackets([malformed, packet({ id: 'task-ok' })])).not.toThrow();
    const result = validateLoopTaskPackets([malformed, packet({ id: 'task-ok' })]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected validation failure');
    expect(result.errors.join('\n')).toContain('scope.write');
  });

  it('returns validation errors instead of throwing for null packets', () => {
    expect(() => validateLoopTaskPackets([null])).not.toThrow();
    const result = validateLoopTaskPackets([null]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected validation failure');
    expect(result.errors.join('\n')).toContain('packet must be an object');
  });

  it('returns validation errors instead of throwing for non-array packet collections', () => {
    expect(() => validateLoopTaskPackets(null)).not.toThrow();
    expect(validateLoopTaskPackets(null)).toEqual({
      ok: false,
      errors: ['taskPackets must be an array'],
    });
    expect(validateLoopTaskPackets({ task: packet() }).ok).toBe(false);
  });

  it('returns validation errors instead of throwing for non-string array entries', () => {
    const malformed = packet({
      id: 'task-arrays',
      acceptanceCriteria: [123] as unknown as string[],
      verificationPlan: [null] as unknown as string[],
      scope: {
        read: ['src/main'],
        write: ['src/main/file.ts', 42] as unknown as string[],
      },
    });

    expect(() => validateLoopTaskPackets([malformed])).not.toThrow();
    const result = validateLoopTaskPackets([malformed]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected validation failure');
    expect(result.errors.join('\n')).toContain('acceptanceCriteria');
    expect(result.errors.join('\n')).toContain('verificationPlan');
    expect(result.errors.join('\n')).toContain('scope.write');
  });

  it('enforces a depth limit', () => {
    const result = validateLoopTaskPackets([packet({ depth: 2 })], { maxDepth: 1 });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected validation failure');
    expect(result.errors.join('\n')).toContain('depth');
  });

  it('parses the rigid subagent return schema', () => {
    const parsed = parseLoopSubagentReturn(`
Scope:
- src/main/api/adapter.ts
Result:
Implemented retry handling.
Key files:
- src/main/api/adapter.ts
Issues:
- none
`);

    expect(parsed.scope).toContain('src/main/api/adapter.ts');
    expect(parsed.result).toContain('retry handling');
    expect(parsed.keyFiles).toEqual(['src/main/api/adapter.ts']);
    expect(parsed.issues).toEqual(['none']);
  });

  it('injects subagent results as pending input with duplicate-polling guard text', () => {
    const pending = buildSubagentResultPendingInput({
      taskId: 'task-1',
      summary: 'Retry adapter landed',
      keyFiles: ['src/main/api/adapter.ts'],
      issues: ['none'],
    });

    expect(pending.source).toBe('subagent-result');
    expect(pending.kind).toBe('queue');
    expect(pending.message).toContain('do NOT poll or duplicate');
    expect(pending.message).toContain('Retry adapter landed');
  });
});
