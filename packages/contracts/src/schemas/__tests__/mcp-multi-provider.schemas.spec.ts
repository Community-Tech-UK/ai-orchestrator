import { describe, expect, it } from 'vitest';
import {
  McpInjectionTargetsPayloadSchema,
  OrchestratorMcpServerSchema,
  OrchestratorMcpServerUpsertSchema,
  McpConnectorAuthPayloadSchema,
} from '@contracts/schemas/mcp-multi-provider';

describe('mcp-multi-provider schemas', () => {
  it('rejects non-orchestrator scopes for orchestrator records', () => {
    const result = OrchestratorMcpServerSchema.safeParse({
      id: 'x',
      name: 'x',
      scope: 'user',
      transport: 'stdio',
      command: 'node',
      autoConnect: false,
      createdAt: 1,
      updatedAt: 1,
    });
    expect(result.success).toBe(false);
  });

  it('accepts HTTP records with urls', () => {
    const result = OrchestratorMcpServerSchema.safeParse({
      id: 'x',
      name: 'x',
      scope: 'orchestrator-bootstrap',
      transport: 'http',
      url: 'https://example.com/mcp',
      autoConnect: true,
      createdAt: 1,
      updatedAt: 1,
    });
    expect(result.success).toBe(true);
  });

  it('allows empty injection target arrays', () => {
    expect(McpInjectionTargetsPayloadSchema.safeParse({ serverId: 'x', providers: [] }).success)
      .toBe(true);
  });

  it('accepts Gemini and Cursor connector injection without accepting Cursor file settings', () => {
    expect(McpInjectionTargetsPayloadSchema.safeParse({ serverId: 'x', providers: ['gemini', 'cursor'] }).success)
      .toBe(true);
    expect(OrchestratorMcpServerUpsertSchema.safeParse({
      name: 'connector', transport: 'stdio', command: 'PLACEHOLDER_COMMAND', injectInto: ['gemini', 'cursor'],
    }).success).toBe(true);
  });

  it('preserves orchestrator injection targets on upsert payloads', () => {
    const result = OrchestratorMcpServerUpsertSchema.safeParse({
      name: 'fs',
      transport: 'stdio',
      command: 'npx',
      injectInto: ['claude'],
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.injectInto).toEqual(['claude']);
  });

  it('allows edit payloads to omit redacted HTTP urls', () => {
    expect(
      OrchestratorMcpServerUpsertSchema.safeParse({
        id: 'server-id',
        name: 'http-server',
        transport: 'http',
      }).success,
    ).toBe(true);
  });

  it('accepts a Microsoft 365 connector without a local program', () => {
    expect(OrchestratorMcpServerUpsertSchema.safeParse({
      name: 'm365-comtech', kind: 'microsoft365', accountId: 'PLACEHOLDER_ACCOUNT', transport: 'stdio',
    }).success).toBe(true);
  });

  it('requires a bearer value only for saving a bearer token', () => {
    expect(McpConnectorAuthPayloadSchema.safeParse({ serverId: 'connector', action: 'set-bearer' }).success).toBe(false);
    expect(McpConnectorAuthPayloadSchema.safeParse({ serverId: 'connector', action: 'test', bearerToken: 'PLACEHOLDER_TOKEN' }).success).toBe(false);
    expect(McpConnectorAuthPayloadSchema.safeParse({ serverId: 'connector', action: 'set-bearer', bearerToken: 'PLACEHOLDER_TOKEN' }).success).toBe(true);
  });
});
