import * as esbuild from 'esbuild';

async function build(): Promise<void> {
  await esbuild.build({
    entryPoints: ['src/worker-agent/index.ts'],
    bundle: true,
    platform: 'node',
    target: 'node20',
    outfile: 'dist/worker-agent/index.js',
    format: 'cjs',
    external: ['electron', 'better-sqlite3'],
    tsconfig: 'tsconfig.worker.json',
    banner: {
      js: '#!/usr/bin/env node',
    },
    logLevel: 'info',
  });

  console.log('Worker agent built -> dist/worker-agent/index.js');
}

build().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
