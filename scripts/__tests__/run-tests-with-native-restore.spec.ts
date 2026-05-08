import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { runTestsWithNativeRestore } = require('../run-tests-with-native-restore.js') as {
  runTestsWithNativeRestore: (options: {
    nodeExec: string;
    projectRoot: string;
    testArgs?: string[];
    run: (command: string, args: string[]) => { status: number | null; signal?: NodeJS.Signals | null; error?: Error };
  }) => number;
};

describe('runTestsWithNativeRestore', () => {
  it('restores Electron native modules after a successful Vitest run', () => {
    const projectRoot = '/repo';
    const run = vi.fn(() => ({ status: 0, signal: null }));

    const exitCode = runTestsWithNativeRestore({
      nodeExec: '/node',
      projectRoot,
      testArgs: ['src/main/example.spec.ts'],
      run,
    });

    expect(exitCode).toBe(0);
    expect(run).toHaveBeenCalledTimes(5);
    expect(run).toHaveBeenNthCalledWith(1, '/node', [
      path.join(projectRoot, 'scripts', 'check-node.js'),
    ]);
    expect(run).toHaveBeenNthCalledWith(2, '/node', [
      path.join(projectRoot, 'scripts', 'ensure-test-native-modules.js'),
    ]);
    expect(run).toHaveBeenNthCalledWith(3, '/node', [
      path.join(projectRoot, 'scripts', 'verify-package-exports.js'),
    ]);
    expect(run).toHaveBeenNthCalledWith(4, '/node', [
      path.join(projectRoot, 'node_modules', 'vitest', 'vitest.mjs'),
      'run',
      'src/main/example.spec.ts',
    ]);
    expect(run).toHaveBeenNthCalledWith(5, '/node', [
      path.join(projectRoot, 'scripts', 'rebuild-native-modules.js'),
    ]);
  });

  it('still restores Electron native modules when Vitest fails', () => {
    const projectRoot = '/repo';
    const run = vi
      .fn()
      .mockReturnValueOnce({ status: 0, signal: null })
      .mockReturnValueOnce({ status: 0, signal: null })
      .mockReturnValueOnce({ status: 0, signal: null })
      .mockReturnValueOnce({ status: 1, signal: null })
      .mockReturnValueOnce({ status: 0, signal: null });

    const exitCode = runTestsWithNativeRestore({
      nodeExec: '/node',
      projectRoot,
      run,
    });

    expect(exitCode).toBe(1);
    expect(run).toHaveBeenCalledTimes(5);
    expect(run).toHaveBeenNthCalledWith(5, '/node', [
      path.join(projectRoot, 'scripts', 'rebuild-native-modules.js'),
    ]);
  });

  it('restores Electron native modules when preflight fails after the test ABI rebuild', () => {
    const projectRoot = '/repo';
    const run = vi
      .fn()
      .mockReturnValueOnce({ status: 0, signal: null })
      .mockReturnValueOnce({ status: 0, signal: null })
      .mockReturnValueOnce({ status: 1, signal: null })
      .mockReturnValueOnce({ status: 0, signal: null });

    const exitCode = runTestsWithNativeRestore({
      nodeExec: '/node',
      projectRoot,
      run,
    });

    expect(exitCode).toBe(1);
    expect(run).toHaveBeenCalledTimes(4);
    expect(run).toHaveBeenNthCalledWith(4, '/node', [
      path.join(projectRoot, 'scripts', 'rebuild-native-modules.js'),
    ]);
  });

  it('fails when restoration fails after tests pass', () => {
    const run = vi
      .fn()
      .mockReturnValueOnce({ status: 0, signal: null })
      .mockReturnValueOnce({ status: 0, signal: null })
      .mockReturnValueOnce({ status: 0, signal: null })
      .mockReturnValueOnce({ status: 0, signal: null })
      .mockReturnValueOnce({ status: 1, signal: null });

    expect(runTestsWithNativeRestore({ nodeExec: '/node', projectRoot: '/repo', run })).toBe(1);
  });
});
