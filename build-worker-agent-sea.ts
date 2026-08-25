import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

const localRequire = createRequire(__filename);

function assertNode22Plus(): void {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 22) {
    throw new Error(
      `SEA build requires Node >= 22 (current: ${process.versions.node}). Skip on older Node or upgrade.`,
    );
  }
}

/**
 * The SEA base binary is a straight copy of the running Node. Distributions that
 * link Node against a shared libnode (Homebrew's `node` is a ~68 KB stub) produce
 * a worker binary that cannot start anywhere the shared library is absent, and
 * postject cannot inject into it either. Fail loudly instead of shipping that.
 */
function assertSelfContainedNode(): void {
  const execPath = process.execPath;
  const fail = (reason: string): never => {
    throw new Error(
      `SEA build needs a self-contained Node binary, but ${execPath} ${reason}.\n` +
        `Re-run with the Node pinned in .nvmrc (e.g. \`nvm use\`) rather than a Homebrew/shared-library build.`,
    );
  };

  if (process.platform !== 'win32') {
    const linkTool = process.platform === 'darwin' ? 'otool' : 'ldd';
    const linkArgs = process.platform === 'darwin' ? ['-L', execPath] : [execPath];
    try {
      const linkage = execFileSync(linkTool, linkArgs, { encoding: 'utf8' });
      if (/libnode/i.test(linkage)) fail('is dynamically linked against libnode');
      return;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('SEA build needs')) throw err;
      // Linkage tool unavailable — fall through to the size heuristic.
    }
  }

  const MIN_SELF_CONTAINED_BYTES = 20 * 1024 * 1024;
  if (fs.statSync(execPath).size < MIN_SELF_CONTAINED_BYTES) {
    fail('is too small to be a statically linked Node');
  }
}

/** Copy over a possibly read-only previous artifact and leave it executable. */
function copyExecutable(source: string, destination: string): void {
  fs.rmSync(destination, { force: true });
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, 0o755);
}

async function main(): Promise<void> {
  assertNode22Plus();
  assertSelfContainedNode();
  const bundle = path.resolve('dist/worker-agent/index.js');
  if (!fs.existsSync(bundle)) {
    throw new Error(`Missing ${bundle} — run npm run build:worker-agent first`);
  }
  const outDir = path.resolve('dist/worker-agent-sea');
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
  const binOut = path.join(outDir, `worker-agent${suffix}`);
  copyExecutable(process.execPath, binOut);
  const workerToolsSource = path.resolve('dist/worker-tools');
  if (fs.existsSync(workerToolsSource)) {
    const workerToolsOut = path.join(outDir, 'worker-tools');
    fs.rmSync(workerToolsOut, { recursive: true, force: true });
    fs.cpSync(workerToolsSource, workerToolsOut, { recursive: true });
  }

  const seaResourceName = 'NODE_SEA_BLOB';
  const postjectArgs = [
    binOut,
    seaResourceName,
    seaConfig.output,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ];
  if (process.platform === 'darwin') postjectArgs.push('--macho-segment-name', 'NODE_SEA');
  execFileSync(process.execPath, [localRequire.resolve('postject/dist/cli.js'), ...postjectArgs], { stdio: 'inherit' });
  if (process.platform === 'darwin') {
    execFileSync('codesign', ['--sign', '-', '--force', '--timestamp=none', binOut], { stdio: 'inherit' });
  }

  const aliasOut = path.join(outDir, `aio-worker${suffix}`);
  copyExecutable(binOut, aliasOut);
  console.log(`[sea] built ${binOut}`);
  console.log(`[sea] built ${aliasOut}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
