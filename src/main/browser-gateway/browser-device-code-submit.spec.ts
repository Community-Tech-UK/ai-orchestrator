import { describe, expect, it } from 'vitest';
import { BrowserOneTimeCodeFillLedger } from './browser-one-time-code-submit';

const scope = {
  instanceId: 'test-session', ownerGeneration: 'test-owner-generation',
  profileId: 'test-browser-profile', targetId: 'test-tab', browserNodeId: 'test-browser-node',
  origin: 'https://auth.openai.com', operationHandle: 'test-operation',
  nativeNodeId: 'test-native-node', nativeProfileId: 'test-native-profile',
  expectedIdentity: 'test-account@example.test', approvalId: 'test-approval',
  documentId: 'test-document', extensionInstanceId: 'test-installation',
  extensionGeneration: 'test-extension-generation', expiresAt: 5_000,
};

describe('device login submit receipts in the existing fill ledger', () => {
  it('allows exactly one matching submit without granting ordinary code clicks', () => {
    const ledger = new BrowserOneTimeCodeFillLedger(() => 1_000);
    expect(ledger.recordDevice(scope)).toBe(true);
    expect(ledger.has(scope)).toBe(false);
    expect(ledger.consumeDevice(scope)).toBe(true);
    expect(ledger.consumeDevice(scope)).toBe(false);
    expect(ledger.recordDevice(scope)).toBe(false);
  });

  it.each(Object.keys(scope) as (keyof typeof scope)[])('rejects a changed %s without spending the original', (key) => {
    const ledger = new BrowserOneTimeCodeFillLedger(() => 1_000);
    ledger.recordDevice(scope);
    const changed = { ...scope, [key]: key === 'expiresAt' ? 6_000 : 'different' };
    expect(ledger.consumeDevice(changed)).toBe(false);
    expect(ledger.consumeDevice(scope)).toBe(true);
  });

  it('expires at the native deadline, including delayed timer execution', () => {
    let now = 1_000;
    const ledger = new BrowserOneTimeCodeFillLedger(() => now);
    ledger.recordDevice(scope);
    now = 5_000;
    expect(ledger.consumeDevice(scope)).toBe(false);
    expect(ledger.recordDevice(scope)).toBe(false);
  });

  it.each([NaN, Infinity, 1_000, 301_001])('refuses an invalid or excessive expiry %s', (expiresAt) => {
    const ledger = new BrowserOneTimeCodeFillLedger(() => 1_000);
    expect(ledger.recordDevice({ ...scope, expiresAt })).toBe(false);
    expect(ledger.consumeDevice({ ...scope, expiresAt })).toBe(false);
  });

  it('copies the binding so caller mutation cannot change an approved destination', () => {
    const ledger = new BrowserOneTimeCodeFillLedger(() => 1_000);
    const input = { ...scope };
    ledger.recordDevice(input);
    input.documentId = 'replacement-document';
    expect(ledger.consumeDevice(input)).toBe(false);
    expect(ledger.consumeDevice(scope)).toBe(true);
  });

  it('cancellation burns an existing receipt and cannot resurrect it', () => {
    const ledger = new BrowserOneTimeCodeFillLedger(() => 1_000);
    ledger.recordDevice(scope);
    ledger.invalidateDevice(scope.operationHandle);
    expect(ledger.consumeDevice(scope)).toBe(false);
    expect(ledger.recordDevice(scope)).toBe(false);
  });

  it('a new device fill replaces older fills for that tab, including ordinary fills', () => {
    const ledger = new BrowserOneTimeCodeFillLedger(() => 1_000);
    ledger.record(scope);
    ledger.recordDevice(scope);
    expect(ledger.has(scope)).toBe(false);
    const next = { ...scope, operationHandle: 'test-next-operation' };
    ledger.recordDevice(next);
    expect(ledger.consumeDevice(scope)).toBe(false);
    expect(ledger.recordDevice(scope)).toBe(false);
    expect(ledger.consumeDevice(next)).toBe(true);
  });

  it('an ordinary fill invalidates the previous device fill for the same tab', () => {
    const ledger = new BrowserOneTimeCodeFillLedger(() => 1_000);
    ledger.recordDevice(scope);
    ledger.record(scope);
    expect(ledger.consumeDevice(scope)).toBe(false);
    expect(ledger.has(scope)).toBe(true);
  });

  it('removes an ordinary submit exception belonging to another session on the device tab', () => {
    const ledger = new BrowserOneTimeCodeFillLedger(() => 1_000);
    const other = { ...scope, instanceId: 'test-other-session' };
    ledger.record(other);
    ledger.recordDevice(scope);
    expect(ledger.has(other)).toBe(false);
    expect(ledger.consumeDevice(scope)).toBe(true);
  });

  it.each(Object.keys(scope).filter((key) => key !== 'expiresAt'))('refuses an empty %s binding', (key) => {
    const ledger = new BrowserOneTimeCodeFillLedger(() => 1_000);
    expect(ledger.recordDevice({ ...scope, [key]: '' })).toBe(false);
  });

  it('refuses a device receipt at another origin', () => {
    const ledger = new BrowserOneTimeCodeFillLedger(() => 1_000);
    expect(ledger.recordDevice({ ...scope, origin: 'https://example.test' })).toBe(false);
  });

  it('does not evict a live receipt when capacity is reached, but reclaims expired ones', () => {
    let now = 1_000;
    const ledger = new BrowserOneTimeCodeFillLedger(() => now);
    for (let i = 0; i < 64; i++) {
      expect(ledger.recordDevice({ ...scope, operationHandle: `test-operation-${i}`, targetId: `test-tab-${i}` })).toBe(true);
    }
    expect(ledger.recordDevice(scope)).toBe(false);
    expect(ledger.consumeDevice({ ...scope, operationHandle: 'test-operation-0', targetId: 'test-tab-0' })).toBe(true);
    now = 5_000;
    expect(ledger.recordDevice({ ...scope, expiresAt: 6_000 })).toBe(true);
  });
});
