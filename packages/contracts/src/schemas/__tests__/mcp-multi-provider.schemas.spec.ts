import { describe, expect, it } from 'vitest';
import {
  McpFanOutPayloadSchema,
  McpInjectionTargetsPayloadSchema,
  McpResolveDriftPayloadSchema,
  OrchestratorMcpServerSchema,
  OrchestratorMcpServerUpsertSchema,
  SharedMcpServerUpsertSchema,
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

  it('requires shared targets', () => {
    expect(
      SharedMcpServerUpsertSchema.safeParse({
        name: 'fs',
        transport: 'stdio',
        command: 'npx',
        targets: [],
      }).success,
    ).toBe(false);
  });

  it('validates fan-out providers', () => {
    expect(McpFanOutPayloadSchema.safeParse({ serverId: 'x', providers: ['claude'] }).success)
      .toBe(true);
    expect(McpFanOutPayloadSchema.safeParse({ serverId: 'x', providers: ['cursor'] }).success)
      .toBe(false);
  });

  it('validates drift resolution action', () => {
    expect(
      McpResolveDriftPayloadSchema.safeParse({
        serverId: 'x',
        provider: 'claude',
        action: 'overwrite-target',
      }).success,
    ).toBe(true);
    expect(
      McpResolveDriftPayloadSchema.safeParse({
        serverId: 'x',
        provider: 'claude',
        action: 'invalid',
      }).success,
    ).toBe(false);
  });

  it('allows empty injection target arrays', () => {
    expect(McpInjectionTargetsPayloadSchema.safeParse({ serverId: 'x', providers: [] }).success)
      .toBe(true);
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
});
