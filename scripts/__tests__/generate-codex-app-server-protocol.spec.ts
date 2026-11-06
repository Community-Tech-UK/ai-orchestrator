import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cli = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock('node:child_process', () => ({ ...cli, default: cli }));

const sources: Record<string, string> = {
  'ClientRequest.ts': 'export type ClientRequest = { "method": "thread/start" };',
  'ServerNotification.ts': 'export type ServerNotification = { "method": "thread/started" };',
  'v2/ThreadStartParams.ts': 'export type ThreadStartParams = { cwd?: string, config?: Record<string, unknown> };',
  'v2/ThreadResumeParams.ts': 'export type ThreadResumeParams = { threadId: string, excludeTurns?: boolean };',
  'v2/ThreadStartResponse.ts': 'export type ThreadStartResponse = { thread: Thread };',
  'v2/ThreadResumeResponse.ts': 'export type ThreadResumeResponse = { thread: Thread };',
  'v2/ThreadCompactStartResponse.ts': 'export type ThreadCompactStartResponse = Record<string, never>;',
  'v2/TurnStartParams.ts': 'export type TurnStartParams = { threadId: string, input: Array<UserInput>, effort?: ReasoningEffort, serviceTier?: string, outputSchema?: unknown };',
  'v2/TurnStartResponse.ts': 'export type TurnStartResponse = { turn: Turn };',
  'v2/TurnInterruptResponse.ts': 'export type TurnInterruptResponse = Record<string, never>;',
};

let root: string;
let outputPath: string;
let originalArgv: string[];

beforeEach(() => {
  vi.resetModules();
  root = mkdtempSync(join(tmpdir(), 'aio-protocol-generator-test-'));
  outputPath = join(root, 'src/main/cli/adapters/codex/generated/app-server-protocol.gen.ts');
  mkdirSync(dirname(outputPath), { recursive: true });
  originalArgv = process.argv;
  process.argv = ['node', 'generate-codex-app-server-protocol.ts'];
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  cli.execFileSync.mockImplementation((command: string, args: string[]) => {
    if (command !== 'codex') throw new Error('Unexpected subprocess');
    if (args[0] === '--version') return 'codex-cli 0.162.1';
    const outputDir = args[args.indexOf('--out') + 1];
    for (const [name, source] of Object.entries(sources)) {
      const path = join(outputDir, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, source);
    }
    return '';
  });
});

afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  cli.execFileSync.mockReset();
  rmSync(root, { recursive: true, force: true });
});

describe('Codex protocol generator check', () => {
  it('reports both versions and the minor-version gap without replacing the stale manifest', async () => {
    const previous = 'export const CODEX_APP_SERVER_PROTOCOL_VERSION = "codex-cli 0.144.4" as const;\n';
    writeFileSync(outputPath, previous);
    process.argv.push('--check');

    await expect(import('../generate-codex-app-server-protocol')).rejects.toThrow(
      'snapshot 0.144.4, installed 0.162.1 (18 minor versions behind)',
    );
    expect(readFileSync(outputPath, 'utf8')).toBe(previous);
  });

  it('generates a manifest and accepts the same CLI contract on check', async () => {
    await import('../generate-codex-app-server-protocol');
    const generated = readFileSync(outputPath, 'utf8');
    expect(generated).toContain('"codex-cli 0.162.1"');
    expect(generated).toContain('"excludeTurns"');
    vi.resetModules();
    process.argv.push('--check');
    await expect(import('../generate-codex-app-server-protocol')).resolves.toBeDefined();
    expect(readFileSync(outputPath, 'utf8')).toBe(generated);
  });

  it('still fails a check on contract drift when the installed and snapshot versions match', async () => {
    writeFileSync(outputPath, 'export const CODEX_APP_SERVER_PROTOCOL_VERSION = "codex-cli 0.162.1" as const;\n');
    process.argv.push('--check');
    const failure = await import('../generate-codex-app-server-protocol').then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(failure?.message).toContain('Codex protocol manifest is stale: snapshot 0.162.1, installed 0.162.1.');
    expect(failure?.message).not.toContain('minor versions behind');
  });
});
