const MAX_RANGE_TOKENS = 4096;
const MIN_KNOWN_WINDOW_TOKENS = 512;

export const MAX_RANGE_BYTES_PER_TOKEN = 16;

export class EvidenceRetrievalError extends Error {
  override readonly name = 'EvidenceRetrievalError';

  constructor(readonly code: string) {
    super(code);
  }
}

export function calculateEvidenceRangeTokenBudget(providerWindowTokens?: number): number {
  if (providerWindowTokens === undefined) return MAX_RANGE_TOKENS;
  if (!Number.isSafeInteger(providerWindowTokens) || providerWindowTokens <= 0) {
    throw new EvidenceRetrievalError('PROVIDER_WINDOW_INVALID');
  }
  const onePercent = Math.max(1, Math.floor(providerWindowTokens / 100));
  if (providerWindowTokens < MIN_KNOWN_WINDOW_TOKENS) return onePercent;
  return Math.min(MAX_RANGE_TOKENS, Math.max(MIN_KNOWN_WINDOW_TOKENS, onePercent));
}

export function validateEvidenceRange(
  startByte: number,
  endByte: number,
  byteCount: number,
): void {
  if (
    !Number.isSafeInteger(startByte)
    || !Number.isSafeInteger(endByte)
    || startByte < 0
    || endByte <= startByte
    || endByte > byteCount
  ) {
    throw new EvidenceRetrievalError('RANGE_INVALID');
  }
}

export function boundedUtf8Slice(
  content: Uint8Array,
  tokenLimit: number,
  estimateTokens: (text: string) => number,
): { bytes: Uint8Array; text: string } {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    throw new EvidenceRetrievalError('RANGE_UTF8_INVALID');
  }
  const codePoints = Array.from(text);
  let low = 1;
  let high = codePoints.length;
  let acceptedText = '';
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = codePoints.slice(0, middle).join('');
    if (estimateTokens(wrapUntrustedEvidence('range', candidate)) <= tokenLimit) {
      acceptedText = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (!acceptedText) throw new EvidenceRetrievalError('TOKEN_LIMIT_TOO_SMALL');
  return { bytes: new TextEncoder().encode(acceptedText), text: acceptedText };
}

export function trimIncompleteUtf8Suffix(content: Uint8Array): Uint8Array {
  for (let trimmed = 0; trimmed <= Math.min(3, content.byteLength - 1); trimmed += 1) {
    const candidate = content.subarray(0, content.byteLength - trimmed);
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(candidate);
      return candidate;
    } catch {
      // A valid UTF-8 stream can have at most three incomplete suffix bytes.
    }
  }
  throw new EvidenceRetrievalError('RANGE_UTF8_INVALID');
}

export function wrapUntrustedEvidence(evidenceId: string, content: string): string {
  return `<UNTRUSTED EVIDENCE id="${evidenceId}">\n${content}\n</UNTRUSTED EVIDENCE>`;
}

export function isValidEvidenceRange(
  startByte: number,
  endByte: number,
  byteCount: number,
): boolean {
  return Number.isSafeInteger(startByte)
    && Number.isSafeInteger(endByte)
    && startByte >= 0
    && endByte > startByte
    && endByte <= byteCount;
}

export function boundedEvidenceText(
  text: string,
  tokenLimit: number,
  estimateTokens: (value: string) => number,
): string {
  return boundedUtf8Slice(new TextEncoder().encode(text), tokenLimit, estimateTokens).text;
}
