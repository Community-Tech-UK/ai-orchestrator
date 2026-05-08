import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards against accidental reintroduction of the deleted full-screen
 * `ModelPickerHostComponent`. The compact picker fully replaces it; any new
 * code that imports the old host or mounts `<app-model-picker-host>`
 * indicates a regression.
 */
describe('compact model picker migration', () => {
  const skipDirs = new Set(['node_modules', 'dist', 'out', '.git', 'coverage', 'docs', '.angular']);

  function* walk(dir: string): Generator<string> {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        if (skipDirs.has(entry)) continue;
        yield* walk(path);
      } else if (entry.endsWith('.ts') || entry.endsWith('.html')) {
        yield path;
      }
    }
  }

  function findReferences(needle: string): string[] {
    const offenders: string[] = [];
    for (const file of walk('src')) {
      // The migration test itself names the symbol — skip it to avoid a
      // self-match.
      if (file.endsWith('migration.spec.ts')) continue;
      const content = readFileSync(file, 'utf-8');
      if (content.includes(needle)) offenders.push(file);
    }
    return offenders;
  }

  it('no source file imports ModelPickerHostComponent', () => {
    expect(findReferences('ModelPickerHostComponent')).toEqual([]);
  });

  it('no template uses <app-model-picker-host>', () => {
    expect(findReferences('app-model-picker-host')).toEqual([]);
  });

  it('no source file imports the deleted file path', () => {
    expect(findReferences('model-picker-host.component')).toEqual([]);
  });
});
