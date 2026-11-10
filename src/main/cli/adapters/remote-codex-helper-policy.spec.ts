import { describe, expect, it } from 'vitest';
import {
  assertRemoteCodexHelperPolicySupported,
  assertRemoteCodexWorkerSupported,
  REMOTE_CODEX_HELPER_POLICY_UNSUPPORTED,
} from './remote-codex-helper-policy';

describe('assertRemoteCodexHelperPolicySupported', () => {
  it('refuses a worker that does not advertise the capability, exactly', () => {
    expect(() => assertRemoteCodexHelperPolicySupported({})).toThrow(REMOTE_CODEX_HELPER_POLICY_UNSUPPORTED);
    expect(() => assertRemoteCodexHelperPolicySupported(undefined)).toThrow(REMOTE_CODEX_HELPER_POLICY_UNSUPPORTED);
    expect(() => assertRemoteCodexHelperPolicySupported({ codexHelperPolicy: '1' as never })).toThrow(REMOTE_CODEX_HELPER_POLICY_UNSUPPORTED);
  });

  it('accepts a worker that advertises it', () => {
    expect(() => assertRemoteCodexHelperPolicySupported({ codexHelperPolicy: 1 })).not.toThrow();
  });
});

describe('assertRemoteCodexWorkerSupported', () => {
  it('keeps the persistent-Codex fence and ignores other providers', () => {
    expect(() => assertRemoteCodexWorkerSupported('codex', { ephemeral: false }, { codexHelperPolicy: 1 })).toThrow(/Persistent Codex/);
    expect(() => assertRemoteCodexWorkerSupported('codex', { ephemeral: false }, { codexSpawnMetadata: 1, codexHelperPolicy: 1 })).not.toThrow();
    expect(() => assertRemoteCodexWorkerSupported('claude', { ephemeral: false }, {})).not.toThrow();
  });

  it('refuses every Codex session, whatever its helper level, on a worker without the capability', () => {
    expect(() => assertRemoteCodexWorkerSupported('codex', {}, { codexSpawnMetadata: 1 })).toThrow(REMOTE_CODEX_HELPER_POLICY_UNSUPPORTED);
  });
});
