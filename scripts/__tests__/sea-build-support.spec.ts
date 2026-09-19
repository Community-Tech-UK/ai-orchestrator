import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertSeaBuildSupported,
  canBuildSeaWithNode,
  NODE_SEA_FUSE,
  nodeBinarySupportsSea,
} from '../sea-build-support';

const scratchDirectories: string[] = [];

afterEach(() => {
  for (const directory of scratchDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('SEA build support', () => {
  it('recognizes the Node SEA fuse in a binary image', () => {
    expect(nodeBinarySupportsSea(Buffer.from('ordinary Node executable'))).toBe(false);
    expect(nodeBinarySupportsSea(Buffer.from(`prefix ${NODE_SEA_FUSE}:0 suffix`))).toBe(true);
  });

  it('rejects a Node binary without the SEA fuse before postject runs', () => {
    const scratchDirectory = mkdtempSync(join(tmpdir(), 'aio-sea-support-'));
    scratchDirectories.push(scratchDirectory);
    const binaryPath = join(scratchDirectory, 'node');
    writeFileSync(binaryPath, 'not SEA capable');

    expect(() => assertSeaBuildSupported(binaryPath)).toThrow(/does not contain the Node SEA fuse/);
    expect(canBuildSeaWithNode(binaryPath)).toBe(false);
  });

  it('accepts a binary that contains the fuse', () => {
    const scratchDirectory = mkdtempSync(join(tmpdir(), 'aio-sea-support-'));
    scratchDirectories.push(scratchDirectory);
    const binaryPath = join(scratchDirectory, 'node');
    writeFileSync(binaryPath, `header bytes ${NODE_SEA_FUSE}:0 trailer bytes`);

    expect(canBuildSeaWithNode(binaryPath)).toBe(true);
    expect(() => assertSeaBuildSupported(binaryPath)).not.toThrow();
  });

  it('treats a missing executable as unsupported rather than throwing from the read', () => {
    expect(canBuildSeaWithNode('/nonexistent/path/to/node')).toBe(false);
    expect(() => assertSeaBuildSupported('/nonexistent/path/to/node')).toThrow(
      /does not contain the Node SEA fuse/,
    );
  });
});
