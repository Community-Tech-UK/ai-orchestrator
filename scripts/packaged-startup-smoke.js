#!/usr/bin/env node
/* eslint-env node */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const STARTUP_TIMEOUT_MS = 120_000;
const EXIT_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 250;
const MAX_CAPTURED_OUTPUT_LENGTH = 2 * 1024 * 1024;

function getPackagedExecutableCandidates(root = ROOT, platform = process.platform) {
  if (platform === 'darwin') {
    return [
      path.join(root, 'release', 'mac-arm64', 'Harness.app', 'Contents', 'MacOS', 'Harness'),
      path.join(root, 'release', 'mac', 'Harness.app', 'Contents', 'MacOS', 'Harness'),
      path.join(root, 'release', 'mac-x64', 'Harness.app', 'Contents', 'MacOS', 'Harness'),
    ];
  }
  if (platform === 'win32') {
    return [path.join(root, 'release', 'win-unpacked', 'Harness.exe')];
  }
  if (platform === 'linux') {
    return [
      path.join(root, 'release', 'linux-unpacked', 'harness'),
      path.join(root, 'release', 'linux-unpacked', 'Harness'),
    ];
  }
  throw new Error(`Packaged startup smoke does not support ${platform}`);
}

function getLaunchCommand({ executablePath, platform = process.platform, env = process.env }) {
  if (platform === 'linux' && !env.DISPLAY) {
    return { command: 'xvfb-run', args: ['-a', executablePath, '--no-sandbox'] };
  }
  return {
    command: executablePath,
    args: platform === 'linux' ? ['--no-sandbox'] : [],
  };
}

function classifyStartupLog(content) {
  if (
    content.includes('Failed to initialize: IPC handlers')
    || content.includes('CONTEXT_EVIDENCE_RUNTIME_UNAVAILABLE')
    || content.includes('Context evidence initialization failed')
    || content.includes('Context-evidence IPC registered in unavailable mode')
    || content.includes('Window failed to load content')
  ) {
    return 'failed';
  }
  return content.includes('Harness initialized') ? 'ready' : 'pending';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function removeTempDirectory(directoryPath, rmSync = fs.rmSync) {
  try {
    rmSync(directoryPath, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
    return true;
  } catch {
    return false;
  }
}

async function runPackagedStartupSmoke(options = {}) {
  const platform = options.platform ?? process.platform;
  const root = options.root ?? ROOT;
  const executablePath = getPackagedExecutableCandidates(root, platform)
    .find((candidate) => fs.existsSync(candidate));
  if (!executablePath) {
    throw new Error(`Packaged startup smoke found no unpacked ${platform} executable`);
  }

  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-startup-smoke-'));
  const logPath = path.join(userDataPath, 'logs', 'app.log');
  const readyMarkerPath = path.join(userDataPath, 'startup-smoke-ready');
  const env = {
    ...process.env,
    AIO_STARTUP_SMOKE: '1',
    AIO_STARTUP_SMOKE_USER_DATA_PATH: userDataPath,
  };
  const launch = getLaunchCommand({ executablePath, platform, env });
  const child = spawn(launch.command, launch.args, {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let exitResult = null;
  let capturedOutput = '';
  const captureOutput = (chunk) => {
    capturedOutput = `${capturedOutput}${String(chunk)}`.slice(-MAX_CAPTURED_OUTPUT_LENGTH);
  };
  child.stdout?.on('data', captureOutput);
  child.stderr?.on('data', captureOutput);
  child.once('exit', (code, signal) => {
    exitResult = { code, signal };
  });
  child.once('error', (error) => {
    exitResult = { error };
  });

  try {
    const startupDeadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < startupDeadline) {
      const fileContent = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
      const content = `${capturedOutput}\n${fileContent}`;
      const status = classifyStartupLog(content);
      if (status === 'failed') {
        throw new Error('Packaged startup smoke observed a critical initialization failure');
      }
      if (status === 'ready' || fs.existsSync(readyMarkerPath)) break;
      if (exitResult) {
        if ('error' in exitResult || exitResult.code !== 0) {
          throw new Error(`Packaged app exited before startup completed: ${formatExit(exitResult)}`);
        }
        // A successful smoke run self-quits immediately after logging readiness.
        // Re-read the completed log below instead of racing the exit event against
        // the next polling interval.
        break;
      }
      await delay(POLL_INTERVAL_MS);
    }

    const finalFileContent = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
    const finalContent = `${capturedOutput}\n${finalFileContent}`;
    const finalStatus = classifyStartupLog(finalContent);
    if (finalStatus === 'failed') {
      throw new Error('Packaged startup smoke observed a critical initialization failure');
    }
    if (
      finalStatus !== 'ready'
      && !fs.existsSync(readyMarkerPath)
    ) {
      throw new Error(`Packaged app did not initialize within ${STARTUP_TIMEOUT_MS}ms`);
    }

    const exitDeadline = Date.now() + EXIT_TIMEOUT_MS;
    while (!exitResult && Date.now() < exitDeadline) await delay(POLL_INTERVAL_MS);
    if (!exitResult) {
      child.kill();
      throw new Error('Packaged app did not exit after completing startup smoke');
    }
    if ('error' in exitResult) throw exitResult.error;
    if (exitResult.code !== 0) {
      throw new Error(`Packaged app exited abnormally after startup: ${formatExit(exitResult)}`);
    }
    console.log(`Packaged startup smoke passed (${platform})`);
  } finally {
    if (!exitResult) child.kill();
    if (!removeTempDirectory(userDataPath)) {
      console.warn('Packaged startup smoke could not remove its temporary profile');
    }
  }
}

function formatExit(result) {
  if ('error' in result) return result.error.message;
  return `code=${String(result.code)} signal=${String(result.signal)}`;
}

if (require.main === module) {
  runPackagedStartupSmoke().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

module.exports = {
  classifyStartupLog,
  getLaunchCommand,
  getPackagedExecutableCandidates,
  removeTempDirectory,
  runPackagedStartupSmoke,
};
