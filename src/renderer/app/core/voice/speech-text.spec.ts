import { describe, expect, it } from 'vitest';
import { OPENAI_TTS_INPUT_LIMIT, toSpeakableText, truncateForTts } from './speech-text';

describe('speech text helpers', () => {
  it('strips fenced code, inline code, links, images, and markdown emphasis', () => {
    const text = toSpeakableText([
      '# Heading',
      'Use **bold** and `inline()`.',
      '```ts',
      'const secret = "not spoken";',
      '```',
      '[Docs](https://example.com) ![alt](image.png)',
    ].join('\n'));

    expect(text).toBe('Heading Use bold. Docs');
    expect(text).not.toContain('const secret');
    expect(text).not.toContain('https://example.com');
  });

  it('turns code-only output into empty speech text', () => {
    expect(toSpeakableText('```ts\nconsole.log("only code");\n```')).toBe('');
  });

  it('caps TTS text at the OpenAI limit and prefers sentence boundaries', () => {
    const long = `${'A'.repeat(600)}. ${'B'.repeat(OPENAI_TTS_INPUT_LIMIT)}`;
    const truncated = truncateForTts(long, OPENAI_TTS_INPUT_LIMIT + 100);

    expect(truncated.length).toBeLessThanOrEqual(OPENAI_TTS_INPUT_LIMIT);
    expect(truncated.endsWith('.')).toBe(true);
  });
});
