import type { OutputMessage } from './instance.types';
import { stabilizeThinkingBlocks } from '../../../../../shared/utils/thinking-extractor';
import { getStreamingStatusMergePolicy, nextMonotonicStreamingContent } from '../../../../../shared/utils/streaming-content';

export function getAccumulatedStreamingContent(message: OutputMessage): string {
  const accumulated = message.metadata?.['accumulatedContent'];
  return typeof accumulated === 'string' ? accumulated : message.content;
}
/** The same merge applies to ordinary live batches and output racing a history snapshot. */
export function appendInstanceOutputMessage(buffer: OutputMessage[], message: OutputMessage, userIds: Set<string>): void {
  const streaming = message.metadata?.['streaming'];
  if (streaming === true || streaming === false) {
    const index = buffer.findIndex(previous => previous.id === message.id);
    if (index < 0) buffer.push({ ...message, content: getAccumulatedStreamingContent(message) });
    else {
      const previous = buffer[index];
      const statusPolicy = getStreamingStatusMergePolicy(previous, message);
      if (statusPolicy === 'ignore') return;
      buffer[index] = { ...previous,
        content: statusPolicy === 'replace'
          ? getAccumulatedStreamingContent(message)
          : nextMonotonicStreamingContent(previous.content ?? '', getAccumulatedStreamingContent(message)),
        metadata: message.metadata,
        thinking: message.thinking ? stabilizeThinkingBlocks(previous.thinking, message.thinking) : previous.thinking,
        thinkingExtracted: message.thinkingExtracted ?? previous.thinkingExtracted,
      };
    }
    return;
  }
  if (message.type === 'user') {
    if (userIds.has(message.id)) return;
    userIds.add(message.id);
  }
  buffer.push(message);
}
