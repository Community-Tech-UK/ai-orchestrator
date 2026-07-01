import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { readProviderEnv } from './provider-env';

describe('readProviderEnv', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefers an existing process env value over the proc-environ fallback', () => {
    const environPath = writeProcEnviron('PROVIDER_KEY=from-proc\0');

    expect(readProviderEnv('PROVIDER_KEY', {
      env: { PROVIDER_KEY: 'from-process' },
      platform: 'linux',
      procEnvironPath: environPath,
    })).toBe('from-process');
  });

  it('reads a missing value from proc self environ when the fallback file exists', () => {
    const environPath = writeProcEnviron('OTHER=value\0PROVIDER_KEY=from-proc\0');

    expect(readProviderEnv('PROVIDER_KEY', {
      env: {},
      platform: 'linux',
      procEnvironPath: environPath,
    })).toBe('from-proc');
  });

  it('preserves fallback values that contain equals signs', () => {
    const environPath = writeProcEnviron('PROVIDER_KEY=sk-test=with=equals\0');

    expect(readProviderEnv('PROVIDER_KEY', {
      env: {},
      platform: 'linux',
      procEnvironPath: environPath,
    })).toBe('sk-test=with=equals');
  });

  it('does not read proc environ on Windows', () => {
    const environPath = writeProcEnviron('PROVIDER_KEY=from-proc\0');

    expect(readProviderEnv('PROVIDER_KEY', {
      env: {},
      platform: 'win32',
      procEnvironPath: environPath,
    })).toBeUndefined();
  });

  it('returns undefined when the fallback file is absent or the key is invalid', () => {
    const missingPath = join(makeTempDir(), 'missing-environ');

    expect(readProviderEnv('PROVIDER_KEY', {
      env: {},
      platform: 'linux',
      procEnvironPath: missingPath,
    })).toBeUndefined();
    expect(readProviderEnv('', {
      env: {},
      platform: 'linux',
      procEnvironPath: missingPath,
    })).toBeUndefined();
    expect(readProviderEnv('PROVIDER=KEY', {
      env: {},
      platform: 'linux',
      procEnvironPath: missingPath,
    })).toBeUndefined();
  });

  function writeProcEnviron(contents: string): string {
    const path = join(makeTempDir(), 'environ');
    writeFileSync(path, contents);
    return path;
  }

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'aio-provider-env-'));
    tempDirs.push(dir);
    return dir;
  }
});
