import type { MobileMessageDto } from './models';

export const LOCAL_MESSAGE_ID_PREFIX = 'local-';
const LOCAL_ECHO_REPLACE_WINDOW_MS = 2 * 60_000;

export function findOptimisticUserEchoIndex(
  messages: MobileMessageDto[],
  incoming: MobileMessageDto,
): number {
  if (incoming.id.startsWith(LOCAL_MESSAGE_ID_PREFIX) || incoming.type !== 'user') {
    return -1;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isOptimisticEchoOf(messages[index], incoming)) {
      return index;
    }
  }
  return -1;
}

function isOptimisticEchoOf(local: MobileMessageDto, incoming: MobileMessageDto): boolean {
  if (!local.id.startsWith(LOCAL_MESSAGE_ID_PREFIX) || local.type !== 'user') {
    return false;
  }
  if (local.content !== incoming.content) {
    return false;
  }
  if (Boolean(local.hasAttachments) !== Boolean(incoming.hasAttachments)) {
    return false;
  }
  return timestampsAreClose(local.timestamp, incoming.timestamp);
}

function timestampsAreClose(localTimestamp: number, incomingTimestamp: number): boolean {
  if (!Number.isFinite(localTimestamp) || !Number.isFinite(incomingTimestamp)) {
    return true;
  }
  return Math.abs(localTimestamp - incomingTimestamp) <= LOCAL_ECHO_REPLACE_WINDOW_MS;
}
