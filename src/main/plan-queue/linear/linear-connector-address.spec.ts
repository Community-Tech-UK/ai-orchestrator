import { describe, expect, it } from 'vitest';
import type { OrchestratorMcpServer } from '../../../shared/types/mcp-orchestrator.types';
import { checkLinearConnectorRecord, isLinearConnectorRecord } from './linear-connector-address';

function record(overrides: Partial<OrchestratorMcpServer> = {}): OrchestratorMcpServer {
  return {
    id: 'c1',
    name: 'whatever name',
    scope: 'orchestrator',
    kind: 'remote',
    authType: 'oauth',
    transport: 'http',
    url: 'https://mcp.linear.app/mcp',
    autoConnect: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('Linear connector address rule', () => {
  it('accepts the read-and-write and the older streaming address, with browser sign-in or a key', () => {
    expect(checkLinearConnectorRecord(record())).toEqual({ ok: true });
    expect(checkLinearConnectorRecord(record({ url: 'https://mcp.linear.app/sse', transport: 'sse' }))).toEqual({ ok: true });
    expect(checkLinearConnectorRecord(record({ authType: 'bearer' }))).toEqual({ ok: true });
    expect(checkLinearConnectorRecord(record({ url: 'https://MCP.Linear.App/mcp' }))).toEqual({ ok: true });
  });

  it('goes by the address and never the name', () => {
    expect(isLinearConnectorRecord(record({ name: 'linear', url: 'https://example.test/mcp' }))).toBe(false);
    expect(isLinearConnectorRecord(record({ name: 'My notes', url: 'https://mcp.linear.app/mcp' }))).toBe(true);
  });

  it.each([
    ['http:', 'http://mcp.linear.app/mcp'],
    ['another host', 'https://example.test/mcp'],
    ['a look-alike host', 'https://mcp.linear.app.example.test/mcp'],
    ['a host that only ends the same way', 'https://evilmcp.linear.app/mcp'],
    ['a trailing-dot host', 'https://mcp.linear.app./mcp'],
    ['a user name in the address', 'https://user@mcp.linear.app/mcp'],
    ['a user name and password in the address', 'https://user:secret@mcp.linear.app/mcp'],
    ['a look-alike made with a user name', 'https://mcp.linear.app@example.test/mcp'],
    ['a port', 'https://mcp.linear.app:8443/mcp'],
    ['another path', 'https://mcp.linear.app/other'],
    ['a longer path', 'https://mcp.linear.app/mcp/extra'],
    ['a trailing slash', 'https://mcp.linear.app/mcp/'],
    ['a query', 'https://mcp.linear.app/mcp?x=1'],
    ['a fragment', 'https://mcp.linear.app/mcp#x'],
    ['no address at all', ''],
    ['an address that is not a web address', 'not a url'],
  ])('refuses %s', (_label, url) => {
    const check = checkLinearConnectorRecord(record({ url }));
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.problem).toBe('not-linear');
  });

  it('refuses the read-only address with its own plain reason', () => {
    const check = checkLinearConnectorRecord(record({ url: 'https://mcp.linear.app/mcp/readonly' }));
    expect(check).toMatchObject({ ok: false, problem: 'read-only' });
    if (!check.ok) expect(check.reason).toContain('read and write');
  });

  it('refuses a local program, a Microsoft 365 record, a connector that is off, and one with no sign-in', () => {
    expect(checkLinearConnectorRecord(record({ kind: 'local', transport: 'stdio', url: undefined, command: 'linear' }))).toMatchObject({ ok: false, problem: 'not-linear' });
    expect(checkLinearConnectorRecord(record({ transport: 'stdio' }))).toMatchObject({ ok: false });
    expect(checkLinearConnectorRecord(record({ kind: 'microsoft365', accountId: 'a' }))).toMatchObject({ ok: false, problem: 'not-linear' });
    expect(checkLinearConnectorRecord(record({ autoConnect: false }))).toMatchObject({ ok: false, problem: 'off' });
    expect(checkLinearConnectorRecord(record({ authType: 'none' }))).toMatchObject({ ok: false, problem: 'not-linear' });
    expect(checkLinearConnectorRecord(record({ authType: undefined }))).toMatchObject({ ok: false });
  });
});
