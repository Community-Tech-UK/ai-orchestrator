import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

function assertNode22Plus(): void {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 22) {
    throw new Error(
      `SEA build requires Node >= 22 (current: ${process.versions.node}). Skip on older Node or upgrade.`,
    );
  }
}

async function main(): Promise<void> {
  assertNode22Plus();
  const bundle = path.resolve('dist/loop-control-cli/index.js');
  if (!fs.existsSync(bundle)) {
    throw new Error(`Missing ${bundle} — run npm run build:loop-control-cli first`);
  }
  const outDir = path.resolve('dist/loop-control-cli-sea');
  fs.mkdirSync(outDir, { recursive: true });

  const seaConfig = {
    main: bundle,
    output: path.join(outDir, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: true,
  };
  const cfgPath = path.join(outDir, 'sea-config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(seaConfig, null, 2));

  execFileSync(process.execPath, ['--experimental-sea-config', cfgPath], { stdio: 'inherit' });

  const suffix = process.platform === 'win32' ? '.exe' : '';
  const binOut = path.join(outDir, `aio-loop-control${suffix}`);
  fs.copyFileSync(process.execPath, binOut);

  const postjectArgs = [
    binOut,
    'NODE_SEA_BLOB',
    seaConfig.output,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ];
  if (process.platform === 'darwin') postjectArgs.push('--macho-segment-name', 'NODE_SEA');
  execFileSync('npx', ['postject', ...postjectArgs], { stdio: 'inherit' });
  if (process.platform === 'darwin') {
    execFileSync('codesign', ['--sign', '-', '--force', '--timestamp=none', binOut], { stdio: 'inherit' });
  }

  console.log(`[sea] built ${binOut}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
