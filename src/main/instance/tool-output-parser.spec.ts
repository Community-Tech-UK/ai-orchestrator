import { describe, expect, it } from 'vitest';
import { extractFilePaths } from './tool-output-parser';
import type { OutputMessage } from '../../shared/types/instance.types';

const WD = '/home/user/project';

function makeMessage(
  type: OutputMessage['type'],
  name: string,
  input: Record<string, unknown>
): OutputMessage {
  return {
    id: '1',
    timestamp: Date.now(),
    type,
    content: '',
    metadata: { name, input },
  };
}

function toolUse(name: string, input: Record<string, unknown>): OutputMessage {
  return makeMessage('tool_use', name, input);
}

function toolResult(name: string, input: Record<string, unknown>): OutputMessage {
  return makeMessage('tool_result', name, input);
}

// ---------------------------------------------------------------------------
// Claude provider
// ---------------------------------------------------------------------------

describe('Claude provider', () => {
  it('extracts file_path from Write', () => {
    const msg = toolUse('Write', {
      file_path: `${WD}/src/main.ts`,
      content: 'hello',
    });
    expect(extractFilePaths(msg, WD, 'claude')).toEqual([`${WD}/src/main.ts`]);
  });

  it('extracts file_path from Write tool_result messages', () => {
    const msg = toolResult('Write', {
      file_path: `${WD}/src/tool-result.ts`,
      content: 'updated',
    });
    expect(extractFilePaths(msg, WD, 'claude')).toEqual([`${WD}/src/tool-result.ts`]);
  });

  it('extracts file_path from Edit', () => {
    const msg = toolUse('Edit', {
      file_path: `${WD}/src/util.ts`,
      old_string: 'a',
      new_string: 'b',
    });
    expect(extractFilePaths(msg, WD, 'claude')).toEqual([`${WD}/src/util.ts`]);
  });

  it('extracts file_paths from MultiEdit', () => {
    const msg = toolUse('MultiEdit', {
      edits: [
        { file_path: `${WD}/a.ts`, old_string: 'x', new_string: 'y' },
        { file_path: `${WD}/b.ts`, old_string: 'p', new_string: 'q' },
      ],
    });
    const result = extractFilePaths(msg, WD, 'claude');
    expect(result).toContain(`${WD}/a.ts`);
    expect(result).toContain(`${WD}/b.ts`);
    expect(result).toHaveLength(2);
  });

  it('extracts redirect target from Bash >', () => {
    const msg = toolUse('Bash', {
      command: `echo hello > ${WD}/out.txt`,
    });
    expect(extractFilePaths(msg, WD, 'claude')).toContain(`${WD}/out.txt`);
  });

  it('extracts append redirect target from Bash >>', () => {
    const msg = toolUse('Bash', {
      command: `echo line >> ${WD}/log.txt`,
    });
    expect(extractFilePaths(msg, WD, 'claude')).toContain(`${WD}/log.txt`);
  });

  it('extracts tee target from Bash', () => {
    const msg = toolUse('Bash', {
      command: `cat /dev/stdin | tee ${WD}/out.txt`,
    });
    expect(extractFilePaths(msg, WD, 'claude')).toContain(`${WD}/out.txt`);
  });

  it('extracts sed -i target from Bash', () => {
    const msg = toolUse('Bash', {
      command: `sed -i 's/foo/bar/' ${WD}/config.cfg`,
    });
    expect(extractFilePaths(msg, WD, 'claude')).toContain(`${WD}/config.cfg`);
  });

  it('ignores Read tool', () => {
    const msg = toolUse('Read', { file_path: `${WD}/src/main.ts` });
    expect(extractFilePaths(msg, WD, 'claude')).toEqual([]);
  });

  it('ignores Glob tool', () => {
    const msg = toolUse('Glob', { pattern: '**/*.ts' });
    expect(extractFilePaths(msg, WD, 'claude')).toEqual([]);
  });

  it('ignores Grep tool', () => {
    const msg = toolUse('Grep', { pattern: 'foo', path: WD });
    expect(extractFilePaths(msg, WD, 'claude')).toEqual([]);
  });

  it('ignores WebSearch tool', () => {
    const msg = toolUse('WebSearch', { query: 'typescript' });
    expect(extractFilePaths(msg, WD, 'claude')).toEqual([]);
  });

  it('ignores Agent tool', () => {
    const msg = toolUse('Agent', { prompt: 'do something' });
    expect(extractFilePaths(msg, WD, 'claude')).toEqual([]);
  });

  it('ignores TodoWrite tool', () => {
    const msg = toolUse('TodoWrite', { todos: [] });
    expect(extractFilePaths(msg, WD, 'claude')).toEqual([]);
  });

  it('ignores LS tool', () => {
    const msg = toolUse('LS', { path: WD });
    expect(extractFilePaths(msg, WD, 'claude')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Codex provider
// ---------------------------------------------------------------------------

describe('Codex provider', () => {
  it('extracts path from write_file', () => {
    const msg = toolUse('write_file', {
      path: `${WD}/dist/bundle.js`,
      content: '// code',
    });
    expect(extractFilePaths(msg, WD, 'codex')).toEqual([`${WD}/dist/bundle.js`]);
  });

  it('extracts destination paths from apply_patch', () => {
    const patch = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      'index abc..def 100644',
      '--- a/src/foo.ts',
      `+++ b/src/foo.ts`,
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
    ].join('\n');
    const msg = toolUse('apply_patch', { patch });
    // The +++ line has 'src/foo.ts' which is relative – should resolve inside WD
    const result = extractFilePaths(msg, WD, 'codex');
    expect(result).toContain(`${WD}/src/foo.ts`);
  });

  it('extracts redirect target from shell command', () => {
    const msg = toolUse('shell', {
      command: `echo data >> ${WD}/output.log`,
    });
    expect(extractFilePaths(msg, WD, 'codex')).toContain(`${WD}/output.log`);
  });

  it('ignores read_file tool', () => {
    const msg = toolUse('read_file', { path: `${WD}/src/main.ts` });
    expect(extractFilePaths(msg, WD, 'codex')).toEqual([]);
  });

  it('ignores list_dir tool', () => {
    const msg = toolUse('list_dir', { path: WD });
    expect(extractFilePaths(msg, WD, 'codex')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Gemini provider
// ---------------------------------------------------------------------------

describe('Gemini provider', () => {
  it('extracts path from edit_file', () => {
    const msg = toolUse('edit_file', {
      path: `${WD}/lib/helper.ts`,
      content: 'updated',
    });
    expect(extractFilePaths(msg, WD, 'gemini')).toEqual([`${WD}/lib/helper.ts`]);
  });

  it('extracts path from write_file', () => {
    const msg = toolUse('write_file', {
      path: `${WD}/lib/new.ts`,
      content: 'fresh',
    });
    expect(extractFilePaths(msg, WD, 'gemini')).toEqual([`${WD}/lib/new.ts`]);
  });

  it('extracts mv destination from shell command', () => {
    const msg = toolUse('shell', {
      command: `mv ${WD}/old.ts ${WD}/new.ts`,
    });
    expect(extractFilePaths(msg, WD, 'gemini')).toContain(`${WD}/new.ts`);
  });
});

// ---------------------------------------------------------------------------
// Copilot provider
// ---------------------------------------------------------------------------

describe('Copilot provider', () => {
  it('extracts path from editFile', () => {
    const msg = toolUse('editFile', {
      path: `${WD}/pages/index.tsx`,
      content: 'jsx here',
    });
    expect(extractFilePaths(msg, WD, 'copilot')).toEqual([`${WD}/pages/index.tsx`]);
  });

  it('extracts path from createFile', () => {
    const msg = toolUse('createFile', {
      path: `${WD}/pages/about.tsx`,
      content: 'about page',
    });
    expect(extractFilePaths(msg, WD, 'copilot')).toEqual([`${WD}/pages/about.tsx`]);
  });

  it('extracts cp destination from runCommand', () => {
    const msg = toolUse('runCommand', {
      command: `cp ${WD}/template.ts ${WD}/pages/copy.tsx`,
    });
    expect(extractFilePaths(msg, WD, 'copilot')).toContain(`${WD}/pages/copy.tsx`);
  });

  it('ignores readFile tool', () => {
    const msg = toolUse('readFile', { path: `${WD}/pages/index.tsx` });
    expect(extractFilePaths(msg, WD, 'copilot')).toEqual([]);
  });

  it('ignores listFiles tool', () => {
    const msg = toolUse('listFiles', { path: WD });
    expect(extractFilePaths(msg, WD, 'copilot')).toEqual([]);
  });

  it('ignores searchFiles tool', () => {
    const msg = toolUse('searchFiles', { pattern: '*.ts', path: WD });
    expect(extractFilePaths(msg, WD, 'copilot')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting concerns
// ---------------------------------------------------------------------------

describe('Cross-cutting', () => {
  it('returns empty array for non-tool_use messages (assistant)', () => {
    const msg: OutputMessage = {
      id: '2',
      timestamp: Date.now(),
      type: 'assistant',
      content: 'I will write a file',
      metadata: { name: 'Write', input: { file_path: `${WD}/src/main.ts` } },
    };
    expect(extractFilePaths(msg, WD, 'claude')).toEqual([]);
  });

  it('extracts file paths from tool_result messages', () => {
    const msg: OutputMessage = {
      id: '3',
      timestamp: Date.now(),
      type: 'tool_result',
      content: 'done',
      metadata: { name: 'Write', input: { file_path: `${WD}/src/main.ts` } },
    };
    expect(extractFilePaths(msg, WD, 'claude')).toEqual([`${WD}/src/main.ts`]);
  });

  it('returns empty array for system messages', () => {
    const msg: OutputMessage = {
      id: '4',
      timestamp: Date.now(),
      type: 'system',
      content: 'system info',
    };
    expect(extractFilePaths(msg, WD, 'claude')).toEqual([]);
  });

  it('returns empty array for user messages', () => {
    const msg: OutputMessage = {
      id: '5',
      timestamp: Date.now(),
      type: 'user',
      content: 'please write a file',
    };
    expect(extractFilePaths(msg, WD, 'claude')).toEqual([]);
  });

  it('filters out paths outside the working directory', () => {
    const msg = toolUse('Write', {
      file_path: '/etc/passwd',
      content: 'evil',
    });
    expect(extractFilePaths(msg, WD, 'claude')).toEqual([]);
  });

  it('filters bash redirect targeting code outside working directory', () => {
    const msg = toolUse('Bash', {
      command: 'echo data > /tmp/outside.ts',
    });
    expect(extractFilePaths(msg, WD, 'claude')).toEqual([]);
  });

  it('allows document artifacts outside the working directory', () => {
    const msg = toolUse('Bash', {
      command: 'echo notes > /tmp/review.md',
    });
    expect(extractFilePaths(msg, WD, 'claude')).toEqual(['/tmp/review.md']);
  });

  it('resolves relative paths against the working directory', () => {
    const msg = toolUse('Write', {
      file_path: 'src/relative.ts',
      content: 'hello',
    });
    expect(extractFilePaths(msg, WD, 'claude')).toEqual([`${WD}/src/relative.ts`]);
  });

  it('deduplicates identical paths', () => {
    const msg = toolUse('MultiEdit', {
      edits: [
        { file_path: `${WD}/src/dup.ts`, old_string: 'a', new_string: 'b' },
        { file_path: `${WD}/src/dup.ts`, old_string: 'c', new_string: 'd' },
      ],
    });
    expect(extractFilePaths(msg, WD, 'claude')).toHaveLength(1);
  });

  it('returns empty array when metadata is absent', () => {
    const msg: OutputMessage = {
      id: '6',
      timestamp: Date.now(),
      type: 'tool_use',
      content: '',
    };
    expect(extractFilePaths(msg, WD, 'claude')).toEqual([]);
  });

  it('uses generic fallback for unknown provider', () => {
    const msg = toolUse('custom_write', {
      file_path: `${WD}/src/custom.ts`,
    });
    expect(extractFilePaths(msg, WD, 'unknown-provider')).toContain(
      `${WD}/src/custom.ts`
    );
  });

  it('uses generic fallback for unknown provider with path field', () => {
    const msg = toolUse('file_op', {
      path: `${WD}/output.txt`,
    });
    expect(extractFilePaths(msg, WD, 'unknown-provider')).toContain(
      `${WD}/output.txt`
    );
  });
});
