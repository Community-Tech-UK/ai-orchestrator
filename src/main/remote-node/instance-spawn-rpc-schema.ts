import { z } from 'zod/v4';
import { RemoteSpawnMetadataSchema } from './remote-spawn-metadata';
import { REASONING_EFFORTS } from '../../shared/types/provider.types';
import { RemoteClaudeSpawnPolicySchema } from './claude-spawn-policy-schema';

const ProviderModelIdSchema = z.string().max(512);

export const InstanceSpawnParamsSchema = z.object({
  ...RemoteSpawnMetadataSchema.shape,
  instanceId: z.string().min(1), sessionId: z.string().min(1).max(512).optional(), interactionId: z.string().uuid().optional(),
  cliType: z.string().min(1),
  workingDirectory: z.string().min(1),
  usageSettlementProtocol: z.literal(1).optional(), // Per-instance opt-in; legacy workers strip it.
  systemPrompt: z.string().optional(),
  model: ProviderModelIdSchema.optional(),
  /**
   * Optional for wire compatibility: older workers may omit this field and
   * continue to use the CLI's own default.
   */
  reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
  yoloMode: z.boolean().optional(),
  allowedTools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  resume: z.boolean().optional(),
  forkSession: z.boolean().optional(),
  transcriptKnown: z.boolean().optional(), additionalDirectories: z.array(z.string().min(1).max(4096)).max(64).optional(),
  mcpConfig: z.array(z.string()).optional(),
  nodePlacement: z.object({
    requiresBrowser: z.boolean().optional(),
    requiresAndroid: z.boolean().optional(),
    androidDeviceKind: z.enum(['emulator', 'physical', 'any']).optional(),
    requiresIos: z.boolean().optional(),
    requiresGpu: z.boolean().optional(),
    preferPlatform: z.enum(['darwin', 'win32', 'linux']).optional(),
    preferNodeId: z.string().optional(),
    requiresCli: z.string().optional(),
    requiresOpenCodeMajor: z.union([z.literal(1), z.literal(2)]).optional(),
    requiresWorkingDirectory: z.string().optional(),
  }).optional(),
  /**
   * GitHub Copilot account routing (spec §13).
   *
   * SAFE METADATA ONLY. The worker derives its own profile home from
   * `profileId` under its own AIO state directory and verifies its own local
   * binding before spawning. A controller path or a token must never appear
   * here — the whole point of node-local binding is that credentials do not
   * travel.
   *
   * Optional for wire compatibility: an older worker ignores it, which means an
   * unrouted Copilot spawn — the controller-side fail-closed check in
   * `createCliAdapter` is what stops that reaching a worker at all.
   */
  copilotAccountRoute: z.object({
    profileId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    expectedLogin: z.string().max(64).nullable().optional(),
    host: z.string().max(253).optional(),
    source: z.string().max(32).optional(),
  }).optional(),
  /**
   * Claude Code / Codex / OpenCode account pool routing (decision D10). Same
   * contract as `copilotAccountRoute`: safe metadata only, the worker verifies
   * its own binding for the profile before spawning. OpenCode/MiMo routes also
   * carry the Token Plan `region` — it derives the account's provider name and
   * model metadata on the executing node, and is never a path or credential.
   */
  accountRoute: z.object({
    provider: z.enum(['claude', 'codex', 'opencode']),
    profileId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    expectedIdentity: z.string().max(320).nullable().optional(),
    source: z.string().max(32).optional(),
    region: z.enum(['ams', 'sgp', 'cn']).optional(),
  }).optional(),
  claudeSpawnPolicy: RemoteClaudeSpawnPolicySchema.optional(),
  rtk: z.object({ enabled: z.boolean() }).strict().optional(),
});

export const InstanceChangeModelParamsSchema = z.object({
  previousInstanceId: z.string().min(1).max(200),
  replacement: InstanceSpawnParamsSchema,
}).strict();
