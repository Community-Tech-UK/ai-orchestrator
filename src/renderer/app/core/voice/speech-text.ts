export const OPENAI_TTS_INPUT_LIMIT = 4096;
export const DEFAULT_TTS_TARGET_CHARS = 3500;

export function toSpeakableText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' link omitted ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[>\-*+]\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_{1,2}([^_]+)_{1,2}/g, '$1')
    .replace(/\s+(and|or)\s*([.?!])/gi, '$2')
    .replace(/\s+([.,!?;:])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function truncateForTts(
  text: string,
  maxChars = DEFAULT_TTS_TARGET_CHARS
): string {
  const limit = Math.min(maxChars, OPENAI_TTS_INPUT_LIMIT);
  if (text.length <= limit) return text;

  const clipped = text.slice(0, limit);
  const sentenceEnd = Math.max(
    clipped.lastIndexOf('. '),
    clipped.lastIndexOf('? '),
    clipped.lastIndexOf('! ')
  );
  return clipped
    .slice(0, sentenceEnd > 500 ? sentenceEnd + 1 : limit)
    .trim();
}
