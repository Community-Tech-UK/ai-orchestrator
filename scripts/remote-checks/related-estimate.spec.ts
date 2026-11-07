import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { estimateRelatedSpecs } = require('./related-estimate.js') as {
  estimateRelatedSpecs(root: string, changed: string[]): number;
};

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'related-estimate-'));
  temps.push(root);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  return root;
}

describe('estimateRelatedSpecs', () => {
  it('follows imports backwards through other files to the specs', () => {
    const root = project({
      'src/base.ts': 'export const a = 1;\n',
      'src/middle.ts': "export { a } from './base';\n",
      'src/top.ts': "import { a } from './middle.js';\n",
      'src/top.spec.ts': "import './top';\n",
      'src/other.spec.ts': "import x from 'vitest';\n",
    });
    expect(estimateRelatedSpecs(root, ['src/base.ts'])).toBe(1);
  });

  it('understands aliases, dynamic imports, require and mocks', () => {
    const root = project({
      'tsconfig.json': `{
        // a comment, so this isn't strict JSON
        "compilerOptions": { "paths": { "@shared/*": ["./src/shared/*"], "@one": ["./src/one/index"] } }
      }`,
      'src/shared/a.ts': '',
      'src/one/index.ts': "import '@shared/a';\n",
      'src/alias.spec.ts': "import '@shared/a';\n",
      'src/exact.spec.ts': "import '@one';\n",
      'src/dynamic.spec.ts': "await import('./shared/a');\n",
      'src/require.spec.ts': "require('./shared/a');\n",
      'src/mock.spec.ts': "vi.mock('./shared/a');\n",
    });
    expect(estimateRelatedSpecs(root, ['src/shared/a.ts'])).toBe(5);
  });

  it('counts a changed spec itself, once, and copes with an import loop', () => {
    const root = project({
      'src/a.ts': "import './b';\n",
      'src/b.ts': "import './a';\n",
      'src/a.spec.ts': "import './a';\n",
    });
    expect(estimateRelatedSpecs(root, ['src/a.spec.ts', 'src/a.ts'])).toBe(1);
  });

  it('finds nothing for a file no spec reaches', () => {
    const root = project({ 'src/a.ts': '', 'src/b.spec.ts': '' });
    expect(estimateRelatedSpecs(root, ['src/a.ts'])).toBe(0);
  });
});
