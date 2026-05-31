import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Guardrail: every worker_thread entry whose value-import closure reaches a
 * path-aliased module (@contracts / @shared / @sdk) MUST register those aliases
 * as its FIRST statement, e.g. `require('../register-aliases')`.
 *
 * Why: worker threads are separate module realms. They do NOT inherit the main
 * thread's `register-aliases` patch to `Module._resolveFilename`, so a transitive
 * `import … from '@contracts/…'` anywhere in the worker's closure crashes it at
 * load with "Cannot find module '@contracts/…'", silently degrading whatever the
 * worker powers (this exact bug disabled memory/RLM context for entire sessions
 * via context-worker-main.ts → skill-loader → @contracts/schemas/plugin).
 *
 * This test is pure filesystem analysis — it imports no production code. It walks
 * each worker's value-import graph (skipping `import type`, which tsc erases) and
 * fails any worker that reaches an alias but lacks the bootstrap. Workers whose
 * closure never touches an alias are intentionally exempt (no needless no-op).
 *
 * If this fails: add `require('../register-aliases')` as the first statement of
 * the named worker entry (before any import), mirroring src/main/index.ts.
 */

const SPEC_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_MAIN = resolve(SPEC_DIR, '..'); // src/main/__tests__ -> src/main

/** Prefixes registered by register-aliases.ts that need the runtime resolver patch. */
const ALIAS_PREFIX = /^@(contracts|shared|sdk)(\/|$)/;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\n)\s*\/\/[^\n]*/g, '$1');
}

function resolveRelativeImport(spec: string, fromFile: string): string | null {
  if (!spec.startsWith('.')) return null; // bare/aliased/node module — not walked
  const base = resolve(dirname(fromFile), spec);
  const candidates = [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx'), `${base}.js`];
  return candidates.find((c) => existsSync(c)) ?? null;
}

interface Dep { spec: string; typeOnly: boolean }

function parseDeps(rawSrc: string): Dep[] {
  const src = stripComments(rawSrc);
  const deps: Dep[] = [];
  const re = /(?:^|\n)\s*(?:import|export)\b([\s\S]*?)\bfrom\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const clause = m[1] ?? '';
    const spec = m[2] ?? '';
    deps.push({ spec, typeOnly: /^\s*type\b/.test(clause) });
  }
  return deps;
}

const relPath = (p: string): string => {
  const idx = p.indexOf('/src/');
  return idx >= 0 ? p.slice(idx + 1) : p;
};

/** Walk the value-import closure; return the chain that first reaches an alias, if any. */
function findAliasReach(entry: string): string[] | null {
  const seen = new Set<string>();
  const stack: { file: string; chain: string[] }[] = [{ file: entry, chain: [] }];
  while (stack.length > 0) {
    const { file, chain } = stack.pop() as { file: string; chain: string[] };
    if (seen.has(file)) continue;
    seen.add(file);

    let src: string;
    try {
      src = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const myChain = [...chain, file];
    const deps = parseDeps(src);
    for (const dep of deps) {
      if (dep.typeOnly) continue; // erased by tsc → no runtime require
      if (ALIAS_PREFIX.test(dep.spec)) return [...myChain, dep.spec];
      const resolved = resolveRelativeImport(dep.spec, file);
      if (resolved) stack.push({ file: resolved, chain: myChain });
    }
  }
  return null;
}

function bootstrapsAliasesFirst(rawSrc: string): boolean {
  const s = stripComments(rawSrc);
  const reqIdx = s.search(/require\(\s*['"][^'"]*register-aliases['"]\s*\)/);
  if (reqIdx < 0) return false;
  const impMatch = /(?:^|\n)\s*import\b[\s\S]*?\bfrom\s*['"]/.exec(s);
  if (!impMatch) return true; // no ESM import at all → ordering moot
  return reqIdx < (impMatch.index ?? Number.MAX_SAFE_INTEGER);
}

/** Recursively find worker ENTRY files: import node:worker_threads + use isMainThread/parentPort. */
function discoverWorkerEntries(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      discoverWorkerEntries(full, out);
    } else if (name.endsWith('.ts') && !name.endsWith('.spec.ts') && !name.endsWith('.d.ts')) {
      const src = readFileSync(full, 'utf8');
      if (src.includes('worker_threads') && /\bisMainThread\b|\bparentPort\b/.test(src)) {
        out.push(full);
      }
    }
  }
  return out;
}

describe('worker alias bootstrap', () => {
  const entries = discoverWorkerEntries(SRC_MAIN);

  it('discovers worker entry files', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it('guard is not vacuous: the context-worker is detected as alias-reaching and bootstrapped', () => {
    // This pins the real regression (context-worker-main → skill-loader →
    // @contracts/schemas/plugin) so the guard can never silently become a no-op.
    const ctx = resolve(SRC_MAIN, 'instance/context-worker-main.ts');
    expect(existsSync(ctx)).toBe(true);
    expect(findAliasReach(ctx), 'context-worker should reach an alias via its import closure').not.toBeNull();
    expect(bootstrapsAliasesFirst(readFileSync(ctx, 'utf8'))).toBe(true);
  });

  for (const entry of entries) {
    it(`${relPath(entry)} registers aliases iff its closure reaches @contracts/@shared/@sdk`, () => {
      const reach = findAliasReach(entry);
      if (!reach) return; // closure never touches an alias — exempt
      const chainStr = reach.slice(-3).map((p) => (p.startsWith('@') ? p : relPath(p))).join(' -> ');
      expect(
        bootstrapsAliasesFirst(readFileSync(entry, 'utf8')),
        `${relPath(entry)} reaches an aliased import (… ${chainStr}) but does not ` +
          `require('../register-aliases') before its first import. Worker threads are separate ` +
          `module realms and don't inherit the main-thread alias resolver, so this crashes the ` +
          `worker at load. Add it as the first statement (see src/main/index.ts).`,
      ).toBe(true);
    });
  }
});
