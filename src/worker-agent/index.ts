import { WorkerAgent } from './worker-agent';
import {
  assertWorkerConfigHasCoordinator,
  DEFAULT_CONFIG_PATH,
  getConfiguredCoordinatorUrl,
  loadWorkerConfig,
  resolveConfigPath,
} from './worker-config';
import { parseServiceArgs, runServiceCommand } from './cli/service-cli';
import { runPairCommand } from './cli/pair-cli';
import { runBrowserExtensionNativeHost } from '../main/browser-gateway/browser-extension-native-host';
import { installWorkerFileLogging } from './worker-file-logger';
import { runWorkerSupervisor } from './worker-supervisor';
import { acquireSingleInstanceLock } from './single-instance-lock';
import { captureRuntimeVitals, startRuntimeVitalsLogging } from './worker-runtime-vitals';

const SUPERVISE_FLAG = '--supervise';

async function main(): Promise<void> {
  let argv = process.argv.slice(2);
  if (argv[0] === 'native-host') {
    await runBrowserExtensionNativeHost();
    return;
  }

  if (argv[0] === 'pair') {
    // The launcher scripts append --supervise to whatever the user typed, so a
    // `start-worker.sh pair "<link>"` carries it through to here. The pair
    // parser rejects unknown `--` options outright, and supervision is not a
    // pair concern anyway — it is re-added below once pairing succeeds.
    const result = await runPairCommand(argv.slice(1).filter((a) => a !== SUPERVISE_FLAG));
    if (!result.startWorker) {
      process.exit(result.exitCode);
    }
    argv = ['--config', result.configPath, SUPERVISE_FLAG];
  }

  const cmd = parseServiceArgs(argv);

  if (cmd && cmd.kind !== 'run') {
    const code = await runServiceCommand(cmd);
    process.exit(code);
  }

  const serviceMode = cmd?.kind === 'run';

  // Supervisor mode: a thin parent that keeps the real worker alive across
  // crashes. Only meaningful outside service mode — WinSW/launchd/systemd already
  // supervise. The Windows Startup launcher runs `node index.js --supervise`.
  if (!serviceMode && argv.includes(SUPERVISE_FLAG)) {
    // Own log file: the supervised child also installs file logging, and two
    // processes appending to one path keep independent size counters, so they
    // would race each other's rotation. Splitting them also makes the restart
    // history readable on its own — "did it come back?" is the first question
    // after a worker disappears.
    installWorkerFileLogging({ fileName: 'worker-supervisor.log' });
    const childArgs = argv.filter((a) => a !== SUPERVISE_FLAG);
    const code = await runWorkerSupervisor({ childArgs });
    process.exit(code);
  }

  // Always-on file logging in non-service mode. Service mode redirects stdout to
  // the WinSW/launchd logpath already, so installing here would double-log.
  if (!serviceMode) {
    installWorkerFileLogging();
  }

  const configPath = serviceMode
    ? resolveConfigPath(true)
    : argv.includes('--config')
      ? argv[argv.indexOf('--config') + 1]
      : undefined;

  const activeConfigPath = configPath ?? DEFAULT_CONFIG_PATH;
  const config = loadWorkerConfig(activeConfigPath);
  assertWorkerConfigHasCoordinator(config);

  console.log(`Worker node "${config.name}" (${config.nodeId})`);
  console.log(`Connecting to coordinator at ${getConfiguredCoordinatorUrl(config)}...`);

  // Single-instance guard: a second worker for the same node id would register
  // under the same identity and evict the primary's coordinator socket in a
  // flap storm that fails in-flight work. Detect the live primary and exit
  // cleanly instead of connecting.
  const lock = acquireSingleInstanceLock({ key: `${config.namespace}:${config.nodeId}` });
  if (!lock) {
    console.warn(
      `[WorkerAgent] Another worker is already running for node "${config.nodeId}" — exiting`,
    );
    process.exit(0);
  }
  // Exit forensics. A worker that vanishes silently is impossible to diagnose
  // after the fact: on 2026-09-03 this process stopped mid-log-line and stayed
  // dead for 23 hours with no shutdown line, no crash handler line and no
  // Windows error record. These handlers make the next occurrence self-
  // describing — if a final line IS present the exit ran JavaScript (and names
  // the cause), and if it is ABSENT the process was hard-killed from outside
  // (TerminateProcess / V8 fatal abort), which is itself the answer.
  //
  // `exit` handlers must be synchronous; the file logger uses appendFileSync,
  // so the line is on disk before the process goes.
  process.on('exit', (code) => {
    // Release FIRST. The log line below goes through the patched console, which
    // re-throws whatever the mirrored write throws (a torn-down stdout during
    // exit can raise ERR_STREAM_DESTROYED) — and a throw here would skip the
    // release the previous handler always performed.
    lock.release();
    try {
      console.warn(
        `[WorkerAgent] process exiting ${JSON.stringify({
          code,
          ...captureRuntimeVitals(),
        })}`,
      );
    } catch {
      // Nothing useful left to do on the way out.
    }
  });

  const agent = new WorkerAgent(config, activeConfigPath);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received — shutting down...`);
    await agent.disconnect();
    lock.release();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // Windows delivers SIGHUP when the owning console window is closed and
  // SIGBREAK on Ctrl+Break. The worker is a child of a long-lived `cmd /K`
  // console, so "someone closed the window" is a live failure mode — without
  // these it exits with no record at all.
  process.on('SIGHUP', () => void shutdown('SIGHUP'));
  process.on('SIGBREAK', () => void shutdown('SIGBREAK'));

  // Resource trend, so a future silent death can be attributed to (or cleared
  // of) heap exhaustion from the last line written before the gap.
  startRuntimeVitalsLogging();

  // Survive our own bugs. A worker with no supervision that hits an
  // uncaughtException / unhandledRejection would exit and stay dead until the
  // user logs in again. Log it (the file logger captures it for a post-mortem)
  // and tear the socket down so the reconnect loop takes over, instead of dying.
  // The `--supervise` parent is the backstop if the process still exits.
  process.on('uncaughtException', (err) => {
    console.error('[WorkerAgent] uncaughtException — recovering, not exiting:', err);
    if (!shuttingDown) {
      agent.handleFatalProcessError();
    }
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[WorkerAgent] unhandledRejection — recovering, not exiting:', reason);
    if (!shuttingDown) {
      agent.handleFatalProcessError();
    }
  });

  await agent.connect();
  console.log('Worker agent started. Listening for work.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
