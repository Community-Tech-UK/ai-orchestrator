import { describe, it, expect } from 'vitest';
import { runInNewContext } from 'node:vm';
import { liveThoughtLine } from './live-thought-line';
describe('liveThoughtLine', () => {
  it('prefers a short bold heading that opens the text', () => expect(liveThoughtLine('**Checking migration order**\n\nMore. Detail.')).toBe('Checking migration order'));
  it('treats bold inside a sentence as emphasis, not a heading', () => {
    expect(liveThoughtLine('Intro. **Checking migration order** More')).toBe('Intro');
    expect(liveThoughtLine('Checking the **migration** order. Then more.')).toBe('Checking the migration order');
  });
  it('uses the first sentence and strips Markdown', () => expect(liveThoughtLine('# Checking `retry` [logic](https://example.invalid). Next.')).toBe('Checking retry logic'));
  it('caps long text at 60 characters including ellipsis', () => expect(liveThoughtLine('a'.repeat(90))).toHaveLength(60));
  it('returns null for empty text', () => expect(liveThoughtLine('  ')).toBeNull());

  it('keeps distant headings from replacing the first transient text', () => {
    const headline = liveThoughtLine('Opening context '.repeat(400) + '**Distant heading**');
    expect(headline).toMatch(/^Opening context /);
    expect(headline).toHaveLength(60);
  });
  it.each(['[', '<'])('handles unmatched %s while returning a short headline', (delimiter) => {
    expect(liveThoughtLine(delimiter.repeat(8_000))).toBe(delimiter.repeat(59) + '…');
  });
  it.each(['[', '<'])('bounds cleanup of malformed %s input', (delimiter) => {
    expect(runInNewContext('headline(text)', {
      headline: liveThoughtLine, text: delimiter.repeat(40_000),
    }, { timeout: 300 })).toBe(delimiter.repeat(59) + '…');
  });
  it('retains short HTML, links and headings in the opening text', () => {
    expect(liveThoughtLine('<b>Checking</b> [links](https://example.invalid). Later.')).toBe('Checking links');
    expect(liveThoughtLine('**Preferred heading** Later. More.')).toBe('Preferred heading');
  });
});
