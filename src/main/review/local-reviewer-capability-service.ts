import { z } from 'zod';
import type { ModelRuntimeTarget } from '../../shared/types/local-model-runtime.types';
import {
  type LocalModelToolTurnClient,
  type LocalModelToolTurnMessage,
} from '../cli/adapters/local-model-chat-adapter';
import { OllamaCliAdapter } from '../cli/adapters/ollama-cli-adapter';
import { OpenAICompatibleChatAdapter } from '../cli/adapters/openai-compatible-chat-adapter';
import {
  serializeUntrustedLocalReviewToolResult,
  type LocalReviewToolDefinition,
} from './local-review.types';

type LocalModelTarget = Extract<ModelRuntimeTarget, { kind: 'local-model' }>;

export type LocalReviewerQualification =
  | { status: 'verified' }
  | { status: 'unverified'; reason: string };

export interface LocalReviewerCapabilityServiceOptions {
  clientFactory?: (target: LocalModelTarget) => Promise<LocalModelToolTurnClient>;
  timeoutMs?: number;
}

const PROBE_PATH = '__aio_local_review_probe__.txt';
const PROBE_TIMEOUT_MS = 30_000;
const probeTool: LocalReviewToolDefinition = {
  name: 'workspace_read',
  description: 'Read the synthetic capability-probe file.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: { path: { type: 'string', const: PROBE_PATH } },
  },
};
const probeArgumentsSchema = z.object({ path: z.literal(PROBE_PATH) }).strict();
const probeResponseSchema = z.object({
  ok: z.literal(true),
  evidence: z.literal('synthetic'),
}).strict();

const cachedQualifications = new Map<string, LocalReviewerQualification>();
const pendingQualifications = new Map<string, Promise<LocalReviewerQualification>>();
const qualificationGenerations = new Map<string, number>();
let globalGeneration = 0;
export type LocalReviewerQualificationListener = (
  target: LocalModelTarget,
  qualification: LocalReviewerQualification,
) => void;
const qualificationListeners = new Set<LocalReviewerQualificationListener>();

export function subscribeToLocalReviewerQualifications(
  listener: LocalReviewerQualificationListener,
): () => void {
  qualificationListeners.add(listener);
  return () => qualificationListeners.delete(listener);
}

export function getCachedLocalReviewerQualification(
  target: LocalModelTarget,
): LocalReviewerQualification | undefined {
  return cachedQualifications.get(qualificationKey(target));
}

export function invalidateFailedLocalReviewerQualifications(): void {
  for (const key of pendingQualifications.keys()) {
    pendingQualifications.delete(key);
    bumpQualificationGeneration(key);
  }
  for (const [key, qualification] of cachedQualifications) {
    if (qualification.status === 'verified') continue;
    cachedQualifications.delete(key);
    bumpQualificationGeneration(key);
  }
}

export class LocalReviewerCapabilityService {
  private readonly clientFactory: (target: LocalModelTarget) => Promise<LocalModelToolTurnClient>;
  private readonly timeoutMs: number;

  constructor(options: LocalReviewerCapabilityServiceOptions = {}) {
    this.clientFactory = options.clientFactory ?? createLocalReviewerToolTurnClient;
    this.timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  }

  qualify(target: ModelRuntimeTarget): Promise<LocalReviewerQualification> {
    if (target.kind !== 'local-model') {
      return Promise.resolve({ status: 'unverified', reason: 'Only local-model targets can be qualified.' });
    }
    const key = qualificationKey(target);
    const cached = cachedQualifications.get(key);
    if (cached) return Promise.resolve(cached);
    const pending = pendingQualifications.get(key);
    if (pending) return pending;

    const generation = generationFor(key);
    const qualification = this.runProbe(target)
      .then((result) => {
        if (generationFor(key) === generation) {
          cachedQualifications.set(key, result);
          for (const listener of qualificationListeners) {
            try { listener(target, result); } catch { /* Observers cannot fail qualification. */ }
          }
        }
        return result;
      })
      .finally(() => {
        if (pendingQualifications.get(key) === qualification) pendingQualifications.delete(key);
      });
    pendingQualifications.set(key, qualification);
    return qualification;
  }

