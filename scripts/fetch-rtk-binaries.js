/* eslint-env node */
/**
 * Fetch and verify RTK binaries from GitHub releases.
 *
 * RTK (Rust Token Killer) is a single-binary CLI we shell out to from
 * src/main/cli/rtk/rtk-runtime.ts to compress LLM-bound shell command output.
 *
 * This script:
 *  - Downloads per-platform RTK binaries from rtk-ai/rtk GitHub releases
 *  - Verifies SHA256 against scripts/rtk-binaries.sha256.json
 *  - Extracts to resources/rtk/<platform>-<arch>/rtk[.exe]
 *  - Is idempotent: re-runs no-op if extracted files match expected hash
 *
 * Wired into npm `prebuild` and `predev`. Run manually: `node scripts/fetch-rtk-binaries.js`.
 *
 * To bump the pinned version:
 *  1. Update RTK_VERSION below
 *  2. Run this script (it'll download but mismatch hashes, capture printed actuals)
 *  3. Update scripts/rtk-binaries.sha256.json with the printed actuals
 *  4. Commit both files
 *
 * To bypass for local dev / CI runs that don't need rtk: set FETCH_RTK_SKIP=1.
 */

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const RTK_VERSION = '0.39.0';
const projectRoot = path.resolve(__dirname, '..');
const outputRoot = path.join(projectRoot, 'resources', 'rtk');
const manifestPath = path.join(__dirname, 'rtk-binaries.sha256.json');

/**
 * Mapping of our internal (platform, arch) → RTK release asset name.
 * RTK release naming convention:
 *   rtk-<rust-target-triple>.tar.gz  (or .zip on Windows)
 *
 * The internal key uses Node's `process.platform` + `process.arch` values
 * because that's what `rtk-runtime.ts` will use to resolve the binary at runtime.
 */
const TARGETS = [
  {
    key: 'darwin-arm64',
    asset: 'rtk-aarch64-apple-darwin.tar.gz',
    archive: 'tar.gz',
    binary: 'rtk',
  },
  {
    key: 'darwin-x64',
    asset: 'rtk-x86_64-apple-darwin.tar.gz',
    archive: 'tar.gz',
    binary: 'rtk',
  },
  {
    key: 'linux-x64',
    asset: 'rtk-x86_64-unknown-linux-musl.tar.gz',
    archive: 'tar.gz',
    binary: 'rtk',
  },
  {
    key: 'linux-arm64',
    asset: 'rtk-aarch64-unknown-linux-gnu.tar.gz',
    archive: 'tar.gz',
    binary: 'rtk',
  },
  {
    key: 'win32-x64',
    asset: 'rtk-x86_64-pc-windows-msvc.zip',
    archive: 'zip',
    binary: 'rtk.exe',
  },
];

const RELEASE_BASE = `https://github.com/rtk-ai/rtk/releases/download/v${RTK_VERSION}`;

