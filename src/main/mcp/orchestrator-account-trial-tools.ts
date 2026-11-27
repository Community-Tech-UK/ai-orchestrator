import * as path from 'node:path';
import { z } from 'zod/v4';
import type { McpServerToolDefinition } from './mcp-server-tools';
import type { OrchestratorToolsRpcClientLike } from './orchestrator-tools-rpc-client';
import {
  ACCOUNT_TRIAL_DEFAULT_TTL_MINUTES,
  ACCOUNT_TRIAL_MAX_PROFILES,
  ACCOUNT_TRIAL_MAX_SESSIONS,
  ACCOUNT_TRIAL_MAX_TTL_MINUTES,
  ACCOUNT_TRIAL_POLICY,
  type AccountTrialOperations,
} from '../../shared/types/account-trial.types';

export const ACCOUNT_TRIAL_TOOL = 'account_trial';

const DESCRIPTION =
  'Reserve AI accounts for a trial and start chat sessions on them (account settings are read-only to agents). '
  + `Actions: reserve {profiles:[{provider,profileId}], ttlMinutes?} saves each account's automation policy and sets it to "${ACCOUNT_TRIAL_POLICY}" `
  + `(the only value it can set; default ${ACCOUNT_TRIAL_DEFAULT_TTL_MINUTES} min, max ${ACCOUNT_TRIAL_MAX_TTL_MINUTES}, up to ${ACCOUNT_TRIAL_MAX_PROFILES} accounts), returns leaseId; `
  + `start_session {leaseId,provider,profileId,prompt,model?,workingDirectory?,name?} starts a fresh chat on an account in your lease (max ${ACCOUNT_TRIAL_MAX_SESSIONS}), returns instanceId; `
  + 'release {leaseId} restores every saved policy and stops that lease\'s sessions; status {} shows your leases. '
  + 'Take provider and profileId from get_setting providerAccountProfiles (Claude and Codex legacy accounts share the id "legacy"). '
  + 'A lease also ends when your session ends, on expiry, or at Harness restart. A policy changed by hand meanwhile is left alone and reported. '
  + 'Never creates, signs in, enables or removes an account.';

const ProfileRefSchema = z.object({
  provider: z.enum(['claude', 'codex', 'opencode']),
  profileId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'profileId must be a lowercase safe slug'),
}).strict();

const LeaseIdSchema = z.string().min(1).max(100);

export const AccountTrialArgsSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('reserve'),
    profiles: z.array(ProfileRefSchema).min(1).max(ACCOUNT_TRIAL_MAX_PROFILES),
    ttlMinutes: z.number().int().min(1).max(ACCOUNT_TRIAL_MAX_TTL_MINUTES).optional(),
  }).strict(),
  z.object({
    action: z.literal('start_session'),
    leaseId: LeaseIdSchema,
    provider: z.enum(['claude', 'codex', 'opencode']),
    profileId: ProfileRefSchema.shape.profileId,
    prompt: z.string().min(1).max(50_000),
    model: z.string().trim().min(1).max(200).optional(),
    workingDirectory: z.string().min(1).max(1000)
      .refine((value) => path.isAbsolute(value) || path.win32.isAbsolute(value), { message: 'workingDirectory must be an absolute path' })
      .optional(),
    name: z.string().trim().min(1).max(100).optional(),
  }).strict(),
  z.object({ action: z.literal('release'), leaseId: LeaseIdSchema }).strict(),
  z.object({ action: z.literal('status') }).strict(),
]);

export type AccountTrialArgs = z.infer<typeof AccountTrialArgsSchema>;

export interface AccountTrialToolContext {
  instanceId?: string | null;
  accountTrial?: AccountTrialOperations | null;
}

const inputSchema = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['reserve', 'start_session', 'release', 'status'] },
    profiles: {
      type: 'array',
      minItems: 1,
      maxItems: ACCOUNT_TRIAL_MAX_PROFILES,
      
      items: {
        type: 'object',
        properties: {
          provider: { type: 'string', enum: ['claude', 'codex', 'opencode'] },
          profileId: { type: 'string' },
        },
        required: ['provider', 'profileId'],
        additionalProperties: false,
      },
    },
    ttlMinutes: { type: 'integer', minimum: 1, maximum: ACCOUNT_TRIAL_MAX_TTL_MINUTES },
    leaseId: { type: 'string' },
    provider: { type: 'string', enum: ['claude', 'codex', 'opencode'] },
    profileId: { type: 'string' },
    prompt: { type: 'string' },
    model: { type: 'string', description: 'MiMo accounts need a Token Plan model.' },
    workingDirectory: { type: 'string', description: 'Absolute path; defaults to your folder.' },
    name: { type: 'string' },
  },
  required: ['action'],
  additionalProperties: false,
};

export function createAccountTrialToolDefinitions(context: AccountTrialToolContext): McpServerToolDefinition[] {
  return [
    {
      name: ACCOUNT_TRIAL_TOOL,
      description: DESCRIPTION,
      inputSchema,
      handler: async (args) => {
        const parsed = AccountTrialArgsSchema.parse(args);
        if (!context.accountTrial) {
          throw new Error('account_trial is unavailable: account trial control is not wired in this process');
        }
        if (!context.instanceId) {
          throw new Error('account_trial is unavailable: the calling session could not be identified');
        }
        const owner = context.instanceId;
        const trial = context.accountTrial;
        switch (parsed.action) {
          case 'reserve':
            return trial.reserve(owner, {
              profiles: parsed.profiles,
              ...(parsed.ttlMinutes !== undefined ? { ttlMinutes: parsed.ttlMinutes } : {}),
            });
          case 'start_session':
            return trial.startSession(owner, {
              leaseId: parsed.leaseId,
              provider: parsed.provider,
              profileId: parsed.profileId,
              prompt: parsed.prompt,
              ...(parsed.model ? { model: parsed.model } : {}),
              ...(parsed.workingDirectory ? { workingDirectory: parsed.workingDirectory } : {}),
              ...(parsed.name ? { name: parsed.name } : {}),
            });
          case 'release':
            return trial.release(owner, parsed.leaseId);
          case 'status':
            return trial.status(owner);
        }
      },
    },
  ];
}

export function createAccountTrialForwarderTools(client: OrchestratorToolsRpcClientLike): McpServerToolDefinition[] {
  return [
    {
      name: ACCOUNT_TRIAL_TOOL,
      description: DESCRIPTION,
      inputSchema,
      handler: async (args) => {
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          throw new Error('account_trial args must be an object');
        }
        return client.call(`orchestrator_tools.${ACCOUNT_TRIAL_TOOL}`, args as Record<string, unknown>);
      },
    },
  ];
}
