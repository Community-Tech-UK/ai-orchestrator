import { omittedSectionHeadings, formatOmittedSectionNames } from '../../context/system-prompt-sections';
import { escapeSystemInstructionDelimiter, wrapSystemInstructions } from './system-instruction-wrapper';

export interface AcpSystemPromptDelivery {
  block: string;
  originalChars: number;
  deliveredChars: number;
  truncated: boolean;
  omittedHeadings: string[];
}

/** Backstop only: normal budgeted prompts are delivered in full. */
export function buildAcpSystemPromptBlock(systemPrompt: string, maxChars = 96_000): AcpSystemPromptDelivery {
  if (!Number.isSafeInteger(maxChars) || maxChars < 256) throw new RangeError('ACP system prompt budget must be at least 256 characters.');
  const escaped = escapeSystemInstructionDelimiter(systemPrompt);
  if (escaped.length <= maxChars) {
    return { block: wrapSystemInstructions(systemPrompt), originalChars: systemPrompt.length,
      deliveredChars: systemPrompt.length, truncated: false, omittedHeadings: [] };
  }
  const tailChars = Math.min(6_000, Math.floor(maxChars / 3));
  // A fixed reservation keeps cuts deterministic and bounds metadata separately.
  const metadataBudget = Math.min(2_000, Math.floor(maxChars / 4));
  const headChars = maxChars - tailChars - metadataBudget - 58;
  const omittedHeadings = omittedSectionHeadings(escaped, headChars, escaped.length - tailChars);
  const names = formatOmittedSectionNames(omittedHeadings, metadataBudget);
  const marker = `\n[ACP first-message excerpt; omitted sections (JSON): ${names}]\n`;
  const finalHead = Math.min(headChars, maxChars - tailChars - marker.length);
  const excerpt = escaped.slice(0, finalHead) + marker + escaped.slice(-tailChars);
  return { block: wrapSystemInstructions(excerpt), originalChars: systemPrompt.length,
    deliveredChars: finalHead + tailChars, truncated: true, omittedHeadings };
}
