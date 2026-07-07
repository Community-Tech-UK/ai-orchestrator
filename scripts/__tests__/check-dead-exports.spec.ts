import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface FileFixture {
  path: string;
  content: string;
}

interface DeadHelperCandidate {
  kind: string;
  name: string;
  path: string;
  line: number;
}

interface DeadHelperBaselineEntry {
  kind: string;
  name: string;
  path: string;
}

interface CheckDeadExportsModule {
  collectDeadHelperCandidates(files: FileFixture[]): DeadHelperCandidate[];
  filterBaselinedCandidates(
    candidates: DeadHelperCandidate[],
    baseline?: DeadHelperBaselineEntry[],
  ): DeadHelperCandidate[];
}

const { collectDeadHelperCandidates, filterBaselinedCandidates } = require('../check-dead-exports.js') as CheckDeadExportsModule;

describe('collectDeadHelperCandidates', () => {
  it('flags unreferenced module reset helpers and convenience getters', () => {
    const candidates = collectDeadHelperCandidates([
      {
        path: 'src/main/foo.ts',
        content: [
          'export function _resetFooForTesting(): void {}',
          'export function getFoo(): Foo { return Foo.getInstance(); }',
          'export class Bar { static _resetForTesting(): void {} }',
        ].join('\n'),
      },
    ]);

    expect(candidates.map((candidate) => candidate.name).sort()).toEqual([
      'Bar._resetForTesting',
      '_resetFooForTesting',
      'getFoo',
    ].sort());
  });

  it('does not flag helpers with references', () => {
    const candidates = collectDeadHelperCandidates([
      {
        path: 'src/main/foo.ts',
        content: [
          'export function _resetFooForTesting(): void {}',
          'export function getFoo(): Foo { return Foo.getInstance(); }',
          'export class Bar { static _resetForTesting(): void {} }',
        ].join('\n'),
      },
      {
        path: 'src/main/foo.spec.ts',
        content: [
          '_resetFooForTesting();',
          'getFoo();',
          'Bar._resetForTesting();',
        ].join('\n'),
      },
    ]);

    expect(candidates).toEqual([]);
  });

  it('filters candidates already captured in the baseline', () => {
    const candidates = [
      {
        kind: 'static-reset-helper',
        name: 'Known._resetForTesting',
        path: 'src/main/known.ts',
        line: 10,
      },
      {
        kind: 'module-reset-helper',
        name: '_resetNewForTesting',
        path: 'src/main/new.ts',
        line: 5,
      },
    ];

    expect(
      filterBaselinedCandidates(candidates, [
        {
          kind: 'static-reset-helper',
          name: 'Known._resetForTesting',
          path: 'src/main/known.ts',
        },
      ]),
    ).toEqual([
      {
        kind: 'module-reset-helper',
        name: '_resetNewForTesting',
        path: 'src/main/new.ts',
        line: 5,
      },
    ]);
  });
});
