#!/usr/bin/env node
/* eslint-env node */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  extractContractsChannelEntries,
} = require('./ipc-channel-utils');

const ROOT = path.resolve(__dirname, '..');
const CONTRACTS_CHANNELS_INDEX_PATH = path.join(ROOT, 'packages/contracts/src/channels/index.ts');
const PRELOAD_DOMAINS_DIR = path.join(ROOT, 'src/preload/domains');
const OUTPUT_PATH = path.join(ROOT, 'docs/generated/architecture-inventory.json');
const SKIPPED_DIRS = new Set([
  '.git',
  '.worktrees',
  'coverage',
  'dist',
  'mempalace-reference',
  'node_modules',
  'out',
  'release',
]);

let indexedFilesCache = null;

function walk(dir, matcher, results = []) {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      walk(fullPath, matcher, results);
    } else if (matcher(fullPath)) {
      results.push(fullPath);
    }
  }
  return results;
}

function toPosixPath(filePath) {
  // Normalize separators so generated paths are byte-identical across platforms.
  // Without this, a Windows-generated inventory uses "\" and fails `--check` on
  // Linux CI (and vice versa). Forward slashes never appear inside a Windows
  // path component and git always reports "/", so converting is safe everywhere.
  return filePath.replace(/\\/g, '/');
}

function relative(filePath) {
  return toPosixPath(path.relative(ROOT, filePath));
}

