import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  classifyStartupLog,
  getLaunchCommand,
  getPackagedExecutableCandidates,
} = require('../packaged-startup-smoke.js') as {
  classifyStartupLog: (content: string) => 'pending' | 'ready' | 'failed';
  getLaunchCommand: (options: {
    executablePath: string;
    platform: string;
    env: Record<string, string | undefined>;
  }) => { command: string; args: string[] };
  getPackagedExecutableCandidates: (root: string, platform: string) => string[];
};

describe('packaged startup smoke helpers', () => {
  it('locates unpacked executables for every release platform', () => {
    expect(getPackagedExecutableCandidates('/repo', 'darwin')).toContain(
      '/repo/release/mac-arm64/Harness.app/Contents/MacOS/Harness',
    );
    expect(getPackagedExecutableCandidates('/repo', 'win32')).toContain(
      '/repo/release/win-unpacked/Harness.exe',
    );
    expect(getPackagedExecutableCandidates('/repo', 'linux')).toContain(
      '/repo/release/linux-unpacked/harness',
    );
  });

  it('uses xvfb for a headless Linux launch', () => {
    expect(getLaunchCommand({
      executablePath: '/repo/release/linux-unpacked/harness',
      platform: 'linux',
      env: {},
    })).toEqual({
      command: 'xvfb-run',
      args: ['-a', '/repo/release/linux-unpacked/harness', '--no-sandbox'],
    });
  });

  it('requires the completed startup marker and rejects critical initialization failures', () => {
    expect(classifyStartupLog('{"level":"info","message":"Initializing Harness"}\n'))
      .toBe('pending');
    expect(classifyStartupLog('{"level":"info","message":"Harness initialized"}\n'))
      .toBe('ready');
    expect(classifyStartupLog(
      '{"level":"error","message":"Failed to initialize: IPC handlers"}\n',
    )).toBe('failed');
    expect(classifyStartupLog(
      '{"level":"warn","message":"Context-evidence IPC registered in unavailable mode"}\n',
    )).toBe('failed');
  });
});
