import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sanitizeAttachmentFilename,
  dedupeFilenames,
  saveLoopAttachments,
  cleanupLoopAttachments,
  renderAttachmentBlock,
  ensureLoopAttachmentsIgnored,
  containsIgnore,
  LOOP_ATTACHMENT_ROOT,
} from './loop-attachments';

describe('sanitizeAttachmentFilename', () => {
  it('keeps simple filenames intact', () => {
    expect(sanitizeAttachmentFilename('foo.png')).toBe('foo.png');
  });

  it('strips path separators', () => {
    expect(sanitizeAttachmentFilename('../etc/passwd')).toBe('etc_passwd');
    expect(sanitizeAttachmentFilename('foo/bar.txt')).toBe('foo_bar.txt');
    expect(sanitizeAttachmentFilename('a\\b\\c.txt')).toBe('a_b_c.txt');
  });

  it('replaces spaces and special characters', () => {
    expect(sanitizeAttachmentFilename('my file (1).png')).toBe('my_file_1_.png');
  });

  it('collapses repeated underscores', () => {
    expect(sanitizeAttachmentFilename('weird   spaces.txt')).toBe('weird_spaces.txt');
  });

  it('strips leading dots to prevent dotfile creation', () => {
    expect(sanitizeAttachmentFilename('.env')).toBe('env');
    expect(sanitizeAttachmentFilename('...secret.png')).toBe('secret.png');
  });

  it('falls back to "file" when result is empty', () => {
    expect(sanitizeAttachmentFilename('!!!')).toBe('file');
    expect(sanitizeAttachmentFilename('')).toBe('file');
  });
});

describe('dedupeFilenames', () => {
  it('passes through unique names', () => {
    expect(dedupeFilenames(['a.png', 'b.png', 'c.png'])).toEqual(['a.png', 'b.png', 'c.png']);
  });

  it('appends index to colliding names before the extension', () => {
    expect(dedupeFilenames(['x.png', 'x.png', 'x.png'])).toEqual(['x.png', 'x_1.png', 'x_2.png']);
  });

  it('handles names without extensions', () => {
    expect(dedupeFilenames(['log', 'log', 'log'])).toEqual(['log', 'log_1', 'log_2']);
  });

  it('sanitizes before deduping', () => {
    expect(dedupeFilenames(['a b.txt', 'a b.txt'])).toEqual(['a_b.txt', 'a_b_1.txt']);
  });
});

describe('renderAttachmentBlock', () => {
  it('returns empty string for no attachments', () => {
    expect(renderAttachmentBlock([])).toBe('');
  });

  it('renders a header + bullet list', () => {
    const block = renderAttachmentBlock([
      { filename: 'a.png', relativePath: '.aio-loop-attachments/r1/a.png', size: 100, skipped: false },
      { filename: 'b.txt', relativePath: '.aio-loop-attachments/r1/b.txt', size: 50, skipped: false },
    ]);
    expect(block).toContain('Attached files');
    expect(block).toContain('- .aio-loop-attachments/r1/a.png');
    expect(block).toContain('- .aio-loop-attachments/r1/b.txt');
  });

  it('annotates skipped attachments', () => {
    const block = renderAttachmentBlock([
      { filename: 'huge.bin', relativePath: '.aio-loop-attachments/r1/huge.bin', size: 0, skipped: true },
    ]);
    expect(block).toContain('skipped: too large or unwritable');
  });
});

describe('containsIgnore', () => {
  it('detects exact match', () => {
    expect(containsIgnore('.aio-loop-attachments\nnode_modules\n', '.aio-loop-attachments')).toBe(true);
  });

  it('tolerates trailing slash', () => {
    expect(containsIgnore('.aio-loop-attachments/\n', '.aio-loop-attachments')).toBe(true);
  });

  it('tolerates leading slash', () => {
    expect(containsIgnore('/.aio-loop-attachments\n', '.aio-loop-attachments')).toBe(true);
  });

  it('ignores comments', () => {
    expect(containsIgnore('# .aio-loop-attachments\n', '.aio-loop-attachments')).toBe(false);
  });

  it('returns false when missing', () => {
    expect(containsIgnore('node_modules\ndist\n', '.aio-loop-attachments')).toBe(false);
  });

  it('handles empty content', () => {
    expect(containsIgnore('', '.aio-loop-attachments')).toBe(false);
  });
});

