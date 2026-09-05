import { mkdtempSync, rmSync, writeFileSync, utimesSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  detectBuildSkew,
  describeBuildSkew,
  readBuildFingerprint,
  MAIN_ENTRY_RELATIVE,
} from './build-skew';

let root: string | null = null;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

function makeRoot(contents = 'console.log(1);'): string {
  root = mkdtempSync(join(tmpdir(), 'build-skew-'));
  mkdirSync(join(root, 'dist', 'main'), { recursive: true });
  writeFileSync(join(root, MAIN_ENTRY_RELATIVE), contents);
  return root;
}

describe('readBuildFingerprint', () => {
  it('reads the compiled entry point', () => {
    const fp = readBuildFingerprint(makeRoot());
    expect(fp?.size).toBeGreaterThan(0);
    expect(fp?.mtimeMs).toBeGreaterThan(0);
  });

  it('returns null when there is no compiled entry point', () => {
    root = mkdtempSync(join(tmpdir(), 'build-skew-'));
    expect(readBuildFingerprint(root)).toBeNull();
  });
});

describe('detectBuildSkew', () => {
  /**
   * The load-bearing property. The original bug was a green signal over a stale
   * build; a guard that reports "same" when it cannot tell reproduces exactly
   * that, so an unknown must never be reported as up to date.
   */
  it('reports unknown, never same, when either side is unavailable', () => {
    const fp = { mtimeMs: 1, size: 2 };
    expect(detectBuildSkew(null, fp).kind).toBe('unknown');
    expect(detectBuildSkew(fp, null).kind).toBe('unknown');
    expect(detectBuildSkew(null, null).kind).toBe('unknown');
  });

  it('reports same for an untouched build', () => {
    const dir = makeRoot();
    const boot = readBuildFingerprint(dir);
    expect(detectBuildSkew(boot, readBuildFingerprint(dir)).kind).toBe('same');
  });

  it('detects a rebuild that changed the file', () => {
    const dir = makeRoot();
    const boot = readBuildFingerprint(dir);
    writeFileSync(join(dir, MAIN_ENTRY_RELATIVE), 'console.log(2); // rebuilt, longer');
    expect(detectBuildSkew(boot, readBuildFingerprint(dir)).kind).toBe('skewed');
  });

  /** A rebuild that happens to produce identical bytes at a new mtime is still skew. */
  it('detects a rebuild that preserved the size', () => {
    const dir = makeRoot('AAAA');
    const boot = readBuildFingerprint(dir);
    const later = Date.now() / 1000 + 60;
    utimesSync(join(dir, MAIN_ENTRY_RELATIVE), later, later);
    expect(detectBuildSkew(boot, readBuildFingerprint(dir)).kind).toBe('skewed');
  });

  /** And one that preserved the mtime but changed the content. */
  it('detects a rewrite that preserved the mtime', () => {
    const boot = { mtimeMs: 1_000, size: 10 };
    expect(detectBuildSkew(boot, { mtimeMs: 1_000, size: 11 }).kind).toBe('skewed');
  });
});

describe('describeBuildSkew', () => {
  it('says nothing unless there is skew', () => {
    expect(describeBuildSkew({ kind: 'same' })).toBeNull();
    expect(describeBuildSkew({ kind: 'unknown', reason: 'x' })).toBeNull();
  });

  it('tells the operator what to do and what they are seeing meanwhile', () => {
    const text = describeBuildSkew({
      kind: 'skewed',
      bootedAt: { mtimeMs: 1, size: 1 },
      onDisk: { mtimeMs: 2, size: 2 },
    });
    expect(text).toContain('Restart');
    expect(text).toContain('old one');
  });
});
