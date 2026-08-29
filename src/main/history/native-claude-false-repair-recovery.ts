import * as fs from 'fs';
import * as zlib from 'zlib';
import { promisify } from 'util';
import type { ConversationData, ConversationHistoryEntry } from '../../shared/types/history.types';
import { getLogger } from '../logging/logger';
import { getTranscriptSnippetService } from './transcript-snippet-service';
import type { ImportedTranscript } from './native-claude-importer';
import {
  extractAuthoredUserMessage,
  hasIndexedCodebaseContextPreamble,
} from './native-user-message';

const gunzip = promisify(zlib.gunzip);
const logger = getLogger('NativeClaudeFalseRepairRecovery');

interface FalseRepairRecoveryOptions {
  entry: ConversationHistoryEntry;
  conversation: ConversationData;
  parsed: ImportedTranscript;
  conversationPath: string;
  saveConversation: (conversation: ConversationData) => Promise<void>;
  truncatePreview: (text: string) => string;
}

function normalizePromptIdentity(content: string): string {
  return extractAuthoredUserMessage(content).replace(/\s+/g, ' ').trim();
}

/**
 * Restore an app-owned archive that the first missing-opening-prompt repair
 * falsely replaced with a context-polluted native transcript. The original
 * archive was saved beside it; messages added after that backup are retained.
 */
export async function recoverFalseMissingOpeningPromptRepair(
  options: FalseRepairRecoveryOptions,
): Promise<boolean> {
  const { entry, conversation, parsed, conversationPath, saveConversation, truncatePreview } = options;
  const hasPollutedUserMessage = conversation.messages.some(
    (message) => message.type === 'user'
      && hasIndexedCodebaseContextPreamble(message.content),
  );
  if (!hasPollutedUserMessage) return false;

  const backupPath = `${conversationPath}.missing-opening-prompt-backup`;
  if (!fs.existsSync(backupPath)) return false;

  let backup: ConversationData;
  try {
    const compressed = await fs.promises.readFile(backupPath);
    const data = await gunzip(compressed);
    backup = JSON.parse(data.toString()) as ConversationData;
  } catch (error) {
    logger.warn('Could not read missing-opening-prompt repair backup', {
      entryId: entry.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }

  const nativeOpeningPrompt = normalizePromptIdentity(parsed.firstUserMessage);
  const backupHasOpeningPrompt = nativeOpeningPrompt.length > 0
    && backup.messages.some(
      (message) => message.type === 'user'
        && normalizePromptIdentity(message.content) === nativeOpeningPrompt,
    );
  if (!backupHasOpeningPrompt) return false;

  const backupMessageIds = new Set(backup.messages.map((message) => message.id));
  const newerTail = conversation.messages.filter(
    (message) => message.timestamp > backup.entry.endedAt
      && !backupMessageIds.has(message.id),
  );
  const recoveredMessages = [...backup.messages, ...newerTail]
    .sort((left, right) => left.timestamp - right.timestamp);
  const userMessages = recoveredMessages.filter((message) => message.type === 'user');
  const firstUserMessage = userMessages[0]?.content ?? parsed.firstUserMessage;
  const lastUserMessage = userMessages.at(-1)?.content ?? firstUserMessage;
  const recoveredEndedAt = recoveredMessages.reduce(
    (latest, message) => Math.max(latest, message.timestamp),
    backup.entry.endedAt,
  );
  const recoveredEntry: ConversationHistoryEntry = {
    ...backup.entry,
    ...entry,
    createdAt: Math.min(backup.entry.createdAt, entry.createdAt),
    endedAt: recoveredEndedAt,
    messageCount: recoveredMessages.length,
    firstUserMessage: truncatePreview(firstUserMessage),
    lastUserMessage: truncatePreview(lastUserMessage),
    aiTitle: entry.aiTitle ?? backup.entry.aiTitle,
    snippets: getTranscriptSnippetService().extractAtArchiveTime({ messages: recoveredMessages }),
  };

  await saveConversation({ entry: recoveredEntry, messages: recoveredMessages });
  Object.assign(entry, recoveredEntry);
  logger.info('Recovered false missing-opening-prompt repair from backup', {
    entryId: entry.id,
    sessionId: parsed.sessionId,
    restoredMessageCount: backup.messages.length,
    retainedTailMessageCount: newerTail.length,
    backupPath,
  });
  return true;
}