function readIndexedFiles() {
  if (indexedFilesCache) return indexedFilesCache;

  try {
    indexedFilesCache = execFileSync('git', ['ls-files', '-z', '--cached'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .split('\0')
      .filter(Boolean)
      .map((file) => path.join(ROOT, file));
    return indexedFilesCache;
  } catch {
    indexedFilesCache = walk(ROOT, (file) => true);
    return indexedFilesCache;
  }
}

/**
 * Read each file's content as it exists **in the git index**, not on disk.
 *
 * Same determinism contract as `toPosixPath` above, one layer down: this file is
 * a generated artifact committed to the repo, so its content must be a pure
 * function of the tree being committed. Reading the working tree broke that —
 * a tracked file left modified-but-unstaged made `--write` (pre-commit) bake in
 * a value no clean checkout can reproduce, so `--check` passed locally and
 * failed in CI on the very same commit.
 *
 * That is not a hypothetical: this repo's plan/livetest lifecycle deliberately
 * keeps tracked docs (e.g. `docs/plans/livetest-remediation-register.md`) dirty
 * and unstaged for long stretches, and `git commit --only <path>` leaves every
 * other modified file unstaged too. The index is exactly what the resulting
 * commit will contain — and in CI, index, HEAD and working tree are identical —
 * so keying off it makes local and CI runs agree by construction.
 *
 * One `git cat-file --batch` process for the whole set; per-file `git show`
 * would be thousands of spawns.
 */
function readIndexedFileContents(files) {
  const contents = new Map();
  if (files.length === 0) return contents;

  let batch;
  try {
    batch = execFileSync('git', ['cat-file', '--batch', '-z'], {
      cwd: ROOT,
      // NUL-delimited input so paths containing spaces or newlines survive.
      input: `${files.map((file) => `:${relative(file)}`).join('\0')}\0`,
      maxBuffer: 512 * 1024 * 1024,
    });
  } catch {
    // No git available — same fallback as readIndexedFiles().
    for (const file of files) {
      contents.set(file, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
    }
    return contents;
  }

  // Response per object: "<oid> <type> <size>\n<content>\n".
  let offset = 0;
  for (const file of files) {
    const headerEnd = batch.indexOf(0x0a, offset);
    if (headerEnd === -1) break;
    const header = batch.toString('utf8', offset, headerEnd);
    offset = headerEnd + 1;

    const size = Number(header.split(' ')[2]);
    if (!Number.isFinite(size)) {
      // "<rev> missing" — no content follows, so don't advance past any.
      contents.set(file, '');
      continue;
    }

    contents.set(file, batch.toString('utf8', offset, offset + size));
    offset += size + 1;
  }
  return contents;
}

function readIndexedFilesMatching(matcher) {
  return readIndexedFiles()
    .filter(matcher)
    .sort((a, b) => relative(a).localeCompare(relative(b)));
}

function readProviderNames() {
  const providersDir = path.join(ROOT, 'src/main/providers');
  const providerFiles = readIndexedFilesMatching((file) =>
    file.startsWith(`${providersDir}${path.sep}`)
    && (file.endsWith('-provider.ts') || file.endsWith('provider-runtime-service.ts')),
  );
  return providerFiles.map(relative).sort();
}

function readPreloadDomains() {
  return readIndexedFilesMatching((file) =>
    path.dirname(file) === PRELOAD_DOMAINS_DIR && path.basename(file).endsWith('.preload.ts'),
  ).map((file) => path.basename(file));
}

function readLargeFiles() {
  const files = readIndexedFilesMatching((file) => {
    if (!/\.(ts|js|html|scss|md)$/.test(file)) return false;
    const rel = relative(file);
    return !rel.startsWith('node_modules/') && !rel.startsWith('dist/');
  });
  const contents = readIndexedFileContents(files);

  return files
    .map((file) => ({
      path: relative(file),
      lines: (contents.get(file) ?? '').split(/\r?\n/).length,
    }))
    .filter((entry) => entry.lines >= 800)
    .sort((a, b) => b.lines - a.lines);
}

function readPackageDependencyGraph() {
  const packagesDir = path.join(ROOT, 'packages');
  const packageFiles = readIndexedFilesMatching((file) =>
    file.startsWith(`${packagesDir}${path.sep}`) && path.basename(file) === 'package.json',
  );
  const contents = readIndexedFileContents(packageFiles);
  const manifests = new Map(
    packageFiles.map((file) => [file, JSON.parse(contents.get(file))]),
  );
  const packageNames = new Set(
    [...manifests.values()].map((manifest) => manifest.name).filter(Boolean),
  );

  return packageFiles
    .map((file) => {
      const manifest = manifests.get(file);
      const dependencyNames = [
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.peerDependencies ?? {}),
        ...Object.keys(manifest.devDependencies ?? {}),
      ].sort();

      return {
        name: manifest.name,
        path: relative(path.dirname(file)),
        localDependencies: dependencyNames.filter((name) => packageNames.has(name)),
        externalDependencyCount: dependencyNames.filter((name) => !packageNames.has(name)).length,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function buildInventory() {
  // Known residual: this still reads the working tree, because it resolves and
  // follows re-exports across several channel files and is shared with
  // `verify:ipc`, which legitimately wants your live edits. Far lower risk than
  // the largeFiles case it is deliberately not grouped with — a dirty
  // `packages/contracts/src/channels/*.ts` is source mid-edit that gets staged
  // with its commit, not a doc the lifecycle parks unstaged for weeks. Route it
  // through readIndexedFileContents() if it ever does drift local-vs-CI.
  const channels = extractContractsChannelEntries(CONTRACTS_CHANNELS_INDEX_PATH);
  const domains = readPreloadDomains();
  const providerFiles = readProviderNames();
  return {
    schemaVersion: 1,
    generatedBy: 'scripts/generate-architecture-inventory.js',
    ipc: {
      channelCount: channels.length,
      channels,
    },
    preload: {
      domainCount: domains.length,
      domains,
    },
    providers: {
      fileCount: providerFiles.length,
      files: providerFiles,
    },
    packages: {
      dependencyGraph: readPackageDependencyGraph(),
    },
    largeFiles: readLargeFiles(),
  };
}

function assertDeterministicPaths(inventory) {
  // Regression guard: fail fast if any path field carries an OS-specific ("\")
  // separator. Runs in both --write (pre-commit) and --check (pre-push/CI) so a
  // Windows contributor sees the error locally instead of only on Linux CI, and
  // so a future codegen change that bypasses toPosixPath() can't slip through.
  const pathValues = [
    ...inventory.providers.files,
    ...inventory.largeFiles.map((entry) => entry.path),
    ...inventory.packages.dependencyGraph.map((pkg) => pkg.path),
  ];
  const offenders = pathValues.filter((value) => value.includes('\\'));
  if (offenders.length > 0) {
    throw new Error(
      'Architecture inventory contains non-POSIX path separators ("\\"): '
      + `${offenders.join(', ')}. Paths must use "/" so the file is byte-identical `
      + 'across Windows, macOS, and Linux. Route paths through toPosixPath().',
    );
  }
}

function main() {
  const mode = process.argv.includes('--check') ? 'check' : 'write';
  const inventory = buildInventory();
  assertDeterministicPaths(inventory);
  const rendered = `${JSON.stringify(inventory, null, 2)}\n`;

  if (mode === 'check') {
    const current = fs.existsSync(OUTPUT_PATH) ? fs.readFileSync(OUTPUT_PATH, 'utf8') : '';
    if (current !== rendered) {
      console.error(
        `Architecture inventory is out of date. Run "npm run generate:architecture" to update ${relative(OUTPUT_PATH)}.`,
      );
      process.exit(1);
    }
    console.log(`Architecture inventory verified at ${relative(OUTPUT_PATH)}`);
    return;
  }

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, rendered);
  console.log(`Wrote architecture inventory to ${relative(OUTPUT_PATH)}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = {
  toPosixPath,
  buildInventory,
  assertDeterministicPaths,
  readIndexedFileContents,
};
