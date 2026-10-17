import { describe, expect, it } from 'vitest';
import type { AgentProfile } from '../../../shared/types/agent.types';
import type { InstanceCreateConfig } from '../../../shared/types/instance.types';
import { buildInstanceRecord } from './instance-create-builder';
import { hasFreshInitialSubmission } from './initial-submission-capture';
const message = { id: 'submission', type: 'user' as const, timestamp: 1, content: 'placeholder request' };
const config: InstanceCreateConfig = { workingDirectory: '/tmp/project', provider: 'opencode', initialUserMessageSource: 'current-submission', initialPrompt: message.content, initialOutputBuffer: [message] };
const build = (overrides: Partial<InstanceCreateConfig> = {}) => buildInstanceRecord({ ...config, ...overrides }, { id: 'build', mode: 'build' } as AgentProfile, { defaultYoloMode: false, getParent: () => undefined });
describe('main-only current-submission provenance', () => {
  it('accepts only the exact fresh live object and unchanged single current submission', () => {
    const live = build(); expect(hasFreshInitialSubmission(live)).toBe(true);
    expect(hasFreshInitialSubmission({ ...live })).toBe(false);
    live.outputBuffer = [{ ...message, content: 'changed' }];
    expect(hasFreshInitialSubmission(live)).toBe(false);
    live.outputBuffer = [message, { ...message, id: 'extra' }];
    expect(hasFreshInitialSubmission(live)).toBe(false);
  });
  it.each([
    { resume: true }, { isRestoredSession: true }, { sessionId: 'existing' }, { historyThreadId: 'existing' },
    { metadata: { openCodeForkSessionId: 'existing' } }, { initialUserMessageSource: undefined },
    { initialRetainedPrompts: [{ id: 'older', content: 'earlier', timestamp: 0 }] },
    { initialPrompt: 'different request' }, { initialOutputBuffer: [{ ...message, id: 'prefix' }, message] },
  ])('rejects unknown, restored or mismatched initial records: %j', (overrides) => {
    expect(hasFreshInitialSubmission(build(overrides as Partial<InstanceCreateConfig>))).toBe(false);
  });
});
