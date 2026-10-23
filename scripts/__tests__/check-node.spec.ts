import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { isSupportedNodeVersion } = require('../check-node.js') as {
  isSupportedNodeVersion: (version: string) => boolean;
};

describe('check-node', () => {
  it.each([
    ['v22.22.3', false],
    ['v22.23.3', false],
    ['v22.23.4', true],
    ['v22.24.0', true],
    ['v23.11.1', false],
    ['v24.15.0', false],
    ['v24.22.0', false],
    ['v24.22.1', true],
    ['v24.23.0', true],
    ['v25.6.0', false],
    ['v26.12.0', false],
    ['v26.12.1', true],
    ['v26.13.0', true],
    ['v27.0.0', false],
  ])('reports supported, security-patched Node %s as %s', (version, expected) => {
    expect(isSupportedNodeVersion(version)).toBe(expected);
  });
});
