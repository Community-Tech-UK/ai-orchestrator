#!/usr/bin/env node
/* eslint-env node */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const STARTUP_TIMEOUT_MS = 120_000;
// Covers the app's own graceful-quit budget (CLEANUP_TIMEOUT_MS, 60s).
const EXIT_TIMEOUT_MS = 75_000;
const TERMINATE_GRACE_MS = 5_000;
const KILL_WAIT_MS = 5_000;
const POLL_INTERVAL_MS = 250;
const MAX_CAPTURED_OUTPUT_LENGTH = 2 * 1024 * 1024;
const FAILURE_LOG_TAIL_LINES = 40;
// Written by the app into the smoke profile; see src/main/app/startup-smoke-markers.ts.
const READY_MARKER = 'startup-smoke-ready';
const PID_MARKER = 'startup-smoke-pid';
// Chromium's `[pid:date/time:FATAL:file.cc(line)] message` fatal-error line.
// Only seen when it reaches our pipes or app.log: the relaunched app's stdio is
// detached from ours, so its fatal errors are caught by the pid check instead.
const CHROMIUM_FATAL_PATTERN = /^\[\d+:[^\]\n]*:FATAL:/m;

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
    || CHROMIUM_FATAL_PATTERN.test(content)
  ) {
    return 'failed';
  }
  return content.includes('Harness initialized') ? 'ready' : 'pending';
}

/**
 * `exitResult` is the launched (bootstrap) process. It normally exits 0 almost
 * at once because the app relaunches itself with its heap flag, so a clean exit
 * alone is not a failure; `appExited` reports whether the relaunched app itself
 * has gone away, which before readiness is.
 */
function getStartupPollDecision(status, exitResult, appExited = false) {
  if (status === 'failed') return 'failed';
  if (status === 'ready') return 'ready';
  if (exitResult && ('error' in exitResult || exitResult.code !== 0)) return 'failed';
  if (appExited) return 'failed';
  return 'wait';
}

function readAppPid(markerPath, readFileSync = fs.readFileSync) {
  try {
    const pid = Number.parseInt(readFileSync(markerPath, 'utf8'), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid, kill = process.kill) {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else — still alive.
    return error?.code === 'EPERM';
  }
}

/**
 * SIGTERM, then SIGKILL. SIGTERM alone is not enough: an app whose main thread
 * is wedged (for example spinning on a fatal-error trap) never gets to handle it.
 */
async function terminateProcess(pid, deps = {}) {
  const kill = deps.kill ?? process.kill;
  const isAlive = deps.isAlive ?? ((target) => isProcessAlive(target, kill));
  const wait = deps.delay ?? delay;
  const waitForExit = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (isAlive(pid) && Date.now() < deadline) await wait(POLL_INTERVAL_MS);
    return !isAlive(pid);
  };
  if (!isAlive(pid)) return 'not-running';
  try { kill(pid, 'SIGTERM'); } catch { /* raced with its own exit */ }
  if (await waitForExit(deps.graceMs ?? TERMINATE_GRACE_MS)) return 'terminated';
  try { kill(pid, 'SIGKILL'); } catch { /* raced with its own exit */ }
  return await waitForExit(deps.killWaitMs ?? KILL_WAIT_MS) ? 'killed' : 'survived';
}

