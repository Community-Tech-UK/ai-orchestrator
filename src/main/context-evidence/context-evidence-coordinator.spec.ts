import { describe, expect, it, vi } from 'vitest';
import type { EvidenceCaptureServiceInput } from './evidence-capture-service';
import { ContextTokenEstimator } from './context-token-estimator';
import { WorkingSetPlanner } from './working-set-planner';
import { WorkingSetRenderer } from './working-set-renderer';
import {
  _resetContextEvidenceCoordinatorForTesting,
  ContextEvidenceCoordinator,
  drainContextEvidenceQueue,
} from './context-evidence-coordinator';

describe('ContextEvidenceCoordinator', () => {
  it('subscribes and cleans up content-free coordinator events', async () => {
    const coordinator = new ContextEvidenceCoordinator({
      captureService: {
        capture: vi.fn(async () => ({
          status: 'failed' as const,
          errorCode: 'CAPTURE_FAILED',
          disclosure: 'Capture failed.',
        })),
      },
      cardService: { build: vi.fn() },
      retrievalService: retrievalStub(),
    });
    const events: unknown[] = [];
    const unsubscribe = coordinator.subscribe((event) => events.push(event));
    const input = {
      captureKey: 'capture-1', conversationId: 'conversation-1', provider: 'claude',
      toolName: 'Read', sourceKind: 'file' as const, mimeType: 'text/plain',
      sensitivity: 'normal' as const, provenanceTrust: 'runtime-authenticated' as const,
      captureMode: 'post-retention' as const, captureCompleteness: 'complete' as const,
      content: new TextEncoder().encode('payload'),
      observedBoundary: 'after-provider-retention' as const,
    };

    await coordinator.capture(input);
    expect(events).toEqual([expect.objectContaining({
      kind: 'capture-failed', conversationId: 'conversation-1', failureCode: 'CAPTURE_FAILED',
    })]);

    unsubscribe();
    await coordinator.capture({ ...input, captureKey: 'capture-2' });
    expect(events).toHaveLength(1);
  });

  it('lets evidence-off lifecycle boundaries drain without initializing the fail-closed runtime', async () => {
    _resetContextEvidenceCoordinatorForTesting();
    await expect(drainContextEvidenceQueue('instance-without-ingress')).resolves.toBeUndefined();
  });

  it('captures AIO MCP output before deriving its encrypted evidence card', async () => {
    const events: string[] = [];
    const capture = vi.fn(async (input: EvidenceCaptureServiceInput) => {
      events.push(`capture:${new TextDecoder().decode(input.content)}`);
      return {
        status: 'captured' as const,
        record: {
          id: 'evidence-1',
          conversationId: input.conversationId,
          provider: input.provider,
          toolName: input.toolName,
          sourceKind: input.sourceKind,
          status: 'complete' as const,
          keyedContentId: 'a'.repeat(64),
          byteCount: input.content.byteLength,
          mimeType: input.mimeType,
          sensitivity: input.sensitivity,
          provenanceTrust: input.provenanceTrust,
          createdAt: 1,
          completedAt: 2,
          keyVersion: 1,
          captureMode: input.captureMode,
          captureCompleteness: input.captureCompleteness,
        },
      };
    });
    const build = vi.fn(async ({ evidenceId }: { evidenceId: string }) => {
      events.push(`card:${evidenceId}`);
      return { card: { id: 'card-1' } } as never;
    });
    const coordinator = new ContextEvidenceCoordinator({
      captureService: { capture },
      cardService: { build },
      retrievalService: retrievalStub(),
    });

    const result = await coordinator.captureAioMcpResult({
      queueId: 'instance-1',
      conversationId: 'conversation-1',
      captureKey: 'mcp:message-1:list_remote_nodes',
      turnRef: 'message-1',
      toolCallRef: 'message-1',
      toolName: 'list_remote_nodes',
      result: { count: 1 },
    });

    expect(events).toEqual(['capture:{"count":1}', 'card:evidence-1']);
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conversation-1',
      provider: 'orchestrator',
      sourceKind: 'mcp',
      observedBoundary: 'before-provider-retention',
      captureMode: 'pre-retention',
      captureCompleteness: 'complete',
      provenanceTrust: 'runtime-authenticated',
      mimeType: 'application/json',
    }));
    expect(result).toMatchObject({
      providerResult: { count: 1 },
      capture: { status: 'captured', record: { id: 'evidence-1' } },
      card: { card: { id: 'card-1' } },
    });
  });

  it('returns a bounded evidence reference after completely capturing an oversized MCP result', async () => {
    let capturedPayload = '';
    const capture = vi.fn(async (input: EvidenceCaptureServiceInput) => {
      capturedPayload = new TextDecoder().decode(input.content);
      return {
        status: 'captured' as const,
        record: {
        id: 'evidence-large',
        conversationId: input.conversationId,
        provider: input.provider,
        providerThreadRef: undefined,
        turnRef: undefined,
        toolCallRef: undefined,
        toolName: input.toolName,
        sourceKind: input.sourceKind,
        sourceLocatorRedacted: undefined,
        status: 'complete' as const,
        keyedContentId: 'a'.repeat(64),
        byteCount: input.content.byteLength,
        tokenEstimate: 10_000,
        mimeType: input.mimeType,
        sensitivity: input.sensitivity,
        provenanceTrust: input.provenanceTrust,
        captureMode: input.captureMode,
        captureCompleteness: input.captureCompleteness,
        truncationReason: undefined,
        keyVersion: 1,
        createdAt: 1,
        completedAt: 2,
        },
      };
    });
    const coordinator = new ContextEvidenceCoordinator({
      captureService: { capture },
      cardService: { build: vi.fn(async () => ({ card: { id: 'card-large' } } as never)) },
      retrievalService: retrievalStub(),
      estimateTokens: (text) => Math.ceil(new TextEncoder().encode(text).byteLength / 4),
    });
    const oversized = { payload: 'a'.repeat(20_000), finalMarker: 'must-not-inline' };

    const result = await coordinator.captureAioMcpResult({
      queueId: 'instance-1',
      conversationId: 'conversation-1',
      captureKey: 'mcp:message-large:list_remote_nodes',
      toolName: 'list_remote_nodes',
      result: oversized,
      providerWindowTokens: 100_000,
    });

    expect(capturedPayload).toContain('must-not-inline');
    expect(result.providerResult).toMatchObject({
      evidenceId: 'evidence-large',
      byteCount: expect.any(Number),
      truncated: true,
      trustBoundary: 'untrusted-source-material',
    });
    expect(JSON.stringify(result.providerResult)).not.toContain('must-not-inline');
    expect(Math.ceil(new TextEncoder().encode(JSON.stringify(result.providerResult)).byteLength / 4))
      .toBeLessThanOrEqual(1_000);
  });

  it('serializes captures for one instance and drains them without blocking another instance', async () => {
    const releases: Array<() => void> = [];
    const started: string[] = [];
    const capture = vi.fn(async (input: EvidenceCaptureServiceInput) => {
      started.push(input.captureKey);
      await new Promise<void>((resolve) => releases.push(resolve));
      return { status: 'failed' as const, errorCode: 'TEST', disclosure: 'test' };
    });
    const coordinator = new ContextEvidenceCoordinator({
      captureService: { capture },
      cardService: { build: vi.fn() },
      retrievalService: retrievalStub(),
    });

    const first = coordinator.captureAioMcpResult(mcpInput('instance-1', 'first'));
    const second = coordinator.captureAioMcpResult(mcpInput('instance-1', 'second'));
    const other = coordinator.captureAioMcpResult(mcpInput('instance-2', 'other'));
    await vi.waitFor(() => expect(started).toEqual(['first', 'other']));
    releases.shift()?.();
    await vi.waitFor(() => expect(started).toEqual(['first', 'other', 'second']));
    releases.shift()?.();
    releases.shift()?.();

    await expect(Promise.all([first, second, other])).resolves.toHaveLength(3);
    await expect(coordinator.drain('instance-1')).resolves.toBeUndefined();
  });

  it('owns exact runtime tool-result bytes at ingress and reports content-free aggregate metrics', async () => {
    const releases: Array<() => void> = [];
    const captured: EvidenceCaptureServiceInput[] = [];
    const events: unknown[] = [];
    const capture = vi.fn(async (input: EvidenceCaptureServiceInput) => {
      captured.push(input);
      await new Promise<void>((resolve) => releases.push(resolve));
      return {
        status: 'captured' as const,
        record: {
          id: `evidence-${captured.length}`,
          conversationId: input.conversationId,
          provider: input.provider,
          toolName: input.toolName,
          sourceKind: input.sourceKind,
          status: 'complete' as const,
          keyedContentId: 'a'.repeat(64),
          byteCount: input.content.byteLength,
          mimeType: input.mimeType,
          sensitivity: input.sensitivity,
          provenanceTrust: input.provenanceTrust,
          createdAt: 1,
          completedAt: 2,
          captureMode: input.captureMode,
          captureCompleteness: input.captureCompleteness,
        },
      };
    });
    const coordinator = new ContextEvidenceCoordinator({
      captureService: { capture },
      cardService: { build: vi.fn(async () => ({ card: { id: 'card' } } as never)) },
      retrievalService: retrievalStub(),
      onEvent: (event) => events.push(event),
    });
    const original = new TextEncoder().encode('line one\r\nline two\n');

    const pending = coordinator.captureRuntimeToolResult({
      queueId: 'instance-1',
      conversationId: 'conversation-1',
      captureKey: 'tool-result:turn-1:tool-1',
      provider: 'claude',
      providerThreadRef: 'session-1',
      turnRef: 'turn-1',
      toolCallRef: 'tool-1',
      toolName: 'Read',
      sourceKind: 'file',
      mimeType: 'text/plain;charset=utf-8',
      content: original,
    });
    original.fill(120);

    await vi.waitFor(() => expect(captured).toHaveLength(1));
    expect(new TextDecoder().decode(captured[0]!.content)).toBe('line one\r\nline two\n');
    expect(captured[0]).toMatchObject({
      provider: 'claude',
      providerThreadRef: 'session-1',
      turnRef: 'turn-1',
      toolCallRef: 'tool-1',
      sourceKind: 'file',
      mimeType: 'text/plain;charset=utf-8',
      provenanceTrust: 'runtime-authenticated',
      captureMode: 'post-retention',
      captureCompleteness: 'complete',
      observedBoundary: 'after-provider-retention',
    });
    releases.shift()?.();
    await pending;

    expect(events).toContainEqual(expect.objectContaining({
      kind: 'metrics-updated',
      queueId: 'instance-1',
      conversationId: 'conversation-1',
      metrics: {
        attempted: 1,
        captured: 1,
        duplicates: 0,
        conflicts: 0,
        failed: 0,
        capturedBytes: 'line one\r\nline two\n'.length,
      },
    }));
    expect(JSON.stringify(events)).not.toContain('line one');
  });

  it('surfaces divergent content for one logical runtime key as a conflict and drains it', async () => {
    const events: unknown[] = [];
    const capture = vi.fn()
      .mockResolvedValueOnce({
        status: 'captured',
        record: {
          id: 'evidence-1', conversationId: 'conversation-1', provider: 'claude',
          toolName: 'Read', sourceKind: 'file', status: 'complete', keyedContentId: 'a'.repeat(64),
          byteCount: 3, mimeType: 'text/plain;charset=utf-8', sensitivity: 'normal',
          provenanceTrust: 'runtime-authenticated', createdAt: 1, completedAt: 2,
          captureMode: 'post-retention', captureCompleteness: 'complete',
        },
      })
      .mockResolvedValueOnce({
        status: 'conflict',
        errorCode: 'EVIDENCE_CAPTURE_KEY_CONTENT_CONFLICT',
        disclosure: 'Divergent content was observed for the same logical capture key.',
      });
    const coordinator = new ContextEvidenceCoordinator({
      captureService: { capture },
      cardService: { build: vi.fn(async () => ({ card: { id: 'card' } } as never)) },
      retrievalService: retrievalStub(),
      onEvent: (event) => events.push(event),
    });
    const input = {
      queueId: 'instance-1', conversationId: 'conversation-1',
      captureKey: 'tool-result:turn-1:tool-1', provider: 'claude',
      turnRef: 'turn-1', toolCallRef: 'tool-1', toolName: 'Read',
      sourceKind: 'file' as const, mimeType: 'text/plain;charset=utf-8',
    };

    await coordinator.captureRuntimeToolResult({ ...input, content: new TextEncoder().encode('one') });
    const conflict = coordinator.captureRuntimeToolResult({ ...input, content: new TextEncoder().encode('two') });
    await coordinator.drain('instance-1');

    await expect(conflict).resolves.toMatchObject({
      capture: { status: 'conflict', errorCode: 'EVIDENCE_CAPTURE_KEY_CONTENT_CONFLICT' },
    });
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'capture-failed',
      conversationId: 'conversation-1',
      failureCode: 'EVIDENCE_CAPTURE_KEY_CONTENT_CONFLICT',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'metrics-updated',
      metrics: expect.objectContaining({ attempted: 2, captured: 1, conflicts: 1 }),
    }));
  });

  it('delegates every retrieval operation through the shared service', async () => {
    const retrieval = retrievalStub();
    const coordinator = new ContextEvidenceCoordinator({
      captureService: { capture: vi.fn() },
      cardService: { build: vi.fn() },
      retrievalService: retrieval,
    });

    await coordinator.list({ conversationId: 'c', requester: requester() });
    await coordinator.getCard({
      conversationId: 'c', requester: requester(), cardId: 'card', tokenLimit: 10,
    });
    await coordinator.search({ conversationId: 'c', requester: requester(), query: 'q', tokenLimit: 10 });
    await coordinator.read({ conversationId: 'c', requester: requester(), evidenceId: 'e', startByte: 0, endByte: 1, tokenLimit: 10 });
    await coordinator.compare({ conversationId: 'c', requester: requester(), left: { evidenceId: 'e', startByte: 0, endByte: 1 }, right: { evidenceId: 'e', startByte: 0, endByte: 1 } });
    await coordinator.verify({ conversationId: 'c', requester: requester(), evidenceId: 'e', startByte: 0, endByte: 1, contentDigest: 'a'.repeat(64) });

    expect(retrieval.list).toHaveBeenCalledOnce();
    expect(retrieval.getCard).toHaveBeenCalledOnce();
    expect(retrieval.search).toHaveBeenCalledOnce();
    expect(retrieval.read).toHaveBeenCalledOnce();
    expect(retrieval.compare).toHaveBeenCalledOnce();
    expect(retrieval.verify).toHaveBeenCalledOnce();
  });

  it('assembles deterministic working sets through the sole production coordinator seam', () => {
    const plan = vi.fn(() => ({ status: 'ready' } as never));
    const render = vi.fn(() => ({ content: 'assembled' } as never));
    const coordinator = new ContextEvidenceCoordinator({
      captureService: { capture: vi.fn() },
      cardService: { build: vi.fn() },
      retrievalService: retrievalStub(),
      workingSetPlanner: { plan },
      workingSetRenderer: { render },
    });
    const input = {
      capacityTokens: 1_000,
      requiredInstructions: ['rules'],
      latestUserIntent: 'continue',
      recentDialogue: [],
      activeTaskState: [],
      evidenceCards: [],
      exactExcerpts: [],
    };

    expect(coordinator.assembleWorkingSet(input)).toEqual({
      plan: { status: 'ready' },
      rendered: { content: 'assembled' },
    });
    expect(plan).toHaveBeenCalledWith(input);
    expect(render).toHaveBeenCalledWith({ status: 'ready' });
  });

  it('refuses planner and renderer instances with inconsistent token accounting', () => {
    const plannerEstimator = new ContextTokenEstimator((text) => Math.max(1, Math.ceil(text.length / 10)));
    const rendererEstimator = new ContextTokenEstimator((text) => Math.max(1, text.length));
    const coordinator = new ContextEvidenceCoordinator({
      captureService: { capture: vi.fn() },
      cardService: { build: vi.fn() },
      retrievalService: retrievalStub(),
      workingSetPlanner: new WorkingSetPlanner(plannerEstimator),
      workingSetRenderer: new WorkingSetRenderer(rendererEstimator),
    });

    expect(() => coordinator.assembleWorkingSet({
      capacityTokens: 1_000,
      requiredInstructions: ['rules'],
      latestUserIntent: 'continue',
      recentDialogue: [], activeTaskState: [], evidenceCards: [], exactExcerpts: [],
    })).toThrowError('WORKING_SET_ESTIMATOR_MISMATCH');
  });
});

function mcpInput(queueId: string, captureKey: string) {
  return {
    queueId,
    conversationId: `conversation-${queueId}`,
    captureKey,
    toolName: 'tool',
    result: { ok: true },
  };
}

function requester() {
  return {
    id: 'test',
    path: 'provider' as const,
    localSensitiveAuthorized: false,
    localRestrictedAuthorized: false,
  };
}

function retrievalStub() {
  return {
    list: vi.fn(async () => []),
    getCard: vi.fn(async () => ({ card: { id: 'card' } } as never)),
    search: vi.fn(async () => []),
    read: vi.fn(async () => ({ evidenceId: 'e' } as never)),
    compare: vi.fn(async () => ({ equal: true } as never)),
    verify: vi.fn(async () => ({ verified: true })),
  };
}
