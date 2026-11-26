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
 * Wired into `npm run electron:build` (--platform=host --strict), CI packaging
 * (--platform=host --strict) and `npm run dev` / `npm start`
 * (--platform=host --soft, warns and continues offline). `npm run fetch:rtk`
 * fetches every platform. The remote worker build (build-worker-agent.ts)
 * passes --current-platform. Run manually: `node scripts/fetch-rtk-binaries.js`.
 *
 * Flags:
 *  --platform=<darwin|linux|win32|host>  fetch only that platform's targets
 *  --current-platform  fetch only this machine's platform-arch target; with no
 *            pinned binary for it, warn and exit 0 (worker runs without RTK)
 *  --strict  exit 1 when any selected target fails; retry each download once
 *  --soft    warn on any failure and always exit 0 (cmd.exe-safe, no `||`)
 *
 * Every download attempt is bounded by a hard transfer deadline (connect,
 * headers and body share one clock) so a stalled transfer can never hang
 * `npm run dev` / `npm start` forever — including `--soft`. On the deadline the
 * request, response and partial file are torn down and the attempt fails;
 * `--strict` then retries once (also bounded) and `--soft` warns and continues.
 * Defaults: 30s in `--soft` (the startup path), 120s otherwise; override with
 * FETCH_RTK_DEADLINE_MS (milliseconds).
 *
 * To bump the pinned version:
 *  1. Update RTK_VERSION below
 *  2. Independently verify the new release binaries and obtain their SHA256 pins
 *  3. Update scripts/rtk-binaries.sha256.json (version and all selected pins)
 *  4. Update RTK_BUNDLED_VERSION in src/main/cli/rtk/rtk-runtime.ts
 *  5. Run src/main/cli/rtk/rtk-version-pins.spec.ts; commit all three pins together
 * The binaries under resources/rtk are no longer tracked in git; the build
 * downloads them and checks them against the fixed fingerprints.
 *
 * To bypass for local dev / CI runs that don't need rtk: set FETCH_RTK_SKIP=1.
 */

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const RTK_VERSION = '0.52.0';
const licensePath = path.join(__dirname, 'licenses', `rtk-${RTK_VERSION}-LICENSE`);
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

/** Hard transfer deadline per download attempt; see the header. */
const DOWNLOAD_DEADLINE_MS = 120_000;
/** `--soft` runs on the dev/startup path, so it bounds a stall more tightly. */
const DOWNLOAD_DEADLINE_SOFT_MS = 30_000;

/**
 * Deadline for one download attempt in the run's mode. FETCH_RTK_DEADLINE_MS
 * (a positive millisecond count) overrides both defaults. Exported for unit
 * tests.
 */
function deadlineMsFor(mode, env = process.env) {
  const raw = Number(env.FETCH_RTK_DEADLINE_MS);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return mode === 'soft' ? DOWNLOAD_DEADLINE_SOFT_MS : DOWNLOAD_DEADLINE_MS;
}

/**
 * Pick the targets for a platform filter. `host` follows `process.platform`;
 * `--current-platform` keeps only the exact platform-arch target.
 * Exported for unit tests.
 */
function selectTargets(argv, platform = process.platform, arch = process.arch) {
  if (argv.includes('--current-platform')) return TARGETS.filter((target) => target.key === `${platform}-${arch}`);
  const flag = argv.find((arg) => String(arg).startsWith('--platform='));
  const requested = flag ? String(flag).slice('--platform='.length) : undefined;
  if (requested === undefined || requested === 'all') return [...TARGETS];
  const resolved = requested === 'host' ? platform : requested;
  if (!['darwin', 'linux', 'win32'].includes(resolved)) {
    throw new Error(`Unknown --platform=${requested}; use darwin, linux, win32, host or all`);
  }
  return TARGETS.filter((target) => target.key.startsWith(`${resolved}-`));
}

/**
 * Exit policy. `strict`: any selected target failing is fatal. `soft`: never
 * fatal. Default (no flag): only an all-failed run is fatal (historical).
 * Exported for unit tests.
 */
function decideExit(results, mode) {
  const errors = results.filter((result) => result.error);
  if (mode === 'soft') return 0;
  if (mode === 'strict') return errors.length > 0 ? 1 : 0;
  return errors.length === results.length && results.length > 0 ? 1 : 0;
}

