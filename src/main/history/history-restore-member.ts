import { getMobileDeviceRegistry } from '../mobile-gateway/mobile-device-registry';
import { memberSessionPolicy, type MemberSessionPolicy } from '../mobile-gateway/mobile-gateway-member-session';

/**
 * A phone-app member's conversation comes back as theirs, on their own worker. When that worker is offline the
 * restore must fail: falling back to this Mac would run their agent as the owner, with the owner's files.
 * A person who has since been removed leaves their conversations to the owner, as everywhere else.
 */
export function resolveMemberRestore(
  mobileProfileId: string | undefined,
  restoreNodeId: string | undefined,
  remoteNodeAvailable: boolean,
): { policy?: MemberSessionPolicy; problem?: { code: string; message: string } } {
  const member = mobileProfileId ? getMobileDeviceRegistry().getMember(mobileProfileId) : undefined;
  if (!member) return {};
  if (!member.session || !restoreNodeId) {
    return { problem: { code: 'MEMBER_NOT_SET_UP', message: 'This conversation belongs to a person whose sessions are not set up on a computer of their own.' } };
  }
  // Moved to another computer since: this one is no longer kept for them, and may be shared or the owner's own login.
  if (restoreNodeId !== member.session.workerNodeId) {
    return { problem: { code: 'MEMBER_COMPUTER_CHANGED', message: 'This conversation ran on a computer that is no longer set up for its person, so it cannot be continued. Start a new one.' } };
  }
  if (!remoteNodeAvailable) {
    return { problem: { code: 'MEMBER_NODE_UNAVAILABLE', message: "This conversation runs on its owner's own computer, which is offline. Restore it when that computer is back." } };
  }
  return { policy: memberSessionPolicy(member) };
}
