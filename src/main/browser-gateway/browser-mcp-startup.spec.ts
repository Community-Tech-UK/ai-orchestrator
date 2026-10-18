import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

async function handshakeWithLogDirectory(logDirectory: string): Promise<void> {
  // Use a real process and production entrypoint: an import-time exception
  // happens before the dispatcher/forwarder catch blocks can handle it.
  const child = execFileAsync(process.execPath, [
    '--import', 'tsx', resolve(__dirname, '../mcp/aio-mcp-dispatcher.ts'), 'browser-gateway',
  ], {
    cwd: resolve(__dirname, '../../..'),
    env: {
      ...process.env,
      AI_ORCHESTRATOR_BROWSER_FORWARDER_LOG_DIR: logDirectory,
      AI_ORCHESTRATOR_BROWSER_TOOL_STABLE: '1',
      // No live app connection or capability is required to initialise tools.
      AI_ORCHESTRATOR_BROWSER_GATEWAY_SOCKET: '',
      AI_ORCHESTRATOR_BROWSER_INSTANCE_ID: '',
      AI_ORCHESTRATOR_BROWSER_CAPABILITY_TOKEN: '',
    },
    timeout: 15_000,
  });
  child.child.stdin?.end([
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    '',
  ].join('\n'));
  const { stdout, stderr } = await child;
  const responses = stdout.trim().split('\n').map((line) => JSON.parse(line));
  expect(responses).toHaveLength(2);
  expect(responses[0]).toMatchObject({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'ai-orchestrator' } } });
  expect(responses[1]).toMatchObject({ jsonrpc: '2.0', id: 2, result: { tools: expect.arrayContaining([
    expect.objectContaining({ name: 'browser.tool_search' }),
    expect.objectContaining({ name: 'browser.tool_execute' }),
    expect.objectContaining({ name: 'browser.find_or_open' }),
  ]) } });
  expect(stderr).toContain('Harness file logging could not be initialised; continuing without file output.');
  expect(stderr).not.toContain(logDirectory);
}

describe('Browser Gateway import-time logging failure', () => {
  it('answers initialise and tools/list when the log ancestor is a file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'browser-log-startup-'));
    try {
      const blocker = join(directory, 'blocker');
      await writeFile(blocker, 'placeholder');
      await handshakeWithLogDirectory(join(blocker, 'forwarder'));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'answers initialise and tools/list when log creation is denied', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'browser-log-permissions-'));
      try {
        await chmod(directory, 0o500);
        await handshakeWithLogDirectory(join(directory, 'forwarder'));
      } finally {
        await chmod(directory, 0o700);
        await rm(directory, { recursive: true, force: true });
      }
    }, 20_000,
  );
});
