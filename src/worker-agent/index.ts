import { WorkerAgent } from './worker-agent';
import { loadWorkerConfig } from './worker-config';

async function main(): Promise<void> {
  const config = loadWorkerConfig();

  console.log(`Worker node "${config.name}" (${config.nodeId})`);
  console.log(`Connecting to coordinator at ${config.coordinatorUrl}...`);

  const agent = new WorkerAgent(config);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received — shutting down...`);
    await agent.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await agent.connect();
    console.log(`Connected! Listening for work.`);
  } catch (err) {
    console.error('Failed to connect:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
