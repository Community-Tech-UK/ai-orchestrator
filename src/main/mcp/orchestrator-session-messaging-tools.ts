import type {
  CrossSessionMessageResult,
  MessageableSession,
} from '@contracts/schemas/instance';
import { z } from 'zod/v4';
import type { CrossSessionMessagingService } from '../instance/cross-session-messaging';
import type { McpServerToolDefinition } from './mcp-server-tools';
import type { OrchestratorToolsRpcClientLike } from './orchestrator-tools-rpc-client';
import {
  LIST_MESSAGEABLE_SESSIONS_DESCRIPTION,
  SEND_SESSION_MESSAGE_DESCRIPTION,
} from './orchestrator-tool-copy';

const TARGET_MAX_LENGTH = 200;
const MESSAGE_MAX_LENGTH = 10_000;

export const INTER_SESSION_MESSAGING_ENABLED_ENV =
  'AI_ORCHESTRATOR_INTER_SESSION_MESSAGING_ENABLED';

export const SendSessionMessageArgsSchema = z.object({
  target: z.string().trim().min(1).max(TARGET_MAX_LENGTH),
  message: z.string().min(1).max(MESSAGE_MAX_LENGTH),
}).strict();

export type SendSessionMessageArgs = z.infer<typeof SendSessionMessageArgsSchema>;

export const ListMessageableSessionsArgsSchema = z.object({}).strict();

export type ListMessageableSessionsArgs = z.infer<typeof ListMessageableSessionsArgsSchema>;

export type SessionMessagingToolService = Pick<
  CrossSessionMessagingService,
  'sendMessage' | 'listMessageableSessions'
>;

export interface SessionMessagingToolContext {
  instanceId?: string | null;
  enabled?: boolean;
  sessionMessagingService?: SessionMessagingToolService | null;
}

const sendSessionMessageInputSchema = {
  type: 'object',
  properties: {
    target: {
      type: 'string',
      minLength: 1,
      maxLength: TARGET_MAX_LENGTH,
      description:
        'Exact live instance id or a case-insensitive unique display name / AI title.',
    },
    message: {
      type: 'string',
      minLength: 1,
      maxLength: MESSAGE_MAX_LENGTH,
      description: 'Text to deliver into the target instance.',
    },
  },
  required: ['target', 'message'],
  additionalProperties: false,
} satisfies Record<string, unknown>;

const listMessageableSessionsInputSchema = {
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
} satisfies Record<string, unknown>;

export function resolveSessionMessagingEnabledFromEnv(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[INTER_SESSION_MESSAGING_ENABLED_ENV] === '1';
}

export function createSessionMessagingToolDefinitions(
  context: SessionMessagingToolContext,
): McpServerToolDefinition[] {
  if (context.enabled !== true || !context.instanceId) {
    return [];
  }

  return [
    {
      name: 'send_session_message',
      description: SEND_SESSION_MESSAGE_DESCRIPTION,
      inputSchema: sendSessionMessageInputSchema,
      handler: async (args) => {
        const parsed = SendSessionMessageArgsSchema.parse(args);
        if (!context.sessionMessagingService) {
          throw new Error(
            'send_session_message is unavailable: cross-session messaging is not wired in this process',
          );
        }
        return context.sessionMessagingService.sendMessage({
          sourceInstanceId: context.instanceId!,
          targetNameOrId: parsed.target,
          message: parsed.message,
        }) satisfies Promise<CrossSessionMessageResult>;
      },
    },
    {
      name: 'list_messageable_sessions',
      description: LIST_MESSAGEABLE_SESSIONS_DESCRIPTION,
      inputSchema: listMessageableSessionsInputSchema,
      handler: async (args) => {
        ListMessageableSessionsArgsSchema.parse(args ?? {});
        if (!context.sessionMessagingService) {
          throw new Error(
            'list_messageable_sessions is unavailable: cross-session messaging is not wired in this process',
          );
        }
        return context.sessionMessagingService.listMessageableSessions(
          context.instanceId!,
        ) satisfies MessageableSession[];
      },
    },
  ];
}

export function createSessionMessagingForwarderTools(
  client: OrchestratorToolsRpcClientLike,
  enabled = false,
): McpServerToolDefinition[] {
  if (!enabled) {
    return [];
  }

  return [
    {
      name: 'send_session_message',
      description: SEND_SESSION_MESSAGE_DESCRIPTION,
      inputSchema: sendSessionMessageInputSchema,
      handler: async (args) => {
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          throw new Error('send_session_message args must be an object');
        }
        return client.call(
          'orchestrator_tools.send_session_message',
          args as Record<string, unknown>,
        );
      },
    },
    {
      name: 'list_messageable_sessions',
      description: LIST_MESSAGEABLE_SESSIONS_DESCRIPTION,
      inputSchema: listMessageableSessionsInputSchema,
      handler: async (args) => {
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          throw new Error('list_messageable_sessions args must be an object');
        }
        return client.call(
          'orchestrator_tools.list_messageable_sessions',
          args as Record<string, unknown>,
        );
      },
    },
  ];
}