function usage() {
  console.error('[rtk] usage: node scripts/fetch-rtk-binaries.js [--platform=darwin|linux|win32|host|all | --current-platform] [--strict|--soft]');
}

function sha256OfFile(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function loadManifest() {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!parsed || parsed.version !== RTK_VERSION) {
      throw new Error(`manifest version must match pinned RTK_VERSION (${RTK_VERSION})`);
    }
    if (!parsed.hashes || typeof parsed.hashes !== 'object' || Array.isArray(parsed.hashes)) {
      throw new Error('manifest hashes must be an object of SHA256 pins');
    }
    return parsed;
  } catch (err) {
    throw new Error(`Could not load trusted RTK manifest at ${manifestPath}: ${err.message}`);
  }
}

function expectedHashFor(target, manifest) {
  const hash = manifest.hashes[target.key];
  if (!Object.hasOwn(manifest.hashes, target.key) || typeof hash !== 'string' || !/^[a-fA-F0-9]{64}$/.test(hash)) {
    throw new Error(`manifest is missing a valid SHA256 pin for ${target.key}`);
  }
  return hash.toLowerCase();
}

/**
 * One bounded download attempt. The deadline covers connect, redirects, headers
 * and body; when it fires, the request, response, write stream and partial file
 * are torn down so a stalled transfer can never hang the caller.
 */
