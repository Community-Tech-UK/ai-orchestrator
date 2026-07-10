import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { marked } from 'marked';

/** Skill-owned template, relative to the repo root. Single source of truth (lint-tested). */
const TEMPLATE_RELATIVE_PATH = join(
  '.claude',
  'skills',
  'doc-review-artifact',
  'references',
  'artifact-template.html',
);

let cachedTemplate: string | null = null;

function candidateRoots(appRoot?: string): string[] {
  const roots = [process.cwd()];
  if (appRoot) roots.push(appRoot);
  return roots;
}

/**
 * Load the artifact template from the skill references directory. Loops run in-repo, so
 * process.cwd() (or the provided app root) resolves it. Cached after first read.
 */
export function loadArtifactTemplate(appRoot?: string): string {
  if (cachedTemplate) return cachedTemplate;
  for (const root of candidateRoots(appRoot)) {
    try {
      cachedTemplate = readFileSync(join(root, TEMPLATE_RELATIVE_PATH), 'utf8');
      return cachedTemplate;
    } catch {
      // try next root
    }
  }
  throw new Error(`doc-review artifact template not found at ${TEMPLATE_RELATIVE_PATH}`);
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
 * the skill template. Sections split at `## ` headings so each gets its own approve/reject
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