function tailLines(text, count) {
  return text.trimEnd().split('\n').slice(-count).join('\n');
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
  // Test seams; production runs use the defaults.
  const startupTimeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
  const exitTimeoutMs = options.exitTimeoutMs ?? EXIT_TIMEOUT_MS;
  const terminateOptions = { graceMs: options.terminateGraceMs ?? TERMINATE_GRACE_MS };
  const executablePath = getPackagedExecutableCandidates(root, platform)
    .find((candidate) => fs.existsSync(candidate));
  if (!executablePath) {
    throw new Error(`Packaged startup smoke found no unpacked ${platform} executable`);
  }

  const userDataPath = fs.mkdtempSync(
    path.join(options.tempRoot ?? os.tmpdir(), 'harness-startup-smoke-'),
  );
  const logPath = path.join(userDataPath, 'logs', 'app.log');
  const readyMarkerPath = path.join(userDataPath, READY_MARKER);
  const pidMarkerPath = path.join(userDataPath, PID_MARKER);
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

  // The relaunched app, once it has published its pid. Null until then, and for
  // builds that predate the pid marker (which leaves the launched-child checks).
  let appPid = null;
  const readTrackedAppPid = () => {
    appPid ??= readAppPid(pidMarkerPath);
    return appPid;
  };
  // Latched: once the app is seen gone, its pid may be recycled by an
  // unrelated process, which must never read as the app or be signalled.
  let appExitObserved = false;
  const hasAppExited = () => {
    if (appExitObserved) return true;
    const pid = readTrackedAppPid();
    if (pid === null) return false;
    appExitObserved = pid === child.pid ? exitResult !== null : !isProcessAlive(pid);
    return appExitObserved;
  };
  const readStartupStatus = () => {
    const fileContent = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
    const status = classifyStartupLog(`${capturedOutput}\n${fileContent}`);
    return status === 'pending' && fs.existsSync(readyMarkerPath) ? 'ready' : status;
  };
  let passed = false;

  try {
    const startupDeadline = Date.now() + startupTimeoutMs;
    while (Date.now() < startupDeadline) {
      // Liveness BEFORE status: an app that wrote its ready marker and then quit
      // must read as ready, not as having died during startup.
      const appExited = hasAppExited();
      const status = readStartupStatus();
      const decision = getStartupPollDecision(status, exitResult, appExited);
      if (decision === 'failed' && status === 'failed') {
        throw new Error('Packaged startup smoke observed a critical initialization failure');
      }
      if (decision === 'failed' && exitResult && ('error' in exitResult || exitResult.code !== 0)) {
        throw new Error(`Packaged app exited before startup completed: ${formatExit(exitResult)}`);
      }
      if (decision === 'failed') {
        // The relaunched app's stdio is detached from ours, so its fatal-error
        // line never reaches capturedOutput; the OS crash report has it.
        const crashHint = platform === 'darwin'
          ? '; see its crash report in ~/Library/Logs/DiagnosticReports'
          : '';
        throw new Error(
          `Packaged app process ${String(appPid)} exited before startup completed${crashHint}`,
        );
      }
      if (decision === 'ready') break;
      await delay(POLL_INTERVAL_MS);
    }

    const finalStatus = readStartupStatus();
    if (finalStatus === 'failed') {
      throw new Error('Packaged startup smoke observed a critical initialization failure');
    }
    if (finalStatus !== 'ready') {
      throw new Error(`Packaged app did not initialize within ${startupTimeoutMs}ms`);
    }

    // The smoke build quits itself once ready. Wait for the launched process AND
    // the relaunched app: the launched one exits long before the app does.
    const isStillRunning = () => exitResult === null
      || (readTrackedAppPid() !== null && !hasAppExited());
    const exitDeadline = Date.now() + exitTimeoutMs;
    while (isStillRunning() && Date.now() < exitDeadline) await delay(POLL_INTERVAL_MS);
    if (isStillRunning()) {
      throw new Error('Packaged app did not exit after completing startup smoke');
    }
    if ('error' in exitResult) throw exitResult.error;
    if (exitResult.code !== 0) {
      throw new Error(`Packaged app exited abnormally after startup: ${formatExit(exitResult)}`);
    }
    passed = true;
    console.log(`Packaged startup smoke passed (${platform})`);
  } finally {
    if (!exitResult && child.pid !== undefined) await terminateProcess(child.pid, terminateOptions);
    const trackedAppPid = readTrackedAppPid();
    if (trackedAppPid !== null && trackedAppPid !== child.pid && !hasAppExited()) {
      const outcome = await terminateProcess(trackedAppPid, terminateOptions);
      if (outcome === 'survived') {
        console.warn(`Packaged startup smoke could not kill app process ${trackedAppPid}`);
      }
    }
    if (passed) {
      if (!removeTempDirectory(userDataPath)) {
        console.warn('Packaged startup smoke could not remove its temporary profile');
      }
    } else {
      reportFailedStartup({ userDataPath, logPath, capturedOutput });
    }
  }
}

/** A failed smoke keeps its profile: the app log is the only record of why. */
function reportFailedStartup({ userDataPath, logPath, capturedOutput }) {
  console.error(`Packaged startup smoke kept its profile for inspection: ${userDataPath}`);
  if (capturedOutput.trim()) {
    console.error(`--- last ${FAILURE_LOG_TAIL_LINES} lines of app stdout/stderr ---`);
    console.error(tailLines(capturedOutput, FAILURE_LOG_TAIL_LINES));
  }
  if (fs.existsSync(logPath)) {
    console.error(`--- last ${FAILURE_LOG_TAIL_LINES} lines of ${logPath} ---`);
    console.error(tailLines(fs.readFileSync(logPath, 'utf8'), FAILURE_LOG_TAIL_LINES));
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
  PID_MARKER,
  READY_MARKER,
  classifyStartupLog,
  getLaunchCommand,
  getPackagedExecutableCandidates,
  getStartupPollDecision,
  isProcessAlive,
  readAppPid,
  removeTempDirectory,
  runPackagedStartupSmoke,
  terminateProcess,
};
