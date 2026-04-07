import { describe, expect, it } from 'vitest';
import type {
  FsEntry,
  FsReadDirectoryParams,
  FsErrorData,
  DiscoveredProject,
} from './remote-fs.types';

describe('remote-fs types', () => {
  it('FsEntry satisfies expected shape', () => {
    const entry: FsEntry = {
      name: 'src',
      path: '/home/user/project/src',
      isDirectory: true,
      isSymlink: false,
      size: 0,
      modifiedAt: 1700000000000,
      ignored: false,
      restricted: false,
    };

    expect(entry.name).toBe('src');
    expect(entry.isDirectory).toBe(true);
    expect(entry.isSymlink).toBe(false);
    expect(entry.ignored).toBe(false);
    expect(entry.restricted).toBe(false);
    expect(entry.extension).toBeUndefined();
    expect(entry.children).toBeUndefined();
  });

  it('FsReadDirectoryParams accepts defaults (only path required)', () => {
    const params: FsReadDirectoryParams = { path: '/home/user/project' };

    expect(params.path).toBe('/home/user/project');
    expect(params.depth).toBeUndefined();
    expect(params.includeHidden).toBeUndefined();
    expect(params.cursor).toBeUndefined();
    expect(params.limit).toBeUndefined();
  });

  it('FsErrorData satisfies expected shape', () => {
    const err: FsErrorData = {
      fsCode: 'EACCES',
      path: '/etc/shadow',
      retryable: false,
      suggestion: 'Check file permissions',
    };

    expect(err.fsCode).toBe('EACCES');
    expect(err.path).toBe('/etc/shadow');
    expect(err.retryable).toBe(false);
    expect(err.suggestion).toBe('Check file permissions');
  });

  it('DiscoveredProject satisfies expected shape', () => {
    const project: DiscoveredProject = {
      path: '/home/user/my-app',
      name: 'my-app',
      markers: ['package.json', '.git'],
    };

    expect(project.path).toBe('/home/user/my-app');
    expect(project.name).toBe('my-app');
    expect(project.markers).toHaveLength(2);
    expect(project.markers).toContain('package.json');
  });
});
