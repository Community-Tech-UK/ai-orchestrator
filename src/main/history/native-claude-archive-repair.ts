import type { OutputMessage } from '../../shared/types/instance.types';
import { isLegacyRedactedToolOutput } from '../session/redacted-tool-output';
import { isNativeTranscriptTailExtension } from './native-claude-importer';

export type NativeClaudeArchiveRepairKind =
  | 'legacy-redacted-output'
  | 'truncated-tail'
  | 'missing-opening-prompt';

export interface NativeClaudeArchiveRepairPlan {
  backupLabel: 'legacy-redacted' | 'truncated' | 'missing-opening-prompt';
  repairKind: NativeClaudeArchiveRepairKind;
  repairedMessages: OutputMessage[];
}

function normalizePromptIdentity(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

export function createNativeClaudeArchiveRepairPlan(
  nativeMessages: OutputMessage[],
  archivedMessages: OutputMessage[],
  nativeFirstUserMessage: string,
): NativeClaudeArchiveRepairPlan | null {
  const hasLegacyRedactedOutput = archivedMessages.some(
    (message) => isLegacyRedactedToolOutput(message.content),
  );
  const hasTruncatedTail = isNativeTranscriptTailExtension(nativeMessages, archivedMessages);
  const nativeOpeningPrompt = normalizePromptIdentity(nativeFirstUserMessage);
  const hasNativeOpeningPrompt = archivedMessages.some(
    (message) => message.type === 'user'
      && normalizePromptIdentity(message.content) === nativeOpeningPrompt,
  );
  const hasMissingOpeningPrompt = nativeOpeningPrompt.length > 0 && !hasNativeOpeningPrompt;
  if (!hasLegacyRedactedOutput && !hasTruncatedTail && !hasMissingOpeningPrompt) {
    return null;
  }

  const repairedMessages = hasLegacyRedactedOutput
    ? nativeMessages.filter((message) => !isLegacyRedactedToolOutput(message.content))
    : nativeMessages;
  if (!repairedMessages.some((message) => message.type === 'user')) {
    return null;
  }

  if (hasLegacyRedactedOutput) {
    return { backupLabel: 'legacy-redacted', repairKind: 'legacy-redacted-output', repairedMessages };
  }
  if (hasTruncatedTail) {
    return { backupLabel: 'truncated', repairKind: 'truncated-tail', repairedMessages };
  }
  return { backupLabel: 'missing-opening-prompt', repairKind: 'missing-opening-prompt', repairedMessages };
}
