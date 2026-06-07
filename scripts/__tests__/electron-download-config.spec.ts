import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';

import { getArtifactRemoteURL } from '@electron/get/dist/cjs/artifact-utils.js';

const repoRoot = process.cwd();
const npmrcPath = join(repoRoot, '.npmrc');
const packageLockPath = join(repoRoot, 'package-lock.json');
const ciWorkflowPath = join(repoRoot, '.github/workflows/ci.yml');
const defaultElectronMirror = 'https://github.com/electron/electron/releases/download/';
const electronMirror = 'https://npmmirror.com/mirrors/electron/';

interface WorkflowStep {
  run?: string;
  env?: Record<string, string>;
}

interface WorkflowJob {
  env?: Record<string, string>;
  steps?: WorkflowStep[];
}

interface WorkflowConfig {
  env?: Record<string, string>;
  jobs?: Record<string, WorkflowJob>;
}

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
  it('does not use deprecated project-level Electron npm config keys', () => {
    if (!existsSync(npmrcPath)) {
      return;
    }

    const npmrc = parseNpmrc(readFileSync(npmrcPath, 'utf8'));

    expect(npmrc['electron_mirror']).toBeUndefined();
    expect(npmrc['electron-mirror']).toBeUndefined();
  });

  it('exports the supported Electron mirror environment variable for CI installs', () => {
    const workflow = load(readFileSync(ciWorkflowPath, 'utf8')) as WorkflowConfig;
    const installSteps = Object.entries(workflow.jobs ?? {}).flatMap(([jobName, job]) =>
      (job.steps ?? [])
        .filter((step) => step.run?.trim() === 'npm ci')
        .map((step) => ({ jobName, job, step })),
    );

    expect(installSteps.length).toBeGreaterThan(0);

    for (const { jobName, job, step } of installSteps) {
      const configuredMirror =
        step.env?.['ELECTRON_MIRROR'] ??
        job.env?.['ELECTRON_MIRROR'] ??
        workflow.env?.['ELECTRON_MIRROR'];

      expect(configuredMirror, `${jobName} npm ci should use ELECTRON_MIRROR`).toBe(
        electronMirror,
      );
    }
  });

  it('uses the supported Electron mirror environment variable', async () => {
    const previousElectronMirror = process.env['ELECTRON_MIRROR'];
    process.env['ELECTRON_MIRROR'] = electronMirror;

    let linuxCiUrl: string;

    try {
      linuxCiUrl = await getArtifactRemoteURL({
        version: `v${getLockedElectronVersion()}`,
        artifactName: 'electron',
        platform: 'linux',
        arch: 'x64',
      });
    } finally {
      if (previousElectronMirror === undefined) {
        delete process.env['ELECTRON_MIRROR'];
      } else {
        process.env['ELECTRON_MIRROR'] = previousElectronMirror;
      }
    }

    expect(electronMirror).not.toBe(defaultElectronMirror);
    expect(electronMirror).toMatch(/^https:\/\//);
    expect(electronMirror).toMatch(/\/$/);

    expect(linuxCiUrl).toBe(
      electronArtifactUrl(electronMirror, getLockedElectronVersion(), 'linux', 'x64'),
    );
    expect(linuxCiUrl).not.toContain('github.com/electron/electron/releases/download');
    expect(linuxCiUrl).toMatch(/\/v\d+\.\d+\.\d+\/electron-v\d+\.\d+\.\d+-linux-x64\.zip$/);
  });
});
