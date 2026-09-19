import { describe, expect, it } from 'vitest';
import { OrchestratorToolsRpcInstanceCapability } from './orchestrator-tools-rpc-capability';

describe('OrchestratorToolsRpcInstanceCapability', () => {
  it('mints a capability for a known local instance', () => {
    const capabilities = new OrchestratorToolsRpcInstanceCapability();
    const token = capabilities.mint('instance-1', (id) => id === 'instance-1');

    expect(typeof token).toBe('string');
    expect(token).toBeTruthy();
  });

  it('refuses to mint for an id that is not a known local instance (defense in depth)', () => {
    const capabilities = new OrchestratorToolsRpcInstanceCapability();

    expect(capabilities.mint('instance-guessed', () => false)).toBeNull();
  });

  it('verifies a freshly minted token for the same instance id', () => {
    const capabilities = new OrchestratorToolsRpcInstanceCapability();
    const token = capabilities.mint('instance-1', () => true)!;

    expect(capabilities.verify('instance-1', token)).toBe(true);
  });

  it('fails closed: rejects a missing token', () => {
    const capabilities = new OrchestratorToolsRpcInstanceCapability();

    expect(capabilities.verify('instance-1', undefined)).toBe(false);
  });

  it('fails closed: rejects an empty-string token', () => {
    const capabilities = new OrchestratorToolsRpcInstanceCapability();

    expect(capabilities.verify('instance-1', '')).toBe(false);
  });

  it('fails closed: rejects a wrong token for a known instance', () => {
    const capabilities = new OrchestratorToolsRpcInstanceCapability();
    capabilities.mint('instance-1', () => true);

    expect(capabilities.verify('instance-1', 'not-the-real-token')).toBe(false);
  });

  it('a capability minted for one instance cannot authenticate a different instance id', () => {
    const capabilities = new OrchestratorToolsRpcInstanceCapability();
    const tokenForA = capabilities.mint('instance-a', () => true)!;

    expect(capabilities.verify('instance-b', tokenForA)).toBe(false);
  });

  it('a token minted under a previous process secret is rejected after a restart (no grandfathering)', () => {
    // Simulates a child spawned before an app restart: its capability was
    // signed with the OLD process's secret, but the server it now talks to
    // has a fresh one. There is no stored per-instance state to carry the
    // token forward across app runs — see the class-level doc comment.
    const beforeRestart = new OrchestratorToolsRpcInstanceCapability();
    const staleToken = beforeRestart.mint('instance-1', () => true)!;

    const afterRestart = new OrchestratorToolsRpcInstanceCapability();

    expect(afterRestart.verify('instance-1', staleToken)).toBe(false);
  });

  it('is deterministic for the lifetime of one instance (same instance, same process secret)', () => {
    const capabilities = new OrchestratorToolsRpcInstanceCapability();
    const first = capabilities.mint('instance-1', () => true);
    const second = capabilities.mint('instance-1', () => true);

    expect(first).toBe(second);
  });
});
