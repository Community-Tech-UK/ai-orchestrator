import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('bundled connector command lifecycle', () => {
  it('stays alive to answer initialize and exits when the input stream closes', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'connector-cli-'));
    let child: ReturnType<typeof spawn> | undefined;
    let closed: Promise<number|null> | undefined;
    try {
      const bundle = path.join(directory, 'aio.cjs');
      const buildArgs = {
        entryPoints: ['src/main/mcp/aio-mcp-dispatcher.ts'],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node22',
        outfile: bundle,
        external: ['electron', 'better-sqlite3', '@sqlite.org/sqlite-wasm'],
        logLevel: 'silent',
      };
      const { execFileSync } = await import('node:child_process');
      execFileSync(
        process.execPath,
        ['-e', `require('esbuild').buildSync(${JSON.stringify(buildArgs)})`],
        { cwd: process.cwd() },
      );
      child = spawn(process.execPath, [bundle, 'connector', 'fixture'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      closed = new Promise<number | null>((resolve) => child!.once('close', resolve));
      const response = new Promise<string>((resolve, reject) => {
        let output = '';
        child!.stdout!.on('data', (chunk) => {
          output += chunk;
          if (output.includes('\n')) resolve(output.split('\n')[0]);
        });
        child!.once('error', reject);
        child!.once('exit', () => {
          if (!output) reject(new Error('Connector exited before answering initialize'));
        });
      });
      child.stdin!.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'fixture', version: '1' },
          },
        }) + '\n',
      );
      expect(JSON.parse(await response)).toMatchObject({
        id: 1,
        result: { serverInfo: { name: 'fixture' } },
      });
      child.stdin!.end();
      expect(await closed).toBe(0);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      if (closed) await closed;
      await fs.rm(directory, { recursive: true, force: true });
    }
  }, 20_000);
});
