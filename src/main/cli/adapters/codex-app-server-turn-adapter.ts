import type {
  CliResponse,
  CliToolCall,
  TurnInterruptCompletion,
} from './base-cli-adapter';
import { CodexAppServerNotificationAdapter } from './codex-app-server-notification-adapter';
import type {
  FileAttachment,
  ThinkingContent,
} from '../../../shared/types/instance.types';
import { generateId } from '../../../shared/utils/id-generator';
import { computeTokenCost } from '../../../shared/data/model-pricing';
import { extractThinkingContent } from '../../../shared/utils/thinking-extractor';
import type {
  AppServerNotification,
  TurnCaptureState,
  UserInput,
} from './codex/app-server-types';
import {
  getCommandAggregatedOutput,
  getCommandExitCode,
} from './codex/thread-item-accessors';
import {
  extractCodexAppServerError,
  formatCodexAppServerError,
} from './codex/app-server-errors';
import { wrapRtkAwareness } from '../rtk/rtk-awareness';
import { hasPendingBrowserApproval } from './codex/browser-approval-watchdog';
import { wrapCodexSystemInstructions } from './codex/codex-prompt-blocks';
import { createCodexTurnCaptureState } from './codex/app-server-thread-runtime';

/** Executes app-server turns using the notification-routing layer. */
export abstract class CodexAppServerTurnAdapter extends CodexAppServerNotificationAdapter {
  protected override async appServerSendMessageInner(
    message: string,
    attachments?: FileAttachment[],
    costRecoveryCount = 0,
  ): Promise<void> {
    if (!this.getAppServerClient() || !this.getAppServerThreadId()) {
      throw new Error('App-server not initialized');
    }

    // Reset per-turn flag so the fallback path works if this turn doesn't
    // receive a thread/tokenUsage/updated notification.
    this.hasTokenUsageNotification = false;

    // App-server turns accept multimodal inputs. Keep supported images as
    // `localImage` items and only fall back to file references for everything
    // else so vision-capable Codex models still receive the original pixels.
    const preparedAttachments = attachments && attachments.length > 0
      ? await this.prepareAttachmentsForAppServer(message, attachments)
      : { input: [], text: message };
    let content = preparedAttachments.text;

    // Include system prompt on the very first turn only.
    if (!this.systemPromptSent && this.cliConfig.systemPrompt?.trim()) {
      // Oversized prompts (usually merged project-instruction files Codex
      // already loads natively) are truncated to the cap rather than silently
      // dropped — dropping delivered NOTHING (no role, no tool permissions)
      // while still marking the prompt as sent.
      const prompt = CodexAppServerTurnAdapter.truncateSystemPrompt(this.cliConfig.systemPrompt.trim());
      content = wrapCodexSystemInstructions(prompt, content);
      this.systemPromptSent = true;
    }

    // Inject RTK awareness on the first turn when the feature is enabled.
    // Codex has no programmatic PreToolUse hook, so awareness-via-prompt is
    // the integration surface — keeps shell commands prefixed with `rtk`.
    if (!this.rtkAwarenessSent && this.cliConfig.rtkEnabled) {
      content = `${wrapRtkAwareness()}\n\n${content}`;
      this.rtkAwarenessSent = true;
    }

    // Start the turn and capture notifications
    const input: UserInput[] = [];
    const text = content.trim();
    if (text) {
      input.push({ type: 'text', text, text_elements: [] });
    }
    input.push(...preparedAttachments.input);

    if (input.length === 0) {
      throw new Error('Cannot send empty app-server turn input');
    }

    const turnState = await this.captureTurn(input);

    if (await this.contextCostController.recoverAfterTurn({
      turnStatus: turnState.finalTurn?.status,
      recoveryCount: costRecoveryCount,
      continueTurn: (continuation, nextCount) => this.appServerSendMessageInner(
        continuation, undefined, nextCount,
      ),
    })) {
      return;
    }

    // Check for failed turns (e.g., context overflow, API errors).
    // Codex reports these as turn/completed with status: "failed".
    const turnStatus = turnState.finalTurn?.status;
    if (turnStatus === 'failed' || turnState.error) {
      const finalTurnError = turnState.finalTurn?.error !== undefined && turnState.finalTurn.error !== null
        ? formatCodexAppServerError(extractCodexAppServerError({ error: turnState.finalTurn.error }))
        : undefined;
      const capturedError = turnState.error instanceof Error
        ? turnState.error.message
        : (typeof turnState.error === 'string' ? turnState.error : undefined);
      const errorMsg = finalTurnError ?? capturedError ?? 'Codex turn failed';
      throw new Error(errorMsg);
    }

    // Emit the final response
    const responseContent = turnState.lastAgentMessage || '';
    const toolCalls = this.buildToolCallsFromTurnState(turnState);

    if (responseContent || toolCalls.length > 0) {
      const extracted = extractThinkingContent(responseContent);

      // Merge thinking from two sources:
      // 1. Structured reasoning items (captured via item/completed type:reasoning)
      // 2. Heuristic extraction from agent message text
      const allThinking: ThinkingContent[] = [];

      // Structured reasoning items take priority — they're the model's actual
      // chain-of-thought, already deduplicated in state.reasoningSummary.
      if (turnState.reasoningSummary.length > 0) {
        allThinking.push({
          id: generateId(),
          content: turnState.reasoningSummary.join('\n\n'),
          format: 'structured',
          timestamp: Date.now(),
        });
      }

      // Also include any thinking extracted from the agent message text itself
      for (const block of extracted.thinking) {
        allThinking.push({
          id: block.id,
          content: block.content,
          format: block.format,
          timestamp: block.timestamp || Date.now(),
        });
      }

      this.emit('output', {
        id: turnState.finalAgentOutputId ?? generateId(),
        timestamp: Date.now(),
        type: 'assistant',
        content: extracted.response,
        metadata: {
          ...(turnState.turnId ? { turnId: turnState.turnId } : {}),
          ...(turnState.finalAgentOutputId ? {
            streaming: false,
            accumulatedContent: extracted.response,
            thinkingExtracted: true,
          } : {}),
        },
        thinking: allThinking.length > 0 ? allThinking : undefined,
        thinkingExtracted: turnState.finalAgentOutputId ? true : undefined,
      });
    }

    // Context tracking: prefer thread/tokenUsage/updated notifications (accurate
    // per-call data with last/total breakdown). Only fall back to turn/completed
    // usage when the notification wasn't received (e.g. older Codex versions).
    // turn/completed usage contains AGGREGATE input_tokens across all internal
    // agentic sub-calls, NOT actual context window occupancy.
    let finalTurnCostUsd = 0;
    if (turnState.finalTurn?.usage) {
      const usage = turnState.finalTurn.usage;
      const inputTokens = usage.input_tokens || 0;
      const outputTokens = usage.output_tokens || 0;
      const turnTokens = inputTokens + outputTokens;

      // Codex's CLI reports no dollar cost (unlike Claude's total_cost_usd), so
      // price the real per-turn input/output split with the shared pricing
      // table and accumulate it. Surfaced via costEstimate on context events.
      finalTurnCostUsd = computeTokenCost(this.cliConfig.model, {
        inputTokens,
        outputTokens,
      });
      this.cumulativeCostUsd += finalTurnCostUsd;

      if (!this.hasTokenUsageNotification) {
        // No accurate notification received — aggregate turn tokens are NOT
        // context-window occupancy (they sum across all internal sub-calls
        // and routinely exceed the context window after a single complex
        // turn). Use the last known good occupancy if we have one; otherwise
        // emit 0 with isEstimated:true rather than clamping the aggregate to
        // 100% of the context window (which would falsely show a full bar).
        const contextWindow = this.resolveContextWindow();
        this.cumulativeTokensUsed += turnTokens;

        if (this.lastTurnTokens > 0) {
          // Re-emit the last known good occupancy (from a previous
          // thread/tokenUsage/updated notification) with updated spend.
          this.emit('context', {
            used: this.lastTurnTokens,
            total: contextWindow,
            percentage: contextWindow > 0 ? Math.min((this.lastTurnTokens / contextWindow) * 100, 100) : 0,
            cumulativeTokens: this.cumulativeTokensUsed,
            costEstimate: this.cumulativeCostUsd,
          });
        } else {
          // No prior occupancy data — we genuinely don't know occupancy.
          // Emit 0 with isEstimated:true and surface lifetime spend via
          // cumulativeTokens. Do NOT cache this in lastTurnTokens, so the
          // next real notification can populate it cleanly.
          this.emit('context', {
            used: 0,
            total: contextWindow,
            percentage: 0,
            cumulativeTokens: this.cumulativeTokensUsed,
            costEstimate: this.cumulativeCostUsd,
            isEstimated: true,
          });
        }
      } else {
        // Accurate notification was already emitted — just update cumulative
        // spend for cost tracking if the notification didn't cover it.
        if (this.cumulativeTokensUsed === 0) {
          this.cumulativeTokensUsed += turnTokens;
        }
      }
    }

    // Build and emit the complete response
    const response: CliResponse = {
      id: this.generateResponseId(),
      content: turnState.lastAgentMessage || '',
      role: 'assistant',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: turnState.finalTurn?.usage ? {
        inputTokens: turnState.finalTurn.usage.input_tokens || 0,
        outputTokens: turnState.finalTurn.usage.output_tokens || 0,
        totalTokens: (turnState.finalTurn.usage.input_tokens || 0) + (turnState.finalTurn.usage.output_tokens || 0),
        cost: finalTurnCostUsd,
      } : undefined,
    };
    this.completeResponse(response);
  }

