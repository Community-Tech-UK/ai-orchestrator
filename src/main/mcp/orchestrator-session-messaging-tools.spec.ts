import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createOperatorTables } from '../operator/operator-schema';
import { DEFAULT_SETTINGS, type AppSettings } from '../../shared/types/settings.types';
import type { SettingsManagerForTools } from './orchestrator-settings-tools';
import {
  createOrchestratorToolDefinitions,
  type OrchestratorToolRuntimeContext,
} from './orchestrator-tools';
import { createOrchestratorToolsForwarderTools } from './orchestrator-tools-mcp-forwarder';
import type { OrchestratorToolsRpcClientLike } from './orchestrator-tools-rpc-client';
import type {
  CrossSessionMessageResult,
  MessageableSession,
} from '@contracts/schemas/instance';
import type { SessionMessagingToolService } from './orchestrator-session-messaging-tools';

function stubClient(impl: OrchestratorToolsRpcClientLike['call']): OrchestratorToolsRpcClientLike {
  return { call: impl };
}

function createSettingsManager(enabled: boolean): SettingsManagerForTools {
  const settings: AppSettings = {
    ...DEFAULT_SETTINGS,
    interSessionMessaging: {
      ...DEFAULT_SETTINGS.interSessionMessaging,
      enabled,
    },
  };
  return {
    getAll: () => settings,
    get: (key) => settings[key],
    set: vi.fn(),
    resetOne: vi.fn(),
  };
}

function createDb(dbs: SqliteDriver[]): SqliteDriver {
  const db = defaultDriverFactory(':memory:');
  createOperatorTables(db);
  dbs.push(db);
  return db;
}

function createContext(
  db: SqliteDriver,
  overrides: Partial<OrchestratorToolRuntimeContext> = {},
): OrchestratorToolRuntimeContext {
  return {
    db,
    instanceId: 'source-instance',
    settingsManager: createSettingsManager(true),
    ...overrides,
  };
}

describe('orchestrator session messaging MCP tools', () => {
  const dbs: SqliteDriver[] = [];

  afterEach(() => {
    for (const db of dbs) db.close();
    dbs.length = 0;
  });

  it('does not advertise the tools when interSessionMessaging.enabled is false', () => {
    const db = createDb(dbs);
    const tools = createOrchestratorToolDefinitions(createContext(db, {
      settingsManager: createSettingsManager(false),
      sessionMessagingService: {
        sendMessage: vi.fn(),
        listMessageableSessions: vi.fn(),
      } as unknown as SessionMessagingToolService,
    }));

    expect(tools.map((tool) => tool.name)).not.toContain('send_session_message');
    expect(tools.map((tool) => tool.name)).not.toContain('list_messageable_sessions');
    expect(
      createOrchestratorToolsForwarderTools(stubClient(async () => null), {
        sessionMessagingEnabled: false,
      }).map((tool) => tool.name),
    ).not.toContain('send_session_message');
  });

  it('advertises send_session_message when enabled and delegates with the calling instance id', async () => {
    const db = createDb(dbs);
    const delivered: CrossSessionMessageResult = {
      outcome: 'delivered',
      targetInstanceId: 'target-instance',
      targetDisplayName: 'Target Session',
      hopCount: 0,
    };
    const sendMessage = vi.fn(async () => delivered);
    const tools = createOrchestratorToolDefinitions(createContext(db, {
      sessionMessagingService: {
        sendMessage,
        listMessageableSessions: vi.fn(),
      } as SessionMessagingToolService,
    }));
    const tool = tools.find((candidate) => candidate.name === 'send_session_message');

    expect(tool).toBeDefined();
    await expect(tool!.handler({
      target: 'Target Session',
      message: 'Please refresh the health check.',
    })).resolves.toEqual(delivered);
    expect(sendMessage).toHaveBeenCalledWith({
      sourceInstanceId: 'source-instance',
      targetNameOrId: 'Target Session',
      message: 'Please refresh the health check.',
    });
  });

  it('rejects malformed or oversized send_session_message payloads before reaching the service and caps the forwarder schema', async () => {
    const db = createDb(dbs);
    const sendMessage = vi.fn(async (): Promise<CrossSessionMessageResult> => ({
      outcome: 'delivered',
      targetInstanceId: 'target-instance',
      targetDisplayName: 'Target Session',
      hopCount: 0,
    }));
    const tools = createOrchestratorToolDefinitions(createContext(db, {
      sessionMessagingService: {
        sendMessage,
        listMessageableSessions: vi.fn(),
      } as SessionMessagingToolService,
    }));
    const tool = tools.find((candidate) => candidate.name === 'send_session_message')!;
    const forwarderTool = createOrchestratorToolsForwarderTools(
      stubClient(async () => null),
      { sessionMessagingEnabled: true },
    ).find((candidate) => candidate.name === 'send_session_message');

    await expect(tool.handler({
      target: 'Target Session',
      message: 'x'.repeat(10_001),
    })).rejects.toThrow();
    await expect(tool.handler({
      target: '   ',
      message: 'hello',
    })).rejects.toThrow();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(forwarderTool?.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        target: { type: 'string', minLength: 1, maxLength: 200 },
        message: { type: 'string', minLength: 1, maxLength: 10_000 },
      },
      required: ['target', 'message'],
      additionalProperties: false,
    });
  });

  it('returns exactly what list_messageable_sessions returns', async () => {
    const db = createDb(dbs);
    const sessions: MessageableSession[] = [
      {
        instanceId: 'target-instance',
        displayName: 'Target Session',
        reachable: true,
        reason: 'reachable',
      },
      {
        instanceId: 'other-instance',
        displayName: 'Other Session',
        reachable: false,
        reason: 'consent-disabled',
      },
    ];
    const listMessageableSessions = vi.fn(() => sessions);
    const tools = createOrchestratorToolDefinitions(createContext(db, {
      sessionMessagingService: {
        sendMessage: vi.fn(),
        listMessageableSessions,
      } as SessionMessagingToolService,
    }));
    const tool = tools.find((candidate) => candidate.name === 'list_messageable_sessions');

    expect(tool).toBeDefined();
    await expect(tool!.handler({})).resolves.toBe(sessions);
    expect(listMessageableSessions).toHaveBeenCalledWith('source-instance');
  });

  it('forwards the enabled session messaging tools over the canonical RPC methods', async () => {
    const call = vi.fn(async (_method: string, payload: Record<string, unknown>) => payload);
    const tools = createOrchestratorToolsForwarderTools(stubClient(call), {
      sessionMessagingEnabled: true,
    });
    const sendTool = tools.find((tool) => tool.name === 'send_session_message');
    const listTool = tools.find((tool) => tool.name === 'list_messageable_sessions');

    await expect(sendTool!.handler({
      target: 'Target Session',
      message: 'Hello',
    })).resolves.toEqual({
      target: 'Target Session',
      message: 'Hello',
    });
    await expect(listTool!.handler({})).resolves.toEqual({});
    expect(call).toHaveBeenNthCalledWith(1, 'orchestrator_tools.send_session_message', {
      target: 'Target Session',
      message: 'Hello',
    });
    expect(call).toHaveBeenNthCalledWith(2, 'orchestrator_tools.list_messageable_sessions', {});
  });
});
