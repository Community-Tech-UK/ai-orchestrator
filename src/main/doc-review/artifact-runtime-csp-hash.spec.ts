import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const TEMPLATE_PATH = join(__dirname, 'assets', 'artifact-template.html');
const INDEX_HTML_PATH = join(__dirname, '..', '..', 'renderer', 'index.html');

function extractInlineScript(html: string): string {
  const match = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (!match) throw new Error('artifact template inline <script> not found');
  return match[1];
}

/**
 * The doc-review artifact runtime executes inline inside a sandboxed `srcdoc` iframe with no
 * `allow-same-origin` (doc-review-viewer.component.ts), so it inherits the renderer's CSP
 * instead of getting an origin of its own. `script-src 'self'` alone blocks it; the CSP in
 * src/renderer/index.html allow-lists it by exact sha256 content hash instead of relaxing to
 * 'unsafe-inline'. The template substitution never touches the text inside the runtime
 * <script> tag (only meta/head/content placeholders), so this hash is constant across every
 * rendered review artifact. This test recomputes it from the tracked template so a future
 * runtime-script edit that forgets to update the CSP fails loudly here instead of silently
 * breaking the Doc Reviews pane at runtime.
 */
describe('doc-review artifact runtime CSP hash', () => {
  it('matches the sha256 hash allow-listed in the renderer CSP', () => {
    const script = extractInlineScript(readFileSync(TEMPLATE_PATH, 'utf8'));
    const hash = createHash('sha256').update(script, 'utf8').digest('base64');
    const indexHtml = readFileSync(INDEX_HTML_PATH, 'utf8');

    expect(indexHtml).toContain(`'sha256-${hash}'`);
  });

  it('would not allow-list a different script (the hash is content-specific, not a blanket relaxation)', () => {
    const script = extractInlineScript(readFileSync(TEMPLATE_PATH, 'utf8'));
    const hash = createHash('sha256').update(script, 'utf8').digest('base64');
    const tamperedHash = createHash('sha256').update(`${script}//tampered`, 'utf8').digest('base64');

    expect(tamperedHash).not.toBe(hash);

    const indexHtml = readFileSync(INDEX_HTML_PATH, 'utf8');
    expect(indexHtml).not.toContain(`'sha256-${tamperedHash}'`);
    // The CSP must not also carry a blanket 'unsafe-inline' escape hatch alongside the hash.
    expect(indexHtml).not.toMatch(/script-src[^;"]*'unsafe-inline'/);
  });
});
