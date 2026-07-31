import { describe, it, expect } from 'vitest';
import { generateLocalSummary } from './context-local-summary';
import type { ConversationTurn } from './context-compactor';

function makeTurn(overrides: Partial<ConversationTurn> = {}): ConversationTurn {
  return {
    id: 't1',
    role: 'assistant',
    content: 'did the thing',
    timestamp: Date.now(),
    tokenCount: 10,
    ...overrides,
  };
}

describe('generateLocalSummary — tool output line (P0.2 never-worse guard)', () => {
  it('uses the full output verbatim when it is already short (truncation would not help)', () => {
    const turns: ConversationTurn[] = [
      makeTurn({
        toolCalls: [{
          id: 'tc1',
          name: 'bash',
          input: 'echo ok',
          output: 'ok',
          inputTokens: 5,
          outputTokens: 1,
        }],
      }),
    ];

    const summary = generateLocalSummary(turns, null);

    expect(summary).toContain('- `bash`: ok');
  });

  it('truncates a genuinely long output to 80 chars', () => {
    const longOutput = 'x'.repeat(500);
    const turns: ConversationTurn[] = [
      makeTurn({
        toolCalls: [{
          id: 'tc1',
          name: 'bash',
          input: 'cat file',
          output: longOutput,
          inputTokens: 5,
          outputTokens: 200,
        }],
      }),
    ];

    const summary = generateLocalSummary(turns, null);

    expect(summary).toContain(`- \`bash\`: ${'x'.repeat(80)}`);
    expect(summary).not.toContain('x'.repeat(81));
  });

  it('reports "no output" when the tool call has none', () => {
    const turns: ConversationTurn[] = [
      makeTurn({
        toolCalls: [{
          id: 'tc1',
          name: 'bash',
          input: 'true',
          inputTokens: 5,
          outputTokens: 0,
        }],
      }),
    ];

    const summary = generateLocalSummary(turns, null);

    expect(summary).toContain('- `bash`: no output');
  });
});
