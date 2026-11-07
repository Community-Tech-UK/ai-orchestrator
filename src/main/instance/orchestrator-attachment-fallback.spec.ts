import { describe, expect, it } from 'vitest';
import { buildUnsupportedAttachmentWarnings, isUnsupportedOrchestratorAttachmentError } from './orchestrator-attachment-fallback';

describe('unsupported attachment wording', () => {
  it('names omitted image and file counts with the right plural', () => {
    const warnings = buildUnsupportedAttachmentWarnings('Example agent', [
      { name: 'image.png', type: 'image/png', size: 0, data: '' },
      { name: 'first.txt', type: 'text/plain', size: 0, data: '' },
      { name: 'second.txt', type: 'text/plain', size: 0, data: '' },
    ]);
    expect(warnings.map(warning => warning.content)).toEqual([
      "Example agent can't take image attachments, so 1 image was left out.",
      "Example agent can't take file attachments, so 2 files were left out.",
    ]);
  });
  it('leaves the internal unsupported-attachment signal intact', () => {
    expect(isUnsupportedOrchestratorAttachmentError(new Error('Example agent does not currently support attachments in orchestrator mode'))).toBe(true);
    expect(isUnsupportedOrchestratorAttachmentError(new Error('Something else failed'))).toBe(false);
    expect(buildUnsupportedAttachmentWarnings('Example agent', [])).toEqual([]);
  });
});
