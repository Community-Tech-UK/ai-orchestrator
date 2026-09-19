/**
 * Shared capability check for the SEA (single-executable application) build
 * scripts (`build-aio-mcp-cli-sea.ts`, `build-loop-control-cli-sea.ts`,
 * `build-worker-agent-sea.ts`).
 *
 * Node only accepts a postject injection when the running binary was built
 * with the experimental SEA support compiled in — which embeds a sentinel
 * "fuse" string that postject flips after injecting the blob. A Node
 * distribution without that fuse (e.g. an older or custom build) still runs
 * `--experimental-sea-config` without complaint, so without this check the
 * failure only ever surfaced late, inside postject, with a much less useful
 * error. Fail fast, before any SEA artifacts are generated.
 */

import { readFileSync } from 'node:fs';

export const NODE_SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

/** True when a Node executable image contains the SEA sentinel fuse. */
export function nodeBinarySupportsSea(binary: Uint8Array): boolean {
  return Buffer.from(binary).includes(NODE_SEA_FUSE);
}

/** Read the candidate executable once so tests and SEA builders share one capability check. */
export function canBuildSeaWithNode(executablePath: string = process.execPath): boolean {
  try {
    return nodeBinarySupportsSea(readFileSync(executablePath));
  } catch {
    return false;
  }
}

/**
 * Fail before generating an incomplete SEA artifact when the current Node
 * binary omits the fuse that postject must flip after injecting the blob.
 */
export function assertSeaBuildSupported(executablePath: string = process.execPath): void {
  if (!canBuildSeaWithNode(executablePath)) {
    throw new Error(
      `SEA build requires a Node binary that contains the Node SEA fuse, but ${executablePath} does not contain the Node SEA fuse. `
        + 'Use the self-contained Node version pinned in .nvmrc (for example, `nvm use`).',
    );
  }
}
