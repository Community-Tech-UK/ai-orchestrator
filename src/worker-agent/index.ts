import { WorkerAgent } from './worker-agent';
import { DEFAULT_CONFIG_PATH, loadWorkerConfig, resolveConfigPath } from './worker-config';
import { parseServiceArgs, runServiceCommand } from './cli/service-cli';
import { runBrowserExtensionNativeHost } from '../main/browser-gateway/browser-extension-native-host';
import { installWorkerFileLogging } from './worker-file-logger';
import { runWorkerSupervisor } from './worker-supervisor';
import { acquireSingleInstanceLock } from './single-instance-lock';

const SUPERVISE_FLAG = '--supervise';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === 'native-host') {
    await runBrowserExtensionNativeHost();
    return;
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
    installWorkerFileLogging();
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

  console.log(`Worker node "${config.name}" (${config.nodeId})`);
  console.log(`Connecting to coordinator at ${config.coordinatorUrl}...`);

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
  // Release the lock on a hard exit too (crash/exit paths that skip shutdown()).
  process.on('exit', () => lock.release());

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
