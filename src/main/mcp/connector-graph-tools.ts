import { z } from 'zod';
import type { GraphSearchMailInput } from '../graph/graph-client';
import type { McpServerToolDefinition } from './mcp-server-tools';
import {
  CalendarCreateEventToolArgsSchema,
  CalendarDeleteEventToolArgsSchema,
  CalendarUpdateEventToolArgsSchema,
  createCalendarToolDefinitions,
  requireWritableAccountKey,
  sanitizeCalendarResult,
  type CalendarGraphClientForTools,
  type CalendarToolDependencies,
} from './orchestrator-calendar-tools';

export interface GraphMailClientForTools {
  searchMail(accountKey: string, input: GraphSearchMailInput): Promise<unknown>;
  readMail(accountKey: string, messageId: string): Promise<unknown>;
  listMailFolders(accountKey: string, folderId?: string): Promise<unknown>;
  createMailDraft(accountKey: string, message: Record<string, unknown>): Promise<unknown>;
  sendMailDraft(accountKey: string, messageId: string): Promise<unknown>;
}

export interface GraphConnectorDependencies extends CalendarToolDependencies {
  graphClient?: (CalendarGraphClientForTools & GraphMailClientForTools) | null;
  assertActive?: () => void;
  authorizeMutation?: (request: {
    accountKey: string;
    toolName: string;
    args: Record<string, unknown>;
  }) => Promise<boolean>;
}

const IdSchema = z.string().trim().min(1).max(512);
const RecipientSchema = z.object({
  emailAddress: z.object({
    address: z.string().trim().email().max(320),
    name: z.string().trim().min(1).max(256).optional(),
  }).strict(),
}).strict();

export const MailSearchArgsSchema = z.object({
  search: z.string().trim().min(1).max(2_000),
  folderId: IdSchema.optional(),
  top: z.number().int().min(1).max(100).optional(),
}).strict();
export const MailReadArgsSchema = z.object({ messageId: IdSchema }).strict();
export const MailListFoldersArgsSchema = z.object({ folderId: IdSchema.optional() }).strict();
export const MailCreateDraftArgsSchema = z.object({
  subject: z.string().trim().min(1).max(255),
  body: z.object({
    contentType: z.enum(['text', 'html']),
    content: z.string().max(100_000),
  }).strict(),
  toRecipients: z.array(RecipientSchema).min(1).max(100),
  ccRecipients: z.array(RecipientSchema).max(100).optional(),
  bccRecipients: z.array(RecipientSchema).max(100).optional(),
}).strict();
export const MailSendArgsSchema = MailReadArgsSchema;

const CALENDAR_MUTATION_SCHEMAS = {
  graph_calendar_create_event: CalendarCreateEventToolArgsSchema,
  graph_calendar_update_event: CalendarUpdateEventToolArgsSchema,
  graph_calendar_delete_event: CalendarDeleteEventToolArgsSchema,
};

/** A catalog is bound to one connector account; it cannot discover or change other accounts. */
export function listGraphConnectorTools(
  accountKey: string,
  dependencies: GraphConnectorDependencies,
  mailEnabled = false,
): McpServerToolDefinition[] {
  const tools = createCalendarToolDefinitions(dependencies)
    .filter((tool) => !['graph_calendar_connect', 'graph_calendar_status', 'graph_calendar_list_accounts'].includes(tool.name))
    .map((tool): McpServerToolDefinition => ({
      ...tool,
      inputSchema: withoutAccount(tool.inputSchema),
      handler: (args) => withFriendlyConnectorReauth(async () => {
        refuseAccountArgument(args);
        const boundArgs = { ...args, account: accountKey };
        const schema = CALENDAR_MUTATION_SCHEMAS[tool.name as keyof typeof CALENDAR_MUTATION_SCHEMAS];
        if (schema) {
          schema.parse(boundArgs);
          await requireWritableAccountKey(dependencies, accountKey);
          await authorizeMutation(dependencies, accountKey, tool.name, args);
        }
        dependencies.assertActive?.();
        return tool.handler(boundArgs);
      }),
    }));
  if (mailEnabled) tools.push(...mailTools(accountKey, dependencies));
  return tools;
}

