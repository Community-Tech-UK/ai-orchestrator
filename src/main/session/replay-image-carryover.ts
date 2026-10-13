/**
 * Images on earlier user turns survive a provider swap.
 *
 * Replay continuity is text. A swap therefore handed the new provider the
 * words "please suspend this user" and dropped the screenshot that said who.
 * Providers that accept images get the original bytes on the same delivery.
 * Providers that refuse attachments (Cursor included) get the files written
 * into the workspace and a path in that same delivery, so the model can read
 * them instead of asking the user to send the image again.
 */

import path from 'node:path';
import type { FileAttachment, OutputMessage } from '../../shared/types/instance.types';
import { INPUT_LIMITS } from '../../shared/constants/limits';
import { processAttachments } from '../cli/file-handler';
import { getLogger } from '../logging/logger';

const logger = getLogger('ReplayImageCarryover');

const EXCERPT_CHARS = 80;

export interface ReplayImageRef {
  name: string;
  turnExcerpt: string;
  attachment: FileAttachment;
}

export interface ReplayImageCarryover {
  /** Appended to the replay delivery. Names the turn each image belonged to. */
  note: string;
  /** Set only when the target provider accepts inline images. */
  attachments?: FileAttachment[];
}

export interface ReplayImageSource {
  outputBuffer?: readonly OutputMessage[];
  retainedPrompts?: readonly OutputMessage[];
  sessionId?: string;
  workingDirectory?: string;
}

function turnExcerpt(content: string): string {
  const collapsed = content.replace(/\s+/g, ' ').trim();
  if (!collapsed) return 'image-only turn';
  if (collapsed.length <= EXCERPT_CHARS) return collapsed;
  return `${collapsed.slice(0, EXCERPT_CHARS - 3)}...`;
}

function imageKey(attachment: FileAttachment): string {
  return `${attachment.name}\u0000${attachment.size}\u0000${attachment.data.slice(0, 80)}`;
}

function safeFileName(name: string, index: number): string {
  const base = path.basename(name).replace(/[^\w.-]+/g, '_').replace(/^\.+/, '');
  return `${index + 1}-${base || 'image'}`;
}

/**
 * User images still held on the live buffer or the retained-prompt side store.
 * The opening image is kept when the set has to be capped.
 */
export function collectReplayImages(messages: readonly OutputMessage[]): {
  images: ReplayImageRef[];
  omitted: number;
} {
  const seen = new Set<string>();
  const collected: ReplayImageRef[] = [];
  const ordered = [...messages].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

  for (const message of ordered) {
    if (message.type !== 'user' || !message.attachments?.length) continue;
    for (const attachment of message.attachments) {
      if (!attachment.type?.startsWith('image/')) continue;
      if (!attachment.data?.trim()) continue;
      const key = imageKey(attachment);
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push({
        name: attachment.name,
        turnExcerpt: turnExcerpt(message.content),
        attachment,
      });
    }
  }

  const limit = INPUT_LIMITS.MAX_ATTACHMENTS;
  if (collected.length <= limit) {
    return { images: collected, omitted: 0 };
  }

  const opening = collected[0];
  const recent = collected.slice(-(limit - 1));
  const images = recent.some((image) => image === opening) ? recent : [opening, ...recent];
  return { images, omitted: collected.length - images.length };
}

export function replayMessagesForImages(source: ReplayImageSource): OutputMessage[] {
  // Image bytes are deduped later. Dropping by message id here would keep a
  // retained copy that lost its attachment and skip the live copy that still
  // has the image.
  return [...(source.retainedPrompts ?? []), ...(source.outputBuffer ?? [])];
}

function linesFor(images: readonly ReplayImageRef[], location: (image: ReplayImageRef, index: number) => string): string[] {
  return images.map((image, index) => `- "${image.turnExcerpt}": ${location(image, index)}`);
}

function savedNote(images: readonly ReplayImageRef[], paths: readonly string[], omitted: number): string {
  const lines = [
    '[Original images from the earlier conversation]',
    'These images belonged to the user turns below. They are part of that request and were not copied into the transcript text. Read each file before you continue.',
    ...linesFor(images, (_image, index) => paths[index] ?? _image.name),
  ];
  if (omitted > 0) {
    lines.push(`${omitted} earlier image(s) were left out to stay within the attachment limit.`);
  }
  lines.push('[End original images]');
  return lines.join('\n');
}

function inlineNote(images: readonly ReplayImageRef[], omitted: number): string {
  const lines = [
    '[Original images from the earlier conversation]',
    'These images belonged to the user turns below and are attached to this message again. Use the attachments; their contents were not copied into the transcript text.',
    ...linesFor(images, (image) => image.name),
  ];
  if (omitted > 0) {
    lines.push(`${omitted} earlier image(s) were left out to stay within the attachment limit.`);
  }
  lines.push('[End original images]');
  return lines.join('\n');
}

function unavailableNote(images: readonly ReplayImageRef[], omitted: number): string {
  const lines = [
    '[Original images from the earlier conversation]',
    'These images belonged to the user turns below, but they could not be copied for this provider. Their contents are missing from this turn.',
    ...linesFor(images, (image) => image.name),
  ];
  if (omitted > 0) {
    lines.push(`${omitted} earlier image(s) were left out to stay within the attachment limit.`);
  }
  lines.push('[End original images]');
  return lines.join('\n');
}

/**
 * Prepare the images that must ride with a replay delivery.
 * Returns null when the carried conversation has no image bytes left.
 */
export async function prepareReplayImageCarryover(params: {
  messages: readonly OutputMessage[];
  /** True when this delivery can pass image bytes to the provider. */
  inline: boolean;
  sessionId?: string;
  workingDirectory?: string;
}): Promise<ReplayImageCarryover | null> {
  const { images, omitted } = collectReplayImages(params.messages);
  if (images.length === 0) return null;

  if (params.inline) {
    return {
      note: inlineNote(images, omitted),
      attachments: images.map((image) => image.attachment),
    };
  }

  if (!params.sessionId || !params.workingDirectory) {
    logger.warn('Replay images were not copied: the new session has no workspace', {
      count: images.length,
    });
    return { note: unavailableNote(images, omitted) };
  }

  const files = images.map((image, index) => ({
    ...image.attachment,
    name: safeFileName(image.attachment.name, index),
  }));

  try {
    const processed = await processAttachments(files, params.sessionId, params.workingDirectory);
    logger.info('Copied original images for the restored provider', {
      count: processed.length,
      omitted,
    });
    return {
      note: savedNote(images, processed.map((file) => file.filePath), omitted),
    };
  } catch (error) {
    logger.warn('Could not copy original images for the restored provider', {
      count: images.length,
      error: error instanceof Error ? error.message : String(error),
    });
    return { note: unavailableNote(images, omitted) };
  }
}
