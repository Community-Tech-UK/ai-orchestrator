import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { QueueJobPaths, packPrefix, resolveInside } from './queue-job-paths';

const paths = new QueueJobPaths(path.join(path.sep, 'tmp-root', 'orch'));

describe('QueueJobPaths', () => {
  it('puts every name under its own folder of the root', () => {
    expect(paths.bareRepo('proj-1')).toBe(path.join(paths.root, 'queue-repos', 'proj-1.git'));
    expect(paths.installedCheckout('proj-1')).toBe(path.join(paths.root, 'queue-repos', 'proj-1-installed'));
    expect(paths.jobFolder('queue/a-b/c')).toBe(path.join(paths.root, 'queue-worktrees', 'queue', 'a-b', 'c'));
    expect(paths.reportFile('job-1', 'turn-1')).toBe(path.join(paths.root, 'queue-reports', 'job-1', 'turn-1.json'));
  });

  it('refuses a name that could climb out of its folder, even when called without the wire schema', () => {
    expect(() => paths.bareRepo('../evil')).toThrow();
    expect(() => paths.jobFolder('queue/../../etc')).toThrow();
    expect(() => paths.jobFolder('main')).toThrow();
    expect(() => paths.planningFolder('a/b')).toThrow();
    expect(() => paths.reportFile('job-1', '../x')).toThrow();
    expect(() => paths.uploadDir('../up')).toThrow();
    expect(() => paths.packFile('x/../../y')).toThrow();
  });

  it('resolveInside refuses a path that leaves the folder or is the folder itself', () => {
    const base = path.join(paths.root, 'docs');
    expect(resolveInside(base, 'a/b.md')).toBe(path.join(base, 'a', 'b.md'));
    expect(resolveInside(base, '../x')).toBeNull();
    expect(resolveInside(base, 'a/../../x')).toBeNull();
    expect(resolveInside(base, '.')).toBeNull();
    expect(resolveInside(base, '..hidden/file')).toBe(path.join(base, '..hidden', 'file'));
  });

  it('gives a job a fixed-length pack prefix that differs between jobs', () => {
    expect(packPrefix('a')).toHaveLength(12);
    expect(packPrefix('a')).not.toBe(packPrefix('a-p'));
  });
});
