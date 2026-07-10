/**
 * Hook Prompt Module
 *
 * Prompt evaluation for hooks using Anthropic API.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { CLAUDE_MODELS } from '../../../shared/types/provider.types';
import type {
  EnhancedHookConfig,
  HookExecutionContext,
  HookExecutionResult,
  HookAction
} from './hook-types';
import { interpolateString } from './hook-utils';
import { parseJsonWithRepair } from '../../cli/json-parse';

const VALID_HOOK_ACTIONS: readonly HookAction[] = ['allow', 'block', 'modify', 'skip'];

/** Strip a single markdown code fence (```json ... ```), if present, before parsing. */
function stripCodeFence(text: string): string {
  const fenceMatch = text.trim().match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  return fenceMatch ? fenceMatch[1].trim() : text.trim();
}

/**
 * Execute a prompt hook.
 */
export async function executePrompt(
  hook: EnhancedHookConfig,
  context: HookExecutionContext,
  anthropic: Anthropic | null
): Promise<HookExecutionResult> {
  const startTime = Date.now();
  const handler = hook.handler;
  const prompt = interpolateString(handler.prompt || '', context);

  if (context.dryRun) {
    return {
      hookId: hook.id,
      hookName: hook.name,
      success: true,
      action: 'allow',
      output: `[DRY RUN] Would evaluate prompt: ${prompt.slice(0, 100)}...`,
      duration: Date.now() - startTime,
      timestamp: startTime
    };
  }

  if (!anthropic) {
    return {
      hookId: hook.id,
      hookName: hook.name,
      success: false,
      action: 'skip',
      error: 'Anthropic client not initialized for prompt hooks',
      duration: Date.now() - startTime,
      timestamp: startTime
    };
  }

  try {
    const response = await anthropic.messages.create({
      model: handler.model || CLAUDE_MODELS.HAIKU,
      max_tokens: 1024,
      system: `You are a security and code review assistant evaluating whether a tool call should be allowed.

Respond with ONLY a single JSON object — no markdown fences, no text before or after it:
{"action": "allow" | "block" | "modify", "reason": "explanation of your decision", "modification": { ...optional modified parameters when action is "modify" }}

If the request is ambiguous or you cannot evaluate it, respond {"action": "skip", "reason": "why you could not decide"} rather than guessing.

Be concise and security-focused.`,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ]
    });

    const responseText =
      response.content[0].type === 'text' ? response.content[0].text : '';

    // Parse response (fence-tolerant, repair-tolerant). An unparseable or
    // invalid verdict must NOT fail open to 'allow' — a fenced/blocked verdict
    // we cannot read is treated as 'skip' (this hook made no decision).
    const parseResult = parseJsonWithRepair<{ action?: unknown; reason?: unknown; modification?: unknown }>(
      stripCodeFence(responseText)
    );
    const parsed = parseResult.ok && parseResult.value && typeof parseResult.value === 'object'
      ? parseResult.value
      : null;
    const action = parsed && VALID_HOOK_ACTIONS.includes(parsed.action as HookAction)
      ? (parsed.action as HookAction)
      : null;

    if (!parsed || !action) {
      return {
        hookId: hook.id,
        hookName: hook.name,
        success: false,
        action: 'skip',
        output: responseText,
        error: 'Prompt hook returned an unparseable or invalid verdict; treating as skip',
        duration: Date.now() - startTime,
        timestamp: startTime
      };
    }

    const reason = typeof parsed.reason === 'string' ? parsed.reason : undefined;
    return {
      hookId: hook.id,
      hookName: hook.name,
      success: true,
      action,
      output: reason,
      blockReason: action === 'block' ? reason : undefined,
      modifiedData: parsed.modification && typeof parsed.modification === 'object'
        ? parsed.modification as Record<string, unknown>
        : undefined,
      duration: Date.now() - startTime,
      timestamp: startTime
    };
  } catch (error) {
    return {
      hookId: hook.id,
      hookName: hook.name,
      success: false,
      action: 'skip',
      error: (error as Error).message,
      duration: Date.now() - startTime,
      timestamp: startTime
    };
  }
}
