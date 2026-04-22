import { describe, expect, it } from 'vitest';
import {
  DebateResponseInvocationPayloadSchema,
  ReviewAgentInvocationPayloadSchema,
  VerificationAgentInvocationPayloadSchema,
  WorkflowAgentInvocationPayloadSchema,
  normalizeInvocationTextResult,
} from './orchestration-invocation.types';

describe('orchestration invocation schemas', () => {
  it('normalizes invocation text results with default token and cost values', () => {
    expect(normalizeInvocationTextResult({ response: 'done' })).toEqual({
      response: 'done',
      tokens: 0,
      cost: 0,
    });
  });

  it('requires correlation ids and callback functions for verification payloads', () => {
    expect(() => VerificationAgentInvocationPayloadSchema.parse({
      correlationId: 'verify-1:agent-1',
      requestId: 'verify-1',
      agentId: 'agent-1',
      model: 'sonnet',
      userPrompt: 'check this',
      callback: () => undefined,
    })).not.toThrow();

    expect(() => VerificationAgentInvocationPayloadSchema.parse({
      requestId: 'verify-1',
      agentId: 'agent-1',
      userPrompt: 'check this',
      callback: 'not-a-function',
    })).toThrow();
  });

  it('enforces the review invocation contract', () => {
    expect(() => ReviewAgentInvocationPayloadSchema.parse({
      correlationId: 'review-1:security',
      reviewId: 'review-1',
      agentId: 'security',
      systemPrompt: 'review strictly',
      context: 'diff content',
      userPrompt: 'find issues',
      callback: () => undefined,
    })).not.toThrow();

    expect(() => ReviewAgentInvocationPayloadSchema.parse({
      correlationId: 'review-1:security',
      reviewId: 'review-1',
      agentId: 'security',
      context: 'diff content',
      userPrompt: 'find issues',
      callback: () => undefined,
    })).toThrow();
  });

  it('enforces debate response payload requirements', () => {
    expect(() => DebateResponseInvocationPayloadSchema.parse({
      correlationId: 'debate-1:agent-a:response',
      debateId: 'debate-1',
      agentId: 'agent-a',
      prompt: 'argue for option A',
      callback: () => undefined,
    })).not.toThrow();

    expect(() => DebateResponseInvocationPayloadSchema.parse({
      correlationId: 'debate-1:agent-a:response',
      agentId: 'agent-a',
      prompt: 'argue for option A',
      callback: () => undefined,
    })).toThrow();
  });

  it('enforces the workflow invocation envelope', () => {
    expect(() => WorkflowAgentInvocationPayloadSchema.parse({
      correlationId: 'workflow-1:agent-1',
      executionId: 'workflow-1',
      agentId: 'agent-1',
      agentType: 'research',
      prompt: 'summarize',
      callback: () => undefined,
    })).not.toThrow();

    expect(() => WorkflowAgentInvocationPayloadSchema.parse({
      correlationId: 'workflow-1:agent-1',
      executionId: 'workflow-1',
      agentId: 'agent-1',
      prompt: 'summarize',
      callback: () => undefined,
    })).toThrow();
  });
});
