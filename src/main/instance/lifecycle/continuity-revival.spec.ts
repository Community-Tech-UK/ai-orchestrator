/**
 * Revival rebuilds a new instance from durable session state and keeps only the
 * newest slice of it, so it is another place the user's opening prompt can be
 * dropped for good. See prompt-retention.ts.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Instance, InstanceCreateConfig } from '../../../shared/types/instance.types';
import type { SessionState } from '../../session/session-continuity.types';
import { reviveContinuitySession } from './continuity-revival';

function history(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `msg-${i}`,
    role: i === 0 ? 'user' : 'assistant',
    content: i === 0 ? 'Migrate the billing service.' : `turn ${i}`,
    timestamp: i + 1,
  }));
}

function makeDeps(entryCount: number) {
  const createInstance = vi.fn(async (config: InstanceCreateConfig) =>
    ({ id: 'revived-1', ...config }) as unknown as Instance);
  const deps = {
    resumeSession: vi.fn(async () => ({
      sessionId: 'sess-1',
      workingDirectory: '/repo',
      displayName: 'Revived',
      conversationHistory: history(entryCount),
    }) as unknown as SessionState),
    createInstance,
  };
  return { deps, createInstance };
}

describe('reviveContinuitySession prompt retention', () => {
  it('carries an opening prompt that falls outside the restored window', async () => {
    const { deps, createInstance } = makeDeps(150);

    await reviveContinuitySession(deps, {
      sourceInstanceId: 'src-1',
      initialPrompt: 'continue',
      reason: 'doc-review-submission',
    });

    const config = createInstance.mock.calls[0][0];
    // The opening prompt is genuinely outside the restored buffer...
    expect(config.initialOutputBuffer?.some((m) => m.content === 'Migrate the billing service.'))
      .toBe(false);
    // ...but survives on the retained set.
    expect(config.initialRetainedPrompts?.map((m) => m.content))
      .toEqual(['Migrate the billing service.']);
  });

  it('retains nothing when the whole history fits in the restored window', async () => {
    const { deps, createInstance } = makeDeps(10);

    await reviveContinuitySession(deps, {
      sourceInstanceId: 'src-1',
      initialPrompt: 'continue',
      reason: 'doc-review-submission',
    });

    const config = createInstance.mock.calls[0][0];
    expect(config.initialRetainedPrompts).toEqual([]);
    expect(config.initialOutputBuffer?.some((m) => m.content === 'Migrate the billing service.'))
      .toBe(true);
  });
});
