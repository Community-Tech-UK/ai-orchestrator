import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('agent instruction pointers', () => {
  it('resolves every concrete docs path and CLAUDE import', () => {
    const root = resolve(__dirname, '../..');
    const missing: string[] = [];
    for (const file of ['AGENTS.md', 'CLAUDE.md']) {
      const text = readFileSync(resolve(root, file), 'utf8');
      const paths = [...text.matchAll(/\bdocs\/[\w./*-]+\.md\b/g)].map((m) => m[0]);
      if (file === 'CLAUDE.md') paths.push(...[...text.matchAll(/^@([^\s]+)$/gm)].map((m) => m[1]));
      for (const path of paths.filter((p) => !p.includes('*'))) {
        if (!existsSync(resolve(root, path))) missing.push(`${file}: ${path}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
