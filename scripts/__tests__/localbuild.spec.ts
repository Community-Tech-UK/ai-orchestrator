import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getElectronBuilderArgs, getNpmInvocation } = require('../localbuild.js') as {
  getElectronBuilderArgs: (platform?: string) => string[];
  getNpmInvocation: () => { command: string; args: string[] };
};

describe('getElectronBuilderArgs', () => {
  it('uses unsigned mac builds on macOS', () => {
    expect(getElectronBuilderArgs('darwin')).toEqual(['--mac', '--config.mac.identity=null']);
  });

  it('builds Windows artifacts on Windows', () => {
    expect(getElectronBuilderArgs('win32')).toEqual([
      '--win',
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
