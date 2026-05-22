import { createHash } from 'crypto';
import type { LoopFileChange, LoopStage, LoopToolCallRecord } from '../../shared/types/loop.types';

/**
 * Compute the work hash for an iteration.
 *
 * sha256( sortedFileDiffPaths ‖ stage ‖ uniqueToolCallSig )
 *
 * This is the structural fingerprint of "what the iteration did" — same
 * fingerprint repeating means the agent is doing the same thing.
 */
export function computeWorkHash(args: {
  stage: LoopStage;
  filesChanged: LoopFileChange[];
  toolCalls: LoopToolCallRecord[];
}): string {
  const sortedFiles = [...args.filesChanged]
    .map((f) => `${f.path}::${f.contentHash}`)
    .sort()
    .join('|');
  const toolSig = [...new Set(args.toolCalls.map((tc) => `${tc.toolName}::${tc.argsHash}`))]
    .sort()
    .join('|');
  return createHash('sha256')
    .update(args.stage)
    .update('\0')
    .update(sortedFiles)
    .update('\0')
    .update(toolSig)
    .digest('hex');
}
