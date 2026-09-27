import type { MobileDocReviewItemDto, MobileDocReviewOptionDto } from '../../shared/types/mobile-gateway.types';

function attr(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return match ? (match[1] ?? match[2] ?? '') : null;
}

function decode(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Pull review sections and authored options out of an artifact without returning HTML. */
export function parseDocReviewItems(html: string): MobileDocReviewItemDto[] {
  const items: MobileDocReviewItemDto[] = [];
  const sectionRe = /<section\b([^>]*)>([\s\S]*?)<\/section>/gi;
  let section: RegExpExecArray | null;
  while ((section = sectionRe.exec(html))) {
    const id = attr(section[1], 'data-review-item');
    if (!id) continue;
    const title = attr(section[1], 'data-review-title') || id;
    const decisionId = attr(section[1], 'data-decision-id');
    const options: MobileDocReviewOptionDto[] = [];
    const list = /<ul\b([^>]*\bdata-review-options\b[^>]*)>([\s\S]*?)<\/ul>/i.exec(section[2]);
    if (list) {
      const multi = attr(list[1], 'data-multi') === 'true';
      const optionRe = /<li\b([^>]*)>([\s\S]*?)<\/li>/gi;
      let option: RegExpExecArray | null;
      while ((option = optionRe.exec(list[2]))) {
        const optionId = attr(option[1], 'data-option');
        if (!optionId) continue;
        const label = decode(option[2].replace(/<[^>]+>/g, '').trim());
        options.push({
          id: optionId,
          label: label || optionId,
          multi,
          isDefault: attr(option[1], 'data-option-default') === 'true',
        });
      }
    }
    items.push({ id, title: decode(title), decisionId, options });
  }
  return items;
}
