/**
 * Shared by the two "one name for each thing" guard specs
 * (`src/shared/display-names.guard.spec.ts` and
 * `src/shared/attention/instance-status-presentation.guard.spec.ts`): list the
 * production TypeScript under a few roots and read it as a syntax tree.
 *
 * Test sources are never listed, so a spec that mirrors a map cannot trip a
 * guard about production maps.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';

export const REPO_ROOT = resolve(__dirname, '..', '..');

const SKIPPED_DIRECTORIES = new Set([
  'node_modules', 'dist', 'out-tsc', 'coverage', '.git', '.worktrees', '_scratch', '_archive', '__tests__', 'generated',
]);

/** Repo-relative paths (forward slashes) of non-test `.ts` files under the given repo-relative roots. */
export function listProductionSources(roots: readonly string[]): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(full);
      } else if (
        entry.name.endsWith('.ts')
        && !/\.(?:spec|test|d)\.ts$/.test(entry.name)
        && !/\.(?:fixture|test-helpers)\.ts$/.test(entry.name)
      ) {
        found.push(relative(REPO_ROOT, full).split('\\').join('/'));
      }
    }
  };
  for (const root of roots) walk(join(REPO_ROOT, root));
  return found.sort();
}

export function readSource(repoRelativePath: string): string {
  return readFileSync(join(REPO_ROOT, repoRelativePath), 'utf8');
}

export function parseSource(repoRelativePath: string, text: string = readSource(repoRelativePath)): ts.SourceFile {
  return ts.createSourceFile(repoRelativePath, text, ts.ScriptTarget.Latest, true);
}

export function lineOf(file: ts.SourceFile, node: ts.Node): number {
  return file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
}

/** Strips `as const`, parentheses and `satisfies` so `({ ... } as const)` reads as the object inside. */
export function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isAsExpression(current) || ts.isParenthesizedExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return current;
}

/** The text of a property name written as an identifier or a string literal, else null. */
export function propertyKey(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : null;
}
