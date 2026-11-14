import { MOBILE_OWNER_PROFILE_ID } from '../types/mobile-gateway.types';

/** Instance metadata key naming the phone-app person a session belongs to. */
export const MOBILE_PROFILE_METADATA_KEY = 'mobileProfileId';

/**
 * The person a session belongs to. Sessions started anywhere but a member's
 * phone carry no stamp and belong to the owner of the Mac.
 */
export function sessionProfileId(instance: { metadata?: Record<string, unknown> }): string {
  return memberProfileIdOf(instance.metadata) ?? MOBILE_OWNER_PROFILE_ID;
}

/** The member a session was stamped for, or undefined for the owner's sessions. */
export function memberProfileIdOf(metadata: Record<string, unknown> | undefined): string | undefined {
  const stamped = metadata?.[MOBILE_PROFILE_METADATA_KEY];
  return typeof stamped === 'string' && stamped && stamped !== MOBILE_OWNER_PROFILE_ID ? stamped : undefined;
}
