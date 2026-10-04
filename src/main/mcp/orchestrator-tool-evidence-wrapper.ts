import { randomUUID } from 'node:crypto';
import type { OrchestratorToolRuntimeContext } from './orchestrator-tools';
import type { ChatStore } from '../chats/chat-store';
import type { McpServerToolDefinition } from './mcp-server-tools';
import { resolveOrchestratorToolSourceContext } from './orchestrator-tool-source-context';
import {
  evidenceCaptureFailureCode, hasFailedEvidenceCapture, providerResultAfterCapture,
} from './orchestrator-evidence-capture-result';

/** Bind source BEFORE execution, then capture results before provider retention. */
export function wrapOrchestratorToolsWithEvidence(
  tools: McpServerToolDefinition[],
  context: OrchestratorToolRuntimeContext,
  chatStore: ChatStore,
): McpServerToolDefinition[] {
  const evidence = context.contextEvidence;
  if (!evidence) return tools;
  return tools.map((tool) => tool.name.startsWith('evidence_') ? tool : {
    ...tool,
    handler: async (args) => {
      // A server-owned ID identifies this invocation even if provider events
      // arrive after execution and multiple calls share one genuine user source.
      const invocationId = `mcp-invocation:${randomUUID()}`;
      const block = (execution: 'not_started' | 'completed', reason: string): never => {
        throw new Error(
          `EVIDENCE_CAPTURE_REQUIRED execution=${execution} reason=${reason} invocation=${invocationId}`
          + (execution === 'completed' ? ' action_executed_do_not_blindly_retry' : ''),
        );
      };
      const ownershipFailure = (): string | null => {
        if (!context.resolveEvidenceConversation) return null;
        try {
          return context.resolveEvidenceConversation() === evidence.conversationId
            ? null : 'CONVERSATION_OWNERSHIP_CHANGED';
        } catch {
          return 'SOURCE_OWNERSHIP_LOOKUP_FAILED';
        }
      };
      let source;
      let sourceFailure: string | null = null;
      if (!context.instanceId || !evidence.conversationId) {
        sourceFailure = 'CONVERSATION_UNRESOLVED';
      } else if (!evidence.coordinator.captureAioMcpResult) {
        sourceFailure = 'CAPTURE_UNAVAILABLE';
      } else {
        try {
          await context.prepareEvidenceSource?.(context.instanceId);
        } catch {
          sourceFailure = 'SOURCE_PERSISTENCE_FAILED';
        }
        sourceFailure ??= ownershipFailure();
        if (!sourceFailure) {
          try {
            source = await resolveOrchestratorToolSourceContext({
              chatStore,
              ledger: context.ledger ?? null,
              instanceId: context.instanceId,
              preferredConversationId: evidence.conversationId,
              toolName: tool.name,
            });
            sourceFailure = source.threadId !== evidence.conversationId
              ? 'CONVERSATION_MISMATCH'
              : source.failureReason
                ?? (source.sourceMessageId.startsWith('mcp-tool:') ? 'SOURCE_MESSAGE_MISSING' : null);
          } catch {
            sourceFailure = 'SOURCE_LOOKUP_FAILED';
          }
        }
      }
      sourceFailure ??= ownershipFailure();
      if (sourceFailure && evidence.mode === 'enforce') block('not_started', sourceFailure);
      if (context.abortSignal?.aborted) throw new Error('ORCHESTRATOR_REQUEST_ABORTED execution=not_started');
      const result = await tool.handler(args);
      const ownerAfterExecution = ownershipFailure();
      if (ownerAfterExecution && evidence.mode === 'enforce') block('completed', ownerAfterExecution);
      if (sourceFailure || !source || ownerAfterExecution) return result;
      let captureResult: unknown;
      try {
        captureResult = await evidence.coordinator.captureAioMcpResult!({
          queueId: context.instanceId!,
          conversationId: evidence.conversationId!,
          captureKey: invocationId,
          turnRef: source.sourceMessageId,
          toolCallRef: invocationId,
          toolName: tool.name,
          result,
          ...(evidence.providerWindowTokens === undefined
            ? {}
            : { providerWindowTokens: evidence.providerWindowTokens }),
        });
      } catch {
        if (evidence.mode === 'enforce') block('completed', 'CAPTURE_EXCEPTION');
        return result;
      }
      const ownerAfterCapture = ownershipFailure();
      if (ownerAfterCapture) {
        if (evidence.mode === 'enforce') block('completed', ownerAfterCapture);
        return result;
      }
      if (hasFailedEvidenceCapture(captureResult, evidence.conversationId!)) {
        if (evidence.mode === 'enforce') block('completed', evidenceCaptureFailureCode(captureResult));
        return result;
      }
      return providerResultAfterCapture(captureResult, result);
    },
  });
}
