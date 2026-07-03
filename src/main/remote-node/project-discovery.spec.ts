import { describe, it, expect, beforeEach, vi } from 'vitest';

// `vi.hoisted` so the mock factory (hoisted above declarations) can reference it.
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}));

// Mock the logger to avoid electron / filesystem dependencies
vi.mock('../logging/logger', () => ({
  getLogger: () => mockLogger,
}));

// Mock fs/promises before importing the module under test
vi.mock('node:fs/promises');

import fs from 'node:fs/promises';
import { ProjectDiscovery } from './project-discovery';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockDirent {
  name: string;
  isDirectory: () => boolean;
  isSymbolicLink: () => boolean;
}

function makeDir(name: string): MockDirent {
  return { name, isDirectory: () => true, isSymbolicLink: () => false };
}

function makeFile(name: string): MockDirent {
  return { name, isDirectory: () => false, isSymbolicLink: () => false };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProjectDiscovery', () => {
  let discovery: ProjectDiscovery;
  const mockReaddir = vi.mocked(fs.readdir);

  beforeEach(() => {
    discovery = new ProjectDiscovery();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Test 1: Discovers projects with .git marker
  // -------------------------------------------------------------------------

  it('discovers projects with .git marker', async () => {
    // Root: /home returns one directory 'my-app'
    // /home/my-app: contains '.git' and 'package.json'
    mockReaddir.mockImplementation(async (dirPath: unknown) => {
      if (dirPath === '/home') {
        return [makeDir('my-app')] as never;
      }
      if (dirPath === '/home/my-app') {
        return [makeFile('.git'), makeFile('package.json')] as never;
      }
      return [] as never;
    });

    const results = await discovery.scan(['/home']);

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('my-app');
    expect(results[0].path).toBe('/home/my-app');
    expect(results[0].markers).toContain('.git');
    expect(results[0].markers).toContain('package.json');
  });

  // -------------------------------------------------------------------------
  // Test 2: Skips node_modules and .git directories
  // -------------------------------------------------------------------------

  it('skips node_modules and .git directories', async () => {
    mockReaddir.mockImplementation(async (dirPath: unknown) => {
      if (dirPath === '/home') {
        return [makeDir('node_modules'), makeDir('.git')] as never;
      }
      return [] as never;
    });

    const results = await discovery.scan(['/home']);

    expect(results).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Test 3: Respects max depth of 4
  // -------------------------------------------------------------------------

  it('respects max depth of 4 (no more than 5 readdir calls)', async () => {
    // Every directory always has one subdirectory called 'sub'
    // so without a depth limit this would recurse forever.
    // With MAX_DEPTH=4, readdir should be called at depths 0–4 = 5 calls max.
    mockReaddir.mockImplementation(async () => {
      return [makeDir('sub')] as never;
    });

    await discovery.scan(['/root']);

    expect(mockReaddir).toHaveBeenCalledTimes(5);
  });

  // -------------------------------------------------------------------------
  // Test 4: Permission-denied dirs are logged at debug, not warn
  // -------------------------------------------------------------------------

  it('logs expected permission/missing errors at debug, not warn', async () => {
    for (const code of ['EPERM', 'EACCES', 'ENOENT', 'ENOTDIR', 'ELOOP']) {
      mockReaddir.mockImplementationOnce(async () => {
        const err = new Error(`${code}: nope`) as NodeJS.ErrnoException;
        err.code = code;
        throw err;
      });
      await discovery.scan([`/locked-${code}`]);
    }

    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Skipping unreadable directory during scan',
      expect.objectContaining({ code: 'EPERM' }),
    );
  });

  // -------------------------------------------------------------------------
  // Test 5: Unexpected read errors still warn
  // -------------------------------------------------------------------------

  it('still warns on unexpected read errors', async () => {
    mockReaddir.mockImplementationOnce(async () => {
      const err = new Error('EIO: disk exploded') as NodeJS.ErrnoException;
      err.code = 'EIO';
      throw err;
    });

    await discovery.scan(['/flaky']);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Failed to read directory',
      expect.objectContaining({ dirPath: '/flaky' }),
    );
  });
});
