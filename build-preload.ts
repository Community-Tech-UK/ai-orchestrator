import * as esbuild from 'esbuild';

async function build(): Promise<void> {
  await esbuild.build({
    entryPoints: ['src/preload/preload.ts'],
    bundle: true,
    platform: 'node',
    target: 'node20',
    outfile: 'dist/preload/preload.js',
    format: 'cjs',
    external: ['electron'],
    tsconfig: 'tsconfig.electron.json',
    logLevel: 'info',
  });

  console.log('Preload bundled -> dist/preload/preload.js');
}

build().catch((err) => {
  console.error('Preload build failed:', err);
  process.exit(1);
});
