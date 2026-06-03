import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ensureProjectStoryDir,
  appendToStoryFile,
  extractAuthoredLessons,
} from '../project-story-convention';

describe('extractAuthoredLessons (A7#15)', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-lessons-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns null when the file does not exist', () => {
    expect(extractAuthoredLessons({ projectRoot: root })).toBeNull();
  });

  it('returns null for the untouched skeleton (only a placeholder comment)', () => {
    ensureProjectStoryDir({ projectRoot: root });
    expect(extractAuthoredLessons({ projectRoot: root })).toBeNull();
  });

  it('returns the authored content once a real entry is appended, stripped of skeleton comments', () => {
    ensureProjectStoryDir({ projectRoot: root });
    appendToStoryFile(
      'lessons.md',
      'BSD grep alternation',
      'macOS grep treats \\| literally; use ripgrep.',
      { projectRoot: root },
    );
    const lessons = extractAuthoredLessons({ projectRoot: root });
    expect(lessons).not.toBeNull();
    expect(lessons).toContain('BSD grep alternation');
    expect(lessons).toContain('use ripgrep');
    // skeleton HTML comment must be stripped
    expect(lessons).not.toContain('<!--');
    expect(lessons).not.toContain('Record surprising bugs');
  });
});
