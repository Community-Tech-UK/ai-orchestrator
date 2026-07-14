import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getElectronBuilderArgs, getNpmInvocation } = require('../localbuild.js') as {
  getElectronBuilderArgs: (platform?: string) => string[];
  getNpmInvocation: () => { command: string; args: string[] };
};

describe('getElectronBuilderArgs', () => {
  it('builds only the arm64 DMG with the local real-identity signer on macOS', () => {
    expect(getElectronBuilderArgs('darwin')).toEqual([
      '--mac',
      'dmg',
      '--arm64',
      '--config.mac.notarize=false',
    ]);
  });

  it('builds only the x64 NSIS setup package on Windows', () => {
    expect(getElectronBuilderArgs('win32')).toEqual([
      '--win',
      'nsis',
      '--x64',
      '--config.win.signAndEditExecutable=false',
    ]);
  });

  it('builds Linux artifacts on Linux', () => {
    expect(getElectronBuilderArgs('linux')).toEqual(['--linux']);
  });

  it('throws for unsupported platforms', () => {
    expect(() => getElectronBuilderArgs('freebsd')).toThrowError(
      'Unsupported platform for localbuild: freebsd',
    );
  });
});

describe('getNpmInvocation', () => {
  it('reuses npm_execpath when npm provides a JS entrypoint', () => {
    const original = process.env['npm_execpath'];
    process.env['npm_execpath'] = 'C:/npm/bin/npm-cli.js';

    expect(getNpmInvocation()).toEqual({
      command: process.execPath,
      args: ['C:/npm/bin/npm-cli.js'],
    });

    process.env['npm_execpath'] = original;
  });
});
