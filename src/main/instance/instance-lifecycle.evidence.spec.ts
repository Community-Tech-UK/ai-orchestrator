import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: vi.fn(() => '/tmp/aio-task-7') },
}));

import { createInstance, type InstanceCreateConfig } from '../../shared/types/instance.types';
import { initializeInstanceEvidenceOwnership } from '../context-evidence/evidence-conversation-resolver';
import { reviveContinuitySession } from './lifecycle/continuity-revival';
import type { SessionState } from '../session/session-continuity.types';

function instance(provider: 'claude' | 'codex' = 'claude') {
  return createInstance({
    workingDirectory: '/work/project',
    provider,
    historyThreadId: 'history-1',
    sessionId: 'provider-session-1',
  });
}

describe('instance lifecycle context-evidence ownership gate', () => {
  it('keeps default-off providers inert without resolving or claiming capture', async () => {
    const target = instance();
    const resolver = { resolve: vi.fn() };

    await initializeInstanceEvidenceOwnership(target, {
      contextEvidenceModeByProvider: { claude: 'off' },
    }, resolver);

    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(target.contextEvidence).toEqual({
      mode: 'off',
      captureFailureCount: 0,
    });
  });

  it('records canonical ownership before a shadow provider can capture', async () => {
    const target = instance();
    const resolver = {
      resolve: vi.fn().mockResolvedValue({
        status: 'resolved',
        mode: 'shadow',
        conversationId: 'aio-ledger-1',
        source: 'instance-history',
      }),
    };

    await initializeInstanceEvidenceOwnership(target, {
      contextEvidenceModeByProvider: { claude: 'shadow' },
    }, resolver);

    expect(resolver.resolve).toHaveBeenCalledWith(target, { mode: 'shadow' });
    expect(target.contextEvidence).toEqual({
      mode: 'shadow',
      conversationId: 'aio-ledger-1',
      ownershipSource: 'instance-history',
      captureFailureCount: 0,
    });
  });

  it('keeps shadow output pass-through while recording unresolved ownership as a capture failure', async () => {
    const target = instance();
    const resolver = {
      resolve: vi.fn().mockResolvedValue({
        status: 'unresolved',
        mode: 'shadow',
        reason: 'history-thread-unavailable',
        disposition: 'preserve-provider-output',
        metric: {
          name: 'context_evidence_capture_failure',
          reason: 'unresolved-conversation-ownership',
          increment: 1,
        },
      }),
    };

    await initializeInstanceEvidenceOwnership(target, {
      contextEvidenceModeByProvider: { claude: 'shadow' },
    }, resolver);

    expect(target.contextEvidence).toMatchObject({
      mode: 'shadow',
      captureFailureCount: 1,
      lastCaptureFailure: {
        code: 'unresolved-conversation-ownership',
        disposition: 'preserve-provider-output',
      },
    });
  });

  it('marks enforce mode to pause before destructive compaction or completion', async () => {
    const target = instance('codex');
    const resolver = {
      resolve: vi.fn().mockResolvedValue({
        status: 'unresolved',
        mode: 'enforce',
        reason: 'history-thread-unavailable',
        disposition: 'pause-before-destructive-action',
        metric: {
          name: 'context_evidence_capture_failure',
          reason: 'unresolved-conversation-ownership',
          increment: 1,
        },
      }),
    };

    await initializeInstanceEvidenceOwnership(target, {
      contextEvidenceModeByProvider: { codex: 'enforce' },
    }, resolver);

    expect(target.contextEvidence).toMatchObject({
      mode: 'enforce',
      captureFailureCount: 1,
      lastCaptureFailure: {
        disposition: 'pause-before-destructive-action',
      },
    });
  });

  it('normalizes the legacy openai provider key onto a codex instance', async () => {
    const target = instance('codex');
    const resolver = {
      resolve: vi.fn().mockResolvedValue({
        status: 'resolved',
        mode: 'shadow',
        conversationId: 'aio-ledger-codex',
        source: 'instance-history',
      }),
    };

    await initializeInstanceEvidenceOwnership(target, {
      contextEvidenceModeByProvider: { openai: 'shadow' },
    }, resolver);

    expect(resolver.resolve).toHaveBeenCalledWith(target, { mode: 'shadow' });
  });

  it('keeps a legacy continuity provider session separate from its app-owned history identity', async () => {
    let createConfig: InstanceCreateConfig | undefined;
    await reviveContinuitySession({
      resumeSession: vi.fn(async () => ({
        instanceId: 'source-instance',
        sessionId: 'provider-native-collision',
        displayName: 'Restored',
        provider: 'claude',
        workingDirectory: '/work/project',
        conversationHistory: [],
        pendingTasks: [],
        environmentVariables: {},
        activeFiles: [],
        skillsLoaded: [],
        hooksActive: [],
      } as unknown as SessionState)),
      createInstance: vi.fn(async (config) => {
        createConfig = config;
        return createInstance(config);
      }),
    }, {
      sourceInstanceId: 'source-instance',
      initialPrompt: 'continue',
      reason: 'doc-review-submission',
    });

    expect(createConfig).toMatchObject({
      historyThreadId: 'source-instance',
      sessionId: 'provider-native-collision',
      resume: true,
    });
  });
});
