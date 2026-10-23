/**
 * Screen checks share the existing consistency dimension. A fifth review angle
 * would create required coverage that an unavailable style reviewer could block.
 * UI findings are explicitly advisory through conversion and aggregation.
 */
export const UI_CONSISTENCY_CHECKS = [
  { id: 'name', guideKeyword: 'tooltip', text: 'An icon-only control (a button that shows only a glyph or a picture) without a tooltip and an accessible name.' },
  { id: 'native-title', guideKeyword: 'title', text: 'A native title attribute on a control.' },
  { id: 'wording', guideKeyword: 'jargon', text: 'New raw status text, internal codes or jargon in text a user can see.' },
  { id: 'status', guideKeyword: 'status', text: 'A new local status-to-label map instead of the shared status presenter.' },
  { id: 'consequence', guideKeyword: 'consequence', text: 'A destructive, money-spending or auto-approving action whose consequence is not shown in visible text beside it.' },
] as const;

export function changedPathsFromReviewContent(content: string): string[] {
  const paths = new Set<string>();
  for (const line of content.split('\n')) {
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
      ?? /^\+\+\+ b\/(.+)$/.exec(line)
      ?? /^\+\+\+ new file: (.+)$/.exec(line);
    if (match) paths.add((match[2] ?? match[1]).trim());
    if (paths.size >= 500) break;
  }
  return [...paths];
}

export function touchesRendererScreens(paths: readonly string[]): boolean {
  return paths.some((path) => path.startsWith('src/renderer/')
    && /\.(?:html|ts|scss|css)$/.test(path) && !/\.(?:spec|test)\.ts$/.test(path));
}

/** Static material also participates in promptVersionForAngle's cache key. */
export const UI_CONSISTENCY_SECTION = `
## Screen and wording check (this change touches renderer files)
In addition to the review that follows, look at the changed lines only for these five patterns:
${UI_CONSISTENCY_CHECKS.map((check, index) => `${index + 1}. ${check.text}`).join('\n')}
These five patterns are house rules for this repository, not style preferences.
Write each match as one entry in the consistency issues that starts with "UI:" and ends with the evidence line described below. These entries are advisory: when they are the only issues, keep the consistency score at 3 or 4. When no pattern matches, add no UI entry.
Example entry: "UI: the new Remove button shows only a × and has no tooltip or accessible name.
#EVIDENCE#
{"file": "src/renderer/app/features/instance-detail/composer-queue.component.html", "lines": [12, 12], "quote": "<button (click)=\\"remove()\\">×</button>"}"
`;

export function uiConsistencySection(content: string, changedFiles?: readonly string[]): string {
  return touchesRendererScreens(changedFiles ?? changedPathsFromReviewContent(content)) ? UI_CONSISTENCY_SECTION : '';
}
