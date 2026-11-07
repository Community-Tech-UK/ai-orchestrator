/** Escape a closing delimiter in untrusted prompt data. */
export function escapeClosingTag(text: string, tag: string): string {
  return text.split(`</${tag}>`).join(`<\\/${tag}>`);
}
