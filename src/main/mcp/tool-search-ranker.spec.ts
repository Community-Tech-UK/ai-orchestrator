import { describe, expect, it } from 'vitest';
import { rankToolDocuments, tokenize } from './tool-search-ranker';

const DOCS = [
  { id: 'browser.fill_form', text: 'browser.fill_form Fill multiple form fields. fields selector value verify' },
  { id: 'browser.type', text: 'browser.type Type text into one page element. selector value' },
  { id: 'browser.click', text: 'browser.click Click a page element. selector actionHint' },
  { id: 'browser.screenshot', text: 'browser.screenshot Capture a screenshot image of the page. maxWidth maxHeight fullPage' },
  { id: 'browser.navigate', text: 'browser.navigate Navigate the tab to a destination URL.' },
];

describe('tokenize', () => {
  it('lowercases and splits tool ids into searchable tokens', () => {
    expect(tokenize('browser.fill_form')).toEqual(['browser', 'fill', 'form']);
  });

  it('drops single-character noise tokens', () => {
    expect(tokenize('type into a form')).toEqual(['type', 'into', 'form']);
  });
});

describe('rankToolDocuments', () => {
  it('finds form filling from a natural-language query', () => {
    const results = rankToolDocuments('type into a form', DOCS);
    const ids = results.map((result) => result.id);
    // Both typing tools surface; irrelevant tools (click/navigate/screenshot)
    // must rank below them or not at all.
    expect(ids.slice(0, 2).sort()).toEqual(['browser.fill_form', 'browser.type']);
  });

  it('returns only positively scored documents', () => {
    const results = rankToolDocuments('screenshot', DOCS);
    expect(results).toEqual([
      { id: 'browser.screenshot', score: expect.any(Number) },
    ]);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('caps results at the limit, best first', () => {
    const results = rankToolDocuments('browser page element', DOCS, 2);
    expect(results).toHaveLength(2);
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
  });

  it('is deterministic on score ties via id ordering', () => {
    const tied = [
      { id: 'b.two', text: 'shared token' },
      { id: 'a.one', text: 'shared token' },
    ];
    const results = rankToolDocuments('shared', tied);
    expect(results.map((result) => result.id)).toEqual(['a.one', 'b.two']);
  });

  it('returns empty for an empty or stop-token query', () => {
    expect(rankToolDocuments('', DOCS)).toEqual([]);
    expect(rankToolDocuments('a', DOCS)).toEqual([]);
  });
});
