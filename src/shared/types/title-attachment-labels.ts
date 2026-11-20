/**
 * The attachment names a session title may use. Shared by the title derivation
 * in `title-derivation.ts` and the live auto-title service.
 */

/** Harness's own name for a pasted picture; its extension follows the picture's type. */
const PASTED_IMAGE_NAME = /^pasted[-_ ]?image(?:[-_ ]?\d+)?\.[\w.+-]+$/i;
const PICTURE_EXTENSION = /\.(?:png|jpe?g|gif|webp|heic|heif|bmp|tiff?|avif)$/i;
/** Names screenshot tools, clipboards and cameras give a picture before a date or number. */
const PICTURE_TOOL_PREFIX = /^(?:image|screen[-_ ]?shot|cleanshot|img|pxl|dsc)/i;

/**
 * True for a name a tool made up for a picture: Harness's `pasted-image-N`, the
 * clipboard's `image.png`, or a screenshot or camera name followed only by a
 * date, time or number (`Screenshot 2026-11-19 at 10.15.03.png`, `IMG_1234.HEIC`).
 * Such a name says nothing about what the picture shows, so a title built from
 * one ("Fix pasted-image-5.png") identifies nothing. A name with words of its
 * own (`Screenshot login bug.png`) is kept.
 */
export function isPlaceholderImageName(name: string): boolean {
  const label = attachmentLabel(name);
  if (PASTED_IMAGE_NAME.test(label)) return true;
  if (!PICTURE_EXTENSION.test(label)) return false;
  const stem = label.replace(PICTURE_EXTENSION, '');
  const prefix = PICTURE_TOOL_PREFIX.exec(stem);
  if (!prefix) return false;
  // Loop attachments swap spaces for underscores (`Screenshot_2026-11-19_at_10.15.03.png`).
  const rest = stem.slice(prefix[0].length).replace(/_/g, ' ').replace(/\b(?:at|from|am|pm)\b/gi, '');
  return !/\p{L}{2,}/u.test(rest);
}

/** Reduce an attachment name to a clean basename for use in a title. */
export function attachmentLabel(name: string): string {
  return (name.split(/[/\\]/).pop() ?? name).trim();
}

/**
 * Map raw attachment names to the labels a title may use: clean, non-empty,
 * and not a made-up picture name (see {@link isPlaceholderImageName}).
 */
export function attachmentLabels(names: readonly string[]): string[] {
  return names.map(attachmentLabel)
    .filter((label) => label.length > 0 && !isPlaceholderImageName(label));
}
