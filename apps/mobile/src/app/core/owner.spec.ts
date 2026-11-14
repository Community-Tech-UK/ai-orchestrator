import { describe, expect, it } from 'vitest';
import { isOwnerPhone } from './owner';

describe('isOwnerPhone', () => {
  it('is false only when the gateway says the phone belongs to another person', () => {
    expect(isOwnerPhone({ isOwner: false })).toBe(false);
    expect(isOwnerPhone({ isOwner: true })).toBe(true);
  });

  it('treats a gateway that does not say, and a snapshot not yet received, as the owner', () => {
    expect(isOwnerPhone({})).toBe(true);
    expect(isOwnerPhone(null)).toBe(true);
    expect(isOwnerPhone(undefined)).toBe(true);
  });
});
