import { describe, expect, it } from 'vitest';
import {
  assertRemoteCodexExecSkillsPolicySupported,
  assertRemoteCodexHelperPolicySupported,
  assertRemoteCodexThreadCreditsSupported,
  assertRemoteCodexWorkerSupported,
  REMOTE_CODEX_EXEC_SKILLS_POLICY_UNSUPPORTED,
  REMOTE_CODEX_HELPER_POLICY_UNSUPPORTED,
  REMOTE_CODEX_THREAD_CREDITS_UNSUPPORTED,
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

describe('assertRemoteCodexThreadCreditsSupported', () => {
  it('refuses a worker that does not advertise the capability, exactly, even when it advertises the helper policy', () => {
    expect(() => assertRemoteCodexThreadCreditsSupported({})).toThrow(REMOTE_CODEX_THREAD_CREDITS_UNSUPPORTED);
    expect(() => assertRemoteCodexThreadCreditsSupported(undefined)).toThrow(REMOTE_CODEX_THREAD_CREDITS_UNSUPPORTED);
    expect(() => assertRemoteCodexThreadCreditsSupported({ codexThreadCredits: '1' as never })).toThrow(REMOTE_CODEX_THREAD_CREDITS_UNSUPPORTED);
    expect(() => assertRemoteCodexThreadCreditsSupported({ codexThreadCredits: 1 })).not.toThrow();
  });
});

describe('assertRemoteCodexWorkerSupported', () => {
  it('keeps the persistent-Codex fence and ignores other providers', () => {
    expect(() => assertRemoteCodexWorkerSupported('codex', { ephemeral: false }, { codexHelperPolicy: 1 })).toThrow(/Persistent Codex/);
    expect(() => assertRemoteCodexWorkerSupported('codex', { ephemeral: false }, { codexSpawnMetadata: 1, codexHelperPolicy: 1, codexThreadCredits: 1 })).not.toThrow();
    expect(() => assertRemoteCodexWorkerSupported('claude', { ephemeral: false }, {})).not.toThrow();
  });

  it('refuses every Codex session, whatever its helper level, on a worker without the capability', () => {
    expect(() => assertRemoteCodexWorkerSupported('codex', {}, { codexSpawnMetadata: 1 })).toThrow(REMOTE_CODEX_HELPER_POLICY_UNSUPPORTED);
  });

  it('refuses every Codex session on a worker from before thread-credit telemetry, which still advertises the helper policy', () => {
    const beforeThreadCredits = { codexSpawnMetadata: 1, codexHelperPolicy: 1, codexExecSkillsPolicy: 1 } as const;
    expect(() => assertRemoteCodexWorkerSupported('codex', {}, beforeThreadCredits)).toThrow(REMOTE_CODEX_THREAD_CREDITS_UNSUPPORTED);
    expect(() => assertRemoteCodexWorkerSupported('codex', { sessionKind: 'chat' }, beforeThreadCredits)).toThrow(REMOTE_CODEX_THREAD_CREDITS_UNSUPPORTED);
    expect(() => assertRemoteCodexWorkerSupported('claude', {}, beforeThreadCredits)).not.toThrow();
  });
});

describe('assertRemoteCodexExecSkillsPolicySupported', () => {
  const current = { codexSpawnMetadata: 1, codexHelperPolicy: 1, codexThreadCredits: 1, codexExecSkillsPolicy: 1 } as const;

  it.each(['plan-queue', 'child', 'loop', 'automation', 'review'])('refuses a %s Codex session on a worker that does not advertise the capability, exactly', (sessionKind) => {
    expect(() => assertRemoteCodexExecSkillsPolicySupported({ sessionKind }, {})).toThrow(REMOTE_CODEX_EXEC_SKILLS_POLICY_UNSUPPORTED);
    expect(() => assertRemoteCodexExecSkillsPolicySupported({ sessionKind }, undefined)).toThrow(REMOTE_CODEX_EXEC_SKILLS_POLICY_UNSUPPORTED);
    expect(() => assertRemoteCodexExecSkillsPolicySupported({ sessionKind }, { codexExecSkillsPolicy: '1' as never })).toThrow(REMOTE_CODEX_EXEC_SKILLS_POLICY_UNSUPPORTED);
    expect(() => assertRemoteCodexExecSkillsPolicySupported({ sessionKind }, { codexExecSkillsPolicy: 1 })).not.toThrow();
  });

  it('leaves chats alone, since they keep Codex\'s own catalog', () => {
    expect(() => assertRemoteCodexExecSkillsPolicySupported({ sessionKind: 'chat' }, {})).not.toThrow();
    expect(() => assertRemoteCodexExecSkillsPolicySupported({}, {})).not.toThrow();
  });

  it('is part of the combined Codex fence, and ignores other providers', () => {
    const olderThanSkillsPolicy = { codexSpawnMetadata: 1, codexHelperPolicy: 1, codexThreadCredits: 1 } as const;
    expect(() => assertRemoteCodexWorkerSupported('codex', { sessionKind: 'plan-queue' }, olderThanSkillsPolicy)).toThrow(REMOTE_CODEX_EXEC_SKILLS_POLICY_UNSUPPORTED);
    expect(() => assertRemoteCodexWorkerSupported('codex', { sessionKind: 'plan-queue' }, current)).not.toThrow();
    expect(() => assertRemoteCodexWorkerSupported('codex', { sessionKind: 'chat' }, olderThanSkillsPolicy)).not.toThrow();
    expect(() => assertRemoteCodexWorkerSupported('claude', { sessionKind: 'plan-queue' }, {})).not.toThrow();
  });
});
