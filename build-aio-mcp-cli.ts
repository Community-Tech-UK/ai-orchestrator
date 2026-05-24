import * as esbuild from 'esbuild';

async function build(): Promise<void> {
  await esbuild.build({
    entryPoints: ['src/main/mcp/aio-mcp-dispatcher.ts'],
    bundle: true,
    platform: 'node',
    target: 'node22',
    outfile: 'dist/aio-mcp-cli/index.js',
    format: 'cjs',
    // Keep native modules and Electron out — the dispatcher only contains
    // stdio↔Unix-socket forwarders that talk to the parent app over RPC.
    // If any of these are accidentally pulled in by a future change, the
    // SEA build below will fail loudly at runtime (better) rather than
    // silently shipping a broken native binding.
    external: ['electron', 'better-sqlite3', '@sqlite.org/sqlite-wasm'],
    tsconfig: 'tsconfig.electron.json',
    banner: {
      js: '#!/usr/bin/env node',
    },
    logLevel: 'info',
  });

  console.log('aio-mcp CLI bundle built -> dist/aio-mcp-cli/index.js');
}

build().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
