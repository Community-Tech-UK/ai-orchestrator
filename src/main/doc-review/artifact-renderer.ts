import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { marked } from 'marked';

/** Tracked runtime asset, relative to the repo root in development. */
const TEMPLATE_RELATIVE_PATH = join(
  'src',
  'main',
  'doc-review',
  'assets',
  'artifact-template.html',
);

let cachedTemplate: string | null = null;

function candidatePaths(appRoot?: string): string[] {
  const paths = [join(__dirname, 'assets', 'artifact-template.html')];
  if (appRoot) paths.push(join(appRoot, TEMPLATE_RELATIVE_PATH));
  paths.push(join(process.cwd(), TEMPLATE_RELATIVE_PATH));
  return [...new Set(paths)];
}

/**
 * Load the tracked artifact template. The build copies it beside the compiled module;
 * source-tree fallbacks support development and callers that provide an application root.
 * Cached after first read.
 */
export function loadArtifactTemplate(appRoot?: string): string {
  if (cachedTemplate) return cachedTemplate;
  for (const candidate of candidatePaths(appRoot)) {
    try {
      cachedTemplate = readFileSync(candidate, 'utf8');
      return cachedTemplate;
    } catch {
      // try next root
    }
  }
  throw new Error(`doc-review artifact template not found (${TEMPLATE_RELATIVE_PATH})`);
}

/**
 * sha256 (base64) of review runtimes shipped by earlier template versions. Each artifact keeps
 * the runtime it was written with, and the renderer CSP allow-lists only the current runtime's
 * hash, so an in-app read swaps a known older runtime for the current one. When the runtime
 * script changes, add the outgoing hash here.
 */
const PREVIOUS_RUNTIME_SHA256: ReadonlySet<string> = new Set([
  'yx4kjyTOVHK4OxrRqPVdFnG7y42LuQ7CP65Gl8gIFTo=',
]);

const INLINE_SCRIPT = /<script>([\s\S]*?)<\/script>/g;

/**
 * Replace every inline script that exactly matches an earlier review runtime with the
 * current template's runtime. Any other script is left untouched (and stays blocked by the
 * renderer CSP). Only the in-memory copy changes; the artifact on disk is not rewritten.
 */
export function upgradeArtifactRuntime(html: string, appRoot?: string): string {
  return html.replace(INLINE_SCRIPT, (block: string, body: string) => {
    const hash = createHash('sha256').update(body, 'utf8').digest('base64');
    if (!PREVIOUS_RUNTIME_SHA256.has(hash)) return block;
    const current = /<script>[\s\S]*?<\/script>/.exec(loadArtifactTemplate(appRoot));
    if (!current) throw new Error('doc-review artifact template has no runtime script');
    return current[0];
  });
}

/** For tests: drop the cached template so a fresh read happens. */
export function _resetTemplateCacheForTesting(): void {
  cachedTemplate = null;
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function slugify(value: string, fallback: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || fallback;
}

interface MarkdownSection {
  id: string;
  title: string;
  body: string;
}

/**
 * Split a Markdown document into reviewable sections at each top-level (`## `) heading.
 * Content before the first `## ` becomes an "Overview" section.
 */
export function splitMarkdownSections(markdown: string): MarkdownSection[] {
  const lines = markdown.split(/\r?\n/);
  const sections: MarkdownSection[] = [];
  let current: MarkdownSection | null = null;
  const usedIds = new Set<string>();

  const pushCurrent = () => {
    if (current && current.body.trim()) sections.push(current);
  };
  const startSection = (title: string) => {
    pushCurrent();
    let id = slugify(title, `section-${sections.length + 1}`);
    while (usedIds.has(id)) id = `${id}-${sections.length + 1}`;
    usedIds.add(id);
    current = { id, title, body: '' };
  };

  startSection('Overview');
  for (const line of lines) {
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2) {
      startSection(h2[1]);
      current!.body += `## ${h2[1]}\n`;
      continue;
    }
    current!.body += `${line}\n`;
  }
  pushCurrent();
  return sections;
}

function renderSections(markdown: string): string {
  const sections = splitMarkdownSections(markdown);
  return sections
    .map((section) => {
      const html = marked.parse(section.body, { async: false }) as string;
      return (
        `<section data-review-item="${escapeAttr(section.id)}" ` +
        `data-review-title="${escapeAttr(section.title)}">\n${html}\n</section>`
      );
    })
    .join('\n');
}

export interface RenderPlanArtifactInput {
  title: string;
  markdown: string;
  reviewId: string;
  sourcePath?: string;
  generatedAt: string;
  appRoot?: string;
}

/**
 * Render a plan/spec/report Markdown document into a self-contained review artifact using
 * the tracked template. Sections split at `## ` headings so each gets its own approve/reject
 * control. The embedded runtime and all contract markers come from the template.
 */
export function renderPlanArtifact(input: RenderPlanArtifactInput): string {
  const template = loadArtifactTemplate(input.appRoot);
  const content = renderSections(input.markdown);
  return template
    .replace(/\{\{TITLE\}\}/g, escapeAttr(input.title))
    .replace(/\{\{SOURCE\}\}/g, escapeAttr(input.sourcePath ?? ''))
    .replace(/\{\{REVIEW_ID\}\}/g, escapeAttr(input.reviewId))
    .replace(/\{\{GENERATED_AT\}\}/g, escapeText(input.generatedAt))
    .replace('{{CONTENT}}', content);
}
