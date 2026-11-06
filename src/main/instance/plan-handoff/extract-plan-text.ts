export interface ExtractPlanTextInput {
  messages: { id?: string; type: string; content: string }[];
  planModeContent?: string;
  maxChars?: number;
}

export interface ExtractPlanTextResult {
  text: string;
  truncated: boolean;
  source: 'plan-mode' | 'assistant';
  sourceMessageIds: string[];
}

const BLOCK_OPEN = ':::ORCHESTRATOR_COMMAND:::';
const BLOCK_CLOSE = ':::END_COMMAND:::';
const TRUNCATION_MARKER = '\n\n[plan truncated]\n\n';

/**
 * Removes every `:::ORCHESTRATOR_COMMAND::: ... :::END_COMMAND:::` block.
 *
 * Output is identical to `text.replace(/:::ORCHESTRATOR_COMMAND:::[\s\S]*?:::END_COMMAND:::/g, '')`,
 * but linear. The regex retried every unclosed opener against the rest of the
 * text, which is quadratic on model output with many openers and no closer. Once
 * one opener has no closer after it, no later opener can have one either.
 */
export function stripOrchestratorBlocks(text: string): string {
  let cursor = 0;
  let out = '';
  for (;;) {
    const open = text.indexOf(BLOCK_OPEN, cursor);
    if (open === -1) break;
    const close = text.indexOf(BLOCK_CLOSE, open + BLOCK_OPEN.length);
    if (close === -1) break;
    out += text.slice(cursor, open);
    cursor = close + BLOCK_CLOSE.length;
  }
  return cursor === 0 ? text : out + text.slice(cursor);
}

function capText(text: string, maxChars: number): { text: string; truncated: boolean } {
  const limit = Math.max(0, Math.floor(maxChars));
  if (text.length <= limit) return { text, truncated: false };
  if (limit <= TRUNCATION_MARKER.length) {
    return { text: TRUNCATION_MARKER.trim().slice(0, limit), truncated: true };
  }
  const available = limit - TRUNCATION_MARKER.length;
  const headLength = Math.ceil(available * 0.7);
  const tailLength = available - headLength;
  return {
    text: text.slice(0, headLength) + TRUNCATION_MARKER + (tailLength > 0 ? text.slice(-tailLength) : ''),
    truncated: true,
  };
}

export function extractPlanText(input: ExtractPlanTextInput): ExtractPlanTextResult {
  try {
    const maxChars = input.maxChars ?? 24_000;
    const planModeContent = input.planModeContent?.trim();
    if (planModeContent) {
      return { ...capText(planModeContent, maxChars), source: 'plan-mode', sourceMessageIds: [] };
    }

    const messages = input.messages ?? [];
    let lastUserIndex = -1;
    for (let index = 0; index < messages.length; index += 1) {
      if (messages[index].type === 'user') lastUserIndex = index;
    }
    const assistants = messages.slice(lastUserIndex + 1).filter((message) => message.type === 'assistant');
    let picked = assistants;
    const join = (parts: typeof assistants): string => parts
      .map((message) => stripOrchestratorBlocks(message.content).trim())
      .filter(Boolean)
      .join('\n\n');
    let text = join(picked);
    if (text.length < 400 && assistants.length > 0) {
      const previous = messages.slice(0, Math.max(0, lastUserIndex)).filter((message) => message.type === 'assistant').slice(-1)[0];
      picked = previous ? [previous, ...assistants] : assistants;
      text = join(picked);
    }
    return {
      ...capText(text, maxChars),
      source: 'assistant',
      sourceMessageIds: picked.flatMap((message) => message.id ? [message.id] : []),
    };
  } catch {
    return { text: '', truncated: false, source: 'assistant', sourceMessageIds: [] };
  }
}
