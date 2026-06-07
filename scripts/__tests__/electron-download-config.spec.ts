import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const npmrcPath = join(repoRoot, '.npmrc');
const packageLockPath = join(repoRoot, 'package-lock.json');
const defaultElectronMirror = 'https://github.com/electron/electron/releases/download/';

function parseNpmrc(content: string): Record<string, string> {
  return Object.fromEntries(
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#') && line.includes('='))
      .map((line) => {
        const separatorIndex = line.indexOf('=');
        return [line.slice(0, separatorIndex).trim(), line.slice(separatorIndex + 1).trim()];
      }),
  );
}

function getLockedElectronVersion(): string {
  const packageLock = JSON.parse(readFileSync(packageLockPath, 'utf8')) as {
    packages: Record<string, { version?: string }>;
  };
  const electronVersion = packageLock.packages['node_modules/electron']?.version;

  if (!electronVersion) {
    throw new Error('package-lock.json is missing node_modules/electron');
  }

  return electronVersion;
}

function electronArtifactUrl(mirror: string, version: string, platform: string, arch: string): string {
  const normalizedVersion = version.startsWith('v') ? version : `v${version}`;
  const filename = `electron-${normalizedVersion}-${platform}-${arch}.zip`;
  return `${mirror}${normalizedVersion}/${filename}`;
}

describe('Electron download npm config', () => {
  it('uses a project-level mirror instead of Electron get defaulting to GitHub releases', () => {
    expect(existsSync(npmrcPath)).toBe(true);

    const npmrc = parseNpmrc(readFileSync(npmrcPath, 'utf8'));
    const electronMirror = npmrc['electron_mirror'];

    expect(electronMirror).toBeDefined();
    expect(electronMirror).not.toBe(defaultElectronMirror);
    expect(electronMirror).toMatch(/^https:\/\//);
    expect(electronMirror).toMatch(/\/$/);

    const linuxCiUrl = electronArtifactUrl(
      electronMirror,
      getLockedElectronVersion(),
      'linux',
      'x64',
    );

    expect(linuxCiUrl).not.toContain('github.com/electron/electron/releases/download');
    expect(linuxCiUrl).toMatch(/\/v\d+\.\d+\.\d+\/electron-v\d+\.\d+\.\d+-linux-x64\.zip$/);
  });
});
