/**
 * Pure helpers for turning a Claude Code `AskUserQuestion` tool input into a
 * human-readable prompt that Harness surfaces as an `input_required` request.
 *
 * The real Claude Code tool nests one or more questions under `questions[]`,
 * each with its own `header`/`question` text and `options[]` (objects of
 * `{ label, description }`). Earlier/flattened shapes put `question`/`options`
 * at the top level. Both are handled so the actual question and its options are
 * surfaced instead of a generic "Claude requested input" notice.
 */

import type { AskUserQuestionEntry, AskUserQuestionOption } from '../../../shared/types/ask-user-question.types';

function readString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function readOptionLabel(opt: unknown): string | undefined {
  if (typeof opt === 'string') {
    return opt.trim().length > 0 ? opt.trim() : undefined;
  }
  if (opt && typeof opt === 'object') {
    return readString(opt as Record<string, unknown>, ['label', 'title', 'value', 'id']);
  }
  return undefined;
}

/**
 * Render a single AskUserQuestion entry (header/question + numbered options)
 * into a human-readable block. Returns an empty string when the entry carries
 * no usable question text or options.
 */
function renderQuestionBlock(value: unknown): string {
  if (!value || typeof value !== 'object') {
    return '';
  }

  const obj = value as Record<string, unknown>;
  const header = readString(obj, ['header', 'title']);
  const question = readString(obj, ['question', 'prompt', 'message', 'text']);
  const multiSelect = obj['multiSelect'] === true;

  const options = Array.isArray(obj['options']) ? obj['options'] : [];
  const optionLines = options
    .map((opt, index) => {
      const label = readOptionLabel(opt);
      if (!label) {
        return '';
      }
      const description =
        opt && typeof opt === 'object'
          ? readString(opt as Record<string, unknown>, ['description'])
          : undefined;
      return description ? `${index + 1}. ${label} — ${description}` : `${index + 1}. ${label}`;
    })
    .filter((line) => line.length > 0);

  const parts: string[] = [];
  if (header && header !== question) {
    parts.push(header);
  }
  if (question) {
    parts.push(question);
  }

  if (parts.length === 0 && optionLines.length === 0) {
    return '';
  }

  if (optionLines.length > 0) {
    parts.push('', multiSelect ? 'Options (select one or more):' : 'Options:', ...optionLines);
  }

  return parts.join('\n').trim();
}

/**
 * Extract a usable question from preceding assistant text when the tool input
 * itself carries no structured question. Prefers the last paragraph containing
 * a question mark, otherwise returns the whole normalized text.
 */
export function extractAskUserQuestionFallback(text: string | undefined): string | undefined {
  const normalized = text?.replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return undefined;
  }

  const paragraphs = normalized
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const questionParagraph = [...paragraphs].reverse().find((part) => part.includes('?'));
  return questionParagraph || normalized;
}

/**
 * Parse a Claude Code `AskUserQuestion` tool input into structured entries the
 * renderer can present as clickable options. Handles both the real nested
 * `questions[]` schema and the older flat `{ question, options }` shape.
 * Returns an empty array when nothing actionable can be extracted.
 */
export function parseAskUserQuestions(input: unknown): AskUserQuestionEntry[] {
  if (!input || typeof input !== 'object') {
    return [];
  }

  const data = input as Record<string, unknown>;
  const rawList = Array.isArray(data['questions']) ? data['questions'] : [data];
  const entries: AskUserQuestionEntry[] = [];

  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const obj = raw as Record<string, unknown>;
    const question = readString(obj, ['question', 'prompt', 'message', 'text']);
    const header = readString(obj, ['header', 'title']);

    const rawOptions = Array.isArray(obj['options']) ? obj['options'] : [];
    const options: AskUserQuestionOption[] = [];
    for (const opt of rawOptions) {
      const label = readOptionLabel(opt);
      if (!label) {
        continue;
      }
      const description =
        opt && typeof opt === 'object'
          ? readString(opt as Record<string, unknown>, ['description'])
          : undefined;
      options.push(description ? { label, description } : { label });
    }

    if (!question && !header && options.length === 0) {
      continue;
    }

    entries.push({
      header,
      question: question || header || 'Please choose an option',
      multiSelect: obj['multiSelect'] === true,
      options,
    });
  }

  return entries;
}

export function buildAskUserQuestionPrompt(input: unknown, fallbackText?: string): string {
  const fallbackPrompt = extractAskUserQuestionFallback(fallbackText);
  if (!input || typeof input !== 'object') {
    return fallbackPrompt || 'Input required from Claude. Please provide your response.';
  }

  const data = input as Record<string, unknown>;

  const questionObjects = Array.isArray(data['questions']) ? data['questions'] : null;
  if (questionObjects && questionObjects.length > 0) {
    const blocks = questionObjects
      .map((question) => renderQuestionBlock(question))
      .filter((block) => block.length > 0);
    if (blocks.length > 0) {
      return blocks.join('\n\n').trim();
    }
  }

  // Flat single-question shape (`{ question, title, options }`).
  const flatBlock = renderQuestionBlock(data);
  if (flatBlock) {
    return flatBlock;
  }

  if (fallbackPrompt) {
    return fallbackPrompt;
  }
  return 'Claude requested input via AskUserQuestion.';
}
