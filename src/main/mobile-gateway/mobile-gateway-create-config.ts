/**
 * What a phone's "new session" request becomes: the owner's choices as sent,
 * or, for a member, the settings the owner saved for that person.
 */
import type { FileAttachment, InstanceCreateConfig } from '../../shared/types/instance.types';
import type { MobileMemberProfile } from '../../shared/types/mobile-gateway.types';
import type { ReasoningEffort } from '../../shared/types/provider.types';
import type { QuotaAccountProfile } from '../../shared/utils/provider-quota-account-sections';
import { buildMemberCreateConfig, MobileSessionRequestError } from './mobile-gateway-member-session';

const VALID_PROVIDERS = new Set([
  'auto', 'claude', 'codex', 'gemini', 'antigravity', 'copilot', 'cursor', 'grok', 'opencode',
]);

/** The create request after the route has checked each field's shape. */
export interface MobileCreateRequest {
  workingDirectory: string;
  /** As typed on the phone. The owner's is checked against the known providers, a member's against Claude and Codex. */
  provider?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  accountProfileId?: string;
  initialPrompt?: string;
  attachments?: FileAttachment[];
  forceNodeId?: string;
  nodeName: string;
}

/** Throws `MobileSessionRequestError` when the request cannot be placed. */
export function buildMobileCreateConfig(
  request: MobileCreateRequest,
  member: MobileMemberProfile | undefined,
  deps: { accounts(): readonly QuotaAccountProfile[]; resolveNodeId(nameOrId: string): string | null },
): InstanceCreateConfig {
  const config = member
    ? buildMemberCreateConfig(member, request, deps.accounts())
    : buildOwnerCreateConfig(request, deps.resolveNodeId);
  // The phone's new-session box is a person typing, like its send box.
  return config.initialPrompt?.trim()
    ? { ...config, initialPromptOrigin: { kind: 'person' as const, typedAt: Date.now() } }
    : config;
}

function buildOwnerCreateConfig(
  request: MobileCreateRequest,
  resolveNodeId: (nameOrId: string) => string | null,
): InstanceCreateConfig {
  let forceNodeId = request.forceNodeId;
  if (!forceNodeId && request.nodeName) {
    forceNodeId = resolveNodeId(request.nodeName) ?? undefined;
    if (!forceNodeId) throw new MobileSessionRequestError(404, `Worker node not found: ${request.nodeName}`);
  }
  return {
    workingDirectory: request.workingDirectory,
    initialPrompt: request.initialPrompt,
    attachments: request.attachments,
    provider: request.provider && VALID_PROVIDERS.has(request.provider)
      ? (request.provider as InstanceCreateConfig['provider'])
      : undefined,
    modelOverride: request.model,
    reasoningEffort: request.reasoningEffort,
    ...(request.accountProfileId ? { accountProfileId: request.accountProfileId } : {}),
    forceNodeId,
  };
}
