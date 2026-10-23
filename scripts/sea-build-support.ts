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
 *
 * A SEA also embeds the Node runtime that builds it, so building on a Node
 * below the security floor in `check-node.js` would ship that runtime's
 * vulnerabilities (October 2026 security release: CVE-2026-111497, and
 * CVE-2026-106074, which specifically requires SEAs to be rebuilt).
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const localRequire = createRequire(__filename);
const { isSupportedNodeVersion } = localRequire('./check-node.js') as {
  isSupportedNodeVersion: (version: string) => boolean;
};

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
 * Fail before generating an incomplete or vulnerable SEA artifact: the Node
 * that runs the build must be at or above the `check-node.js` security floor,
 * and its binary must contain the fuse that postject flips after injecting
 * the blob.
 */
export function assertSeaBuildSupported(
  executablePath: string = process.execPath,
  nodeVersion: string = process.version,
): void {
  if (!isSupportedNodeVersion(nodeVersion)) {
    throw new Error(
      `SEA build refuses Node ${nodeVersion}: the executable would embed a Node runtime below the security floor in scripts/check-node.js. `
        + 'Use the Node version pinned in .nvmrc (for example, `nvm use`).',
    );
  }
  if (!canBuildSeaWithNode(executablePath)) {
    throw new Error(
      `SEA build requires a Node binary that contains the Node SEA fuse, but ${executablePath} does not contain the Node SEA fuse. `
        + 'Use the self-contained Node version pinned in .nvmrc (for example, `nvm use`).',
    );
  }
}
