import * as esbuild from 'esbuild';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';

const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { version?: string };
const workerAgentVersion = packageJson.version ?? '0.1.0';
// The extension a worker node's Chrome loads lives in this same checkout. The
// relay tells the extension this version so it can reload onto matching code.
const extensionManifest = JSON.parse(
  fs.readFileSync('resources/browser-extension/manifest.json', 'utf8'),
) as { version?: string };
// The self-updater builds a candidate beside the live bundle and only swaps it
// in after it passes a self-check (src/worker-agent/worker-self-update.ts).
const workerOutfile = process.env['AIO_WORKER_BUILD_OUTFILE'] || 'dist/worker-agent/index.js';
// Unique per build. The relay and Chrome's native host are the same bundle, so
// a native host whose id differs from the relay's is running an older build.
const workerBuildId = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;

async function build(): Promise<void> {
  await Promise.all([
    esbuild.build({
      entryPoints: ['src/worker-agent/index.ts'],
      bundle: true,
      platform: 'node',
      target: 'node22',
      outfile: workerOutfile,
      format: 'cjs',
      external: ['electron', 'better-sqlite3', 'node-pty'],
      tsconfig: 'tsconfig.worker.json',
      define: {
        'process.env.AIO_WORKER_AGENT_VERSION': JSON.stringify(workerAgentVersion),
        'process.env.AIO_WORKER_BUILD_ID': JSON.stringify(workerBuildId),
        ...(extensionManifest.version
          ? { 'process.env.AIO_WORKER_EXTENSION_VERSION': JSON.stringify(extensionManifest.version) }
          : {}),
      },
      banner: {
        js: '#!/usr/bin/env node',
      },
      logLevel: 'info',
    }),
    esbuild.build({
      entryPoints: ['scripts/worker-tools/axe-audit.mjs'],
      bundle: true,
      platform: 'node',
      target: 'node22',
      outfile: 'dist/worker-tools/axe-audit.mjs',
      format: 'esm',
      banner: {
        js: '#!/usr/bin/env node',
      },
      logLevel: 'info',
    }),
  ]);

  console.log(`Worker agent built -> ${workerOutfile}`);
  console.log('Worker axe runner built -> dist/worker-tools/axe-audit.mjs');
}

build().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
