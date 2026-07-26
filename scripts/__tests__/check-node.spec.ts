import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { isSupportedNodeVersion } = require('../check-node.js') as {
  isSupportedNodeVersion: (version: string) => boolean;
};

describe('check-node', () => {
  it.each([
    ['v22.22.2', false],
    ['v22.22.3', true],
    ['v23.11.1', false],
    ['v24.14.0', false],
    ['v24.15.0', true],
    ['v25.6.0', false],
    ['v26.0.0', true],
    ['v27.0.0', false],
  ])('reports Angular 22 support for Node %s as %s', (version, expected) => {
    expect(isSupportedNodeVersion(version)).toBe(expected);
  });
});
