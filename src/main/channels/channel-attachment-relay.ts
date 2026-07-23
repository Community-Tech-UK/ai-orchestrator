/**
 * Channel Attachment Relay
 *
 * Relays agent-produced files/images (mobile-parity backlog #3) to a chat
 * channel. Agent output carries attachments as data URLs (`FileAttachment.data`
 * = `data:<mime>;base64,<payload>`). The channel adapters send files by path, so
 * each attachment is decoded to a bounded temp file, sent, and cleaned up.
 *
 * Kept separate from the router so the temp-file handling and dedup logic stay
 * testable and don't bloat the streaming path.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getLogger } from '../logging/logger';
import type { FileAttachment } from '../../shared/types/instance.types';
import type { BaseChannelAdapter } from './channel-adapter';

const logger = getLogger('ChannelAttachmentRelay');

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // Discord's default non-boost upload cap.
const DATA_URL_RE = /^data:([^;,]*)(;base64)?,(.*)$/s;

/** A stable-ish key so the same attachment isn't relayed twice across flushes. */
export function attachmentKey(attachment: FileAttachment): string {
  return `${attachment.name}:${attachment.size}:${attachment.data.slice(0, 48)}`;
}

/** Turn a possibly-unsafe attachment name into a temp-file-safe basename. */
function safeBasename(name: string): string {
  const base = path.basename(name || 'attachment').replace(/[^A-Za-z0-9._-]/g, '_');
  return base.replace(/^\.+/, '') || 'attachment';
}

interface DecodedAttachment {
  buffer: Buffer;
  name: string;
}

function decodeAttachment(attachment: FileAttachment): DecodedAttachment | null {
  const match = DATA_URL_RE.exec(attachment.data);
  if (!match) {
    // Only inline data URLs are relayed; a bare path/URL is not fetched here.
    return null;
  }
  const isBase64 = Boolean(match[2]);
  const payload = match[3] ?? '';
  const buffer = isBase64
    ? Buffer.from(payload, 'base64')
    : Buffer.from(decodeURIComponent(payload), 'utf8');
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_ATTACHMENT_BYTES) {
    return null;
  }
  return { buffer, name: safeBasename(attachment.name) };
}

/**
 * Relay the given attachments to `chatId`, skipping any whose key is already in
 * `sentKeys` (mutated as attachments are sent). Best-effort: individual failures
 * are logged and skipped, never thrown. Returns the number actually sent.
 */
export async function relayAttachmentsToChannel(
  adapter: BaseChannelAdapter,
  chatId: string,
  attachments: FileAttachment[],
  sentKeys: Set<string>,
): Promise<number> {
  let sent = 0;
  for (const attachment of attachments) {
    const key = attachmentKey(attachment);
    if (sentKeys.has(key)) continue;
    sentKeys.add(key);

    const decoded = decodeAttachment(attachment);
    if (!decoded) continue;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-chan-'));
    const tmpPath = path.join(tmpDir, decoded.name);
    try {
      fs.writeFileSync(tmpPath, decoded.buffer);
      await adapter.sendFile(chatId, tmpPath);
      sent += 1;
    } catch (err) {
      logger.warn('Failed to relay attachment to channel', {
        chatId,
        name: decoded.name,
        error: String(err),
      });
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Temp cleanup is best-effort.
      }
    }
  }
  return sent;
}
