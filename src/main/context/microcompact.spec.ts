import { describe, it, expect } from 'vitest';
import { Microcompact, type MicrocompactTurn } from './microcompact';

describe('Microcompact', () => {
  const makeTurn = (id: string, tokenCount: number, toolOutputTokens = 0): MicrocompactTurn => ({
    id,
    role: 'assistant',
    content: 'response',
    tokenCount,
    timestamp: Date.now(),
    toolCalls: toolOutputTokens > 0 ? [{
      id: `tc-${id}`,
      name: 'bash',
      input: 'ls',
      output: 'file1\nfile2',
      inputTokens: 10,
      outputTokens: toolOutputTokens,
    }] : undefined,
  });

  it('removes tool outputs from old turns, preserving recent ones', () => {
    const mc = new Microcompact({ recentTurnsToProtect: 2, minSavingsTokens: 100 });
    const turns = [
      makeTurn('old1', 100, 500),
      makeTurn('old2', 100, 600),
      makeTurn('recent1', 100, 300),
      makeTurn('recent2', 100, 200),
    ];
    const result = mc.compact(turns);
    expect(result.tokensSaved).toBeGreaterThan(0);
    expect(result.turns[0].toolCalls![0].output).toBe('[microcompacted]');
    expect(result.turns[1].toolCalls![0].output).toBe('[microcompacted]');
    expect(result.turns[2].toolCalls![0].output).toBe('file1\nfile2');
    expect(result.turns[3].toolCalls![0].output).toBe('file1\nfile2');
  });

  it('skips compaction when savings below threshold', () => {
    const mc = new Microcompact({ recentTurnsToProtect: 2, minSavingsTokens: 5000 });
    const turns = [makeTurn('old1', 100, 50), makeTurn('recent1', 100, 50)];
    const result = mc.compact(turns);
    expect(result.tokensSaved).toBe(0);
    expect(result.skipped).toBe(true);
  });

  it('preserves turns with no tool calls', () => {
    const mc = new Microcompact({ recentTurnsToProtect: 1, minSavingsTokens: 0 });
    const turns = [
      { id: 'plain', role: 'user' as const, content: 'hello', tokenCount: 50, timestamp: Date.now() },
      makeTurn('recent', 100, 200),
    ];
    const result = mc.compact(turns);
    expect(result.turns[0].content).toBe('hello');
  });

  it('reports correct metrics', () => {
    const mc = new Microcompact({ recentTurnsToProtect: 1, minSavingsTokens: 0 });
    const turns = [
      makeTurn('old', 100, 1000),
      makeTurn('recent', 100, 500),
    ];

    const result = mc.compact(turns);
    expect(result.turnsCompacted).toBe(1);
    expect(result.tokensSaved).toBe(1000 - 5); // output tokens minus placeholder cost
  });
});
