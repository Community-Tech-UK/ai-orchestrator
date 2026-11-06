import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => ({
  isPackaged: false,
  getAppPath: vi.fn(() => '/Users/suas/work/orchestrat0r/ai-orchestrator'),
}));

vi.mock('electron', () => ({
  app: electronMock,
}));

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  _resetForTesting,
  compareVersions,
  getRtkRuntime,
  parseVersion,
  RTK_BUNDLED_VERSION,
  RTK_MIN_REWRITE_VERSION,
  RTK_MIN_VERSION,
  supportsRewriteVersion,
} from '../rtk-runtime';

/**
 * Build a stub rtk binary as a shell script that mimics the real
 * `rtk --version` and `rtk rewrite <cmd>` exit code protocol.
 *
 * @param spec.version    Version string to print on `rtk --version`
 * @param spec.behavior   Map of input command → result (`allow`, `passthrough`, `deny`, `ask`, `crash`)
 */
function makeStubBinary(
  rootDir: string,
  spec: {
    version: string;
    behavior?: Record<string, 'allow' | 'passthrough' | 'deny' | 'ask' | 'crash'>;
  },
): string {
  const binaryPath = path.join(rootDir, process.platform === 'win32' ? 'rtk.cmd' : 'rtk');
  const behavior = spec.behavior ?? { 'git status': 'allow' };

  if (process.platform === 'win32') {
    // Skip Windows scripting in unit tests — these run in CI on Linux/macOS.
    // We still create the file so isAvailable() can find it, and probeVersion
    // will fail gracefully.
    writeFileSync(binaryPath, `@echo off\r\necho rtk ${spec.version}\r\n`, 'utf-8');
    return binaryPath;
  }

  const cases = Object.entries(behavior)
    .map(([cmd, kind]) => {
      const safeCmd = cmd.replace(/'/g, `'\\''`);
      switch (kind) {
        case 'allow':
          return `  '${safeCmd}') printf 'rtk ${safeCmd}'; exit 0 ;;`;
        case 'passthrough':
          return `  '${safeCmd}') exit 1 ;;`;
        case 'deny':
          return `  '${safeCmd}') exit 2 ;;`;
        case 'ask':
          return `  '${safeCmd}') printf 'rtk ${safeCmd}'; exit 3 ;;`;
        case 'crash':
          return `  '${safeCmd}') echo "boom" >&2; exit 99 ;;`;
        default:
          return '';
      }
    })
    .join('\n');

  const script = `#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then
  echo "rtk ${spec.version}"
  exit 0
fi
if [[ "$1" == "rewrite" ]]; then
  case "$2" in
${cases}
    *) exit 1 ;;
  esac
