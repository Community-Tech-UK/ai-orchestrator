import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  ensureProjectStoryDir,
  appendToStoryFile,
  readStoryFile,
} from '../project-story-convention';

describe('project-story-convention', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-story-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates .aio/ with three skeleton files', () => {
    const aioDir = ensureProjectStoryDir({ projectRoot: tmpDir });
    expect(aioDir).toBe(path.join(tmpDir, '.aio'));
    for (const f of ['decisions.md', 'lessons.md', 'handovers.md']) {
      expect(fs.existsSync(path.join(aioDir, f))).toBe(true);
    }
    const decisions = fs.readFileSync(path.join(aioDir, 'decisions.md'), 'utf-8');
    expect(decisions).toContain('# Architectural Decisions');
  });

  it('is idempotent and does not overwrite existing files by default', () => {
    const aioDir = ensureProjectStoryDir({ projectRoot: tmpDir });
    fs.writeFileSync(path.join(aioDir, 'decisions.md'), 'CUSTOM');
    ensureProjectStoryDir({ projectRoot: tmpDir });
    expect(fs.readFileSync(path.join(aioDir, 'decisions.md'), 'utf-8')).toBe('CUSTOM');
  });

  it('appendToStoryFile adds a timestamped entry', () => {
    ensureProjectStoryDir({ projectRoot: tmpDir });
    appendToStoryFile('lessons.md', 'Learned X', 'Body details.', { projectRoot: tmpDir });
    const contents = readStoryFile('lessons.md', { projectRoot: tmpDir });
    expect(contents).toContain('— Learned X');
    expect(contents).toContain('Body details.');
  });

  it('readStoryFile returns null when no file', () => {
    expect(readStoryFile('decisions.md', { projectRoot: tmpDir })).toBeNull();
  });
});