describe('saveLoopAttachments / cleanupLoopAttachments', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'loop-attachments-'));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('writes each attachment under .aio-loop-attachments/<runId>/', async () => {
    const data = new TextEncoder().encode('hello');
    const result = await saveLoopAttachments(workspace, 'run-1', [
      { name: 'foo.txt', data },
      { name: 'bar.png', data },
    ]);

    expect(result).toHaveLength(2);
    expect(result[0].skipped).toBe(false);
    expect(result[0].relativePath).toBe(`${LOOP_ATTACHMENT_ROOT}/run-1/foo.txt`);
    expect(result[1].relativePath).toBe(`${LOOP_ATTACHMENT_ROOT}/run-1/bar.png`);

    const fooPath = join(workspace, LOOP_ATTACHMENT_ROOT, 'run-1', 'foo.txt');
    const written = await readFile(fooPath);
    expect(written.toString('utf8')).toBe('hello');
  });

  it('sanitizes and dedupes filenames', async () => {
    const data = new TextEncoder().encode('x');
    const result = await saveLoopAttachments(workspace, 'run-2', [
      { name: '../etc/passwd', data },
      { name: 'a b.txt', data },
      { name: 'a b.txt', data },
    ]);

    expect(result[0].filename).toBe('etc_passwd');
    expect(result[1].filename).toBe('a_b.txt');
    expect(result[2].filename).toBe('a_b_1.txt');
  });

  it('removes the run folder on cleanup', async () => {
    const data = new TextEncoder().encode('x');
    await saveLoopAttachments(workspace, 'run-3', [{ name: 'foo.txt', data }]);
    const dir = join(workspace, LOOP_ATTACHMENT_ROOT, 'run-3');
    await expect(stat(dir)).resolves.toBeDefined();

    await cleanupLoopAttachments(workspace, 'run-3');
    await expect(stat(dir)).rejects.toThrow();
  });

  it('cleanup is idempotent / silent when folder missing', async () => {
    await expect(cleanupLoopAttachments(workspace, 'never-existed')).resolves.toBeUndefined();
  });
});

describe('ensureLoopAttachmentsIgnored', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'loop-gitignore-'));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('creates .gitignore when missing', async () => {
    await ensureLoopAttachmentsIgnored(workspace);
    const content = await readFile(join(workspace, '.gitignore'), 'utf8');
    expect(content).toContain(`${LOOP_ATTACHMENT_ROOT}/`);
  });

  it('appends to existing .gitignore', async () => {
    await writeFile(join(workspace, '.gitignore'), 'node_modules\n');
    await ensureLoopAttachmentsIgnored(workspace);
    const content = await readFile(join(workspace, '.gitignore'), 'utf8');
    expect(content).toContain('node_modules');
    expect(content).toContain(`${LOOP_ATTACHMENT_ROOT}/`);
  });

  it('is idempotent', async () => {
    await writeFile(join(workspace, '.gitignore'), `${LOOP_ATTACHMENT_ROOT}/\n`);
    await ensureLoopAttachmentsIgnored(workspace);
    const content = await readFile(join(workspace, '.gitignore'), 'utf8');
    // Should still appear exactly once.
    const matches = content.match(new RegExp(`${LOOP_ATTACHMENT_ROOT}`, 'g'));
    expect(matches).toHaveLength(1);
  });

  it('inserts a leading newline when existing file lacks trailing newline', async () => {
    await writeFile(join(workspace, '.gitignore'), 'dist');
    await ensureLoopAttachmentsIgnored(workspace);
    const content = await readFile(join(workspace, '.gitignore'), 'utf8');
    expect(content.startsWith('dist\n')).toBe(true);
    expect(content).toContain(`${LOOP_ATTACHMENT_ROOT}/`);
  });
});

it('saveLoopAttachments cleanup integration via parent rm', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'loop-attachments-cleanup-'));
  try {
    const data = new TextEncoder().encode('x');
    await saveLoopAttachments(workspace, 'run-x', [{ name: 'foo.txt', data }]);
    await mkdir(join(workspace, LOOP_ATTACHMENT_ROOT, 'other-run'), { recursive: true });
    await cleanupLoopAttachments(workspace, 'run-x');
    // Sibling runs are not touched.
    await expect(stat(join(workspace, LOOP_ATTACHMENT_ROOT, 'other-run'))).resolves.toBeDefined();
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