export async function callGraphConnectorTool(
  accountKey: string,
  toolName: string,
  args: Record<string, unknown>,
  dependencies: GraphConnectorDependencies,
  mailEnabled = false,
): Promise<unknown> {
  const tool = listGraphConnectorTools(accountKey, dependencies, mailEnabled).find((candidate) => candidate.name === toolName);
  if (!tool) throw new Error(`Unknown Microsoft 365 connector tool: ${toolName}`);
  const result = await tool.handler(args);
  return result === undefined ? { ok: true } : result;
}

function mailTools(accountKey: string, dependencies: GraphConnectorDependencies): McpServerToolDefinition[] {
  const tool = <T extends Record<string, unknown>>(
    name: string,
    description: string,
    schema: z.ZodType<T>,
    handler: (client: GraphMailClientForTools, args: T) => Promise<unknown>,
    write = false,
    approval = false,
  ): McpServerToolDefinition => ({
    name, description,
    inputSchema: z.toJSONSchema(schema) as Record<string, unknown>,
    handler: (args) => withFriendlyConnectorReauth(async () => {
      const parsed = schema.parse(args);
      await requireConnectedAccount(dependencies, accountKey);
      if (write) await requireWritableAccountKey(dependencies, accountKey);
      if (approval) await authorizeMutation(dependencies, accountKey, name, parsed);
      if (write) await requireWritableAccountKey(dependencies, accountKey);
      if (!dependencies.graphClient) throw new Error('Microsoft 365 tools are unavailable in this process.');
      dependencies.assertActive?.();
      return sanitizeCalendarResult(await handler(dependencies.graphClient, parsed));
    }),
  });
  return [
    tool('graph_mail_search', 'Search mail in this Microsoft 365 account using Outlook search terms. Returns at most top messages (25 by default).',
      MailSearchArgsSchema, (client, args) => client.searchMail(accountKey, args)),
    tool('graph_mail_read', 'Read one message from this Microsoft 365 account.',
      MailReadArgsSchema, (client, args) => client.readMail(accountKey, args.messageId)),
    tool('graph_mail_list_folders', 'List top-level mail folders, or child folders of folderId, in this Microsoft 365 account.',
      MailListFoldersArgsSchema, (client, args) => client.listMailFolders(accountKey, args.folderId)),
    tool('graph_mail_create_draft', 'Create an unsent draft in this agent-writable Microsoft 365 account.',
      MailCreateDraftArgsSchema, (client, args) => client.createMailDraft(accountKey, args), true),
    tool('graph_mail_send', 'Send an existing draft from this agent-writable Microsoft 365 account. Requires operator approval.',
      MailSendArgsSchema, (client, args) => client.sendMailDraft(accountKey, args.messageId), true, true),
  ];
}

function withoutAccount(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = { ...(schema['properties'] as Record<string, unknown>) };
  delete properties['account'];
  return {
    ...schema,
    properties,
    required: (schema['required'] as string[]).filter((name) => name !== 'account'),
  };
}

function refuseAccountArgument(args: Record<string, unknown>): void {
  if (Object.hasOwn(args, 'account')) throw new Error('The account is fixed by this connector and cannot be changed in a tool call.');
}

async function requireConnectedAccount(dependencies: GraphConnectorDependencies, accountKey: string): Promise<void> {
  const accounts = await dependencies.authManager?.listAccounts();
  if (!accounts?.some((account) => account.accountKey === accountKey)) {
    throw new Error('Sign in to this Microsoft 365 account again in Settings → Connectors.');
  }
}

async function authorizeMutation(
  dependencies: GraphConnectorDependencies,
  accountKey: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<void> {
  if (!await dependencies.authorizeMutation?.({ accountKey, toolName, args })) {
    throw new Error('Microsoft 365 changes require operator approval.');
  }
}

async function withFriendlyConnectorReauth(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof Error && /reauth_required|invalid_grant|interaction_required|login_required|authentication has expired/i.test(error.message)) {
      throw new Error('Sign in to this Microsoft 365 account again in Settings → Connectors.', { cause: error });
    }
    throw error;
  }
}
