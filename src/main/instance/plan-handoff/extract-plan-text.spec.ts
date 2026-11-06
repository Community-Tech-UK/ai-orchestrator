import { describe, expect, it } from 'vitest';
import { extractPlanText } from './extract-plan-text';

const message = (type: string, content: string, id?: string) => ({ type, content, id });

describe('extractPlanText', () => {
  it('prefers Plan Mode content and caps it', () => {
    const result = extractPlanText({
      messages: [message('assistant', 'ignored')],
      planModeContent: 'x'.repeat(2_000),
      maxChars: 1_000,
    });
    expect(result.source).toBe('plan-mode');
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(1_000);
  });

  it('uses assistant turns after the last user and strips command blocks', () => {
    const result = extractPlanText({ messages: [
      message('assistant', 'older plan', 'old'),
      message('user', 'replan'),
      message('assistant', `First step ${'detail '.repeat(70)}:::ORCHESTRATOR_COMMAND:::delete:::END_COMMAND:::`, 'a'),
      message('tool', 'tool result'),
      message('assistant', 'Second step', 'b'),
    ] });
    expect(result.text).toContain('First step');
    expect(result.text).toContain('Second step');
    expect(result.text).not.toContain('delete');
    expect(result.text).not.toContain('older plan');
    expect(result.sourceMessageIds).toEqual(['a', 'b']);
  });

  it('extends a short answer to the previous assistant message', () => {
    const result = extractPlanText({ messages: [
      message('assistant', 'The full earlier plan', 'previous'),
      message('user', 'okay'),
      message('assistant', 'Ready to implement', 'last'),
    ] });
    expect(result.text).toContain('The full earlier plan');
    expect(result.sourceMessageIds).toEqual(['previous', 'last']);
  });

  it('keeps head, tail and marker within the limit', () => {
    const result = extractPlanText({
      messages: [message('assistant', `HEAD${'x'.repeat(4_000)}TAIL`)],
      maxChars: 1_000,
    });
    expect(result.text).toContain('HEAD');
    expect(result.text).toContain('TAIL');
    expect(result.text).toContain('[plan truncated]');
    expect(result.text.length).toBeLessThanOrEqual(1_000);
  });

  it('returns empty text for empty or tool-only input', () => {
    expect(extractPlanText({ messages: [] }).text).toBe('');
    expect(extractPlanText({ messages: [message('tool', 'not a plan')] }).text).toBe('');
  });
});
