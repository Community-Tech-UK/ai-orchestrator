/**
 * Pure helpers for the Codex CLI adapter's exec path.
 *
 * Split out of codex-cli-adapter.ts to keep the adapter focused on process
 * orchestration. These build the replay prompt, parse streamed lines, maintain
 * the local conversation-replay history, and normalize attachment data. All are
 * stateless: adapter state (the conversation history, the replay-size caps) is
 * passed in and, where mutated, returned.
 */
import { buildCodexReplayPrompt } from './codex-prompt-blocks';
import type { CliMessage, CliResponse, CliToolCall } from '../base-cli-adapter';

export interface CodexConversationEntry {
  content: string;
  role: 'assistant' | 'user';
}

export function buildReplayPrompt(
  conversationHistory: CodexConversationEntry[],
  currentMessage: string,
  maxEntries: number,
  maxCharsPerEntry: number,
): string {
  return buildCodexReplayPrompt(
    conversationHistory.slice(-maxEntries),
    currentMessage,
    maxCharsPerEntry,
  );
}

export function consumeLines(
  chunk: string,
  carry: string,
  handleLine: (line: string) => void,
): string {
  const combined = carry + chunk;
  const lines = combined.split('\n');
  const remainder = lines.pop() || '';
  for (const line of lines) {
    if (line.trim()) {
      handleLine(line);
    }
  }
  return remainder;
}

export async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Append this turn's user + assistant content to the replay history, trimming to
 * `maxEntries`. Mutates `conversationHistory` in place and returns the array to
 * assign back (a fresh sliced array when the cap is exceeded).
 */
export function recordConversationTurn(
  conversationHistory: CodexConversationEntry[],
  message: CliMessage,
  response: CliResponse,
  maxEntries: number,
): CodexConversationEntry[] {
  const userContent = buildHistoryEntryContent(message);
  if (userContent) {
    conversationHistory.push({ role: 'user', content: userContent });
  }

  const assistantContent = response.content.trim() || summarizeToolCalls(response.toolCalls);
  if (assistantContent) {
    conversationHistory.push({ role: 'assistant', content: assistantContent });
  }

  if (conversationHistory.length > maxEntries) {
    return conversationHistory.slice(-maxEntries);
  }
  return conversationHistory;
}

export function buildHistoryEntryContent(message: CliMessage): string {
  const imageNames = (message.attachments || [])
    .filter((attachment) => attachment.type === 'image')
    .map((attachment) => attachment.name || 'image');
  const imageSummary = imageNames.length > 0
    ? `[Attached images: ${imageNames.join(', ')}]`
    : '';

  if (message.content.trim() && imageSummary) {
    return `${message.content.trim()}\n${imageSummary}`;
  }

  return message.content.trim() || imageSummary;
}

export function summarizeToolCalls(toolCalls?: CliToolCall[]): string {
  if (!toolCalls || toolCalls.length === 0) {
    return '';
  }

  return toolCalls
    .slice(0, 3)
    .map((toolCall) => {
      if (toolCall.name === 'command_execution' && typeof toolCall.arguments['command'] === 'string') {
        return `Executed command: ${toolCall.arguments['command'] as string}`;
      }
      return `Used tool: ${toolCall.name}`;
    })
    .join('\n');
}

export function normalizeAttachmentData(data: string): string {
  if (!data) {
    return data;
  }

  if (data.startsWith('data:')) {
    return data;
  }

  if (looksLikeBase64(data)) {
    return data;
  }

  return Buffer.from(data, 'utf-8').toString('base64');
}

export function looksLikeBase64(data: string): boolean {
  if (data.length < 16 || data.length % 4 !== 0) {
    return false;
  }
  return /^[A-Za-z0-9+/]+={0,2}$/.test(data);
}
