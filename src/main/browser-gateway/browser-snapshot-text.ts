import { maybeExtractPageText } from './browser-aux-extraction';
import { boundBrowserText, redactBrowserText } from './browser-redaction';

/** Bound what the agent sees without cutting the extraction model's page input. */
export async function browserSnapshotText(text: string, extractionHint?: string): Promise<string> {
  const redacted = redactBrowserText(text);
  const preview = boundBrowserText(redacted);
  if (!extractionHint?.trim()) return preview;
  // Preserve the extraction input's former 50 KB / 400-line budget. The
  // smaller agent preview must not remove relevant content from that input.
  const extractionInput = Buffer.from(redacted).subarray(0, 51_200).toString().split('\n', 400).join('\n');
  const extracted = await maybeExtractPageText(extractionInput, extractionHint);
  // An extract must fit the same response budget. Keep the raw preview on
  // failure or an oversized extract, with just one spill of the original page.
  if (extracted === null || Buffer.byteLength(extracted) > 12_000 || extracted.split('\n').length > 400) return preview;
  const spillNote = /\n\n\[Output truncated\.[^\]]*\]$/.exec(preview)?.[0] ?? '';
  return `${extracted}${spillNote}`;
}