function download(url, dest, options = {}) {
  const deadlineMs = Number.isFinite(options.deadlineMs) && options.deadlineMs > 0
    ? options.deadlineMs
    : DOWNLOAD_DEADLINE_MS;
  return new Promise((resolve, reject) => {
    let settled = false;
    let request = null;
    let response = null;
    let out = null;
    const timer = setTimeout(() => {
      fail(new Error(`download timed out after ${deadlineMs}ms: ${url}`));
    }, deadlineMs);
    function cleanupStreams() {
      clearTimeout(timer);
      if (response) {
        try { response.destroy(); } catch { /* best-effort */ }
        response = null;
      }
      if (request) {
        try { request.destroy(); } catch { /* best-effort */ }
        request = null;
      }
      if (out) {
        try { out.destroy(); } catch { /* best-effort */ }
        out = null;
      }
      try { fs.rmSync(dest, { force: true }); } catch { /* best-effort */ }
    }
    function fail(err) {
      if (settled) return;
      settled = true;
      cleanupStreams();
      reject(err);
    }
    function succeed() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    }
    const followRedirects = (currentUrl, hops = 0) => {
      if (hops > 5) {
        fail(new Error(`Too many redirects fetching ${url}`));
        return;
      }
      try {
        request = https.get(currentUrl, (res) => {
          if (settled) {
            try { res.destroy(); } catch { /* best-effort */ }
            return;
          }
          response = res;
          if (res.statusCode === 301 || res.statusCode === 302) {
            const next = res.headers.location;
            if (!next) {
              fail(new Error(`Redirect from ${currentUrl} had no Location header`));
              return;
            }
            res.resume();
            response = null;
            followRedirects(next, hops + 1);
            return;
          }
          if (res.statusCode !== 200) {
            fail(new Error(`HTTP ${res.statusCode} for ${currentUrl}`));
            return;
          }
          out = fs.createWriteStream(dest);
          const stream = out;
          res.pipe(stream);
          stream.on('finish', () => stream.close((err) => (err ? fail(err) : succeed())));
          stream.on('error', fail);
        });
        request.on('error', fail);
        // Socket-level stall guard on top of the hard deadline; optional because
        // synthetic transports may not model ClientRequest#setTimeout.
        if (typeof request.setTimeout === 'function') {
          request.setTimeout(deadlineMs);
          request.on('timeout', () => fail(new Error(`download stalled (socket idle ${deadlineMs}ms): ${currentUrl}`)));
        }
      } catch (err) {
        fail(err);
      }
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

async function ensureTarget(target, manifest, options = {}) {
  const targetDir = path.join(outputRoot, target.key);
  const finalBinary = path.join(targetDir, target.binary);
  const expectedHash = expectedHashFor(target, manifest);
  // Restore a missing licence even on the already-downloaded fast path.
  fs.mkdirSync(targetDir, { recursive: true });
  const license = fs.readFileSync(licensePath, 'utf8');
  if (!license.includes('Apache License') || !license.includes('Version 2.0')) {
    throw new Error('Pinned RTK Apache licence is missing or invalid');
  }
  fs.writeFileSync(path.join(targetDir, 'LICENSE'), license);

  if (fs.existsSync(finalBinary)) {
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
    try {
      await download(url, archivePath, { deadlineMs: options.deadlineMs });
    } catch (firstError) {
      if (!options.retry) throw firstError;
      console.warn(`[rtk] ${target.key}: download failed, retrying once`);
      await download(url, archivePath, { deadlineMs: options.deadlineMs });
    }
    const archiveHash = manifest.archiveHashes?.[target.key];
    if (archiveHash && sha256OfFile(archivePath) !== archiveHash) {
      throw new Error(`${target.key}: downloaded archive sha256 does not match the pinned release`);
    }

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

    const actualHash = sha256OfFile(extractedBinary);
    if (expectedHash !== actualHash) {
      throw new Error(
        `${target.key}: sha256 mismatch — manifest expects ${expectedHash}, downloaded ${actualHash}. ` +
          'Verify the release and its trusted manifest before retrying.',
      );
    }
    fs.copyFileSync(extractedBinary, finalBinary);
    const installedHash = sha256OfFile(finalBinary);
    if (installedHash !== expectedHash) {
      fs.unlinkSync(finalBinary);
      throw new Error(`${target.key}: installed sha256 mismatch — manifest expects ${expectedHash}, copied ${installedHash}`);
    }
    if (process.platform !== 'win32' && target.key !== 'win32-x64') {
      fs.chmodSync(finalBinary, 0o755);
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

async function main(argv = process.argv.slice(2), platform = process.platform) {
  const strict = argv.includes('--strict');
  const soft = argv.includes('--soft');
  if (strict && soft) {
    usage();
    process.exitCode = 2;
    return;
  }
  const mode = strict ? 'strict' : soft ? 'soft' : 'default';
  if (process.env.FETCH_RTK_SKIP === '1') {
    console.log('[rtk] FETCH_RTK_SKIP=1 — skipping');
    return;
  }

  let targets;
  try {
    targets = selectTargets(argv, platform);
  } catch (error) {
    if (soft) {
      console.warn(`[rtk] ${error.message}`);
      return;
    }
    throw error;
  }
  if (targets.length === 0) {
    console.warn(`[rtk] No pinned binary for ${platform}-${process.arch}; worker will run without bundled RTK`);
    return;
  }

  let manifest;
  try {
    manifest = loadManifest();
    // Validate EVERY selected pin before even the first cache check or download.
    // Soft/dev may continue startup, but must never provision unverified code.
    for (const target of targets) expectedHashFor(target, manifest);
  } catch (error) {
    const message = `[rtk] ${error.message}; provisioning skipped`;
    if (soft) console.warn(message);
    else console.error(message);
    process.exitCode = soft ? 0 : 1;
    return;
  }
  fs.mkdirSync(outputRoot, { recursive: true });

  const results = [];
  for (const target of targets) {
    try {
      const result = await ensureTarget(target, manifest, { retry: strict, deadlineMs: deadlineMsFor(mode) });
      results.push(result);
    } catch (err) {
      console.error(`[rtk] ${target.key}: ${err.message}`);
      // In default mode one failed platform does not fail the run: CI for that
      // platform fails at package time. --strict turns any failure into a
      // failed build; --soft only warns.
      results.push({ key: target.key, error: err.message });
    }
  }

  const errors = results.filter((r) => r.error);
  if (errors.length > 0) {
    const summary = `[rtk] ${errors.length} target(s) failed; ${results.length - errors.length} succeeded`;
    if (soft) console.warn(summary);
    else console.error(summary);
    if (errors.length === results.length) console.error('[rtk] All targets failed to fetch');
  }
  process.exitCode = decideExit(results, mode);
}

if (require.main === module) {
  main().catch((err) => {
    if (process.argv.includes('--soft')) {
      console.warn('[rtk] fatal:', err);
      process.exitCode = 0;
      return;
    }
    console.error('[rtk] fatal:', err);
    process.exitCode = 1;
  });
}

module.exports = { selectTargets, decideExit, deadlineMsFor, TARGETS, RTK_VERSION };
