import { describe, it, expect } from 'vitest';
import { detectBrowserIntent } from '../browser-intent';

describe('detectBrowserIntent', () => {
  it('returns true for browser-related keywords', () => {
    expect(detectBrowserIntent('open the browser and test')).toBe(true);
    expect(detectBrowserIntent('take a screenshot of the page')).toBe(true);
    expect(detectBrowserIntent('navigate to https://example.com')).toBe(true);
    expect(detectBrowserIntent('run the playwright e2e test')).toBe(true);
    expect(detectBrowserIntent('scrape the website data')).toBe(true);
    expect(detectBrowserIntent('click the submit button')).toBe(true);
  });

  it('returns false for non-browser content', () => {
    expect(detectBrowserIntent('fix the TypeScript compilation error')).toBe(false);
    expect(detectBrowserIntent('refactor the database module')).toBe(false);
    expect(detectBrowserIntent('write unit tests for the parser')).toBe(false);
    expect(detectBrowserIntent('')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(detectBrowserIntent('OPEN CHROME and test')).toBe(true);
    expect(detectBrowserIntent('Run Selenium Tests')).toBe(true);
  });
});
