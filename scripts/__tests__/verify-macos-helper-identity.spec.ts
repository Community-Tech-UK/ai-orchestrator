import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const verifier = require('../verify-macos-helper-identity.js') as {
  parseCodeSignMetadata: (output: string) => {
    identifier?: string;
    teamIdentifier?: string;
    signature?: string;
  };
  verifyMacHelperIdentity: (
    appPath: string,
    deps: {
      pathExists: (targetPath: string) => boolean;
      readMetadata: (targetPath: string) => {
        identifier?: string;
        teamIdentifier?: string;
        signature?: string;
      };
    },
  ) => { appTeamIdentifier: string; helperTeamIdentifier: string };
};

describe('macOS helper identity verifier', () => {
  it('provides metadata parsing and ownership verification entry points', () => {
    expect(verifier.parseCodeSignMetadata).toBeTypeOf('function');
    expect(verifier.verifyMacHelperIdentity).toBeTypeOf('function');
  });

  it('parses the identity fields emitted by codesign', () => {
    expect(verifier.parseCodeSignMetadata([
      'Identifier=com.ai.orchestrator',
      'Signature size=4789',
      'TeamIdentifier=TEAM123456',
    ].join('\n'))).toEqual({
      identifier: 'com.ai.orchestrator',
      signature: 'size=4789',
      teamIdentifier: 'TEAM123456',
    });
  });

  it('accepts matching non-empty app and helper Team IDs', () => {
    const result = verifier.verifyMacHelperIdentity('/tmp/Harness.app', {
      pathExists: () => true,
      readMetadata: (targetPath) => ({
        identifier: targetPath.endsWith('desktop-helper')
          ? 'desktop-helper'
          : 'com.ai.orchestrator',
        signature: 'size=4789',
        teamIdentifier: 'TEAM123456',
      }),
    });

    expect(result).toEqual({
      appTeamIdentifier: 'TEAM123456',
      helperTeamIdentifier: 'TEAM123456',
    });
  });

  it.each([
    {
      name: 'missing helper',
      pathExists: () => false,
      readMetadata: () => ({}),
      expected: 'Packaged macOS desktop helper is missing',
    },
    {
      name: 'ad-hoc signatures',
      pathExists: () => true,
      readMetadata: () => ({ teamIdentifier: 'not set' }),
      expected: 'must use a real code-signing identity',
    },
    {
      name: 'mismatched teams',
      pathExists: () => true,
      readMetadata: (targetPath: string) => ({
        teamIdentifier: targetPath.endsWith('desktop-helper') ? 'TEAM999999' : 'TEAM123456',
      }),
      expected: 'must share the same Team ID',
    },
  ])('rejects $name', ({ pathExists, readMetadata, expected }) => {
    expect(() => verifier.verifyMacHelperIdentity('/tmp/Harness.app', {
      pathExists,
      readMetadata,
    })).toThrow(expected);
  });
});
