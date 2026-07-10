import { describe, expect, it, beforeEach } from 'vitest';
import {
  _resetTemplateCacheForTesting,
  renderPlanArtifact,
  splitMarkdownSections,
} from './artifact-renderer';
import { parseArtifactMeta } from './artifact-validator';

const MARKDOWN = `# My Plan

Intro paragraph.

## Phase 1

Do the first thing.

## Phase 2 <danger>

Do the second thing.
`;

describe('artifact-renderer', () => {
  beforeEach(() => _resetTemplateCacheForTesting());

  it('splits markdown into an overview plus one section per H2', () => {
    const sections = splitMarkdownSections(MARKDOWN);
    expect(sections.map((s) => s.title)).toEqual(['Overview', 'Phase 1', 'Phase 2 <danger>']);
    expect(sections[0].id).toBe('overview');
    expect(sections[1].id).toBe('phase-1');
  });

  it('renders a valid, self-contained artifact from markdown', () => {
    const html = renderPlanArtifact({
      title: 'My Plan',
      markdown: MARKDOWN,
      reviewId: '2026-07-10-my-plan',
      sourcePath: 'docs/plan.md',
      generatedAt: '2026-07-10',
    });

    expect(parseArtifactMeta(html).isArtifact).toBe(true);
    expect(html).toContain('<meta name="aio-doc-review" content="v1">');
    expect(html).toContain('content="2026-07-10-my-plan"');
    expect(html).toContain('data-review-item="phase-1"');
    // No unreplaced template tokens.
    expect(html).not.toContain('{{');
    // No external requests survive.
    expect(html).not.toMatch(/https?:\/\//i);
  });

  it('escapes untrusted heading/title text into attributes', () => {
    const html = renderPlanArtifact({
      title: 'A "quoted" & <tagged> plan',
      markdown: MARKDOWN,
      reviewId: 'r1',
      generatedAt: '2026-07-10',
    });
    expect(html).toContain('content="A &quot;quoted&quot; &amp; &lt;tagged&gt; plan"');
    // The Phase 2 heading with an angle-bracket token is escaped in the section title attr.
    expect(html).toContain('data-review-title="Phase 2 &lt;danger&gt;"');
  });
});
