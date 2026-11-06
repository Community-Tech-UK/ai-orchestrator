import { describe, expect, it, vi } from 'vitest';
import type { OutputMessage } from '../../../../shared/types/instance.types';
import { createMockProcess } from '../codex-cli-adapter.test-helpers';
import { isSessionNotFoundText } from '../resume-error-classifier';
import { runCodexExecProcess, type CodexExecProcessResult } from './exec-process-runner';

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

const ROUTER_A = '2026-10-18T00:51:03.042357Z ERROR codex_core::tools::router: error=Exit code: 1';
const ROUTER_B = '2026-10-18T00:51:09.511220Z ERROR codex_core::tools::router: error=Exit code: 1';
const ROUTER_OTHER = '2026-10-18T00:52:11.100000Z ERROR codex_core::tools::router: error=Exit code: 2 (different text)';
const MCP_FAILED = '2026-10-18T00:51:04.000000Z ERROR codex_core::mcp_connection_manager: MCP client for `playwright` failed to start: request timed out after 10 seconds';
const AUTH_FATAL = '2026-10-18T00:51:05.000000Z ERROR codex_core::auth: unauthorized: token expired';
const SESSION_FATAL = '2026-10-18T00:51:06.000000Z ERROR codex_core::codex: thread not found: 019a0000-aaaa-bbbb-cccc-000000000001';
const NETWORK = '2026-10-18T00:51:07.000000Z ERROR codex_core::client: stream disconnected before completion: error sending request for url (https://example.invalid/backend/responses)';
const WARN_LINE = '2026-10-18T00:51:08.000000Z  WARN codex_core::config: something odd happened';

interface RunOptions {
  stderr: string[];
  /** Written last, with no trailing newline, so it is still buffered at close. */
  unterminated?: string;
  code?: number;
  message?: { role: 'user'; content: string };
}

async function run(options: RunOptions): Promise<{ outputs: OutputMessage[]; result?: CodexExecProcessResult; error?: Error }> {
  const child = createMockProcess();
  const outputs: OutputMessage[] = [];
  const message = options.message ?? { role: 'user' as const, content: 'Inspect layout' };
  const pending = runCodexExecProcess({
    deadlineMs: 5000, timeoutMs: 5000, turnIdleTimeoutMs: 5000, phase: 'turn',
    emitExit: () => {}, emitHeartbeat: () => {}, emitOutput: o => outputs.push(o),
    generateResponseId: () => 'response', isActiveProcess: p => p === child,
    message, onThreadId: () => {}, setProcess: () => {}, spawn: () => child,
  });
  // Let stdin acceptance settle before driving the child's output.
  await new Promise<void>(resolve => setImmediate(resolve));
  for (const line of options.stderr) child.stderr.write(`${line}\n`);
  if (options.unterminated) child.stderr.write(options.unterminated);
  child.stdout.write(JSON.stringify({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'Done.' } }) + '\n');
  child.emitClose(options.code ?? 0);
  try {
    return { outputs, result: await pending };
  } catch (error) {
    return { outputs, error: error as Error };
  }
}

const diagnosticOutputs = (outputs: OutputMessage[]): OutputMessage[] => outputs.filter(o => o.metadata?.['diagnostic'] === true);
const presentationOf = (output: OutputMessage): { category: string; headline: string; whatToDo: string; rawDetail: string } =>
  output.metadata?.['errorPresentation'] as { category: string; headline: string; whatToDo: string; rawDetail: string };

