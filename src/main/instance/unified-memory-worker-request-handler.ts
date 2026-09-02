import type { UnifiedMemoryController } from '../memory/unified-controller';
import type {
  UnifiedMemoryWorkerRequest,
  UnifiedMemoryWorkerResult,
} from './unified-memory-worker-port';

export type UnifiedMemoryWorkerRequestController = Pick<
  UnifiedMemoryController,
  | 'processInput'
  | 'retrieve'
  | 'recordSessionEnd'
  | 'recordWorkflow'
  | 'recordStrategy'
  | 'recordTaskOutcome'
  | 'getStats'
  | 'getSessionHistory'
  | 'getPatterns'
  | 'getWorkflows'
  | 'save'
  | 'load'
  | 'configure'
>;

export function handleUnifiedMemoryWorkerRequest<
  TRequest extends UnifiedMemoryWorkerRequest,
>(
  controller: UnifiedMemoryWorkerRequestController,
  request: TRequest,
): Promise<UnifiedMemoryWorkerResult<TRequest>>;
export async function handleUnifiedMemoryWorkerRequest(
  controller: UnifiedMemoryWorkerRequestController,
  request: UnifiedMemoryWorkerRequest,
): Promise<UnifiedMemoryWorkerResult> {
  switch (request.kind) {
    case 'process-input':
      await controller.processInput(request.input, request.sessionId, request.taskId);
      return undefined;
    case 'retrieve':
      return await controller.retrieve(request.query, request.taskId, request.options);
    case 'record-session-end':
      await controller.recordSessionEnd(
        request.sessionId,
        request.outcome,
        request.summary,
        request.lessons,
      );
      return undefined;
    case 'record-workflow':
      return await controller.recordWorkflow(
        request.name,
        request.steps,
        request.applicableContexts,
      );
    case 'record-strategy':
      return await controller.recordStrategy(
        request.strategy,
        request.conditions,
        request.taskId,
        request.success,
        request.score,
      );
    case 'record-outcome':
      controller.recordTaskOutcome(request.taskId, request.success, request.score);
      return undefined;
    case 'get-stats':
      return controller.getStats();
    case 'get-sessions':
      return controller.getSessionHistory(request.limit);
    case 'get-patterns':
      return controller.getPatterns(request.minSuccessRate);
    case 'get-workflows':
      return controller.getWorkflows();
    case 'save':
      return await controller.save();
    case 'load':
      await controller.load(request.snapshot);
      return undefined;
    case 'configure':
      controller.configure(request.config);
      return undefined;
    default:
      throw new Error(
        `Unknown unified-memory worker request kind: ${unknownRequestKind(request)}`,
      );
  }
}

function unknownRequestKind(request: never): string {
  return String((request as { kind?: unknown }).kind);
}
