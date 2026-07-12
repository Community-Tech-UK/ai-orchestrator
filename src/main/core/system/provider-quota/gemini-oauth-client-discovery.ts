/**
 * Runtime discovery of the public installed-app OAuth client shipped inside the
 * locally-installed gemini-cli bundle.
 *
 * This is used only by {@link GeminiUsageEndpointProbe}'s legacy
 * `~/.gemini/oauth_creds.json` fallback: that credential file does not carry the
 * OAuth client needed to refresh its access token, so we read the (public,
 * non-confidential) client from the user's machine at runtime rather than
 * committing it to this repo. Best-effort and read-only.
 */

import { readFile as fsReadFile, readdir, realpath, access } from 'fs/promises';
import * as path from 'path';
import { getCliAdditionalPaths } from '../../../cli/cli-environment';

export interface GeminiOAuthClient {
  clientId?: string;
  clientSecret?: string;
}

/** Injectable filesystem ops so the discovery loop is unit-testable. */
export interface GeminiOAuthDiscoveryDeps {
  /** Directories to search for the CLI binaries. Defaults to the CLI PATH. */
  searchDirs?: string[];
  realpath?: (p: string) => Promise<string>;
  readdir?: (p: string) => Promise<string[]>;
  readFile?: (p: string) => Promise<string>;
  access?: (p: string) => Promise<void>;
}

/**
 * Build the directory list to search for the Antigravity/Gemini CLI binaries.
 *
 * A packaged Electron app launched from Finder/Dock inherits the stripped
 * launchd PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), which omits user-managed
 * install dirs like `~/.local/bin` (where `agy` lives) and the active nvm bin
 * (where `gemini` lives). Searching only `process.env.PATH` therefore finds
 * neither binary in the GUI app — so we union the CLI-augmented dirs (nvm,
 * `~/.local/bin`, `~/.npm-global/bin`, Homebrew, …) with whatever PATH does
 * carry. This mirrors how the rest of the app resolves provider CLIs.
 */
function geminiCliSearchDirs(env: NodeJS.ProcessEnv): string[] {
  const augmented = getCliAdditionalPaths(env);
  const fromPath = (env['PATH'] ?? '')
    .split(path.delimiter)
    .filter(Boolean);
  return [...new Set([...augmented, ...fromPath])];
}

/**
 * Discover the public installed-app OAuth client shipped inside the locally
 * installed gemini-cli bundle. The bundle stores it as plain
 * `OAUTH_CLIENT_ID = "…"` / `OAUTH_CLIENT_SECRET = "…"` assignments. Best-effort
 * and read-only; returns null when the CLI isn't installed or the pattern moves.
 *
 * This keeps the (public, non-confidential) client out of this repo — it is read
 * from the user's machine at runtime instead of being committed.
 *
 * Both `agy` and `gemini` are tried, and crucially the search does NOT stop at
 * the first binary it finds on PATH: `agy` now ships as a single compiled
 * Mach-O executable whose directory contains no extractable `.js` bundle, so
 * stopping there yielded no client (→ token refresh failed → a spurious
 * "reauth needed" banner even though the user was signed in). We keep scanning
 * every candidate binary until one bundle actually yields the client.
 */
export async function discoverGeminiOAuthClient(
  env: NodeJS.ProcessEnv,
  deps: GeminiOAuthDiscoveryDeps = {},
): Promise<GeminiOAuthClient | null> {
  const searchDirs = deps.searchDirs ?? geminiCliSearchDirs(env);
  const realpathFn = deps.realpath ?? realpath;
  const readdirFn = deps.readdir ?? ((p: string) => readdir(p));
  const readFileFn = deps.readFile ?? ((p: string) => fsReadFile(p, 'utf8'));
  const accessFn = deps.access ?? ((p: string) => access(p));

  for (const name of ['agy', 'gemini']) {
    for (const dir of searchDirs) {
      if (!dir) continue;
      const binary = path.join(dir, name);
      try {
        await accessFn(binary);
      } catch {
        continue; // not in this dir; try the next
      }
      const client = await extractOAuthClientFromBundle(binary, {
        realpath: realpathFn,
        readdir: readdirFn,
        readFile: readFileFn,
      });
      if (client) return client;
      // Binary exists but its dir yielded no client (e.g. the compiled `agy`);
      // keep scanning so `gemini`'s JS bundle still gets a chance.
    }
  }
  return null;
}

/** Scan a CLI binary's bundle directory for the embedded OAuth client. */
async function extractOAuthClientFromBundle(
  binary: string,
  ops: {
    realpath: (p: string) => Promise<string>;
    readdir: (p: string) => Promise<string[]>;
    readFile: (p: string) => Promise<string>;
  },
): Promise<GeminiOAuthClient | null> {
  let resolved = binary;
  try {
    resolved = await ops.realpath(binary);
  } catch {
    /* use the unresolved path */
  }

  const bundleDir = path.dirname(resolved);
  let entries: string[];
  try {
    entries = await ops.readdir(bundleDir);
  } catch {
    return null;
  }

  // The client lives in the main entry + lazily-loaded chunk-*.js files.
  const candidates = entries
    .filter((name) => name.endsWith('.js'))
    .sort((a, b) => Number(b.startsWith('chunk-')) - Number(a.startsWith('chunk-')));

  for (const name of candidates) {
    let text: string;
    try {
      text = await ops.readFile(path.join(bundleDir, name));
    } catch {
      continue;
    }
    const idMatch = /OAUTH_CLIENT_ID\s*=\s*["']([^"']+)["']/.exec(text);
    const secretMatch = /OAUTH_CLIENT_SECRET\s*=\s*["']([^"']+)["']/.exec(text);
    if (idMatch?.[1] && secretMatch?.[1]) {
      return { clientId: idMatch[1], clientSecret: secretMatch[1] };
    }
  }
  return null;
}