describe('Codex exec stderr lines', () => {
  it('shows one message when the same log line repeats with a new timestamp', async () => {
    const { outputs } = await run({ stderr: [ROUTER_A, ROUTER_B] });
    expect(diagnosticOutputs(outputs)).toHaveLength(1);
  });

  it('keeps the timestamp and the raw line out of the visible text, and the raw line in Details', async () => {
    const { outputs } = await run({ stderr: [ROUTER_A] });
    const [shown] = diagnosticOutputs(outputs);
    expect(shown.content).not.toMatch(/2026-10-18|codex_core|tools::router|Exit code|ERROR|\[codex\]/);
    expect(shown.content.length).toBeGreaterThan(0);
    expect(presentationOf(shown).rawDetail).toBe('ERROR codex_core::tools::router: error=Exit code: 1');
    expect(shown.metadata).toMatchObject({ diagnostic: true, loggedAt: '2026-10-18T00:51:03.042357Z' });
  });

  it('shows at most one message per category in a turn, whatever the line says', async () => {
    const { outputs } = await run({ stderr: [ROUTER_A, ROUTER_OTHER, WARN_LINE] });
    const categories = diagnosticOutputs(outputs).map(o => o.metadata?.['category']);
    expect(categories).toEqual(['process', 'unknown']);
  });

  it('names the tool server that did not start and keeps the raw line behind Details', async () => {
    const { outputs } = await run({ stderr: [MCP_FAILED] });
    const [shown] = diagnosticOutputs(outputs);
    expect(shown.metadata?.['category']).toBe('tool-server');
    expect(shown.type).toBe('system');
    expect(shown.content).toContain("A tool server didn't start for this Codex session: playwright");
    expect(shown.content).not.toMatch(/request timed out|codex_core|MCP client for/);
    expect(presentationOf(shown)).toMatchObject({
      category: 'tool-server',
      rawDetail: 'ERROR codex_core::mcp_connection_manager: MCP client for `playwright` failed to start: request timed out after 10 seconds',
    });
  });

  it('does not let an authentication word inside a tool-server failure turn it into a Codex sign-out', async () => {
    const line = '2026-10-18T00:51:04.000000Z ERROR codex_core::mcp_connection_manager: MCP client for `linear` failed to start: 401 Unauthorized';
    const { outputs } = await run({ stderr: [line] });
    const [shown] = diagnosticOutputs(outputs);
    expect(shown.metadata?.['category']).toBe('tool-server');
    expect(shown.type).toBe('system');
    expect(shown.content).toContain('linear');
  });

  it('presents a Codex sign-out as an error without the provider text', async () => {
    const { outputs } = await run({ stderr: [AUTH_FATAL] });
    const [shown] = diagnosticOutputs(outputs);
    expect(shown.type).toBe('error');
    expect(shown.content).toContain('Signed out of Codex');
    expect(shown.content).not.toMatch(/unauthorized|token expired|codex_core/i);
    expect(presentationOf(shown).category).toBe('auth');
  });

  it('presents a dropped connection plainly, without the request address', async () => {
    const { outputs } = await run({ stderr: [NETWORK] });
    const [shown] = diagnosticOutputs(outputs);
    expect(shown.metadata?.['category']).toBe('network');
    expect(shown.content).toContain('connection');
    expect(shown.content).not.toMatch(/example\.invalid|stream disconnected|sending request/);
  });

  it('keeps a lost Codex session recognisable to the session-not-found handling', async () => {
    const { outputs } = await run({ stderr: [SESSION_FATAL] });
    const [shown] = diagnosticOutputs(outputs);
    expect(shown.type).toBe('error');
    expect(isSessionNotFoundText(shown.content)).toBe(true);
    expect(shown.content).not.toMatch(/019a0000|codex_core/);
  });

  it('lets a fatal line through even when a harmless line of the same category came first', async () => {
    const harmless = '2026-10-18T00:51:01.000000Z  WARN codex_core::exec: sandbox warning only';
    const fatal = '2026-10-18T00:51:02.000000Z ERROR codex_core::exec: sandbox permission denied';
    const { outputs } = await run({ stderr: [harmless, fatal] });
    expect(diagnosticOutputs(outputs).map(o => [o.metadata?.['category'], o.type])).toEqual([['sandbox', 'system'], ['sandbox', 'error']]);
  });

  it('stays silent for informational lines', async () => {
    const { outputs } = await run({ stderr: ['Reading prompt from stdin...', '2026-10-18T00:51:00.000000Z  INFO codex_core::codex: session configured'] });
    expect(diagnosticOutputs(outputs)).toHaveLength(0);
  });

  it('applies the same rules to a final line that has no newline, and marks it as already shown', async () => {
    const { outputs, result } = await run({ stderr: [ROUTER_A], unterminated: ROUTER_B });
    expect(diagnosticOutputs(outputs)).toHaveLength(1);
    const unshown = result!.diagnostics.filter(d => d.level !== 'info' && !d.streamed);
    expect(unshown).toEqual([]);
  });

  it('leaves nothing for the adapter to print at the end of the turn: every line that is not informational is already shown or deliberately held back', async () => {
    // The adapter used to print the leftovers as "[codex] <raw line>" once the turn ended. That path is gone,
    // and this is what makes it safe to be: a line is marked as handled the moment it is classified.
    const { outputs, result } = await run({
      stderr: [ROUTER_A, ROUTER_B, ROUTER_OTHER, MCP_FAILED, AUTH_FATAL, SESSION_FATAL, NETWORK, WARN_LINE, 'Reading prompt from stdin...'],
      unterminated: ROUTER_B,
    });

    const lines = result!.diagnostics;
    expect(lines.length).toBeGreaterThan(8);
    expect(lines.filter(d => d.level !== 'info' && !d.streamed)).toEqual([]);
    expect(outputs.some(o => /^\[codex\]/.test(o.content))).toBe(false);
    for (const shown of diagnosticOutputs(outputs)) {
      expect(shown.content).not.toMatch(/codex_core|2026-10-18T/);
    }
  });

  it('shows a lone unterminated final line through the same presenter', async () => {
    const { outputs } = await run({ stderr: [], unterminated: MCP_FAILED });
    const [shown] = diagnosticOutputs(outputs);
    expect(shown.content).toContain('playwright');
    expect(shown.content).not.toMatch(/codex_core|request timed out/);
  });

  it('counts a category once per turn even when the turn is retried with the same message', async () => {
    const message = { role: 'user' as const, content: 'Inspect layout' };
    const first = await run({ stderr: [ROUTER_A], message });
    const second = await run({ stderr: [ROUTER_B], message });
    expect(diagnosticOutputs(first.outputs)).toHaveLength(1);
    expect(diagnosticOutputs(second.outputs)).toHaveLength(0);
  });

  it('shows the same category again for a different turn', async () => {
    const first = await run({ stderr: [ROUTER_A] });
    const second = await run({ stderr: [ROUTER_B] });
    expect(diagnosticOutputs(first.outputs)).toHaveLength(1);
    expect(diagnosticOutputs(second.outputs)).toHaveLength(1);
  });

  it('strips the timestamp from the lines kept on the result and from a failed turn\'s error', async () => {
    const child = createMockProcess();
    const pending = runCodexExecProcess({
      deadlineMs: 5000, timeoutMs: 5000, turnIdleTimeoutMs: 5000, phase: 'turn',
      emitExit: () => {}, emitHeartbeat: () => {}, emitOutput: () => {},
      generateResponseId: () => 'response', isActiveProcess: p => p === child,
      message: { role: 'user', content: 'Inspect layout' }, onThreadId: () => {}, setProcess: () => {}, spawn: () => child,
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    child.stderr.write(`${AUTH_FATAL}\n`);
    child.emitClose(1);
    await expect(pending).rejects.toThrow(/unauthorized: token expired/);
    await pending.catch((error: Error) => expect(error.message).not.toMatch(/2026-10-18T/));
  });
});
