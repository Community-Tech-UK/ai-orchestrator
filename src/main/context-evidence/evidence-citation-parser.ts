import type { EvidenceCitation } from '@contracts/types/context-evidence';

const MARKER_LIKE_PATTERN = /\[evidence:[^\]]*\]/g;
const CITATION_PATTERN = /^\[evidence:([^\]@]{1,128})@(\d+)-(\d+)#([a-f0-9]{64})\]$/;

export interface ParsedEvidenceCitations {
  citations: EvidenceCitation[];
  malformedMarkers: string[];
}

export function parseEvidenceCitations(text: string): ParsedEvidenceCitations {
  const citations: EvidenceCitation[] = [];
  const malformedMarkers: string[] = [];
  for (const marker of text.match(MARKER_LIKE_PATTERN) ?? []) {
    const match = CITATION_PATTERN.exec(marker);
    if (!match) {
      malformedMarkers.push(marker);
      continue;
    }
    const startByte = Number(match[2]);
    const endByte = Number(match[3]);
    if (
      !Number.isSafeInteger(startByte)
      || !Number.isSafeInteger(endByte)
      || startByte < 0
      || endByte <= startByte
    ) {
      malformedMarkers.push(marker);
      continue;
    }
    citations.push({
      evidenceId: match[1]!,
      startByte,
      endByte,
      contentDigest: match[4]!,
    });
  }
  return { citations, malformedMarkers };
}
