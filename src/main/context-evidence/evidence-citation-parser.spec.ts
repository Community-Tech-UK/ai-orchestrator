import { describe, expect, it } from 'vitest';
import { parseEvidenceCitations } from './evidence-citation-parser';

describe('parseEvidenceCitations', () => {
  it('parses exact citation markers with UTF-8 byte ranges', () => {
    const digest = 'a'.repeat(64);
    expect(parseEvidenceCitations(`Claim [evidence:ev-1@2-9#${digest}].`)).toEqual({
      citations: [{ evidenceId: 'ev-1', startByte: 2, endByte: 9, contentDigest: digest }],
      malformedMarkers: [],
    });
  });

  it.each([
    '[evidence:ev-1@9-2#' + 'a'.repeat(64) + ']',
    '[evidence:ev-1@0-2#short]',
    '[evidence:@0-2#' + 'a'.repeat(64) + ']',
  ])('reports marker-like malformed input without accepting it: %s', (marker) => {
    const parsed = parseEvidenceCitations(marker);
    expect(parsed.citations).toEqual([]);
    expect(parsed.malformedMarkers).toEqual([marker]);
  });
});
