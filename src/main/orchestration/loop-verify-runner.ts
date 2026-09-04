import type { VerifyOutcomeLike } from './loop-coordinator-utils';

export interface LoopVerifyRun {
  quick: VerifyOutcomeLike;
  first: VerifyOutcomeLike;
  final: VerifyOutcomeLike;
  verifyLabel: string;
  resolverVerifyLabel: 'quick-verify' | 'verify' | 'second-verify';
}

/**
 * Shared verify orchestration for gated, review-driven, and ping-pong
 * completion. Quick-verify short-circuits a failed cheap check; `runVerifyTwice`
 * only re-runs a non-skipped first pass.
 */
export async function runLoopVerify(args: {
  runQuickVerify: () => Promise<VerifyOutcomeLike>;
  runVerify: () => Promise<VerifyOutcomeLike>;
  runVerifyTwice: boolean;
}): Promise<LoopVerifyRun> {
  const quick = await args.runQuickVerify();
  if (quick.status === 'failed') {
    return {
      quick,
      first: quick,
      final: quick,
      verifyLabel: 'quick verify',
      resolverVerifyLabel: 'quick-verify',
    };
  }
  const first = await args.runVerify();
  if (first.status === 'skipped' || !args.runVerifyTwice) {
    return {
      quick,
      first,
      final: first,
      verifyLabel: 'verify',
      resolverVerifyLabel: 'verify',
    };
  }
  const second = await args.runVerify();
  return {
    quick,
    first,
    final: second,
    verifyLabel: 'verify',
    resolverVerifyLabel: second.status === 'failed' ? 'second-verify' : 'verify',
  };
}
