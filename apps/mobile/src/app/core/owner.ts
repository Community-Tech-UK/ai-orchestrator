import type { MobileSnapshot } from './models';

/**
 * False on a phone that belongs to another person, who sees only their own
 * sessions and cannot reach the owner's areas. A gateway too old to say has
 * only an owner.
 */
export function isOwnerPhone(snapshot: Pick<MobileSnapshot, 'isOwner'> | null | undefined): boolean {
  return snapshot?.isOwner !== false;
}
