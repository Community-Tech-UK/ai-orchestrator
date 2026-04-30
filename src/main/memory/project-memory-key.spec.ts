import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getProjectMemoryLookupKeys,
  normalizeProjectMemoryKey,
  projectMemoryKeysEqual,
  projectMemoryPathContains,
} from './project-memory-key';

describe('project-memory-key', () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const cleanupPath of cleanupPaths.splice(0)) {
      fs.rmSync(cleanupPath, { recursive: true, force: true });
    }
  });

  it('normalizes trailing separators', () => {
    expect(normalizeProjectMemoryKey('/tmp/project/')).toBe('/tmp/project');
  });

  it('resolves symlinks for existing project paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-memory-key-'));
    cleanupPaths.push(root);
    const realProject = path.join(root, 'real-project');
    const linkedProject = path.join(root, 'linked-project');
    fs.mkdirSync(realProject);
    fs.symlinkSync(realProject, linkedProject);

    expect(normalizeProjectMemoryKey(linkedProject)).toBe(normalizeProjectMemoryKey(realProject));
    expect(projectMemoryKeysEqual(linkedProject, realProject)).toBe(true);
  });

  it('keeps Windows-style paths case-insensitive without treating them as POSIX relatives', () => {
    expect(normalizeProjectMemoryKey('C:\\Users\\Alice\\Repo\\')).toBe('c:/users/alice/repo');
    expect(projectMemoryKeysEqual('C:\\Users\\Alice\\Repo', 'c:/users/alice/repo/')).toBe(true);
  });

  it('returns normalized and raw lookup keys for backward compatibility', () => {
    expect(getProjectMemoryLookupKeys('/tmp/project/')).toEqual(['/tmp/project', '/tmp/project/']);
  });

  it('checks whether a candidate path sits inside a project key', () => {
    expect(projectMemoryPathContains('/tmp/project/src/file.ts', '/tmp/project')).toBe(true);
    expect(projectMemoryPathContains('/tmp/project-other/src/file.ts', '/tmp/project')).toBe(false);
  });
});
