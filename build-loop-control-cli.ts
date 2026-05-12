import * as esbuild from 'esbuild';

async function build(): Promise<void> {
  await esbuild.build({
    entryPoints: ['src/main/orchestration/loop-control-cli.ts'],
    bundle: true,
    platform: 'node',
    target: 'node22',
    outfile: 'dist/loop-control-cli/index.js',
    format: 'cjs',
    external: ['electron', 'better-sqlite3'],
    tsconfig: 'tsconfig.electron.json',
    banner: {
      js: '#!/usr/bin/env node',
    },
    logLevel: 'info',
  });

  console.log('Loop control CLI built -> dist/loop-control-cli/index.js');
}

build().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
