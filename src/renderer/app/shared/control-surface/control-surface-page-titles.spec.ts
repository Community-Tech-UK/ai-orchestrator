import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { CONTROL_SURFACES } from './control-surface.registry';

/**
 * Rule D of the wording guard (Phase 3, step 8g): a page is called by its menu label everywhere.
 * For every routed surface the template's first heading (or `.title` element) equals the registry
 * `label`, and any registry `title` equals its `label`.
 */
const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Surfaces whose first heading is deliberately not the page name. Each says why. */
const HEADING_EXEMPT: Readonly<Record<string, string>> = {
  settings: 'its headings are section names (`{{ item.label }}`)',
  automations: 'its headings are group names (`{{ group.title }}`)',
  'plan-queue': 'its first heading belongs to the "Needs your answer" section; the shell heading names the page',
  'worker-mode': 'its headings name the pairing state panels, not the page',
  'compare-split': 'it has no in-page heading; the shell heading names the page',
};

function resolveTs(from: string, specifier: string): string | null {
  const base = resolve(dirname(from), specifier);
  return [`${base}.ts`, join(base, 'index.ts')].find(existsSync) ?? null;
}

/** The component behind a route: a direct `loadComponent`, or the first one a child routes file loads. */
function routedComponentFile(block: string): string | null {
  const routesFile = join(APP_DIR, 'app.routes.ts');
  const imported = /import\('([^']+)'\)/.exec(block)?.[1];
  let file = imported ? resolveTs(routesFile, imported) : null;
  if (file?.endsWith('.routes.ts')) {
    const child = /loadComponent:[\s\S]*?import\('([^']+)'\)/.exec(readFileSync(file, 'utf8'))?.[1];
    file = child ? resolveTs(file, child) : null;
  }
  return file;
}

function templateOf(componentFile: string): string {
  const source = readFileSync(componentFile, 'utf8');
  const url = /templateUrl:\s*'([^']+)'/.exec(source)?.[1];
  if (url) return readFileSync(resolve(dirname(componentFile), url), 'utf8');
  return /template:\s*`([\s\S]*?)`\s*,?\s*(?:styles|styleUrl|changeDetection|\}\))/.exec(source)?.[1] ?? '';
}

/** The first heading element, or the first element whose class list has a `title` token. */
export function firstHeading(html: string): string | null {
  const clean = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const open of clean.matchAll(/<([a-z][\w-]*)\b([^>]*)>/g)) {
    const classes = /\bclass="([^"]*)"/.exec(open[2])?.[1].split(/\s+/) ?? [];
    if (!/^h[1-3]$/.test(open[1]) && !classes.includes('title') && !classes.includes('page-title')) continue;
    const start = (open.index ?? 0) + open[0].length;
    const end = clean.indexOf(`</${open[1]}>`, start);
    if (end < 0) continue;
    return clean.slice(start, end).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  }
  return null;
}

function routeBlocks(): Map<string, string> {
  const blocks = new Map<string, string>();
  for (const block of readFileSync(join(APP_DIR, 'app.routes.ts'), 'utf8').split(/\n {2}\{\n/).slice(1)) {
    const id = /controlSurfaceRouteData\('([^']+)'\)/.exec(block)?.[1];
    if (id && !blocks.has(id)) blocks.set(id, block);
  }
  return blocks;
}

describe('Control surface page titles', () => {
  const blocks = routeBlocks();
  const resolved = CONTROL_SURFACES.flatMap((surface) => {
    const block = blocks.get(surface.id);
    const file = block ? routedComponentFile(block) : null;
    return file ? [{ surface, file }] : [];
  });

  it('resolves almost every routed surface to a template, so the check cannot silently pass', () => {
    expect(resolved.length).toBeGreaterThanOrEqual(45);
  });

  it("gives every surface's registry title the same words as its menu label", () => {
    const mismatched = CONTROL_SURFACES.filter((surface) => surface.title !== surface.label).map((surface) => surface.id);
    expect(mismatched).toEqual([]);
  });

  it("names every routed page's heading as its menu label", () => {
    const mismatched = resolved.flatMap(({ surface, file }) => {
      if (HEADING_EXEMPT[surface.id]) return [];
      const heading = firstHeading(templateOf(file));
      if (heading === null) return [];
      // The computers page binds its heading to the constant the registry also uses.
      if (heading === '{{ computersTitle }}') {
        return /computersTitle\s*=\s*OTHER_COMPUTERS_TITLE/.test(readFileSync(file, 'utf8')) ? [] : [`${surface.id}: unverified binding`];
      }
      return heading === surface.label ? [] : [`${surface.id}: "${heading}" should read "${surface.label}"`];
    });
    expect(mismatched).toEqual([]);
  });

  it('keeps the exemption list to surfaces that still exist', () => {
    const ids = new Set(CONTROL_SURFACES.map((surface) => surface.id));
    expect(Object.keys(HEADING_EXEMPT).filter((id) => !ids.has(id as never))).toEqual([]);
  });
});
