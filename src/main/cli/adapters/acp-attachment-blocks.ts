import { pathToFileURL } from 'url';
import type { AcpContentBlock } from '../../../shared/types/cli.types';
import type { CliAttachment as AdapterCliAttachment } from './base-cli-adapter';

export function toAcpPromptBlockFromAttachment(
  attachment: AdapterCliAttachment,
): AcpContentBlock | null {
  const inlineContent = attachment.content
    ?? (attachment.path?.startsWith('data:') ? attachment.path : undefined);
  if (inlineContent) {
    const parsedDataUrl = parseDataUrl(inlineContent);
    const mimeType = attachment.mimeType?.trim() || parsedDataUrl?.mimeType;
    const base64Data = parsedDataUrl?.base64Data ?? stripDataUrlPrefix(inlineContent);

    if (mimeType?.startsWith('image/')) {
      return {
        type: 'image',
        data: base64Data,
        mimeType,
        // A durable local copy (acp-attachment-store) is referenced by file://
        // so the agent uses that file instead of a temp copy it deletes when
        // the session closes. The inline data stays for agents that ignore uri.
        uri: attachment.path && !attachment.path.startsWith('data:')
          ? toUnencodedFileUri(attachment.path)
          : buildAttachmentUri(attachment.name),
      };
    }

    if (parsedDataUrl || !isTextLikeMimeType(mimeType)) {
      return {
        type: 'resource',
        resource: {
          uri: buildAttachmentUri(attachment.name),
          mimeType,
          blob: base64Data,
          title: attachment.name,
        },
      };
    }

    return {
      type: 'resource',
      resource: {
        uri: buildAttachmentUri(attachment.name),
        mimeType,
        text: inlineContent,
        title: attachment.name,
      },
    };
  }

  if (attachment.path) {
    return {
      type: 'resource',
      resource: {
        uri: toFileUri(attachment.path),
        mimeType: attachment.mimeType,
        text: attachment.content,
        title: attachment.name,
      },
    };
  }

  return null;
}

function toFileUri(filePath: string): string {
  return filePath.startsWith('file://') ? filePath : pathToFileURL(filePath).toString();
}

/**
 * Copilot does not match a percent-encoded file:// image uri to its file, so
 * a path with a space (the macOS userData dir is under "Application Support")
 * falls back to Copilot's deleted-on-close temp copy. Verified live against
 * Copilot 1.0.89-5 for spaces: `file://` + the raw POSIX path resolves, `%20`
 * does not. Any uri Copilot cannot resolve (a Windows path, or characters
 * that were not probed) still carries the inline data, so it degrades to that
 * temp-copy behaviour rather than failing.
 */
function toUnencodedFileUri(filePath: string): string {
  if (filePath.startsWith('file://')) {
    return filePath;
  }
  return filePath.startsWith('/') ? `file://${filePath}` : pathToFileURL(filePath).toString();
}

function stripDataUrlPrefix(data: string): string {
  if (!data.startsWith('data:')) {
    return data;
  }

  const commaIndex = data.indexOf(',');
  return commaIndex === -1 ? data : data.slice(commaIndex + 1);
}

function parseDataUrl(data: string): { mimeType?: string; base64Data: string } | null {
  const match = /^data:([^;,]+)?(?:;[^,]*)?;base64,(.+)$/i.exec(data);
  if (!match) {
    return null;
  }

  return {
    mimeType: match[1] || undefined,
    base64Data: match[2] || '',
  };
}

function isTextLikeMimeType(mimeType: string | undefined): boolean {
  if (!mimeType) {
    return false;
  }

  const normalized = mimeType.trim().toLowerCase();
  return (
    normalized.startsWith('text/')
    || normalized === 'application/json'
    || normalized === 'application/xml'
    || normalized.endsWith('+json')
    || normalized.endsWith('+xml')
  );
}

function buildAttachmentUri(name?: string): string {
  const normalizedName = encodeURIComponent(name?.trim() || 'attachment');
  return `attachment://${normalizedName}`;
}