  /**
   * Checks whether a notification belongs to the current turn.
   * Notifications from unknown threads or from turns we're not tracking
   * are considered foreign and should be routed to the previous handler.
   *
   * Ported from codex-plugin-cc's `belongsToTurn()`.
   */
  private belongsToTurn(state: TurnCaptureState, notification: AppServerNotification): boolean {
    const messageThreadId = notification.params['threadId'] as string | undefined;
    if (!messageThreadId || !state.threadIds.has(messageThreadId)) {
      return false;
    }
    const trackedTurnId = state.threadTurnIds.get(messageThreadId) ?? null;
    // Extract turn ID from notification (can be in params.turnId or params.turn.id)
    const messageTurnId = (notification.params['turnId'] as string | undefined)
      || (notification.params['turn'] && typeof notification.params['turn'] === 'object'
        ? (notification.params['turn'] as Record<string, unknown>)['id'] as string | undefined
        : undefined)
      || null;
    // If either side is unknown, assume it belongs (safe fallback)
    return trackedTurnId === null || messageTurnId === null || messageTurnId === trackedTurnId;
  }

  /**
   * Captures a complete turn from the app-server, routing notifications
   * to adapter events in real-time.
   *
   * This is the core streaming mechanism, modeled after the codex-plugin-cc
   * `captureTurn()` pattern. Includes multi-turn notification routing:
   * notifications from other turns are forwarded to the previous handler.
   */
  private async captureTurn(input: UserInput[]): Promise<TurnCaptureState> {
    this.ensureAppServerRuntimeAttached();
    const turnParams: Record<string, unknown> = {};
    if (this.cliConfig.outputSchema) turnParams['outputSchema'] = this.cliConfig.outputSchema;
    if (this.cliConfig.reasoningEffort) turnParams['effort'] = this.cliConfig.reasoningEffort;
    if (this.cliConfig.fastMode) turnParams['serviceTier'] = 'priority';

    return this.appServerRuntime.captureTurn({
      input,
      turnParams,
      createState: createCodexTurnCaptureState,
      belongsToTurn: (state, notification) => this.belongsToTurn(state, notification),
      handleNotification: (state, notification) => this.handleTurnNotification(state, notification),
      completeTurn: (state, turn) => this.completeTurn(state, turn),
      toInterruptCompletion: (state) => this.toTurnInterruptCompletion(state),
      resolveNotificationIdleTimeoutMs: (turnEstablished) => this.resolveNotificationIdleTimeoutMs(turnEstablished),
      hasPendingApproval: () => hasPendingBrowserApproval(this.cliConfig.browserGatewayInstanceId),
      onHeartbeat: () => this.emit('heartbeat'),
      onAbandonedTurn: () => this.contextDiagnostics?.completeTurn('unknown'),
    });
  }

