import { describe, expect, it } from 'vitest';
import { isAppDocumentNavigation } from './window-navigation-policy';

const PACKAGED_APP_URL =
  'file:///Applications/Harness.app/Contents/Resources/app.asar/dist/renderer/browser/index.html';

describe('isAppDocumentNavigation', () => {
  it('blocks a relative document link resolved against the packaged renderer base URL', () => {
    // Regression: clicking `docs/2026-09-go-ahead/KPI-Testing-Guide.docx` in a
    // transcript navigated the main window here and left a blank screen.
    expect(isAppDocumentNavigation(
      'file:///Applications/Harness.app/Contents/Resources/app.asar/dist/renderer/browser/docs/2026-09-go-ahead/KPI-Testing-Guide.docx',
      PACKAGED_APP_URL,
    )).toBe(false);
  });

  it('blocks other local files in a packaged build', () => {
    expect(isAppDocumentNavigation('file:///Users/someone/report.docx', PACKAGED_APP_URL)).toBe(false);
  });

  it('allows the packaged app document, including query and hash changes', () => {
    expect(isAppDocumentNavigation(PACKAGED_APP_URL, PACKAGED_APP_URL)).toBe(true);
    expect(isAppDocumentNavigation(`${PACKAGED_APP_URL}?x=1#/settings`, PACKAGED_APP_URL)).toBe(true);
  });

  it('compares packaged paths after percent-decoding', () => {
    expect(isAppDocumentNavigation(
      'file:///Users/some%20one/Harness/index.html',
      'file:///Users/some one/Harness/index.html',
    )).toBe(true);
  });

  it('blocks external sites in a packaged build', () => {
    expect(isAppDocumentNavigation('https://example.com/', PACKAGED_APP_URL)).toBe(false);
    expect(isAppDocumentNavigation('http://localhost:4567/', PACKAGED_APP_URL)).toBe(false);
  });

  it('allows any path on the dev server origin and blocks other origins', () => {
    const devUrl = 'http://localhost:4567';
    expect(isAppDocumentNavigation('http://localhost:4567/settings', devUrl)).toBe(true);
    expect(isAppDocumentNavigation('http://localhost:9999/', devUrl)).toBe(false);
    expect(isAppDocumentNavigation('file:///tmp/guide.docx', devUrl)).toBe(false);
    expect(isAppDocumentNavigation('https://example.com/', devUrl)).toBe(false);
  });

  it('blocks unparseable targets', () => {
    expect(isAppDocumentNavigation('not a url', PACKAGED_APP_URL)).toBe(false);
  });
});
