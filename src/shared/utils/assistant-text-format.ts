/**
 * Normalize assistant text for readable display.
 *
 * Cursor and other agent CLIs often stream planning monologue as one long line
 * with missing spaces around inline code and punctuation (e.g. "types:Now add").
 * These helpers insert paragraph breaks and spacing before markdown rendering.
 */

const NARRATION_BREAK_AFTER = /([.!?])\s*(?=(?:Now(?:\s+(?:let me|I'll|the|add|clear|wire|let me run|let me read))?|Let me|I'll|I will|First|Next|Then|Also|After that|Before that|Once|Looking at|Reading|Checking|Implementing|Wiring|Running|Adding|Updating|Fixing|The plan|This plan|Following|Exploring|Tracing|Searching)\b)/gi;

const NARRATION_MARKER_PATTERN =
  /\b(?:now let me|let me|i'll|i will|first,? i|next,? i|now i|now the|now add|now clear|now wire|i need to|i should|i'll start|let me explore|let me read|let me check|let me run|let me look|let me search|let me implement|let me wire)\b/gi;

/** User-facing response openers (stricter than planning narration). */
const USER_RESPONSE_START =
  /^(?:Answer:|Response:|Here's|Here is|Here are|Hi!|Hello|Hey!|Hey,|Sure,|Yes[,.]|No[,.]|Okay[,.]|OK[,.]|Based on|In summary|To summarize|In conclusion|##\s+(?!Crafting|Handling|Analyzing|Planning|Processing|Thinking|Reasoning|Implementing|Exploring|Reading|Checking|Wiring|Running|Adding|Updating|Fixing)\S)/i;

/**
 * Insert paragraph breaks and fix glued tokens in streamed assistant text.
 */
export function formatAssistantTextForDisplay(text: string): string {
  if (!text) {
    return text;
  }

  let formatted = text.replace(/\r\n/g, '\n');

  formatted = formatted.replace(NARRATION_BREAK_AFTER, '$1\n\n');
  formatted = formatted.replace(/(`[^`]+`)([A-Za-z(])/g, '$1 $2');
  formatted = formatted.replace(/(`[^`]+`):([A-Z])/g, '$1: $2');
  // Word-ending colon glued to the next sentence (e.g. "types:Now"), not ::: markers.
  formatted = formatted.replace(/([a-z0-9]):([A-Z])/g, '$1: $2');
  formatted = formatted.replace(/\n{3,}/g, '\n\n');

  return formatted;
}

/**
 * Count planning/narration phrase markers in text.
 */
export function countNarrationMarkers(text: string): number {
  return (text.match(NARRATION_MARKER_PATTERN) ?? []).length;
}

/**
 * True when text is predominantly agent planning monologue.
 *
 * "Predominantly" is load-bearing: this verdict is used to swallow an entire
 * message into a thinking accordion with an empty user-facing response. A
 * substantive answer that merely contains one reflective phrase — e.g. "It also
 * means I should narrow my conclusion" — is NOT planning monologue, and treating
 * it as such silently deletes the whole reply (and, mid-stream, freezes the
 * visible bubble at the prefix before the phrase). So require the markers to be
 * both plural and dense relative to length: a single "I should" can never carry
 * a long answer over the line on its own.
 */
export function isNarrationHeavy(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }

  const markers = countNarrationMarkers(trimmed);
  if (markers < 2) {
    return false;
  }

  // Roughly one narration marker per ~150 characters of prose. A ~180-char
  // planning monologue with 5 markers passes comfortably; a 2700-char analytical
  // answer with a single "I should" does not.
  const denseEnough = markers * 150 >= trimmed.length;
  if (!denseEnough) {
    return false;
  }

  const hasStrongMarker =
    /\b(?:i need to|i should|i'll start|let me explore|respond to the user|no tools? (?:are|is) needed)\b/i.test(
      trimmed,
    );

  return hasStrongMarker || markers >= 3;
}

/**
 * Split planning narration from a user-facing response section.
 */
export function splitNarrationFromResponse(content: string): { thinking: string; response: string } | null {
  const formatted = formatAssistantTextForDisplay(content.trim());
  if (!formatted) {
    return null;
  }

  const paragraphs = formatted
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) {
    return null;
  }

  let splitIndex = -1;
  for (let index = 0; index < paragraphs.length; index += 1) {
    const paragraph = paragraphs[index];
    if (USER_RESPONSE_START.test(paragraph)) {
      splitIndex = index;
      break;
    }
  }

  if (splitIndex > 0) {
    return {
      thinking: paragraphs.slice(0, splitIndex).join('\n\n'),
      response: paragraphs.slice(splitIndex).join('\n\n'),
    };
  }

  if (splitIndex === 0) {
    return null;
  }

  if (!isNarrationHeavy(formatted)) {
    return null;
  }

  return { thinking: formatted, response: '' };
}
