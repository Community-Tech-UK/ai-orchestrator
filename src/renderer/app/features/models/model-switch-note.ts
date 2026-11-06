export interface ModelSwitchNoteInput {
  provider: string;
  targetProvider?: string;
  hasConversation: boolean;
  usedTokens?: number | null;
  residentClaude?: boolean;
  executionLocationType?: string | null;
}

const REPLAY = 'Harness replays your recent messages in shortened form; tool results and file contents are not carried over.';

/** This describes the planned path before a click; the runtime notice reports any fallback afterward. */
export function describeModelSwitchEffect(input: ModelSwitchNoteInput): string | null {
  if (!input.hasConversation) return null;
  const provider = input.provider.trim().toLowerCase();
  const target = input.targetProvider?.trim().toLowerCase() ?? provider;
  if (target !== provider) {
    return 'Switching provider starts a new session. Harness replays your recent messages in shortened form.';
  }
  const count = typeof input.usedTokens === 'number' && Number.isFinite(input.usedTokens) && input.usedTokens > 0
    ? `about ${Math.round(input.usedTokens / 1_000)}K tokens` : null;
  if (provider === 'claude') {
    if (input.residentClaude && input.executionLocationType !== 'remote') {
      return 'Switches in place. The whole conversation, including tool results, is kept. '
        + `The next reply re-reads it at the new model's price${count ? ` (${count})` : ''}.`;
    }
    return `Switching starts a fresh Claude session. ${REPLAY}`;
  }
  const remote = input.executionLocationType === 'remote';
  // Match the adapters' resume support. Local ACP agents advertise it at runtime;
  // remote OpenCode and Codex support it, while the other providers replay.
  if (provider === 'codex' || (remote && provider === 'opencode')) {
    return count
      ? `The conversation continues with the new model, which reads ${count} of history again at full price.`
      : 'The conversation continues with the new model.';
  }
  if (!remote && ['copilot', 'cursor', 'grok', 'opencode'].includes(provider)) {
    return 'If this agent can resume its session, the conversation continues with the new model. '
      + `Otherwise, ${REPLAY}`;
  }
  return `Switching starts a fresh session. ${REPLAY}`;
}
