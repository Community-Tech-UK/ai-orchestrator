import * as esbuild from 'esbuild';
import * as fs from 'node:fs';

const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { version?: string };
const workerAgentVersion = packageJson.version ?? '0.1.0';

async function build(): Promise<void> {
  await Promise.all([
    esbuild.build({
      entryPoints: ['src/worker-agent/index.ts'],
      bundle: true,
      platform: 'node',
      target: 'node22',
      outfile: 'dist/worker-agent/index.js',
      format: 'cjs',
      external: ['electron', 'better-sqlite3', 'node-pty'],
      tsconfig: 'tsconfig.worker.json',
      define: {
        'process.env.AIO_WORKER_AGENT_VERSION': JSON.stringify(workerAgentVersion),
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

  console.log('Worker agent built -> dist/worker-agent/index.js');
  console.log('Worker axe runner built -> dist/worker-tools/axe-audit.mjs');
}

build().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
