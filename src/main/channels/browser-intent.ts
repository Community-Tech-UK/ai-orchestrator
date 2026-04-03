const BROWSER_KEYWORDS = [
  'browse',
  'browser',
  'website',
  'web page',
  'webpage',
  'click',
  'screenshot',
  'navigate',
  'test in browser',
  'open url',
  'selenium',
  'playwright',
  'e2e test',
  'end-to-end',
  'chrome',
  'scrape',
  'crawl',
  'puppeteer',
  'cypress',
];

/**
 * Heuristic: does this message content imply browser automation work?
 * Used by the channel message router to set `nodePlacement.requiresBrowser`.
 */
export function detectBrowserIntent(content: string): boolean {
  if (!content) return false;
  const lower = content.toLowerCase();
  return BROWSER_KEYWORDS.some((kw) => lower.includes(kw));
}