function sha256OfFile(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function loadManifest() {
  if (!fs.existsSync(manifestPath)) {
    return { version: RTK_VERSION, hashes: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (parsed.version !== RTK_VERSION) {
      console.warn(
        `[rtk] manifest version (${parsed.version}) differs from pinned RTK_VERSION (${RTK_VERSION}); treating manifest as stale`,
      );
      return { version: RTK_VERSION, hashes: {} };
    }
    return parsed;
  } catch (err) {
    console.warn(`[rtk] could not parse manifest at ${manifestPath}: ${err.message}`);
    return { version: RTK_VERSION, hashes: {} };
  }
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const followRedirects = (currentUrl, hops = 0) => {
      if (hops > 5) {
        reject(new Error(`Too many redirects fetching ${url}`));
        return;
      }
      https
        .get(currentUrl, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302) {
            const next = res.headers.location;
            if (!next) {
              reject(new Error(`Redirect from ${currentUrl} had no Location header`));
              return;
            }
            res.resume();
            followRedirects(next, hops + 1);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} for ${currentUrl}`));
            return;
          }
          const out = fs.createWriteStream(dest);
          res.pipe(out);
          out.on('finish', () => out.close((err) => (err ? reject(err) : resolve())));
          out.on('error', reject);
        })
        .on('error', reject);
    };
    followRedirects(url);
  });
}

function extractTarGz(archivePath, destDir) {
  // Use system tar — present on macOS, Linux, and Windows 10+.
  const result = spawnSync('tar', ['-xzf', archivePath, '-C', destDir], {
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`tar -xzf ${archivePath} failed (exit ${result.status})`);
  }
}

function extractZip(archivePath, destDir) {
  if (process.platform === 'win32') {
    // PowerShell Expand-Archive is universal on Windows 10+.
    const result = spawnSync(
      'powershell',
      ['-NoProfile', '-Command', `Expand-Archive -Path "${archivePath}" -DestinationPath "${destDir}" -Force`],
      { stdio: 'inherit' },
    );
    if (result.status !== 0) {
      throw new Error(`Expand-Archive ${archivePath} failed (exit ${result.status})`);
    }
  } else {
    const result = spawnSync('unzip', ['-o', archivePath, '-d', destDir], { stdio: 'inherit' });
    if (result.status !== 0) {
      throw new Error(`unzip ${archivePath} failed (exit ${result.status})`);
    }
  }
}

/**
 * Find the rtk binary inside an extracted directory.
 * RTK archives may include a top-level folder or place the binary at the root;
 * we walk a shallow tree to be tolerant of either.
 */
function findBinary(searchRoot, expectedName) {
  const direct = path.join(searchRoot, expectedName);
  if (fs.existsSync(direct)) return direct;

  const entries = fs.readdirSync(searchRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const candidate = path.join(searchRoot, entry.name, expectedName);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

async function ensureTarget(target, manifest) {
  const targetDir = path.join(outputRoot, target.key);
  const finalBinary = path.join(targetDir, target.binary);
  const expectedHash = manifest.hashes[target.key];

  if (fs.existsSync(finalBinary) && expectedHash) {
    const actualHash = sha256OfFile(finalBinary);
    if (actualHash === expectedHash) {
      console.log(`[rtk] ${target.key}: already present, hash matches manifest`);
      return { key: target.key, hash: actualHash, fromCache: true };
    }
    console.warn(
      `[rtk] ${target.key}: present but sha256 mismatch (manifest=${expectedHash}, actual=${actualHash}); re-downloading`,
    );
  }

  fs.mkdirSync(targetDir, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtk-fetch-'));
  const archivePath = path.join(tmpDir, target.asset);

  const url = `${RELEASE_BASE}/${target.asset}`;
  console.log(`[rtk] ${target.key}: downloading ${url}`);
  try {
    await download(url, archivePath);

    if (target.archive === 'tar.gz') {
      extractTarGz(archivePath, tmpDir);
    } else if (target.archive === 'zip') {
      extractZip(archivePath, tmpDir);
    } else {
      throw new Error(`Unknown archive type ${target.archive} for ${target.key}`);
    }

    const extractedBinary = findBinary(tmpDir, target.binary);
    if (!extractedBinary) {
      throw new Error(`Could not locate ${target.binary} inside ${target.asset}`);
    }

    fs.copyFileSync(extractedBinary, finalBinary);
    if (process.platform !== 'win32' && target.key !== 'win32-x64') {
      fs.chmodSync(finalBinary, 0o755);
    }

    const actualHash = sha256OfFile(finalBinary);
    if (expectedHash && expectedHash !== actualHash) {
      // Quarantine the binary so we don't ship a mismatched artifact.
      fs.unlinkSync(finalBinary);
      throw new Error(
        `${target.key}: sha256 mismatch — manifest expects ${expectedHash}, downloaded ${actualHash}. ` +
          `If you bumped RTK_VERSION, update scripts/rtk-binaries.sha256.json with the actual hash above.`,
      );
    }
    console.log(`[rtk] ${target.key}: extracted, sha256=${actualHash}`);
    return { key: target.key, hash: actualHash, fromCache: false };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

async function main() {
  if (process.env.FETCH_RTK_SKIP === '1') {
    console.log('[rtk] FETCH_RTK_SKIP=1 — skipping');
    return;
  }

  fs.mkdirSync(outputRoot, { recursive: true });
  const manifest = loadManifest();

  const results = [];
  for (const target of TARGETS) {
    try {
      const result = await ensureTarget(target, manifest);
      results.push(result);
    } catch (err) {
      console.error(`[rtk] ${target.key}: ${err.message}`);
      // Don't fail the whole run if one platform fails to fetch; CI for that
      // platform will fail at package time. Other platforms must still succeed.
      results.push({ key: target.key, error: err.message });
    }
  }

  // If the manifest was empty (first run after version bump), emit a manifest snippet.
  const missingHashes = results.filter((r) => !r.error && !manifest.hashes[r.key]);
  if (missingHashes.length > 0) {
    const snippet = {
      version: RTK_VERSION,
      hashes: Object.fromEntries(
        results.filter((r) => !r.error).map((r) => [r.key, manifest.hashes[r.key] || r.hash]),
      ),
    };
    console.log('');
    console.log('[rtk] One or more hashes were missing from the manifest.');
    console.log('[rtk] Update scripts/rtk-binaries.sha256.json with:');
    console.log(JSON.stringify(snippet, null, 2));
  }

  const errors = results.filter((r) => r.error);
  if (errors.length === results.length) {
    console.error('[rtk] All targets failed to fetch');
    process.exit(1);
  }
  if (errors.length > 0) {
    console.warn(`[rtk] ${errors.length} target(s) failed; ${results.length - errors.length} succeeded`);
  }
}

main().catch((err) => {
  console.error('[rtk] fatal:', err);
  process.exit(1);
});
