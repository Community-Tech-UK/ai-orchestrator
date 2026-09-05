import type { VerifyOutcomeLike } from './loop-coordinator-utils';

export interface LoopVerifyRun<T extends VerifyOutcomeLike = VerifyOutcomeLike> {
  quick: T;
  first: T;
  final: T;
  verifyLabel: string;
  resolverVerifyLabel: 'quick-verify' | 'verify' | 'second-verify';
  /** L2: the full verify was replayed from an identical working tree. */
  replayed?: boolean;
}

/**
 * L2 replay port. `lookup` answers "have we already graded this exact tree with
 * this exact command?"; `record` stores a settled red for the next claim.
 * Both are optional — an absent port means "always run", which is the safe
 * direction.
 */
export interface LoopVerifyReplayPort<T extends VerifyOutcomeLike> {
  lookup: () => T | null;
  record: (outcome: T) => void;
}

/**
 * Shared verify orchestration for gated, review-driven, and ping-pong
 * completion. Quick-verify short-circuits a failed cheap check; `runVerifyTwice`
 * re-runs a non-skipped first pass and the SECOND result wins — that is the
 * anti-flake contract, so a red first pass must still get its retry.
 *
 * L2 sits outside that cycle deliberately: the replay is consulted once, before
 * any run, and recorded once, after the cycle settles. Consulting it between
 * the two passes would turn the anti-flake retry into a cache read and defeat
 * the feature it exists for.
 */
export async function runLoopVerify<T extends VerifyOutcomeLike>(args: {
  runQuickVerify: () => Promise<T>;
  runVerify: () => Promise<T>;
  runVerifyTwice: boolean;
  replay?: LoopVerifyReplayPort<T>;
}): Promise<LoopVerifyRun<T>> {
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

  const replayed = args.replay?.lookup() ?? null;
  if (replayed) {
    return {
      quick,
      first: replayed,
      final: replayed,
      verifyLabel: 'verify',
      resolverVerifyLabel: 'verify',
      replayed: true,
    };
  }

  const first = await args.runVerify();
  if (first.status === 'skipped' || !args.runVerifyTwice) {
    args.replay?.record(first);
    return {
      quick,
      first,
      final: first,
      verifyLabel: 'verify',
      resolverVerifyLabel: 'verify',
    };
  }
  const second = await args.runVerify();
  args.replay?.record(second);
  return {
    quick,
    first,
    final: second,
    verifyLabel: 'verify',
    resolverVerifyLabel: second.status === 'failed' ? 'second-verify' : 'verify',
  };
}
