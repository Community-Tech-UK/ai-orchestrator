import type { TooltipCopyEntry } from './tooltip-copy';

export const SHARED_IMAGES_COPY = {
  'attachments.preview': { label: 'Preview image', meaning: 'Click to preview image' },
  'attachments.open': { label: 'Open file', meaning: 'Click to open file' },
  'attachments.copy': { label: 'Copy', meaning: 'Copy image to clipboard' },
} as const satisfies Record<string, TooltipCopyEntry>;
