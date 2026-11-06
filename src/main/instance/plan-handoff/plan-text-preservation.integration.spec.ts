import { describe, expect, it, vi } from 'vitest';
import { processClaudeAssistantMessage, type ClaudeAssistantMessageHost } from '../../cli/adapters/claude-assistant-message';
import { PlanBuildHandoff } from './plan-build-handoff';
import { extractPlanText } from './extract-plan-text';
import { createInstance, type OutputMessage, type InstanceCreateConfig } from '../../../shared/types/instance.types';
vi.mock('../../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
const steps = ['1. Preserve existing configuration.', '2. Add the endpoint.', '3. Verify the endpoint.'];
describe('actual Claude output to actual fresh build handoff', () => {
  it.each([
    { name: 'three short current blocks', blocks: steps, previous: '', plan: '' },
    { name: 'three short blocks extend previous without losing current', blocks: steps, previous: 'Earlier plan constraint.', plan: '' },
    { name: 'two short current blocks', blocks: steps.slice(0, 2), previous: '', plan: '' },
    { name: 'one current block extends previous turn', blocks: ['Ready to implement.'], previous: 'Previous complete plan', plan: '' },
    { name: 'three long current blocks ignore earlier turn', blocks: [steps[0] + ' detail'.repeat(70), ...steps.slice(1)], previous: 'Older excluded plan', plan: '' },
    { name: 'plan mode priority', blocks: steps, previous: '', plan: 'Approved Plan Mode content' },
  ])('$name', async ({ blocks, previous, plan }) => {
    const source = createInstance({ workingDirectory: '/tmp/inert-plan', agentId: 'plan', provider: 'claude' });
    if (previous) source.outputBuffer.push({ id: 'previous', timestamp: 1, type: 'assistant', content: previous });
    source.outputBuffer.push({ id: 'user', timestamp: 2, type: 'user', content: 'Plan this change.' });
    const emitted: OutputMessage[] = [];
    const host: ClaudeAssistantMessageHost = {
      emit: (event, value) => { if (event === 'output') emitted.push(value as OutputMessage); return true; },
      rememberToolUse: vi.fn(), emitAsyncWork: vi.fn(), emitAskUserQuestionInputRequired: vi.fn(),
      lastKnownContextWindow: 200_000, hasPerCallUsageThisTurn: false, lastObservedContextUsage: null,
    };
    processClaudeAssistantMessage(host, { type: 'assistant', content: '', timestamp: 3 }, {
      type: 'assistant', message: { content: blocks.map(text => ({ type: 'text', text })) },
    });
    expect(emitted.map(message => message.content)).toEqual(blocks);
    source.outputBuffer.push(...emitted);
    if (plan) source.planMode = { ...source.planMode, enabled: true, state: 'planning', planContent: plan };
    const create = vi.fn(async (config: InstanceCreateConfig) => createInstance(config));
    const handoff = new PlanBuildHandoff({ getInstance: () => source, createInstance: create, emitSystemNotice: vi.fn() });
    const preview = handoff.preview(source.id);
    const result = await handoff.start({ sourceId: source.id, planText: preview.planText });
    expect(result.ok).toBe(true);
    expect(create).toHaveBeenCalledOnce();
    const expected = plan || [...(previous && blocks.join('\n\n').length < 400 ? [previous] : []), ...blocks].join('\n\n');
    expect.soft(preview.planText).toBe(expected);
    expect.soft(create.mock.calls[0][0].initialPrompt).toContain(expected);
    const extracted = extractPlanText({ messages: source.outputBuffer, planModeContent: plan });
    expect(extracted.sourceMessageIds).toEqual(plan ? [] : [
      ...(previous && blocks.join('\n\n').length < 400 ? ['previous'] : []),
      ...emitted.map(message => message.id),
    ]);
    expect(source.outputBuffer.filter(message => message.type === 'assistant')).toHaveLength(blocks.length + (previous ? 1 : 0));
  });
});
describe('low-level maxChars contract, no tiny-cap UI route claimed', () => {
  it.each([1, 2, 3, 4, 23980])('honors marker plus %i available characters', available => {
    const marker = '\n\n[plan truncated]\n\n';
    const maxChars = marker.length + available;
    const result = extractPlanText({ messages: [], planModeContent: 'HEAD' + 'x'.repeat(25000) + 'TAIL', maxChars });
    expect(result.truncated).toBe(true);
    expect(result.text).toContain(marker);
    expect(result.text.length).toBeLessThanOrEqual(maxChars);
  });
});

// No previous user means every assistant belongs to the current extraction range.
it('retains every short block once when no user message is available', () => {
  const messages = steps.map((content, index) => ({ id: String(index), type: 'assistant', content }));
  const result = extractPlanText({ messages });
  expect(result.text).toBe(steps.join('\n\n'));
  expect(result.sourceMessageIds).toEqual(['0', '1', '2']);
});
