import { describe, expect, it } from 'vitest';
import { changedPathsFromReviewContent, touchesRendererScreens, uiConsistencySection, UI_CONSISTENCY_CHECKS } from './review-ui-consistency';

describe('advisory screen check detection', () => {
  it.each([
    'diff --git a/src/renderer/app/x.component.html b/src/renderer/app/x.component.html',
    '+++ b/src/renderer/app/x.component.scss',
    '+++ new file: src/renderer/app/x.component.ts',
  ])('detects renderer diff header %s', (header) => {
    expect(uiConsistencySection(header)).toContain('## Screen and wording check');
  });
  it.each([
    'diff --git a/src/main/index.ts b/src/main/index.ts',
    '+++ b/docs/architecture.md',
    '+++ new file: src/renderer/app/x.component.spec.ts',
    '+const path = "src/renderer/app/x.component.html";',
  ])('ignores non-screen material %s', (header) => expect(uiConsistencySection(header)).toBe(''));
  it('deduplicates paths and caps collection', () => {
    const headers = Array.from({ length: 510 }, (_, index) => `+++ b/src/renderer/${index}.ts`);
    expect(changedPathsFromReviewContent(headers.join('\n'))).toHaveLength(500);
    expect(changedPathsFromReviewContent('+++ b/docs/a.md\n+++ b/docs/a.md')).toEqual(['docs/a.md']);
  });
  it('uses explicit changed file paths for interactive callers', () => {
    expect(uiConsistencySection('code', ['src/renderer/app/app.component.html'])).toContain('UI:');
    expect(touchesRendererScreens(['src/renderer/app/app.component.test.ts'])).toBe(false);
  });
  it('carries all five guide checks and one worked example', () => {
    const section = uiConsistencySection('+++ b/src/renderer/app/app.component.html');
    expect(UI_CONSISTENCY_CHECKS).toHaveLength(5);
    for (const check of UI_CONSISTENCY_CHECKS) expect(section).toContain(check.text);
    expect(section).toContain('"lines": [12, 12]');
    expect(section).not.toMatch(/\b(?:IMPORTANT|ONLY)\b/);
  });
});
