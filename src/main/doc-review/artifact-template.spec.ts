import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Template-lint for the doc-review artifact contract (v1). The skill and the Phase 3
 * main-process renderer both build artifacts from this template, so the contract markers
 * and the "self-contained, no external requests" guarantee must hold.
 */
const TEMPLATE_PATH = join(
  process.cwd(),
  '.claude',
  'skills',
  'doc-review-artifact',
  'references',
  'artifact-template.html',
);

describe('doc-review artifact template', () => {
  const html = readFileSync(TEMPLATE_PATH, 'utf8');

  it('declares the v1 doc-review meta marker', () => {
    expect(html).toContain('<meta name="aio-doc-review" content="v1">');
  });

  it('carries the title, source, and id meta tags', () => {
    expect(html).toContain('name="aio-doc-review-title"');
    expect(html).toContain('name="aio-doc-review-source"');
    expect(html).toContain('name="aio-doc-review-id"');
  });

  it('exposes the fill tokens the skill and renderer replace', () => {
    for (const token of ['{{TITLE}}', '{{SOURCE}}', '{{REVIEW_ID}}', '{{GENERATED_AT}}', '{{CONTENT}}']) {
      expect(html).toContain(token);
    }
  });

  it('embeds the review runtime with both standalone and embedded modes', () => {
    expect(html).toContain('AIO doc-review runtime v1');
    // postMessage protocol used in embedded (in-app iframe) mode.
    expect(html).toContain('aio-review/');
    expect(html).toContain('window.parent.postMessage');
    // Standalone export path.
    expect(html).toContain('.decisions.json');
  });

  it('makes no external requests (self-contained, offline)', () => {
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toMatch(/\bfetch\s*\(/);
    expect(html).not.toMatch(/<link\b[^>]*\brel=["']?stylesheet/i);
    expect(html).not.toMatch(/<script\b[^>]*\bsrc=/i);
  });
});
