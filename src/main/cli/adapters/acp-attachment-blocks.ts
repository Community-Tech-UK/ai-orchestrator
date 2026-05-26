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
        uri: buildAttachmentUri(attachment.name),
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
    const resourceUri = attachment.path.startsWith('file://')
      ? attachment.path
      : pathToFileURL(attachment.path).toString();
    return {
      type: 'resource',
      resource: {
        uri: resourceUri,
        mimeType: attachment.mimeType,
        text: attachment.content,
        title: attachment.name,
      },
    };
  }

  return null;
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
