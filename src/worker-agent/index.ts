import { WorkerAgent } from './worker-agent';
import { loadWorkerConfig, resolveConfigPath } from './worker-config';
import { parseServiceArgs, runServiceCommand } from './cli/service-cli';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = parseServiceArgs(argv);

  if (cmd && cmd.kind !== 'run') {
    const code = await runServiceCommand(cmd);
    process.exit(code);
  }

  const serviceMode = cmd?.kind === 'run';
  const configPath = serviceMode
    ? resolveConfigPath(true)
    : argv.includes('--config')
      ? argv[argv.indexOf('--config') + 1]
      : undefined;

  const config = loadWorkerConfig(configPath);

  console.log(`Worker node "${config.name}" (${config.nodeId})`);
  console.log(`Connecting to coordinator at ${config.coordinatorUrl}...`);

  const agent = new WorkerAgent(config);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n${signal} received — shutting down...`);
    await agent.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await agent.connect();
  console.log('Worker agent started. Listening for work.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
