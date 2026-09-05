import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAIN_ENTRY_RELATIVE } from './build-skew';
import {
  startBuildSkewWatcher,
  stopBuildSkewWatcher,
  _resetForTesting,
} from './build-skew-watcher';

vi.mock('electron', () => ({ app: { isPackaged: false } }));
vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

let root: string;

function writeEntry(contents: string): void {
  writeFileSync(join(root, MAIN_ENTRY_RELATIVE), contents);
}

beforeEach(() => {
  vi.useFakeTimers();
  root = mkdtempSync(join(tmpdir(), 'skew-watch-'));
  mkdirSync(join(root, 'dist', 'main'), { recursive: true });
  writeEntry('console.log(1);');
});

afterEach(() => {
  _resetForTesting();
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

describe('startBuildSkewWatcher (N6)', () => {
  it('stays quiet while the build is untouched', () => {
    const onSkew = vi.fn();
    startBuildSkewWatcher({ appRoot: root, pollMs: 10, onSkew });
    vi.advanceTimersByTime(100);
    expect(onSkew).not.toHaveBeenCalled();
  });

  it('reports once the entry point is rebuilt', () => {
    const onSkew = vi.fn();
    startBuildSkewWatcher({ appRoot: root, pollMs: 10, onSkew });
    writeEntry('console.log(2); // rebuilt');
    vi.advanceTimersByTime(50);
    expect(onSkew).toHaveBeenCalledTimes(1);
    expect(onSkew.mock.calls[0]![0]).toContain('Restart');
  });

  /** A nag every minute trains the operator to ignore it. */
  it('reports only once per process, not on every poll', () => {
    const onSkew = vi.fn();
    startBuildSkewWatcher({ appRoot: root, pollMs: 10, onSkew });
    writeEntry('console.log(2); // rebuilt');
    vi.advanceTimersByTime(500);
    expect(onSkew).toHaveBeenCalledTimes(1);
  });

  it('does not start in a packaged app, where dist/main cannot change', () => {
    const onSkew = vi.fn();
    startBuildSkewWatcher({ appRoot: root, pollMs: 10, isPackaged: true, onSkew });
    writeEntry('console.log(2); // rebuilt');
    vi.advanceTimersByTime(200);
    expect(onSkew).not.toHaveBeenCalled();
  });

  it('does not start when there is no compiled entry point to compare', () => {
    const bare = mkdtempSync(join(tmpdir(), 'skew-empty-'));
    const onSkew = vi.fn();
    try {
      startBuildSkewWatcher({ appRoot: bare, pollMs: 10, onSkew });
      vi.advanceTimersByTime(200);
      expect(onSkew).not.toHaveBeenCalled();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('is idempotent — a second start does not double-report', () => {
    const onSkew = vi.fn();
    startBuildSkewWatcher({ appRoot: root, pollMs: 10, onSkew });
    startBuildSkewWatcher({ appRoot: root, pollMs: 10, onSkew });
    writeEntry('console.log(2); // rebuilt');
    vi.advanceTimersByTime(200);
    expect(onSkew).toHaveBeenCalledTimes(1);
  });

  it('stops cleanly', () => {
    const onSkew = vi.fn();
    startBuildSkewWatcher({ appRoot: root, pollMs: 10, onSkew });
    stopBuildSkewWatcher();
    writeEntry('console.log(2); // rebuilt');
    vi.advanceTimersByTime(200);
    expect(onSkew).not.toHaveBeenCalled();
  });
});
