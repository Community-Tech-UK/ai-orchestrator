import { describe, expect, it } from 'vitest';
import {
  extractFileOperations,
  extractFileOperationsFromTurns,
  summarizeFileOperations,
} from './file-operation-extractor';

describe('file-operation-extractor', () => {
  it('extracts common tool-style file operations with kinds and first-seen dedupe', () => {
    const input = [
      'Read file_path=src/main/context/context-compactor.ts',
      'Edit file_path=src/main/context/context-compactor.ts',
      'Edit file_path=src/main/context/context-compactor.ts',
      'Write path=docs/loop-notes.md',
    ].join('\n');

    expect(extractFileOperations(input)).toEqual([
      {
        kind: 'read',
        path: 'src/main/context/context-compactor.ts',
        source: 'tool-call',
      },
      {
        kind: 'edit',
        path: 'src/main/context/context-compactor.ts',
        source: 'tool-call',
      },
      {
        kind: 'write',
        path: 'docs/loop-notes.md',
        source: 'tool-call',
      },
    ]);
  });

  it('extracts shell command file operations without treating flags as paths', () => {
    const input = [
      'rm src/obsolete.ts',
      'mv src/old-name.ts src/new-name.ts',
      'cp src/template.ts src/copied.ts',
      'git diff -- src/main/context/context-compactor.ts',
      'node scripts/build-report.js',
    ].join('\n');

    expect(extractFileOperations(input)).toEqual([
      { kind: 'delete', path: 'src/obsolete.ts', source: 'tool-output' },
      { kind: 'move', path: 'src/new-name.ts', source: 'tool-output' },
      { kind: 'write', path: 'src/copied.ts', source: 'tool-output' },
      {
        kind: 'read',
        path: 'src/main/context/context-compactor.ts',
        source: 'tool-output',
      },
      { kind: 'execute', path: 'scripts/build-report.js', source: 'tool-output' },
    ]);
  });

  it('extracts assistant prose mentions only when a file operation verb is nearby', () => {
    const input = [
      'I edited src/main/context/context-compaction-prompt.ts and updated tests.',
      'Email james@example.com about the release.',
      'The route /api/users is not a file path.',
    ].join('\n');

    expect(extractFileOperations(input)).toEqual([
      {
        kind: 'edit',
        path: 'src/main/context/context-compaction-prompt.ts',
        source: 'assistant-text',
      },
    ]);
  });

  it('summarizes operations with a stable count cap', () => {
    const operations = extractFileOperations([
      'Read src/main/a.ts',
      'Edit src/main/b.ts',
      'Write src/main/c.ts',
      'rm src/main/d.ts',
      'node scripts/e.ts',
    ].join('\n'));

    expect(summarizeFileOperations(operations, 3)).toBe([
      '- read: src/main/a.ts (tool-call)',
      '- edit: src/main/b.ts (tool-call)',
      '- write: src/main/c.ts (tool-call)',
      '- ...and 2 more file operation(s)',
    ].join('\n'));
  });

  it('does not treat user-requested paths as observed operations for turns', () => {
    expect(extractFileOperationsFromTurns([
      {
        role: 'user',
        content: 'Please update src/requested-only.ts before you finish.',
      },
      {
        role: 'assistant',
        content: 'I updated src/main/context/context-compactor.ts.',
      },
    ])).toEqual([
      {
        kind: 'edit',
        path: 'src/main/context/context-compactor.ts',
        source: 'assistant-text',
      },
    ]);
  });

  it('does not treat assistant future intent as an observed file operation', () => {
    expect(extractFileOperationsFromTurns([
      {
        role: 'assistant',
        content: 'Next I will update src/not-yet-edited.ts after reading the tests.',
      },
    ])).toEqual([]);
  });

  it('keeps completed assistant operations when future intent appears later', () => {
    expect(extractFileOperationsFromTurns([
      {
        role: 'assistant',
        content: 'I updated src/already-edited.ts and will run tests next.',
      },
    ])).toEqual([
      { kind: 'edit', path: 'src/already-edited.ts', source: 'assistant-text' },
    ]);
  });

  it('attributes operations inferred from tool output as tool-output', () => {
    expect(extractFileOperationsFromTurns([
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            name: 'Edit',
            input: '{"file_path":"src/input.ts"}',
            output: 'Updated src/output.ts',
          },
        ],
      },
    ])).toEqual([
      { kind: 'edit', path: 'src/input.ts', source: 'tool-call' },
      { kind: 'edit', path: 'src/output.ts', source: 'tool-output' },
    ]);
  });

  it('extracts common extensionless project files', () => {
    expect(extractFileOperations('Write Dockerfile\nEdit config/Makefile')).toEqual([
      { kind: 'write', path: 'Dockerfile', source: 'tool-call' },
      { kind: 'edit', path: 'config/Makefile', source: 'tool-call' },
    ]);
  });
});
