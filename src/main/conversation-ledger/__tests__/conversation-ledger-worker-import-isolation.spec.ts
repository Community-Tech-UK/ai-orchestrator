import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Guardrail: keep the conversation-ledger worker's import graph free of `electron`.
 *
 * `conversation-ledger-worker-main.ts` runs in a worker_thread, where Electron's
 * `electron` module is NOT resolvable. Any module reachable through its
 * value-import graph that does a top-level `import { … } from 'electron'` crashes
 * the worker at load with "Cannot find module 'electron'", which would silently
 * disable all ledger persistence for the session and reintroduce the very
 * main-thread stalls this worker exists to prevent.
 *
 * The classic trap here is importing the `../conversation-ledger` barrel (which
 * re-exports the electron-importing ConversationLedgerService). The worker must
 * deep-import the store/schema/driver directly. This test statically walks the
 * worker's value-import closure — skipping `import type` / `export type`, which
 * tsc erases — and fails if ANY reachable module top-level value-imports
 * 'electron'. It imports no production code; it is pure filesystem analysis.
 *
 * If this fails: deep-import the specific symbol you need (never a barrel), or
 * hide the electron dependency behind a lazy guarded `require('electron')`.
 */

const SPEC_DIR = dirname(fileURLToPath(import.meta.url));
const WORKER_ENTRY = resolve(SPEC_DIR, '../conversation-ledger-worker-main.ts');

// The worker pulls in driver + schema + store + logger + clone-safe types only.
// This ceiling catches a re-coupling (e.g. a barrel import) long before it
// reaches the hundreds a main-process barrel would drag in.
const CLOSURE_SIZE_CEILING = 80;

function resolveImport(spec: string, fromFile: string): string | null {
  if (!spec.startsWith('.')) return null; // bare module (electron, node:*, npm)
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

interface ParsedModule {
  deps: { spec: string; typeOnly: boolean }[];
  electronValueImport: boolean;
}

function parseModule(rawSrc: string): ParsedModule {
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
  electronImporters: Map<string, string[]>;
} {
  const modules = new Set<string>();
  const electronImporters = new Map<string, string[]>();
  const stack: { file: string; chain: string[] }[] = [{ file: entry, chain: [] }];

  while (stack.length > 0) {
    const next = stack.pop();
    if (!next) break;
    const { file, chain } = next;
    if (modules.has(file)) continue;
    modules.add(file);

    let src: string;
    try {
      src = readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    const { deps, electronValueImport } = parseModule(src);
    const myChain = [...chain, file];
    if (electronValueImport) electronImporters.set(file, myChain);

    for (const dep of deps) {
      if (dep.typeOnly) continue; // erased by tsc → no runtime require
      const resolved = resolveImport(dep.spec, file);
      if (resolved) stack.push({ file: resolved, chain: myChain });
    }
  }

  return { modules, electronImporters };
}

const rel = (p: string): string => {
  const idx = p.indexOf('/src/');
  return idx >= 0 ? p.slice(idx + 1) : p;
};

describe('conversation-ledger worker import isolation', () => {
  it('worker entry file exists', () => {
    expect(existsSync(WORKER_ENTRY)).toBe(true);
  });

  it('no module in the worker value-import closure top-level imports electron', () => {
    const { modules, electronImporters } = walkWorkerClosure(WORKER_ENTRY);

    const offenders = [...electronImporters.entries()].map(
      ([file, chain]) => `${rel(file)}  (via ${chain.slice(-3).map(rel).join(' -> ')})`,
    );

    expect(
      offenders,
      'The conversation-ledger worker runs off the main thread where \'electron\' is not ' +
        'resolvable. These modules in its import closure top-level import electron and will ' +
        `crash the worker:\n${offenders.map((o) => `  - ${o}`).join('\n')}\nDeep-import the ` +
        'specific symbol instead of a barrel, or hide the electron dependency behind a lazy ' +
        'guarded require().',
    ).toEqual([]);

    expect(
      modules.size,
      `Worker import closure grew to ${modules.size} modules. A jump usually means the worker ` +
        're-coupled to the main-process graph through a barrel re-export.',
    ).toBeLessThan(CLOSURE_SIZE_CEILING);
  });
});
