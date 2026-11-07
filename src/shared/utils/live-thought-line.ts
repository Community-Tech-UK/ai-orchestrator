/** A bounded, plain-text headline for transient activity, never transcript content. */
export function liveThoughtLine(text: string): string | null {
  // Activity is a preview: scan only its opening text, before any cleanup.
  const opening = text.slice(0, 4_096);
  const heading = opening.match(/\*\*([^*\n]{1,50})\*\*/)?.[1];
  const plain = (heading ?? opening)
    .replace(/!?(\[([^\]]+)\])\([^)]*\)/g, '$2')
    .replace(/<[^>]*>/g, '')
    .replace(/^[\s#>+-]+/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ').trim();
  if (!plain) return null;
  const sentence = heading ? plain : plain.split(/[.!?](?:\s|$)/, 1)[0].trim();
  return sentence.length > 60 ? sentence.slice(0, 59).trimEnd() + '…' : sentence || null;
}
