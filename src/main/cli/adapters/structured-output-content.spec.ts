import { describe, it, expect } from 'vitest';
import {
  pickStructuredOutputPayload,
  serializeStructuredOutput,
  structuredOutputContent,
  STRUCTURED_OUTPUT_TOOL,
  type StructuredOutputCandidate,
} from './structured-output-content';

const call = (
  name: string,
  input: Record<string, unknown>,
  parentToolUseId?: string | null,
): StructuredOutputCandidate => ({ name, input, parentToolUseId });

describe('structuredOutputContent (LT-025)', () => {
  it('returns the StructuredOutput payload as JSON text', () => {
    const verdict = { overall_verdict: 'CONCERNS', summary: 'unguarded divide' };
    const out = structuredOutputContent([call(STRUCTURED_OUTPUT_TOOL, verdict)]);
    expect(JSON.parse(out as string)).toEqual(verdict);
  });

  it('ignores unrelated tool calls', () => {
    expect(structuredOutputContent([call('Bash', { command: 'ls' })])).toBeNull();
    expect(structuredOutputContent([])).toBeNull();
  });

  it('picks the structured call out of a mixed set', () => {
    const out = structuredOutputContent([
      call('Read', { path: '/tmp/x' }),
      call(STRUCTURED_OUTPUT_TOOL, { overall_verdict: 'PASS' }),
      call('Bash', { command: 'ls' }),
    ]);
    expect(JSON.parse(out as string)).toEqual({ overall_verdict: 'PASS' });
  });

  /**
   * The CLI validates each StructuredOutput call and, on a schema mismatch,
   * hands the model an error tool_result and lets it retry — so one turn can
   * carry a REJECTED payload followed by the accepted one. Taking the first
   * would return the payload the CLI already refused, which then fails the
   * reviewer's own Zod parse and reproduces the LT-025 symptom.
   */
  it('takes the LAST structured call, because an earlier one may be a rejected attempt', () => {
    const out = structuredOutputContent([
      call(STRUCTURED_OUTPUT_TOOL, { overall_verdict: 'APPROVE', score: 9 }),
      call(STRUCTURED_OUTPUT_TOOL, { overall_verdict: 'CONCERNS', summary: 'good' }),
    ]);
    expect(JSON.parse(out as string)).toEqual({ overall_verdict: 'CONCERNS', summary: 'good' });
  });

  /**
   * Subagent assistant messages are streamed into the same top-level NDJSON,
   * tagged with `parent_tool_use_id`. A subagent forced to produce structured
   * output must not overwrite the parent turn's real answer.
   */
  it('ignores a subagent payload and keeps the parent turn answer', () => {
    expect(structuredOutputContent([
      call(STRUCTURED_OUTPUT_TOOL, { sub: 'agent payload' }, 'toolu_parent'),
    ])).toBeNull();

    const out = structuredOutputContent([
      call(STRUCTURED_OUTPUT_TOOL, { overall_verdict: 'PASS' }),
      call(STRUCTURED_OUTPUT_TOOL, { sub: 'agent payload' }, 'toolu_parent'),
    ]);
    expect(JSON.parse(out as string)).toEqual({ overall_verdict: 'PASS' });
  });

  it('returns null for an empty payload so the caller can fall back to text', () => {
    expect(structuredOutputContent([call(STRUCTURED_OUTPUT_TOOL, {})])).toBeNull();
    expect(pickStructuredOutputPayload([call(STRUCTURED_OUTPUT_TOOL, {})])).toBeUndefined();
  });

  it('returns null rather than throwing on an unserializable payload', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular['self'] = circular;
    expect(serializeStructuredOutput(circular)).toBeNull();
  });
});
