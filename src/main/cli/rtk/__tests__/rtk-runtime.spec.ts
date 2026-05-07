import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
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
  RTK_MIN_VERSION,
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
});
