import { describe, expect, it } from 'vitest';
import {
  REQUIRED_SYNC_POINTS,
  discoverSchemaSubpathsFromExports,
  findMissingAliases,
  stripComments,
  type AliasSyncFile,
} from '../check-contracts-aliases';

function filesWithAlias(alias: string): AliasSyncFile[] {
  return REQUIRED_SYNC_POINTS.map((path) => ({
    path,
    content: `const alias = '${alias}';\n`,
  }));
}

describe('contracts schema alias sync auditor', () => {
  it('discovers schema subpaths from package exports only', () => {
    expect(discoverSchemaSubpathsFromExports({
      './schemas/common': {},
      './channels/instance': {},
      './schemas/prompt-history': {},
      './types/transport': {},
    })).toEqual(['common', 'prompt-history']);
  });

  it('detects a missing alias in tsconfig.json', () => {
    const alias = '@contracts/schemas/foo';
    const files = filesWithAlias(alias).map((file) =>
      file.path === 'tsconfig.json' ? { ...file, content: '{}' } : file,
    );

    expect(findMissingAliases(['foo'], files)).toEqual([
      expect.objectContaining({ file: 'tsconfig.json', expected: alias }),
    ]);
  });

  it('detects a missing alias in tsconfig.electron.json', () => {
    const alias = '@contracts/schemas/foo';
    const files = filesWithAlias(alias).map((file) =>
      file.path === 'tsconfig.electron.json' ? { ...file, content: '{}' } : file,
    );

    expect(findMissingAliases(['foo'], files)).toEqual([
      expect.objectContaining({ file: 'tsconfig.electron.json', expected: alias }),
    ]);
  });

  it('detects a missing alias in register-aliases.ts', () => {
    const alias = '@contracts/schemas/foo';
    const files = filesWithAlias(alias).map((file) =>
      file.path === 'src/main/register-aliases.ts' ? { ...file, content: '{}' } : file,
    );

    expect(findMissingAliases(['foo'], files)).toEqual([
      expect.objectContaining({ file: 'src/main/register-aliases.ts', expected: alias }),
    ]);
  });

  it('detects a missing alias in vitest.config.ts', () => {
    const alias = '@contracts/schemas/foo';
    const files = filesWithAlias(alias).map((file) =>
      file.path === 'vitest.config.ts' ? { ...file, content: '{}' } : file,
    );

    expect(findMissingAliases(['foo'], files)).toEqual([
      expect.objectContaining({ file: 'vitest.config.ts', expected: alias }),
    ]);
  });

  it('passes when all four sync points contain the alias', () => {
    expect(findMissingAliases(['foo'], filesWithAlias('@contracts/schemas/foo'))).toEqual([]);
  });

  it('ignores commented-out references', () => {
    const files = REQUIRED_SYNC_POINTS.map((path) => ({
      path,
      content: `// @contracts/schemas/foo\n/* @contracts/schemas/foo */\n`,
    }));

    expect(findMissingAliases(['foo'], files)).toHaveLength(REQUIRED_SYNC_POINTS.length);
  });

  it('strips line and block comments', () => {
    expect(stripComments([
      'const live = "@contracts/schemas/foo";',
      '// const dead = "@contracts/schemas/bar";',
      '/* const dead2 = "@contracts/schemas/baz"; */',
    ].join('\n'))).toContain('@contracts/schemas/foo');
    expect(stripComments('// @contracts/schemas/foo')).not.toContain('@contracts/schemas/foo');
    expect(stripComments('/* @contracts/schemas/foo */')).not.toContain('@contracts/schemas/foo');
  });

  it('preserves wildcard path aliases while stripping real comments', () => {
    const content = [
      '"@shared/*": ["./src/shared/*"],',
      '"@contracts/schemas/foo": ["./packages/contracts/src/schemas/foo.schemas"],',
      '// "@contracts/schemas/bar": ["./packages/contracts/src/schemas/bar.schemas"],',
    ].join('\n');

    const stripped = stripComments(content);
    expect(stripped).toContain('@shared/*');
    expect(stripped).toContain('@contracts/schemas/foo');
    expect(stripped).not.toContain('@contracts/schemas/bar');
  });
});
