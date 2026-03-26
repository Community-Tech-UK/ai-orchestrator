/**
 * Thinking Content Extractor
 *
 * Extracts thinking/reasoning content from LLM responses in various formats
 * and returns the cleaned response content.
 */

import { generateId } from './id-generator';

/**
 * Result of extracting thinking content from a message
 */
export interface ExtractedContent {
  /** The cleaned response without thinking content */
  response: string;
  /** Array of extracted thinking blocks */
  thinking: ThinkingBlock[];
  /** Whether any thinking content was found */
  hasThinking: boolean;
}

/**
 * Individual thinking block with format metadata
 */
export interface ThinkingBlock {
  id: string;
  content: string;
  format: 'structured' | 'xml' | 'bracket' | 'header' | 'sdk' | 'unknown';
  timestamp?: number;
}

// Regex patterns for different thinking formats
// XML-style tags: <thinking>, <thought>, <antthinking>
const XML_THINKING_PATTERN =
  /<\s*(thinking|thought|antthinking)\b[^>]*>([\s\S]*?)<\s*\/\s*\1\s*>/gi;

// Bracket-style tags: [THINKING]...[/THINKING]
const BRACKET_THINKING_PATTERN = /\[THINKING\]([\s\S]*?)\[\/THINKING\]/gi;

