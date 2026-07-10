import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const {
  createSwiftBuildPlan,
  buildDesktopHelper,
} = require('../build-desktop-helper.js') as {
  createSwiftBuildPlan: (options: {
    platform: string;
    arch: string;
    projectRoot: string;
  }) => { command: string; args: string[]; outputPath: string } | null;
  buildDesktopHelper: (options: {
    platform: string;
    arch: string;
    projectRoot: string;
    required: boolean;
    spawnSync: typeof import('node:child_process').spawnSync;
  }) => { skipped: boolean; outputPath?: string };
};

describe('build-desktop-helper', () => {
  it('skips deterministically on non-macOS platforms', () => {
    expect(createSwiftBuildPlan({
      platform: 'linux',
      arch: 'x64',
      projectRoot: '/work/harness',
    })).toBeNull();
  });

  it('builds the Swift helper with an explicit deployment target and frameworks', () => {
    expect(createSwiftBuildPlan({
      platform: 'darwin',
      arch: 'arm64',
      projectRoot: '/work/harness',
    })).toEqual({
      command: 'xcrun',
      args: [
        'swiftc',
        '/work/harness/resources/desktop-helper/DesktopHelper.swift',
        '-O',
        '-whole-module-optimization',
        '-target',
        'arm64-apple-macosx12.0',
        '-framework',
        'AppKit',
        '-framework',
        'ApplicationServices',
        '-framework',
        'CoreGraphics',
        '-o',
        '/work/harness/dist/desktop-helper/desktop-helper',
      ],
      outputPath: '/work/harness/dist/desktop-helper/desktop-helper',
    });
  });

  it('fails clearly when a required macOS helper cannot be compiled', () => {
    const spawnSync = vi.fn(() => ({
      pid: 1,
      output: [],
      stdout: null,
      stderr: null,
      status: null,
      signal: null,
      error: new Error('spawn xcrun ENOENT'),
    })) as unknown as typeof import('node:child_process').spawnSync;

    expect(() => buildDesktopHelper({
      platform: 'darwin',
      arch: 'arm64',
      projectRoot: '/tmp/harness-desktop-helper-test',
      required: true,
      spawnSync,
    })).toThrow(
      'Bundled macOS desktop helper is required, but xcrun swiftc could not compile it',
    );
  });
});
