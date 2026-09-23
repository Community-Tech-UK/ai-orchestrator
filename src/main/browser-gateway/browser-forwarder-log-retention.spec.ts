import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  pruneBrowserForwarderLogs,
  registerBrowserForwarderLogOwner,
} from './browser-forwarder-log-retention';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-23T12:00:00Z').getTime();
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'browser-forwarder-retention-'));
  roots.push(root);
  return root;
}

function makeLog(root: string, id: string, ageDays: number, size = 20): string {
  const directory = path.join(root, id);
  const logs = path.join(directory, 'logs');
  mkdirSync(logs, { recursive: true });
  const file = path.join(logs, 'app.log');
  writeFileSync(file, 'x'.repeat(size));
  const date = new Date(NOW - ageDays * DAY_MS);
  utimesSync(file, date, date);
  utimesSync(directory, date, date);
  return directory;
}

describe('browser forwarder log retention', () => {
  it('prunes expired inactive logs while preserving recent and live forwarders', () => {
    const root = makeRoot();
    const expired = makeLog(root, 'expired', 20);
    const staleMarker = path.join(expired, '.owner-456');
    writeFileSync(staleMarker, '');
    const staleHeartbeat = new Date(NOW - 2 * 60 * 60 * 1000);
    utimesSync(staleMarker, staleHeartbeat, staleHeartbeat);
    const expiredAt = new Date(NOW - 20 * DAY_MS);
    utimesSync(expired, expiredAt, expiredAt);
    const recent = makeLog(root, 'recent', 1);
    const live = makeLog(root, 'live', 20);
    writeFileSync(path.join(live, '.owner-12345'), '');

    const result = pruneBrowserForwarderLogs(root, {
      nowMs: NOW,
      // The old marker belongs to a dead PID; the live forwarder is retained.
      isProcessAlive: (pid) => pid === 12345,
    });

    expect(result.removed).toBe(1);
    expect(readdirSync(root).sort()).toEqual(['live', 'recent']);
    expect(readFileSync(path.join(recent, 'logs', 'app.log'), 'utf8')).toHaveLength(20);
    expect(existsSync(expired)).toBe(false);
  });

  it('caps inactive log count by deleting the oldest first', () => {
    const root = makeRoot();
    makeLog(root, 'oldest', 3);
    makeLog(root, 'middle', 2);
    makeLog(root, 'newest', 1);

    const result = pruneBrowserForwarderLogs(root, {
      nowMs: NOW,
      maxInactiveDirectories: 2,
      maxInactiveBytes: 100,
      isProcessAlive: () => false,
    });

    expect(result.removed).toBe(1);
    expect(readdirSync(root).sort()).toEqual(['middle', 'newest']);
  });

  it('caps aggregate inactive log bytes by deleting the oldest first', () => {
    const root = makeRoot();
    makeLog(root, 'oldest', 3);
    makeLog(root, 'middle', 2);
    makeLog(root, 'newest', 1);

    const result = pruneBrowserForwarderLogs(root, {
      nowMs: NOW,
      maxInactiveDirectories: 10,
      maxInactiveBytes: 30,
      isProcessAlive: () => false,
    });

    expect(result.removed).toBe(2);
    expect(readdirSync(root)).toEqual(['newest']);
  });

  it('preserves a live forwarder whose owner marker aged during sleep', () => {
    const root = makeRoot();
    const directory = makeLog(root, 'sleeping', 20);
    const marker = path.join(directory, '.owner-12345');
    writeFileSync(marker, '');
    const beforeSleep = new Date(NOW - 2 * 60 * 60 * 1000);
    utimesSync(marker, beforeSleep, beforeSleep);
    const logAge = new Date(NOW - 20 * DAY_MS);
    utimesSync(directory, logAge, logAge);

    const result = pruneBrowserForwarderLogs(root, {
      nowMs: NOW,
      maxInactiveDirectories: 0,
      maxInactiveBytes: 0,
      isProcessAlive: (pid) => pid === 12345,
    });

    expect(result.removed).toBe(0);
    expect(existsSync(path.join(directory, 'logs', 'app.log'))).toBe(true);
  });

  it('gives a newly started forwarder time to write its owner marker before cap cleanup', () => {
    const root = makeRoot();
    makeLog(root, 'starting', 0);

    const duringStartup = pruneBrowserForwarderLogs(root, {
      nowMs: NOW + 30 * 1000,
      maxInactiveDirectories: 0,
      maxInactiveBytes: 0,
    });
    expect(duringStartup.removed).toBe(0);
    expect(readdirSync(root)).toEqual(['starting']);

    const afterGrace = pruneBrowserForwarderLogs(root, {
      nowMs: NOW + 2 * 60 * 1000,
      maxInactiveDirectories: 0,
      maxInactiveBytes: 0,
    });
    expect(afterGrace.removed).toBe(1);
    expect(readdirSync(root)).toEqual([]);
  });

  it('does not follow a symlink inside the forwarder log root', () => {
    const root = makeRoot();
    const external = makeRoot();
    makeLog(external, 'outside', 20);
    symlinkSync(path.join(external, 'outside'), path.join(root, 'link'));

    pruneBrowserForwarderLogs(root, { nowMs: NOW, maxInactiveDirectories: 0 });

    expect(existsSync(path.join(external, 'outside', 'logs', 'app.log'))).toBe(true);
  });

  it('registers the current forwarder PID and removes its owner marker on shutdown', () => {
    const root = makeRoot();
    const directory = path.join(root, 'instance-1');

    const unregister = registerBrowserForwarderLogOwner(directory);
    expect(readdirSync(directory)).toContain(`.owner-${process.pid}`);

    unregister();
    expect(readdirSync(directory)).not.toContain(`.owner-${process.pid}`);
  });

});
