import { createHash } from 'node:crypto';
import type { AuxiliaryLlmDecision, AuxiliaryLlmSlot } from '../../shared/types/auxiliary-llm.types';
import { redactSecrets } from './context-compaction-prompt';
import { summarizeFileOperations, type FileOperation } from './file-operation-extractor';
import { getAuxiliaryLlmService } from '../rlm/auxiliary-llm-service';

export interface BranchSummaryInput {
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly transcriptExcerpt: string;
  readonly fileOperations: readonly FileOperation[];
}

export interface BranchSummary {
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly summary: string;
  readonly fileOperations: readonly FileOperation[];
  readonly createdAt: number;
}

export interface BranchSummarizerLike {
  summarize(input: BranchSummaryInput): Promise<BranchSummary>;
}

type AuxiliaryGenerate = (
  slot: AuxiliaryLlmSlot,
  systemPrompt: string,
  userPrompt: string
) => Promise<{
  text: string;
  decision: Pick<AuxiliaryLlmDecision, 'source'>;
}>;

export interface BranchSummarizerOptions {
  readonly auxiliaryGenerate?: AuxiliaryGenerate;
  readonly now?: () => number;
}

const BRANCH_SUMMARY_SYSTEM_PROMPT = [
  'You are a branch navigation summarizer.',
  'Summarize only the supplied source branch turns for use after switching to the destination branch.',
  'Preserve concrete decisions, file paths, and unresolved work. Do not invent context.',
].join(' ');

export class BranchSummarizer implements BranchSummarizerLike {
  private readonly now: () => number;

  constructor(private readonly options: BranchSummarizerOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  async summarize(input: BranchSummaryInput): Promise<BranchSummary> {
    const auxiliarySummary = await this.tryAuxiliarySummary(input);
    const summary = auxiliarySummary ?? buildLocalBranchSummary(input);
    return {
      fromNodeId: input.fromNodeId,
      toNodeId: input.toNodeId,
      summary: redactSecrets(summary),
      fileOperations: [...input.fileOperations],
      createdAt: this.now(),
    };
  }

  private async tryAuxiliarySummary(input: BranchSummaryInput): Promise<string | null> {
    if (!this.options.auxiliaryGenerate) {
      return null;
    }

    try {
      const result = await this.options.auxiliaryGenerate(
        'compression',
        BRANCH_SUMMARY_SYSTEM_PROMPT,
        buildAuxiliaryPrompt(input),
      );
      const text = result.text.trim();
      if (result.decision.source === 'fallback' || !text) {
        return null;
      }
      return text;
    } catch {
      return null;
    }
  }
}

export function createDefaultBranchSummarizer(): BranchSummarizer {
  return new BranchSummarizer({
    auxiliaryGenerate: (slot, systemPrompt, userPrompt) =>
      getAuxiliaryLlmService().generate(slot, systemPrompt, userPrompt),
  });
}

export function branchSummaryMetadataKey(fromNodeId: string, toNodeId: string): string {
  return `${fromNodeId}::${toNodeId}`;
}

export function branchSummaryEventId(
  fromNodeId: string,
  toNodeId: string,
  upToSequence: number
): string {
  const digest = createHash('sha256')
    .update(fromNodeId)
    .update('\0')
    .update(toNodeId)
    .digest('hex')
    .slice(0, 16);
  return `branch-summary:${digest}:${upToSequence}`;
}

export function buildBranchSummaryContextBlock(summary: BranchSummary): string {
  return [
    '<branch_switch_summary>',
    `from: ${summary.fromNodeId}`,
    `to: ${summary.toNodeId}`,
    `createdAt: ${summary.createdAt}`,
    '',
    summary.summary,
    '',
    '<file_operations_observed>',
    summarizeFileOperations(summary.fileOperations),
    '</file_operations_observed>',
    '</branch_switch_summary>',
  ].join('\n');
}

function buildAuxiliaryPrompt(input: BranchSummaryInput): string {
  return [
    `Source branch node: ${input.fromNodeId}`,
    `Destination branch node: ${input.toNodeId}`,
    '',
    'File operations observed:',
    summarizeFileOperations(input.fileOperations),
    '',
    'Transcript excerpt:',
    input.transcriptExcerpt,
  ].join('\n');
}

function buildLocalBranchSummary(input: BranchSummaryInput): string {
  return [
    '## Branch switch summary',
    `${input.fromNodeId} -> ${input.toNodeId}`,
    '',
    '## Recent branch transcript',
    input.transcriptExcerpt.trim() || '(no transcript content)',
    '',
    '## File Operations Observed',
    summarizeFileOperations(input.fileOperations),
  ].join('\n');
}
