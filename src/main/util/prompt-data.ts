/** Escape only the closing delimiter; payloads remain visibly untrusted data. */
export function escapeClosingTag(text: string, tag: string): string {
  if (!/^[a-z][a-z0-9_-]*$/i.test(tag)) throw new Error('Invalid data block tag');
  return text.replace(new RegExp(`</${tag}`, 'gi'), match => match.replace('</', '<\\/'));
}

export function dataBlock(tag: string, text: string, maxChars?: number): string {
  const payload = maxChars === undefined ? text : text.slice(0, Math.max(0, maxChars));
  return `<${tag}>\n${escapeClosingTag(payload, tag)}\n</${tag}>`;
}