const HEADER_START_PATTERN = /^(?:\*\*([^*]+)\*\*|#{1,3}\s+(.+))\n\n([\s\S]*)$/;

const THINKING_HEADER_INDICATORS = [
  'handling',
  'analyzing',
  'processing',
  'thinking',
  'reasoning',
  'planning',
  'considering',
  'evaluating',
  'understanding',
  'examining',
  'reviewing',
  'crafting',
  'drafting',
  'composing',
  'preparing',
  'formulating',
  'responding',
];

const META_REASONING_PATTERNS = [
  /\bi need to\b/i,
  /\bi should\b/i,
  /\bi have to\b/i,
  /\bi'll\b/i,
  /\bi will\b/i,
  /\brespond to the user\b/i,
  /\brespond with\b/i,
  /\buser (?:just )?(?:said|says|asked|is asking|wants|needs)\b/i,
  /\bno tools? (?:are|is) needed\b/i,
  /\bkeep it (?:concise|brief|short|simple|straightforward|friendly)\b/i,
  /\bsimple response could be\b/i,
  /\backnowledge\b/i,
  /\bconsider using\b/i,
];

const RESPONSE_START_PATTERNS = [
  /^(?:Answer:|Response:|Here's|Hi!|Hello|Hey!|Hey,|Sure,|Yes\b|No\b|Okay\b|OK\b|Let me\b|I'll\b|I can\b|Here is\b|Here are\b|Based on\b|In summary\b|To summarize\b|In conclusion\b)/i,
];

/**
 * Main extraction function - handles all formats
 *
 * @param content The raw message content to extract thinking from
 * @returns ExtractedContent with cleaned response and thinking blocks
 */
export function extractThinkingContent(content: string): ExtractedContent {
  if (!content || typeof content !== 'string') {
    return { response: content || '', thinking: [], hasThinking: false };
  }

  const thinking: ThinkingBlock[] = [];
  let cleaned = content;

  // 1. Extract XML-style thinking
  const xmlResult = stripXmlThinkingTags(cleaned);
  cleaned = xmlResult.cleaned;
  xmlResult.extracted.forEach((t) => {
    thinking.push({
      id: generateId(),
      content: t.trim(),
      format: 'xml',
    });
  });

  // 2. Extract bracket-style thinking
  const bracketResult = stripBracketThinkingTags(cleaned);
  cleaned = bracketResult.cleaned;
  bracketResult.extracted.forEach((t) => {
    thinking.push({
      id: generateId(),
      content: t.trim(),
      format: 'bracket',
    });
  });

  // 3. Extract header-style thinking (most complex)
  const headerResult = extractHeaderStyleThinking(cleaned);
  cleaned = headerResult.cleaned;
  headerResult.extracted.forEach((t) => {
    thinking.push({
      id: generateId(),
      content: t.trim(),
      format: 'header',
    });
  });

  // Clean up extra whitespace from extraction
  cleaned = cleaned.trim().replace(/\n{3,}/g, '\n\n');

  // Remove leading separators if thinking was extracted
  if (thinking.length > 0) {
    cleaned = cleaned.replace(/^---\s*\n*/m, '').trim();
  }

  return {
    response: cleaned,
    thinking,
    hasThinking: thinking.length > 0,
  };
}

/**
 * Strip XML-style thinking tags: <thinking>, <thought>, <antthinking>
 *
 * @param content The content to process
 * @returns Object with cleaned content and extracted thinking blocks
 */
export function stripXmlThinkingTags(content: string): {
  cleaned: string;
  extracted: string[];
} {
  const extracted: string[] = [];

  // Reset regex state
  XML_THINKING_PATTERN.lastIndex = 0;

  const cleaned = content.replace(XML_THINKING_PATTERN, (_, _tag, inner) => {
    if (inner && inner.trim()) {
      extracted.push(inner);
    }
    return '';
  });

  return { cleaned, extracted };
}

/**
 * Strip bracket-style tags: [THINKING]...[/THINKING]
 *
 * @param content The content to process
 * @returns Object with cleaned content and extracted thinking blocks
 */
export function stripBracketThinkingTags(content: string): {
  cleaned: string;
  extracted: string[];
} {
  const extracted: string[] = [];

  // Reset regex state
  BRACKET_THINKING_PATTERN.lastIndex = 0;

  const cleaned = content.replace(BRACKET_THINKING_PATTERN, (_, inner) => {
    if (inner && inner.trim()) {
      extracted.push(inner);
    }
    return '';
  });

  return { cleaned, extracted };
}

/**
 * Detect and extract header-style thinking (bold headers + reasoning)
 *
 * Pattern detection:
 * 1. Starts with **Header** or # Header
 * 2. Followed by paragraph(s) of reasoning
 * 3. Ends with separator (---, multiple blank lines, or transition phrase)
 *
 * @param content The content to process
 * @returns Object with cleaned content and extracted thinking blocks
 */
export function extractHeaderStyleThinking(content: string): {
  cleaned: string;
  extracted: string[];
} {
  const trimmed = content.trim();
  const headerMatch = trimmed.match(HEADER_START_PATTERN);
  if (!headerMatch) {
    return { cleaned: content, extracted: [] };
  }

  const header = (headerMatch[1] || headerMatch[2] || '').trim();
  const body = (headerMatch[3] || '').trim();
  if (!header || !body) {
    return { cleaned: content, extracted: [] };
  }

  const split = splitHeaderThinkingBody(body);
  if (!split) {
    return { cleaned: content, extracted: [] };
  }

  const isThinkingHeader = looksLikeThinkingHeader(header);
  const isMetaReasoning = looksLikeMetaReasoning(split.thinking);

  // Only extract when we have a strong signal that the first block is model
  // reasoning. This avoids swallowing legitimate user-facing markdown sections.
  if (!isThinkingHeader && !isMetaReasoning) {
    return { cleaned: content, extracted: [] };
  }

  // Safety net: if we couldn't find any response content, don't extract at
  // all.  Showing the full content (with reasoning mixed in) is better than
  // showing an empty assistant message with only a thinking accordion.
  if (!split.response.trim()) {
    return { cleaned: content, extracted: [] };
  }

  return {
    cleaned: split.response,
    extracted: [`${header}\n\n${split.thinking}`],
  };
}

function looksLikeThinkingHeader(header: string): boolean {
  const headerLower = header.toLowerCase().trim();
  return THINKING_HEADER_INDICATORS.some(
    (indicator) =>
      headerLower.includes(indicator) ||
      headerLower.startsWith('step') ||
      headerLower.startsWith('first') ||
      headerLower.startsWith('next')
  );
}

function looksLikeMetaReasoning(text: string): boolean {
  return META_REASONING_PATTERNS.some((pattern) => pattern.test(text));
}

function looksLikeResponseStart(text: string): boolean {
  return RESPONSE_START_PATTERNS.some((pattern) => pattern.test(text.trim()));
}

function splitHeaderThinkingBody(body: string): { response: string; thinking: string } | null {
  const normalized = body.replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return null;
  }

  const separatorMatch = normalized.match(/^([\s\S]+?)\n---+\s*\n+([\s\S]+)$/);
  if (separatorMatch) {
    const thinking = separatorMatch[1].trim();
    const response = separatorMatch[2].trim();
    if (thinking) {
      return { thinking, response };
    }
  }

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  if (paragraphs.length >= 2) {
    for (let index = 1; index < paragraphs.length; index += 1) {
      const candidate = paragraphs[index];
      if (looksLikeResponseStart(candidate)) {
        return {
          thinking: paragraphs.slice(0, index).join('\n\n'),
          response: paragraphs.slice(index).join('\n\n'),
        };
      }
    }

    if (looksLikeMetaReasoning(paragraphs[0]) && !looksLikeMetaReasoning(paragraphs[1])) {
      return {
        thinking: paragraphs[0],
        response: paragraphs.slice(1).join('\n\n'),
      };
    }
  }

  const lines = normalized.split('\n');
  for (let index = 1; index < lines.length; index += 1) {
    const candidate = lines[index].trim();
    if (!candidate || !looksLikeResponseStart(candidate)) {
      continue;
    }

    const thinking = lines.slice(0, index).join('\n').trim();
    const response = lines.slice(index).join('\n').trim();
    if (thinking) {
      return { thinking, response };
    }
  }

  if (looksLikeMetaReasoning(normalized)) {
    // Before swallowing everything as thinking, check if trailing lines are
    // actual response content (not meta-reasoning).  Scan from the end to
    // find the boundary and preserve those lines as the response.
    const allLines = normalized.split('\n').map((l) => l.trim()).filter(Boolean);
    if (allLines.length >= 2) {
      let splitIdx = allLines.length;
      for (let i = allLines.length - 1; i >= 1; i--) {
        if (!looksLikeMetaReasoning(allLines[i])) {
          splitIdx = i;
        } else {
          break;
        }
      }
      if (splitIdx < allLines.length) {
        return {
          thinking: allLines.slice(0, splitIdx).join('\n'),
          response: allLines.slice(splitIdx).join('\n'),
        };
      }
    }
    return { thinking: normalized, response: '' };
  }

  return null;
}

/**
 * Check if content appears to be purely thinking (no actual response)
 *
 * @param content The content to check
 * @returns true if the content is only thinking with no response
 */
export function isOnlyThinking(content: string): boolean {
  const { response } = extractThinkingContent(content);
  return !response.trim();
}

/**
 * Create a ThinkingBlock from raw content
 *
 * @param content The thinking content
 * @param format The format of the thinking block
 * @param timestamp Optional timestamp
 * @returns A ThinkingBlock object
 */
export function createThinkingBlock(
  content: string,
  format: ThinkingBlock['format'] = 'unknown',
  timestamp?: number
): ThinkingBlock {
  return {
    id: generateId(),
    content: content.trim(),
    format,
    timestamp: timestamp || Date.now(),
  };
}
