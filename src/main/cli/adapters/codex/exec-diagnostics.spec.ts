import { describe, expect, it } from 'vitest';
import { classifyCodexDiagnostic, matchToolServerFailure, stripCodexLogTimestamp } from './exec-diagnostics';

describe('stripCodexLogTimestamp', () => {
  it('removes the leading clock reading and keeps it apart', () => {
    expect(stripCodexLogTimestamp('2026-10-18T00:51:03.042357Z ERROR codex_core::tools::router: x'))
      .toEqual({ line: 'ERROR codex_core::tools::router: x', loggedAt: '2026-10-18T00:51:03.042357Z' });
  });

  it('copes with colour codes around the timestamp and level', () => {
    const coloured = '\u001b[2m2026-10-18T00:51:03.042357Z\u001b[0m \u001b[31mERROR\u001b[0m codex_core::tools::router: x';
    expect(stripCodexLogTimestamp(coloured)).toEqual({
      line: 'ERROR codex_core::tools::router: x', loggedAt: '2026-10-18T00:51:03.042357Z',
    });
  });

  it('leaves a line with no timestamp alone, including a date later in the text', () => {
    expect(stripCodexLogTimestamp('Reading prompt from stdin...')).toEqual({ line: 'Reading prompt from stdin...' });
    expect(stripCodexLogTimestamp('ERROR failed at 2026-10-18T00:51:03Z today').loggedAt).toBeUndefined();
  });
});

describe('classifyCodexDiagnostic', () => {
  it('gives two copies of one problem the same text and category whatever the timestamp', () => {
    const a = classifyCodexDiagnostic('2026-10-18T00:51:03.042357Z ERROR codex_core::tools::router: error=Exit code: 1');
    const b = classifyCodexDiagnostic('2026-10-18T00:59:59.999999Z ERROR codex_core::tools::router: error=Exit code: 1');
    expect(a.line).toBe(b.line);
    expect(a.category).toBe(b.category);
    expect(a.loggedAt).not.toBe(b.loggedAt);
  });

  it.each([
    ['2026-10-18T00:51:04Z ERROR codex_core::mcp: MCP client for `playwright` failed to start: boom', 'playwright'],
    ['ERROR MCP client for `my-server` timed out after 10 seconds. Add or adjust `startup_timeout_sec` in your config.toml', 'my-server'],
    ['WARN The linear MCP server is not logged in. Run `codex mcp login linear`.', 'linear'],
    ['ERROR mcp: github failed: handshake error', 'github'],
    ['WARN MCP startup incomplete (failed: alpha, beta)', 'alpha'],
    ["ERROR failed to start MCP server 'files'", 'files'],
  ])('names the tool server in %s', (line, name) => {
    expect(classifyCodexDiagnostic(line)).toMatchObject({ category: 'tool-server', toolServer: name, fatal: false, level: 'warning' });
  });

  it('knows a tool server failed without inventing a name', () => {
    expect(matchToolServerFailure('ERROR MCP server startup failed')).toEqual({});
    expect(classifyCodexDiagnostic('ERROR MCP server startup failed')).not.toHaveProperty('toolServer');
  });

  it('never takes a name from text outside the safe character set', () => {
    const hostile = classifyCodexDiagnostic('ERROR MCP client for `evil name; rm -rf` failed to start');
    expect(hostile.category).toBe('tool-server');
    expect(hostile).not.toHaveProperty('toolServer');
  });

  it('reads a very long line only as far as a start-up failure would reach, and quickly', () => {
    const padded = `ERROR ${'x'.repeat(50_000)} MCP client for \`late\` failed to start`;
    const started = Date.now();
    expect(matchToolServerFailure(padded)).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('is not fooled by tool-server wording in unrelated or cleanup lines', () => {
    expect(classifyCodexDiagnostic('ERROR codex_core::tools::router: error=Exit code: 1').category).toBe('process');
    expect(classifyCodexDiagnostic('WARN failed to terminate MCP process group 1234').category).toBe('mcp');
  });

  it('keeps a tool server\'s own authentication failure a tool-server problem, but a plain one a sign-out', () => {
    expect(classifyCodexDiagnostic('ERROR MCP client for `linear` failed to start: 401 Unauthorized').category).toBe('tool-server');
    expect(classifyCodexDiagnostic('ERROR unauthorized: token expired')).toMatchObject({ category: 'auth', fatal: true });
  });

  it('classes a dropped connection apart from other errors, and not as fatal', () => {
    expect(classifyCodexDiagnostic('ERROR codex_core::client: stream disconnected before completion: error sending request for url (https://x.invalid/y)'))
      .toMatchObject({ category: 'network', fatal: false, level: 'warning' });
    expect(classifyCodexDiagnostic('WARN Reconnecting... 2/5 (connection reset by peer)').category).toBe('network');
  });

  it('keeps every earlier rule: sandbox, sessions, models and informational noise', () => {
    expect(classifyCodexDiagnostic('ERROR sandbox: permission denied')).toMatchObject({ category: 'sandbox', fatal: true });
    expect(classifyCodexDiagnostic('WARN sandbox is limited')).toMatchObject({ category: 'sandbox', fatal: false });
    expect(classifyCodexDiagnostic('ERROR thread not found: abc')).toMatchObject({ category: 'session', fatal: true });
    expect(classifyCodexDiagnostic('ERROR unknown model gpt-x')).toMatchObject({ category: 'models', fatal: true });
    expect(classifyCodexDiagnostic('WARN failed to refresh available models')).toMatchObject({ category: 'models', fatal: false });
    expect(classifyCodexDiagnostic('2026-10-18T00:51:03Z WARN codex_core::rollout::list: state db missing rollout path')).toMatchObject({ level: 'info' });
    expect(classifyCodexDiagnostic('Reading prompt from stdin...')).toMatchObject({ category: 'unknown', level: 'info' });
  });
});
