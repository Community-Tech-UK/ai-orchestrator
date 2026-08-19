import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Guardrail: keep the codebase-indexing lane's import graph free of `electron`.
 *
 * `codebase-indexing-lane-main.ts` runs as a worker_thread, Electron
 * `utilityProcess`, or (fallback) a plain forked `child_process` — none of
 * which can resolve the `electron` module the way the main process can. Any
 * module reachable through its value-import graph that does a top-level
 * `import { … } from 'electron'` crashes the lane at load, which the
 * `ProcessLaneGateway` would then retry/back off forever
 * (`process-lane-gateway.ts`'s restart/backoff), silently disabling codebase
 * indexing.
 *
 * LT-207 added `registerWorkerEventForwarding`/`context-worker-event-forwarding.ts`
 * to this lane's import closure (to forward `RLMContextManager` events to
 * main — see `codebase-indexing-lane-main.ts`'s `ensureWorkerEventForwarding`).
 * That module also pulls in `skills/skill-attribution-service.ts` and
 * `memory/wake-context-builder.ts`, which were not previously part of this
 * lane's closure — this test was added alongside that change specifically to
 * catch a barrel-import regression there before it reaches a real build.
 *
 * The test statically walks the lane's value-import closure — skipping
 * `import type` / `export type`, which tsc erases and which therefore emit no
 * runtime `require` — and fails if ANY reachable module top-level
 * value-imports 'electron'. It imports no production code; it is pure
 * filesystem analysis (see `context-worker-import-isolation.spec.ts` for the
 * sibling guard this is modeled on).
 *
 * If this fails: something (probably a barrel re-export) pulled a
 * main-process module into the lane. Deep-import the specific symbol you
 * need, or hide the electron dependency behind a lazy guarded
 * `require('electron')` in a try/catch.
 */

const SPEC_DIR = dirname(fileURLToPath(import.meta.url));
const WORKER_ENTRY = resolve(SPEC_DIR, './codebase-indexing-lane-main.ts');

// Measured closure size after LT-207 (registerWorkerEventForwarding +
// skill-attribution-service + wake-context-builder joined the graph) was 107
// modules. Ceiling leaves room for incidental growth while still catching a
// barrel re-coupling long before it reaches hundreds of modules.
const CLOSURE_SIZE_CEILING = 130;

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
  // Strip comments so an `import … from 'electron'` inside a comment/example
  // can't trip the guard.
  const src = rawSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\n)\s*\/\/[^\n]*/g, '$1');

  const deps: { spec: string; typeOnly: boolean }[] = [];
  let electronValueImport = false;

  // Matches `import … from 'x'` and `export … from 'x'`, including multi-line
  // named clauses. The non-greedy clause stops at the first `from`.
  const re = /(?:^|\n)\s*(?:import|export)\b([\s\S]*?)\bfrom\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const clause = m[1] ?? '';
    const spec = m[2] ?? '';
    const typeOnly = /^\s*type\b/.test(clause); // `import type` / `export type`
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

describe('codebase indexing lane import isolation', () => {
  it('lane entry file exists', () => {
    expect(existsSync(WORKER_ENTRY)).toBe(true);
  });

  it('no module in the indexing lane value-import closure top-level imports electron', () => {
    const { modules, electronImporters } = walkWorkerClosure(WORKER_ENTRY);

    const offenders = [...electronImporters.entries()].map(
      ([file, chain]) => `${rel(file)}  (via ${chain.slice(-3).map(rel).join(' -> ')})`,
    );

    expect(
      offenders,
      'The codebase indexing lane runs off the main thread/process where ' +
        "'electron' is not resolvable. These modules in its import closure " +
        `top-level import electron and will crash the lane:\n${offenders
          .map((o) => `  - ${o}`)
          .join('\n')}\nDeep-import the specific symbol instead of a barrel, or ` +
        'hide the electron dependency behind a lazy guarded require().',
    ).toEqual([]);

    expect(
      modules.size,
      `Indexing lane import closure grew to ${modules.size} modules (baseline ` +
        '~107 after LT-207). A jump like this usually means the lane re-coupled ' +
        'to the main-process graph through a barrel re-export.',
    ).toBeLessThan(CLOSURE_SIZE_CEILING);
  });
});
