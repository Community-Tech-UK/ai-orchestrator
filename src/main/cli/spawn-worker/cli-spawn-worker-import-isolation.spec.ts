import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SPEC_DIR = dirname(fileURLToPath(import.meta.url));
const WORKER_ENTRY = resolve(SPEC_DIR, './cli-spawn-worker-main.ts');
const CLOSURE_SIZE_CEILING = 30;

function resolveImport(spec: string, fromFile: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
    `${base}.js`,
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

function parseModule(rawSrc: string): {
  deps: { spec: string; typeOnly: boolean }[];
  electronValueImport: boolean;
} {
  const src = rawSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\n)\s*\/\/[^\n]*/g, '$1');
  const deps: { spec: string; typeOnly: boolean }[] = [];
  let electronValueImport = false;
  const re = /(?:^|\n)\s*(?:import|export)\b([\s\S]*?)\bfrom\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const clause = m[1] ?? '';
    const spec = m[2] ?? '';
    const typeOnly = /^\s*type\b/.test(clause);
    if (spec === 'electron') {
      if (!typeOnly) electronValueImport = true;
      continue;
    }
    deps.push({ spec, typeOnly });
  }
  return { deps, electronValueImport };
}

function walkWorkerClosure(entry: string): {
  modules: Set<string>;
  electronImporters: string[];
} {
  const modules = new Set<string>();
  const electronImporters: string[] = [];
  const stack = [entry];

  while (stack.length > 0) {
    const file = stack.pop();
    if (!file || modules.has(file)) continue;
    modules.add(file);

    const src = readFileSync(file, 'utf8');
    const { deps, electronValueImport } = parseModule(src);
    if (electronValueImport) electronImporters.push(file);

    for (const dep of deps) {
      if (dep.typeOnly) continue;
      const resolved = resolveImport(dep.spec, file);
      if (resolved) stack.push(resolved);
    }
  }

  return { modules, electronImporters };
}

describe('cli spawn worker import isolation', () => {
  it('worker entry file exists', () => {
    expect(existsSync(WORKER_ENTRY)).toBe(true);
  });

  it('does not pull electron into the worker value-import closure', () => {
    const { modules, electronImporters } = walkWorkerClosure(WORKER_ENTRY);

    expect(electronImporters).toEqual([]);
    expect(modules.size).toBeLessThan(CLOSURE_SIZE_CEILING);
  });
});