fi
exit 0
`;
  writeFileSync(binaryPath, script, 'utf-8');
  chmodSync(binaryPath, 0o755);
  return binaryPath;
}

describe('rtk-runtime', () => {
  let tempRoot = '';

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'rtk-runtime-'));
    electronMock.isPackaged = false;
    electronMock.getAppPath.mockReturnValue(tempRoot);
    _resetForTesting();
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    _resetForTesting();
  });

  describe('parseVersion', () => {
    it('extracts the version from "rtk x.y.z"', () => {
      expect(parseVersion('rtk 0.39.0')).toBe('0.39.0');
    });

    it('extracts the version when commit info is appended', () => {
      expect(parseVersion('rtk 0.39.0 (abc1234 2026-04-01)')).toBe('0.39.0');
    });

    it('returns null for empty input', () => {
      expect(parseVersion('')).toBeNull();
    });

    it('returns null for unparseable input', () => {
      expect(parseVersion('not a version line')).toBeNull();
    });
  });

  describe('compareVersions', () => {
    it('returns 0 for equal versions', () => {
      expect(compareVersions('0.39.0', '0.39.0')).toBe(0);
    });

    it('returns negative when a < b', () => {
      expect(compareVersions('0.23.0', '0.39.0')).toBeLessThan(0);
      expect(compareVersions('0.39.0', '1.0.0')).toBeLessThan(0);
    });

    it('returns positive when a > b', () => {
      expect(compareVersions('0.40.0', '0.39.0')).toBeGreaterThan(0);
      expect(compareVersions('1.0.0', '0.39.0')).toBeGreaterThan(0);
    });

    it('strips pre-release suffixes', () => {
      expect(compareVersions('0.39.0-rc.1', '0.39.0')).toBe(0);
    });

    it('treats missing components as zero', () => {
      expect(compareVersions('0.39', '0.39.0')).toBe(0);
    });

    it('declares MIN_VERSION earlier than BUNDLED_VERSION', () => {
      expect(compareVersions(RTK_MIN_VERSION, RTK_BUNDLED_VERSION)).toBeLessThan(0);
    });

    it('bundles rtk 0.52.0', () => {
      expect(RTK_BUNDLED_VERSION).toBe('0.52.0');
    });
  });

  describe('binary resolution', () => {
    it.runIf(process.platform !== 'win32')('reports unavailable when no binary is present', () => {
      const runtime = getRtkRuntime({ bundledOnly: true });
      expect(runtime.isAvailable()).toBe(false);
      expect(runtime.binarySource()).toBe('none');
      expect(runtime.version()).toBeNull();
    });

    it.runIf(process.platform !== 'win32')('uses an explicit override path when provided', () => {
      const stubPath = makeStubBinary(tempRoot, { version: '0.39.0' });
      const runtime = getRtkRuntime({ binaryPathOverride: stubPath });
      expect(runtime.isAvailable()).toBe(true);
      expect(runtime.binarySource()).toBe('override');
      expect(runtime.binaryPath()).toBe(stubPath);
      expect(runtime.version()).toBe('0.39.0');
    });

    it.runIf(process.platform !== 'win32')('rejects an override that fails --version', () => {
      const stubPath = path.join(tempRoot, 'rtk');
      writeFileSync(stubPath, '#!/usr/bin/env bash\nexit 7\n', 'utf-8');
      chmodSync(stubPath, 0o755);
      const runtime = getRtkRuntime({ binaryPathOverride: stubPath });
      expect(runtime.isAvailable()).toBe(false);
    });

    it.runIf(process.platform !== 'win32')(
      'retries the version probe when the first exec times out',
      () => {
        // The first execution of a binary the kernel has not seen before is far
        // more expensive than the next one (on macOS it pays Gatekeeper /
        // code-signing evaluation), and resolution is cached per process — so
        // without a retry, one cold-start stall disables rtk for the session.
        //
        // The stub takes 300ms on every run, so a 1ms budget always times out, and
        // a 4s one leaves room for all but a badly stalled host. A 1ms budget
        // alone doesn't force it: an idle Linux core finished a plain stub inside
        // that budget 275 times in 300. A stub that slept only on its first run
        // was no better, because under parallel forks the exec itself could blow
        // the budget before the script ran.
        const stubPath = path.join(tempRoot, 'rtk');
        writeFileSync(stubPath, '#!/bin/sh\nsleep 0.3\necho "rtk 0.39.0"\n', 'utf-8');
        chmodSync(stubPath, 0o755);

        const oneAttempt = getRtkRuntime({ binaryPathOverride: stubPath, probeTimeoutsMs: [1] });
        expect(oneAttempt.isAvailable()).toBe(false); // no retry -> stays unavailable

        _resetForTesting();

        const withRetry = getRtkRuntime({
          binaryPathOverride: stubPath,
          probeTimeoutsMs: [1, 4_000],
        });
        expect(withRetry.isAvailable()).toBe(true);
        expect(withRetry.version()).toBe('0.39.0');
      },
    );

    it.runIf(process.platform !== 'win32')('rejects an override below the minimum version', () => {
      const stubPath = makeStubBinary(tempRoot, { version: '0.10.0' });
      const runtime = getRtkRuntime({ binaryPathOverride: stubPath });
      expect(runtime.isAvailable()).toBe(false);
    });

    it.runIf(process.platform !== 'win32')('rejects an override that does not exist', () => {
      const runtime = getRtkRuntime({
        binaryPathOverride: path.join(tempRoot, 'does-not-exist'),
      });
      expect(runtime.isAvailable()).toBe(false);
    });
  });

  describe('rewrite', () => {
    it.runIf(process.platform !== 'win32')('maps exit 0 to allow with rewritten stdout', () => {
      const stubPath = makeStubBinary(tempRoot, {
        version: '0.39.0',
        behavior: { 'git status': 'allow' },
      });
      const runtime = getRtkRuntime({ binaryPathOverride: stubPath });
      const result = runtime.rewrite('git status');
      expect(result).toEqual({ kind: 'allow', rewritten: 'rtk git status' });
    });

    it.runIf(process.platform !== 'win32')('maps exit 1 to passthrough', () => {
      const stubPath = makeStubBinary(tempRoot, {
        version: '0.39.0',
        behavior: { 'unknown-cmd': 'passthrough' },
      });
      const runtime = getRtkRuntime({ binaryPathOverride: stubPath });
      const result = runtime.rewrite('unknown-cmd');
      expect(result).toEqual({ kind: 'passthrough' });
    });

    it.runIf(process.platform !== 'win32')('maps exit 2 to deny', () => {
      const stubPath = makeStubBinary(tempRoot, {
        version: '0.39.0',
        behavior: { 'rm -rf': 'deny' },
      });
      const runtime = getRtkRuntime({ binaryPathOverride: stubPath });
      const result = runtime.rewrite('rm -rf');
      expect(result).toEqual({ kind: 'deny' });
    });

    it.runIf(process.platform !== 'win32')('maps exit 3 to ask with rewritten stdout', () => {
      const stubPath = makeStubBinary(tempRoot, {
        version: '0.39.0',
        behavior: { 'git push': 'ask' },
      });
      const runtime = getRtkRuntime({ binaryPathOverride: stubPath });
      const result = runtime.rewrite('git push');
      expect(result).toEqual({ kind: 'ask', rewritten: 'rtk git push' });
    });

    it.runIf(process.platform !== 'win32')('maps unexpected exit codes to error', () => {
      const stubPath = makeStubBinary(tempRoot, {
        version: '0.39.0',
        behavior: { 'weird-cmd': 'crash' },
      });
      const runtime = getRtkRuntime({ binaryPathOverride: stubPath });
      const result = runtime.rewrite('weird-cmd');
      expect(result.kind).toBe('error');
      if (result.kind === 'error') {
        expect(result.reason).toMatch(/unexpected code 99/);
      }
    });

    it('returns error when binary is unavailable', () => {
      const runtime = getRtkRuntime({ bundledOnly: true });
      const result = runtime.rewrite('git status');
      expect(result.kind).toBe('error');
    });

    it.runIf(process.platform !== 'win32')('returns error for empty command input', () => {
      const stubPath = makeStubBinary(tempRoot, { version: '0.39.0' });
      const runtime = getRtkRuntime({ binaryPathOverride: stubPath });
      const result = runtime.rewrite('');
      expect(result.kind).toBe('error');
    });
  });

  describe('singleton caching', () => {
    it.runIf(process.platform !== 'win32')('returns the same instance for identical options', () => {
      const stubPath = makeStubBinary(tempRoot, { version: '0.39.0' });
      const a = getRtkRuntime({ binaryPathOverride: stubPath });
      const b = getRtkRuntime({ binaryPathOverride: stubPath });
      expect(a).toBe(b);
    });

    it.runIf(process.platform !== 'win32')('rebuilds when options change', () => {
      const stubA = makeStubBinary(tempRoot, { version: '0.39.0' });
      const tempB = mkdtempSync(path.join(tmpdir(), 'rtk-runtime-b-'));
      try {
        const stubB = makeStubBinary(tempB, { version: '0.39.1' });
        const a = getRtkRuntime({ binaryPathOverride: stubA });
        const b = getRtkRuntime({ binaryPathOverride: stubB });
        expect(a).not.toBe(b);
        expect(b.version()).toBe('0.39.1');
      } finally {
        rmSync(tempB, { recursive: true, force: true });
      }
    });
  });

  describe('rewrite-capable version (Step 18a)', () => {
    it('pins the rewrite floor at 0.49.0', () => {
      expect(RTK_MIN_REWRITE_VERSION).toBe('0.49.0');
    });

    it('supportsRewriteVersion: false below 0.49.0 and for unknown, true from 0.49.0', () => {
      for (const version of ['0.39.0', '0.42.4', '0.48.9']) {
        expect(supportsRewriteVersion(version)).toBe(false);
      }
      for (const version of ['0.49.0', '0.51.0']) {
        expect(supportsRewriteVersion(version)).toBe(true);
      }
      expect(supportsRewriteVersion(null)).toBe(false);
      expect(supportsRewriteVersion(undefined)).toBe(false);
    });

    it.runIf(process.platform !== 'win32')('supportsRewrite() follows the resolved binary', () => {
      const oldDir = mkdtempSync(path.join(tempRoot, 'old-'));
      expect(getRtkRuntime({ binaryPathOverride: makeStubBinary(oldDir, { version: '0.42.4' }) }).supportsRewrite())
        .toBe(false);
      _resetForTesting();
      const newDir = mkdtempSync(path.join(tempRoot, 'new-'));
      expect(getRtkRuntime({ binaryPathOverride: makeStubBinary(newDir, { version: '0.49.0' }) }).supportsRewrite())
        .toBe(true);
    });
  });

  describe('bundled versus system binary (Step 18a)', () => {
    let savedPath: string | undefined;

    beforeEach(() => {
      savedPath = process.env['PATH'];
    });

    afterEach(() => {
      process.env['PATH'] = savedPath;
    });

    function installBundled(version: string): void {
      const dir = path.join(tempRoot, 'resources', 'rtk', `${process.platform}-${process.arch}`);
      mkdirSync(dir, { recursive: true });
      makeStubBinary(dir, { version });
    }

    function installSystem(version: string): string {
      const dir = path.join(tempRoot, 'system-bin');
      mkdirSync(dir, { recursive: true });
      const binary = makeStubBinary(dir, { version });
      process.env['PATH'] = `${dir}${path.delimiter}${savedPath ?? ''}`;
      return binary;
    }

    it.runIf(process.platform !== 'win32')('chooses bundled 0.51.0 over an older system 0.42.4', () => {
      installBundled('0.51.0');
      installSystem('0.42.4');
      const runtime = getRtkRuntime({});
      expect(runtime.binarySource()).toBe('bundled');
      expect(runtime.version()).toBe('0.51.0');
      expect(runtime.supportsRewrite()).toBe(true);
    });

    it.runIf(process.platform !== 'win32')('chooses a system copy at least as new as the bundled one', () => {
      installBundled('0.51.0');
      const systemBinary = installSystem('0.52.0');
      const runtime = getRtkRuntime({});
      expect(runtime.binarySource()).toBe('system');
      expect(runtime.binaryPath()).toBe(systemBinary);
      expect(runtime.version()).toBe('0.52.0');
    });
  });
});
