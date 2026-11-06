/** Wire-safe spawn options shared by fresh spawns and guarded model replacements. */
import { remoteSpawnMetadata } from '../../remote-node/remote-spawn-metadata';
import type { CliType } from '../cli-detection';
import type { UnifiedSpawnOptions } from './adapter-factory.types';
import type { WorkerNodeCapabilities } from '../../../shared/types/worker-node.types';
import type { RemoteClaudeSpawnPolicy } from '../../remote-node/claude-spawn-policy-schema';

export function remoteCliSpawnParams(
  cliType: CliType,
  options: UnifiedSpawnOptions,
  interactionId: string,
  claudeSpawnPolicy: RemoteClaudeSpawnPolicy | undefined,
  capabilities: WorkerNodeCapabilities | undefined,
) {
  return {
    instanceId: options.sessionId,
    ...remoteSpawnMetadata(options, cliType === 'codex'),
    interactionId,
    cliType,
    usageSettlementProtocol: 1,
    workingDirectory: options.workingDirectory,
    systemPrompt: options.systemPrompt,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    yoloMode: options.yoloMode,
    allowedTools: options.allowedTools,
    disallowedTools: options.disallowedTools,
    resume: options.resume,
    forkSession: options.forkSession,
    transcriptKnown: options.transcriptKnown,
    additionalDirectories: options.additionalDirectories,
    mcpConfig: options.mcpConfig,
    nodePlacement: options.nodePlacement,
    // Copilot account routing: profile ID, expected identity, host, and
    // how it was chosen. Deliberately NOT the controller's profile home —
    // the worker derives its own and verifies its own local binding.
    ...(options.copilotAccountRoute
      ? {
          copilotAccountRoute: {
            profileId: options.copilotAccountRoute.profileId,
            expectedLogin: options.copilotAccountRoute.expectedLogin ?? null,
            ...(options.copilotAccountRoute.host
              ? { host: options.copilotAccountRoute.host }
              : {}),
            source: options.copilotAccountRoute.source,
          },
        }
      : {}),
    // Claude/Codex/OpenCode account pools (D10): same rule, a profile ID
    // and the identity expected (plus the MiMo Token Plan region). The
    // worker derives its own profile home / provider name.
    ...(options.accountRoute
      ? {
          accountRoute: {
            provider: options.accountRoute.provider,
            profileId: options.accountRoute.profileId,
            expectedIdentity: options.accountRoute.expectedIdentity ?? null,
            source: options.accountRoute.source,
            ...(options.accountRoute.region
              ? { region: options.accountRoute.region }
              : {}),
          },
        }
      : {}),
    ...(claudeSpawnPolicy ? { claudeSpawnPolicy } : {}),
    ...(capabilities?.claudeSpawnPolicy === 2
      ? {
          ...(options.rtk ? { rtk: { enabled: options.rtk.enabled } } : {}),
        } : {}),
  };
}
