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

// Header-style: **Header** or # Header followed by content until separator or response transition
// This pattern matches:
// 1. Bold header (**text**) or markdown header (# text, ## text, ### text)
// 2. Followed by one or more paragraphs
// 3. Until we hit a separator (---) or a response transition word/phrase
const HEADER_PATTERN =
  /^(?:\*\*([^*]+)\*\*|#{1,3}\s+(.+))\n\n([\s\S]+?)(?=\n---|\n\n(?:Answer:|Response:|Here's|Hi!|Hello|Sure,|I |The |This |That |Yes|No|Okay|OK|Let me|Here is|Here are|Based on|In summary|To summarize|In conclusion)|\n\n\n|$)/gm;

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
  const extracted: string[] = [];

  // Reset regex state
  HEADER_PATTERN.lastIndex = 0;

  // Only extract if the content starts with a header pattern
  // This prevents extracting legitimate headers from mid-response
  const startsWithHeader =
    /^(?:\*\*[^*]+\*\*|#{1,3}\s+.+)\n\n/.test(content.trim());

  if (!startsWithHeader) {
    return { cleaned: content, extracted: [] };
  }

  const cleaned = content.replace(
    HEADER_PATTERN,
    (match, boldHeader, hashHeader, body) => {
      const header = boldHeader || hashHeader;
      if (header && body && body.trim()) {
        // Don't extract if this looks like a legitimate section
        // Check if the header is one of the common "thinking" indicators
        const thinkingIndicators = [
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
        ];

        const headerLower = header.toLowerCase().trim();
        const isThinkingHeader = thinkingIndicators.some(
          (indicator) =>
            headerLower.includes(indicator) ||
            headerLower.startsWith('step') ||
            headerLower.startsWith('first') ||
            headerLower.startsWith('next')
        );

        // Also check if the body looks like reasoning (short, reflective)
        const bodyLines = body.trim().split('\n').filter(Boolean);
        const isShortReasoning =
          bodyLines.length <= 5 && body.length < 500;

        if (isThinkingHeader || isShortReasoning) {
          extracted.push(`${header}\n\n${body.trim()}`);
          return '';
        }
      }
      return match;
    }
  );

  return { cleaned, extracted };
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
