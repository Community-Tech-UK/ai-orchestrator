/**
 * How a phone-app member's session is set up.
 *
 * The gateway decides where it runs, in which folder and on which accounts,
 * from the settings the owner saved for that person. Whatever the phone sends
 * for those is ignored, so a member cannot reach the owner's folders, other
 * workers or other accounts. The session never runs on this Mac: it is placed
 * on the person's own worker, and if that worker is offline it fails to start.
 */
import type { FileAttachment, InstanceCreateConfig } from '../../shared/types/instance.types';
import type { MobileMemberProfile } from '../../shared/types/mobile-gateway.types';
import type { ReasoningEffort } from '../../shared/types/provider.types';
import { MOBILE_PROFILE_METADATA_KEY } from '../../shared/utils/mobile-profile-stamp';
import type { QuotaAccountProfile } from '../../shared/utils/provider-quota-account-sections';

/** The providers a member may use: the ones whose accounts the owner can fence. */
const MEMBER_PROVIDERS = ['claude', 'codex'] as const;
type MemberProvider = (typeof MEMBER_PROVIDERS)[number];

export class MobileSessionRequestError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = 'MobileSessionRequestError';
  }
}

export interface MobileMemberCreateRequest {
  /** What the phone asked for. `auto` and unset both mean Claude. */
  provider?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  initialPrompt?: string;
  attachments?: FileAttachment[];
}

function memberProvider(requested: string | undefined): MemberProvider {
  if (requested === undefined || requested === 'auto') return 'claude';
  if ((MEMBER_PROVIDERS as readonly string[]).includes(requested)) return requested as MemberProvider;
  throw new MobileSessionRequestError(400, 'Choose Claude or Codex.');
}

/** The session settings Harness applies to everything a member starts. */
export function buildMemberCreateConfig(
  member: MobileMemberProfile,
  request: MobileMemberCreateRequest,
  accounts: readonly QuotaAccountProfile[],
): InstanceCreateConfig {
  const session = member.session;
  if (!session) {
    throw new MobileSessionRequestError(
      409,
      'Sessions are not set up for you yet. Ask the person who runs this Mac to choose a computer, a folder and an account for you.',
    );
  }
  const provider = memberProvider(request.provider);
  const hasAccount = accounts.some(
    (account) => account.provider === provider
      && account.enabled
      && session.allowedAccountProfileIds.includes(account.id),
  );
  if (!hasAccount) {
    throw new MobileSessionRequestError(409, `No ${provider === 'claude' ? 'Claude' : 'Codex'} account is set up for you yet.`);
  }
  return {
    ...memberSessionPolicy(member),
    // Naming the worker makes a session fail to start when it is offline, rather than run here.
    forceNodeId: session.workerNodeId,
    provider,
    initialPrompt: request.initialPrompt,
    attachments: request.attachments,
    modelOverride: request.model,
    reasoningEffort: request.reasoningEffort,
  };
}

/**
 * What every session of this member carries, however it starts (new, restored
 * or woken): their stamp, their account fence, the folder currently saved for
 * them (a restored or revived session must not keep an older folder), and no
 * approval prompts, since the separate login on the worker is the protection
 * and Codex has no approval step to offer.
 */
export type MemberSessionPolicy = Pick<
  InstanceCreateConfig,
  'metadata' | 'yoloMode' | 'allowedAccountProfileIds' | 'workingDirectory'
>;

export function memberSessionPolicy(member: MobileMemberProfile): MemberSessionPolicy {
  const session = member.session;
  if (!session) throw new MobileSessionRequestError(409, 'Sessions are not set up for this person yet.');
  return {
    workingDirectory: session.workingDirectory,
    metadata: { [MOBILE_PROFILE_METADATA_KEY]: member.profileId },
    yoloMode: true,
    allowedAccountProfileIds: [...session.allowedAccountProfileIds],
  };
}