  private toTurnInterruptCompletion(state: TurnCaptureState): TurnInterruptCompletion {
    const finalStatus = state.finalTurn?.status;
    const reason = state.error instanceof Error
      ? state.error.message
      : typeof state.error === 'string'
        ? state.error
        : state.finalTurn?.error !== undefined && state.finalTurn.error !== null
          ? formatCodexAppServerError(extractCodexAppServerError({ error: state.finalTurn.error }))
          : undefined;

    if (finalStatus === 'interrupted') {
      return { status: 'interrupted', turnId: state.turnId ?? undefined, reason };
    }

    if (finalStatus === 'completed') {
      return { status: 'completed', turnId: state.turnId ?? undefined, reason };
    }

    if (finalStatus === 'failed') {
      return { status: 'rejected', turnId: state.turnId ?? undefined, reason: reason ?? 'Codex turn failed' };
    }

    return {
      status: state.completed ? 'completed' : 'unknown',
      turnId: state.turnId ?? undefined,
      reason,
    };
  }

  /** Test-facing compatibility wrapper around the runtime-owned state factory. */
  private createTurnCaptureState(threadId: string): TurnCaptureState {
    return createCodexTurnCaptureState(threadId);
  }

  /**
   * Converts TurnCaptureState command executions and file changes into CliToolCalls.
   */
  private buildToolCallsFromTurnState(state: TurnCaptureState): CliToolCall[] {
    const toolCalls: CliToolCall[] = [];

    for (const cmd of state.commandExecutions) {
      const exitCode = getCommandExitCode(cmd);
      toolCalls.push({
        id: cmd.id || `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: 'command_execution',
        arguments: {
          command: cmd.command,
          exitCode,
          status: cmd.status,
        },
        result: getCommandAggregatedOutput(cmd) || undefined,
      });
    }

    for (const fc of state.fileChanges) {
      toolCalls.push({
        id: fc.id || `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: 'file_change',
        arguments: {
          path: fc.path,
          changeType: fc.changeType,
        },
        result: fc.description || undefined,
      });
    }

    return toolCalls;
  }
  protected abstract resolveNotificationIdleTimeoutMs(turnEstablished: boolean): number;
}
