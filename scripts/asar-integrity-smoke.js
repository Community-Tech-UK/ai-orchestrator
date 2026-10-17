#!/usr/bin/env node

// Automated macOS regression for Electron #52283. Never launches Harness or
// accesses its profile. All mutations and signing apply to a disposable copy.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const asar = require('@electron/asar');

const repo = path.resolve(__dirname, '..');

async function runCase(root, mode, position) {
  const resources = path.join(root, 'Electron.app', 'Contents', 'Resources');
  fs.copyFileSync(path.join(root, 'original.asar'), path.join(resources, 'app.asar'));
  fs.copyFileSync(path.join(root, 'replacement-template.asar'), path.join(root, 'replacement.asar'));
  const env = {
    ...process.env, AIO_ASAR_SMOKE_ROOT: root, AIO_ASAR_SMOKE_MODE: mode,
    AIO_ASAR_SMOKE_POSITION: String(position), AIO_ASAR_SMOKE_SQLITE: require.resolve('better-sqlite3'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const stdoutPath = path.join(root, `${mode}.stdout.log`);
  const stderrPath = path.join(root, `${mode}.stderr.log`);
  const stdout = fs.openSync(stdoutPath, 'w');
  const stderr = fs.openSync(stderrPath, 'w');
  const startedAt = new Date().toISOString();
  let timedOut = false;
  let killTimer;
  const result = await new Promise((resolve) => {
    const child = spawn(path.join(root, 'Electron.app', 'Contents', 'MacOS', 'Electron'), [
      '--headless', '--disable-gpu', '--disable-gpu-compositing', '--disable-software-rasterizer',
      '--disable-background-networking', '--no-first-run',
      // Test-only: agent shells may already be inside a macOS Seatbelt sandbox.
      // This flag never changes the real app or its production sandbox settings.
      '--no-sandbox',
    ], { env, stdio: ['ignore', stdout, stderr] });
    fs.writeFileSync(path.join(root, `${mode}.process.json`), JSON.stringify({ pid: child.pid, startedAt }));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 3_000);
    }, 25_000);
    let finished = false;
    function finish(status, signal, error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      fs.closeSync(stdout);
      fs.closeSync(stderr);
      resolve({ pid: child.pid, startedAt, endedAt: new Date().toISOString(),
        status, signal, timedOut, error: error?.message });
    }
    child.once('exit', (status, signal) => finish(status, signal));
    child.once('error', (error) => finish(null, null, error));
  });
  result.events = fs.readFileSync(stdoutPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  result.stderr = fs.readFileSync(stderrPath, 'utf8');
  fs.writeFileSync(path.join(root, `${mode}.result.json`), JSON.stringify(result, null, 2));
  const find = (stage) => result.events.find((event) => event.stage === stage);
  assert.equal(result.timedOut, false, `${mode}: timed out`);
  assert.equal(result.error, undefined, `${mode}: failed to spawn`);
  assert.equal(find('ready')?.sqlite, true, `${mode}: native database did not run`);
  assert.equal(find('before')?.content, 'ORIGINAL', `${mode}: original resource did not load`);
  assert.equal(find('before')?.visible, false, `${mode}: window was visible`);
  assert.equal(find('unexpected-visible-window'), undefined);
  if (mode === 'tamper') {
    assert.ok(find('archive-modified-in-place'));
    assert.equal(result.status, null);
    assert.equal(result.signal, 'SIGTRAP');
    assert.match(result.stderr, /FATAL:.*asar_file_validator\.cc:\d+\] Failed to validate block while ending ASAR file stream/);
    assert.equal(find('finished'), undefined, 'Modified bytes unexpectedly passed integrity validation');
  } else {
    assert.equal(result.status, 0, `${mode}: exited unsuccessfully; see ${stderrPath}`);
    assert.equal(result.signal, null);
    if (mode === 'swap') assert.ok(find('archive-replaced'));
    assert.equal(find('after')?.visible, false);
    assert.deepEqual(find('finished'), { stage: 'finished', before: 'ORIGINAL', after: 'ORIGINAL' });
  }
  return { mode, electron: find('ready').electron, status: result.status, signal: result.signal };
}

async function main() {
  assert.equal(process.platform, 'darwin', 'This signed-archive regression requires macOS');
  const scratch = path.join(repo, '_scratch');
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'asar-integrity-smoke-'));
  console.log(`ASAR integrity smoke evidence: ${root}`);
  const source = process.argv[2] ? path.resolve(process.argv[2])
    : path.resolve(path.dirname(require('electron')), '..', '..');
  const app = path.join(root, 'Electron.app');
  execFileSync('/bin/cp', ['-cR', source, app]);
  const html = (version) => `<!doctype html><body data-version="${version}">${'fixture '.repeat(24_000)}</body>`;
  for (const [name, version] of [['original', 'ORIGINAL'], ['replacement', 'REPLACED']]) {
    const directory = path.join(root, name);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'asar-integrity-smoke', version: '1.0.0', main: 'main.cjs' }));
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'asar-integrity-smoke', 'main.cjs'), path.join(directory, 'main.cjs'));
    fs.writeFileSync(path.join(directory, 'index.html'), html(version));
    await asar.createPackage(directory, path.join(root, `${name}.asar`));
  }
  fs.renameSync(path.join(root, 'replacement.asar'), path.join(root, 'replacement-template.asar'));
  const original = path.join(root, 'original.asar');
  fs.copyFileSync(original, path.join(app, 'Contents', 'Resources', 'app.asar'));
  const header = asar.getRawHeader(original);
  const headerHash = crypto.createHash('sha256').update(header.headerString).digest('hex');
  const position = 8 + header.headerSize + Number(asar.statFile(original, 'index.html').offset) + html('ORIGINAL').indexOf('ORIGINAL');
  const { flipFuses, FuseVersion, FuseV1Options, getCurrentFuseWire } = await import('@electron/fuses');
  await flipFuses(app, { version: FuseVersion.V1,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true, [FuseV1Options.OnlyLoadAppFromAsar]: true });
  execFileSync('python3', ['-c', [
    'import plistlib,sys', 'p=sys.argv[1]', 'd=plistlib.load(open(p,"rb"))',
    'd["LSUIElement"]=True', 'd["LSBackgroundOnly"]=True',
    'd["CFBundleIdentifier"]="local.harness.asar-integrity-smoke"',
    'd["ElectronAsarIntegrity"]={"Resources/app.asar":{"algorithm":"SHA256","hash":sys.argv[2]}}',
    'plistlib.dump(d,open(p,"wb"))',
  ].join(';'), path.join(app, 'Contents', 'Info.plist'), headerHash]);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'pipe' });
  fs.writeFileSync(path.join(root, 'setup.json'), JSON.stringify({ source, headerHash, position, fuses: await getCurrentFuseWire(app) }, null, 2));
  const results = [];
  for (const mode of ['control', 'swap', 'tamper']) results.push(await runCase(root, mode, position));
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ verdict: 'PASS', results }, null, 2));
  // Keep the evidence; remove only this run's disposable application and data.
  for (const name of ['Electron.app', 'original', 'replacement', 'original.asar', 'replacement.asar', 'replacement-template.asar',
    'profile-control', 'profile-swap', 'profile-tamper', 'crash-dumps']) fs.rmSync(path.join(root, name), { recursive: true, force: true });
  console.log('PASS: original loads, replaced archive stays consistent, changed bytes are rejected, native SQLite works.');
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