  getCachedQualification(target: ModelRuntimeTarget): LocalReviewerQualification | undefined {
    return target.kind === 'local-model'
      ? getCachedLocalReviewerQualification(target)
      : undefined;
  }

  invalidate(target?: ModelRuntimeTarget): void {
    if (!target) {
      cachedQualifications.clear();
      pendingQualifications.clear();
      qualificationGenerations.clear();
      globalGeneration += 1;
      return;
    }
    if (target.kind !== 'local-model') return;
    const key = qualificationKey(target);
    cachedQualifications.delete(key);
    pendingQualifications.delete(key);
    bumpQualificationGeneration(key);
  }

  invalidateFailures(): void {
    invalidateFailedLocalReviewerQualifications();
  }

  private async runProbe(target: LocalModelTarget): Promise<LocalReviewerQualification> {
    if (target.endpointProvider === 'ollama' && target.modelId.toLowerCase().includes(':cloud')) {
      return { status: 'unverified', reason: 'Ollama :cloud models are not eligible for local review.' };
    }
    if (target.source === 'worker-node') {
      return {
        status: 'unverified',
        reason: 'worker-node local review is unavailable until its transport supports normalized tool turns.',
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();
    try {
      const client = await abortable(this.clientFactory(target), controller.signal);
      const initialMessages: LocalModelToolTurnMessage[] = [{
        role: 'user',
        content: `Call workspace_read once with {"path":"${PROBE_PATH}"}. Do not answer directly.`,
      }];
      const first = await abortable(
        client.sendToolTurn(initialMessages, [probeTool], controller.signal),
        controller.signal,
      );
      if (first.toolCalls.length !== 1) {
        return { status: 'unverified', reason: 'Capability probe did not return exactly one tool call.' };
      }
      const call = first.toolCalls[0];
      if (call.name !== 'workspace_read' || !probeArgumentsSchema.safeParse(call.arguments).success) {
        return { status: 'unverified', reason: 'Capability probe returned malformed workspace_read arguments.' };
      }

      const messages: LocalModelToolTurnMessage[] = [
        ...initialMessages,
        { role: 'assistant', content: first.content, toolCalls: first.toolCalls },
        {
          role: 'tool',
          toolCallId: call.id,
          toolName: call.name,
          content: serializeUntrustedLocalReviewToolResult({
            ok: true,
            content: 'synthetic probe content',
          }, 4_096).content,
        },
        {
          role: 'user',
          content: 'Respond only with {"ok":true,"evidence":"synthetic"}.',
        },
      ];
      const final = await abortable(
        client.sendToolTurn(messages, [probeTool], controller.signal),
        controller.signal,
      );
      if (final.toolCalls.length > 0) {
        return { status: 'unverified', reason: 'Capability probe did not finish after the synthetic result.' };
      }
      const parsed = parseJson(final.content);
      if (!probeResponseSchema.safeParse(parsed).success) {
        return { status: 'unverified', reason: 'Capability probe returned an invalid structured response.' };
      }
      return { status: 'verified' };
    } catch (error) {
      const reason = controller.signal.aborted
        ? 'Capability probe timed out.'
        : `Capability probe failed: ${error instanceof Error ? error.message : String(error)}`;
      return { status: 'unverified', reason };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function qualificationKey(target: LocalModelTarget): string {
  return JSON.stringify([
    target.source,
    target.nodeId ?? '',
    target.endpointProvider,
    target.endpointId,
    target.modelId,
  ]);
}

function generationFor(key: string): string {
  return `${globalGeneration}:${qualificationGenerations.get(key) ?? 0}`;
}

function bumpQualificationGeneration(key: string): void {
  qualificationGenerations.set(key, (qualificationGenerations.get(key) ?? 0) + 1);
}

export async function createLocalReviewerToolTurnClient(
  target: LocalModelTarget,
): Promise<LocalModelToolTurnClient> {
  if (target.source !== 'this-device') {
    throw new Error('worker-node normalized tool turns are not implemented');
  }
  if (target.endpointProvider === 'ollama') {
    return new OllamaCliAdapter({ model: target.modelId });
  }
  return new OpenAICompatibleChatAdapter({ endpointId: target.endpointId, model: target.modelId });
}

function parseJson(content: string): unknown {
  try {
    return JSON.parse(content.trim()) as unknown;
  } catch {
    return null;
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
