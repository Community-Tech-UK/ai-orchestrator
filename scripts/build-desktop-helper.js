#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync: nodeSpawnSync } = require('node:child_process');

function resolveRequestedArch({
  args = process.argv.slice(2),
  env = process.env,
  hostArch = process.arch,
} = {}) {
  const explicit = args.find((argument) => argument.startsWith('--arch='));
  if (explicit) return explicit.slice('--arch='.length);
  if (args.includes('--arm64')) return 'arm64';
  if (args.includes('--x64')) return 'x64';
  return env.HARNESS_BUILD_ARCH || hostArch;
}

function createSwiftBuildPlan({
  platform = process.platform,
  arch = process.arch,
  projectRoot = path.resolve(__dirname, '..'),
} = {}) {
  if (platform !== 'darwin') {
    return null;
  }
  if (arch !== 'arm64' && arch !== 'x64') {
    throw new Error(`Unsupported macOS desktop helper architecture: ${arch}`);
  }
  // These paths are consumed by the macOS Swift toolchain (xcrun swiftc), so
  // build them with POSIX separators regardless of the host OS running the build.
  const sourcePath = path.posix.join(
    projectRoot,
    'resources',
    'desktop-helper',
    'DesktopHelper.swift',
  );
  const outputPath = path.posix.join(
    projectRoot,
    'dist',
    'desktop-helper',
    'desktop-helper',
  );
  const swiftArch = arch === 'arm64' ? 'arm64' : 'x86_64';
  return {
    command: 'xcrun',
    args: [
      'swiftc',
      sourcePath,
      '-O',
      '-whole-module-optimization',
      '-target',
      `${swiftArch}-apple-macosx12.0`,
      '-framework',
      'AppKit',
      '-framework',
      'ApplicationServices',
      '-framework',
      'CoreGraphics',
      '-o',
      outputPath,
    ],
    outputPath,
  };
}

function buildDesktopHelper({
  platform = process.platform,
  arch = process.arch,
  projectRoot = path.resolve(__dirname, '..'),
  required = false,
  spawnSync = nodeSpawnSync,
} = {}) {
  const plan = createSwiftBuildPlan({ platform, arch, projectRoot });
  if (!plan) {
    console.log('[desktop-helper] Skipping Swift helper build on non-macOS platform.');
    return { skipped: true };
  }

  fs.mkdirSync(path.dirname(plan.outputPath), { recursive: true });
  const result = spawnSync(plan.command, plan.args, {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (result.error || result.status !== 0 || !fs.existsSync(plan.outputPath)) {
    const detail = result.error?.message
      ?? result.stderr?.trim()
      ?? `swiftc exited with status ${result.status ?? 'unknown'}`;
    const message = [
      'Bundled macOS desktop helper is required, but xcrun swiftc could not compile it.',
      'Install the Xcode command-line tools and retry.',
      detail,
    ].join(' ');
    if (required) {
      throw new Error(message);
    }
    console.warn(`[desktop-helper] ${message}`);
    return { skipped: true };
  }
  fs.chmodSync(plan.outputPath, 0o755);
  console.log(`[desktop-helper] Built ${plan.outputPath}`);
  return { skipped: false, outputPath: plan.outputPath };
}

if (require.main === module) {
  try {
    buildDesktopHelper({
      arch: resolveRequestedArch(),
      required: process.argv.includes('--required'),
    });
  } catch (error) {
    console.error(`[desktop-helper] ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  buildDesktopHelper,
  createSwiftBuildPlan,
  resolveRequestedArch,
};
