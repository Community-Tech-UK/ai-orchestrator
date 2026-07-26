import { readFileSync } from 'node:fs';
import type {
  CliAttachment,
  CliResponse,
} from './base-cli-adapter';
import type { FileAttachment } from '../../../shared/types/instance.types';
import { normalizeAttachmentData } from './codex/exec-helpers';

interface CompleteResponseEmitter {
  on(event: 'complete', listener: (response: CliResponse) => void): unknown;
  off(event: 'complete', listener: (response: CliResponse) => void): unknown;
}

export class SerializedCodexRequestQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(request: () => Promise<T>): Promise<T> {
    const result = this.tail.then(request, request);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export async function captureCorrelatedCodexResponse(
  emitter: CompleteResponseEmitter,
  send: () => Promise<void>,
): Promise<CliResponse> {
  let completed: CliResponse | null = null;
  const capture = (response: CliResponse): void => {
    completed = response;
  };
  emitter.on('complete', capture);
  try {
    await send();
  } finally {
    emitter.off('complete', capture);
  }
  if (!completed) {
    throw new Error('Codex app-server turn completed without a correlated response');
  }
  return completed;
}

export function toCodexFileAttachments(
  attachments?: CliAttachment[],
): FileAttachment[] | undefined {
  if (!attachments || attachments.length === 0) return undefined;
  return attachments.map((attachment, index) => {
    const mimeType = attachment.mimeType
      || (attachment.type === 'image' ? 'image/png' : 'application/octet-stream');
    let data = attachment.content ?? '';
    if (!data && attachment.path) {
      data = readFileSync(attachment.path).toString('base64');
    } else {
      data = normalizeAttachmentData(data);
    }
    return {
      name: attachment.name || `attachment-${index}`,
      type: mimeType,
      size: data.length,
      data,
    };
  });
}
