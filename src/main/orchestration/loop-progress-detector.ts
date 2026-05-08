/**
 * Loop Progress Detector
 *
 * Aggressive no-progress detection. Implements the eight signals described in
 * `plan_loop_mode.md` § A (Aggressive no-progress detection):
 *
 *   A — Identical work hash
 *   B — Edit churn (file content oscillation)
 *   C — Stage stagnation
 *   D — Test pass-count oscillation
 *   D' — Test stagnation with file writes
 *   E — Error bucket / exact-hash repeat
 *   F — Token burn without progress
 *   G — Tool-call repetition (within & across iterations)
 *   H — Output similarity
 *
 * Each signal is a pure function over (history, current, thresholds). The
 * exported `LoopProgressDetector.evaluate()` aggregates them, then applies
 * WARN→CRITICAL escalation if WARNs accumulate in a sliding window.
 *
 * The mantra: "you cannot ask an agent if it is in a loop; you must prove it
 * mathematically." Every signal here is structural / numeric, never a reading
 * of agent self-report.
 */

import type {
  LoopIteration,
  LoopProgressThresholds,
  LoopState,
  LoopVerdict,
  ProgressSignalEvidence,
  ProgressSignalId,
} from '../../shared/types/loop.types';

// ============ helpers ============

/** Combine OK/WARN/CRITICAL — CRITICAL wins, then WARN, else OK. */
function maxVerdict(a: LoopVerdict, b: LoopVerdict): LoopVerdict {
  if (a === 'CRITICAL' || b === 'CRITICAL') return 'CRITICAL';
  if (a === 'WARN' || b === 'WARN') return 'WARN';
  return 'OK';
}

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9_\s]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 0),
  );
}

function jaccard(a: string, b: string): number {
  const A = tokenize(a);
  const B = tokenize(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union > 0 ? inter / union : 0;
}

function meanPairwiseSimilarity(texts: string[]): number {
  if (texts.length < 2) return 0;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      sum += jaccard(texts[i], texts[j]);
      n++;
    }
  }
  return n > 0 ? sum / n : 0;
}

// ============ signal implementations ============

/**
 * Signal A — Identical work hash.
 * Workhash is sha256(sortedFileDiffPaths ‖ stage ‖ toolCallSignature). When
 * the same hash repeats, the agent is doing the same thing repeatedly.
 */
export function signalA_identicalWorkHash(
  history: LoopIteration[],
  current: LoopIteration,
  th: LoopProgressThresholds,
): ProgressSignalEvidence | null {
  const all = [...history, current];
  if (all.length < th.identicalHashWarnConsecutive) return null;

  // Count consecutive matches ending at current.
  let consecutive = 1;
  for (let i = all.length - 2; i >= 0; i--) {
    if (all[i].workHash === current.workHash) consecutive++;
    else break;
  }

  // Window match: how many of the last (window) iterations share current.workHash?
  const windowSize = Math.max(th.identicalHashCriticalWindow, 5);
  const window = all.slice(-windowSize);
  const windowMatches = window.filter((it) => it.workHash === current.workHash).length;

  if (
    consecutive >= th.identicalHashCriticalConsecutive ||
    windowMatches >= th.identicalHashCriticalWindow
  ) {
    return {
      id: 'A',
      verdict: 'CRITICAL',
      message: `Identical work hash repeated (${consecutive} consecutive, ${windowMatches} of last ${window.length})`,
      detail: { consecutive, windowMatches, windowSize: window.length },
    };
  }
  if (consecutive >= th.identicalHashWarnConsecutive) {
    return {
      id: 'A',
      verdict: 'WARN',
      message: `Identical work hash repeated ${consecutive}× consecutively`,
      detail: { consecutive, windowMatches, windowSize: window.length },
    };
  }
  return null;
}

/**
 * Signal B — Edit churn.
 * For each file edited in the last 5 iterations, look at the sequence of
 * content hashes. If any hash repeats with at least one different hash
 * between them (A→B→A), the file is oscillating. Any oscillating file =>
 * CRITICAL. Otherwise the *ratio* of oscillating to distinct files is the
 * churn ratio.
 */
export function signalB_editChurn(
  history: LoopIteration[],
  current: LoopIteration,
  th: LoopProgressThresholds,
): ProgressSignalEvidence | null {
  const window = [...history.slice(-4), current];
  if (window.length < 3) return null;

  const perFile = new Map<string, string[]>();
  for (const it of window) {
    for (const fc of it.filesChanged) {
      if (!perFile.has(fc.path)) perFile.set(fc.path, []);
      perFile.get(fc.path)!.push(fc.contentHash);
    }
  }

  if (perFile.size === 0) return null;

  const oscillatingFiles: string[] = [];
  for (const [path, hashes] of perFile) {
    if (hashes.length < 3) continue;
    // detect A→B→A: a hash that appears at index i and index j > i+1.
    const seen = new Map<string, number>();
    let oscillates = false;
    for (let i = 0; i < hashes.length; i++) {
      const h = hashes[i];
      if (seen.has(h) && i - seen.get(h)! >= 2) {
        oscillates = true;
        break;
      }
      seen.set(h, i);
    }
    if (oscillates) oscillatingFiles.push(path);
  }

  if (oscillatingFiles.length === 0) return null;

  const ratio = oscillatingFiles.length / perFile.size;

  // The plan says: "A→B→A line-content cycle on same file" → CRITICAL.
  // Honor that — even one oscillating file is enough.
  if (oscillatingFiles.length >= 1 && ratio >= th.churnRatioCritical) {
    return {
      id: 'B',
      verdict: 'CRITICAL',
      message: `${oscillatingFiles.length} files oscillating (ratio ${(ratio * 100).toFixed(0)}%)`,
      detail: { oscillatingFiles, ratio },
    };
  }
  // Even a single oscillating file is CRITICAL per spec; promote when the
  // ratio is high. With ratio < churnRatioCritical we still treat any
  // oscillation as CRITICAL when the same file flips A→B→A — that's the
  // spec's intent. Use ratio threshold only to grade WARN vs ignore.
  if (oscillatingFiles.length >= 1) {
    if (ratio >= th.churnRatioWarn) {
      return {
        id: 'B',
        verdict: 'CRITICAL',
        message: `File content oscillating (A→B→A) on ${oscillatingFiles.length} file(s)`,
        detail: { oscillatingFiles, ratio },
      };
    }
    return {
      id: 'B',
      verdict: 'WARN',
      message: `File content oscillating on ${oscillatingFiles.length} file(s) (low ratio)`,
      detail: { oscillatingFiles, ratio },
    };
  }
  return null;
}

/**
 * Signal C — Stage stagnation.
 * Iterations spent on the current STAGE.md value. Each stage has its own
 * thresholds because PLAN/REVIEW are short tasks while IMPLEMENT can take
 * many iterations legitimately.
 */
export function signalC_stageStagnation(
  state: LoopState,
  th: LoopProgressThresholds,
): ProgressSignalEvidence | null {
  const stage = state.currentStage;
  const count = state.iterationsOnCurrentStage;
  const warn = th.stageWarnIterations[stage];
  const crit = th.stageCriticalIterations[stage];
  if (count >= crit) {
    return {
      id: 'C',
      verdict: 'CRITICAL',
      message: `Stuck on ${stage} for ${count} iterations (>= critical ${crit})`,
      detail: { stage, count, criticalThreshold: crit },
    };
  }
  if (count >= warn) {
    return {
      id: 'C',
      verdict: 'WARN',
      message: `${count} iterations on ${stage} (>= warn ${warn})`,
      detail: { stage, count, warnThreshold: warn },
    };
  }
  return null;
}

/**
 * Signal D — Test pass-count oscillation.
 * Strict alternating sequence [N,M,N,M,N] with M≠N => CRITICAL.
 * High direction-change count (3+ flips in 4 deltas) => WARN.
 */
export function signalD_testOscillation(
  history: LoopIteration[],
  current: LoopIteration,
): ProgressSignalEvidence | null {
  const all = [...history, current];
  const counts = all
    .map((it) => it.testPassCount)
    .filter((c): c is number => c !== null && c !== undefined);
  if (counts.length < 5) return null;
  const last5 = counts.slice(-5);

  // Strict alternation
  if (
    last5[0] === last5[2] &&
    last5[1] === last5[3] &&
    last5[2] === last5[4] &&
    last5[0] !== last5[1]
  ) {
    return {
      id: 'D',
      verdict: 'CRITICAL',
      message: `Test pass count oscillating: ${last5.join(' → ')}`,
      detail: { last5 },
    };
  }

  // Direction-change count
  const last5Deltas = [last5[1] - last5[0], last5[2] - last5[1], last5[3] - last5[2], last5[4] - last5[3]];
  let flips = 0;
  for (let i = 1; i < last5Deltas.length; i++) {
    if (Math.sign(last5Deltas[i]) !== 0 && Math.sign(last5Deltas[i - 1]) !== 0 && Math.sign(last5Deltas[i]) !== Math.sign(last5Deltas[i - 1])) {
      flips++;
    }
  }
  if (flips >= 3) {
    return {
      id: 'D',
      verdict: 'WARN',
      message: `Test pass count noisy (${flips} direction changes in 4 deltas): ${last5.join(' → ')}`,
      detail: { last5, flips },
    };
  }

  return null;
}

/**
 * Signal D' — Test stagnation while files written.
 * If testPassCount has been unchanged for N iterations AND files were modified
 * in those iterations, work is happening but tests aren't responding.
 */
export function signalDPrime_testStagnationWithWrites(
  history: LoopIteration[],
  current: LoopIteration,
  th: LoopProgressThresholds,
): ProgressSignalEvidence | null {
  const all = [...history, current];
  // require pass count present & file writes throughout
  const tail = all.slice(-Math.max(th.testStagnationCriticalIterations, th.testStagnationWarnIterations));
  if (tail.length === 0) return null;

  // strip leading entries that have null counts
  let k = tail.length;
  for (let i = 0; i < tail.length; i++) {
    if (tail[i].testPassCount == null) {
      k = i;
      break;
    }
  }
  const usable = tail.slice(0, k > 0 ? k : tail.length);
  if (usable.length < th.testStagnationWarnIterations) return null;

  const first = usable[0].testPassCount;
  const allEqual = usable.every((it) => it.testPassCount === first);
  if (!allEqual) return null;

  const allWroteFiles = usable.every((it) => it.filesChanged.length > 0);
  if (!allWroteFiles) return null;

  if (usable.length >= th.testStagnationCriticalIterations) {
    return {
      id: 'D-prime',
      verdict: 'CRITICAL',
      message: `Tests unchanged at ${first} pass for ${usable.length} iterations despite file writes`,
      detail: { iterations: usable.length, passCount: first },
    };
  }
  if (usable.length >= th.testStagnationWarnIterations) {
    return {
      id: 'D-prime',
      verdict: 'WARN',
      message: `Tests unchanged at ${first} pass for ${usable.length} iterations despite file writes`,
      detail: { iterations: usable.length, passCount: first },
    };
  }
  return null;
}

/**
 * Signal E — Error repeat.
 * Same error bucket appearing 3+ times in last 5 iterations is WARN; 4+ is
 * CRITICAL. Same exact hash 3 in a row is CRITICAL.
 */
export function signalE_errorRepeat(
  history: LoopIteration[],
  current: LoopIteration,
  th: LoopProgressThresholds,
): ProgressSignalEvidence | null {
  const all = [...history, current];
  const window = all.slice(-5);
  if (window.length < th.errorRepeatWarnInWindow) return null;

  // bucket frequency in window
  const bucketCounts = new Map<string, number>();
  for (const it of window) {
    const buckets = new Set(it.errors.map((e) => e.bucket));
    for (const b of buckets) bucketCounts.set(b, (bucketCounts.get(b) ?? 0) + 1);
  }
  let topBucket = '';
  let topCount = 0;
  for (const [b, c] of bucketCounts) {
    if (c > topCount) {
      topBucket = b;
      topCount = c;
    }
  }

  // exact-hash consecutive
  const last3 = all.slice(-3);
  let exactRepeat = 0;
  if (last3.length === 3) {
    const exact = new Set<string>();
    for (let i = 0; i < last3.length; i++) {
      const hashes = new Set(last3[i].errors.map((e) => e.exactHash));
      if (i === 0) {
        for (const h of hashes) exact.add(h);
      } else {
        // intersect
        for (const h of [...exact]) if (!hashes.has(h)) exact.delete(h);
      }
    }
    if (exact.size > 0) {
      exactRepeat = 3;
    }
  }

  if (exactRepeat >= 3) {
    return {
      id: 'E',
      verdict: 'CRITICAL',
      message: `Same error appeared in 3 consecutive iterations`,
      detail: { exactRepeat },
    };
  }
  if (topCount >= th.errorRepeatCriticalInWindow) {
    return {
      id: 'E',
      verdict: 'CRITICAL',
      message: `Error bucket "${topBucket}" hit ${topCount}× in last ${window.length}`,
      detail: { topBucket, topCount, windowSize: window.length },
    };
  }
  if (topCount >= th.errorRepeatWarnInWindow) {
    return {
      id: 'E',
      verdict: 'WARN',
      message: `Error bucket "${topBucket}" hit ${topCount}× in last ${window.length}`,
      detail: { topBucket, topCount, windowSize: window.length },
    };
  }
  return null;
}

/**
 * Signal F — Token burn without progress.
 * Tracked in `state.tokensSinceLastTestImprovement` (incremented by the
 * coordinator and reset whenever the highest test-pass-count increases).
 * Also flag when 3 iterations in a row each spend > 10k tokens.
 */
export function signalF_tokenBurn(
  state: LoopState,
  history: LoopIteration[],
  current: LoopIteration,
  th: LoopProgressThresholds,
): ProgressSignalEvidence | null {
  const accumulated = state.tokensSinceLastTestImprovement;

  if (accumulated >= th.tokensWithoutProgressCritical) {
    return {
      id: 'F',
      verdict: 'CRITICAL',
      message: `${accumulated} tokens spent since last test improvement (>= critical ${th.tokensWithoutProgressCritical})`,
      detail: { accumulated, criticalThreshold: th.tokensWithoutProgressCritical },
    };
  }

  // Rate-based check: last 3 iterations each > 10k
  const last3 = [...history.slice(-2), current];
  if (last3.length === 3 && last3.every((it) => it.tokens > 10_000)) {
    return {
      id: 'F',
      verdict: 'CRITICAL',
      message: `Heavy token burn: 3 consecutive iterations each > 10k tokens`,
      detail: { tokens: last3.map((it) => it.tokens) },
    };
  }

  if (accumulated >= th.tokensWithoutProgressWarn) {
    return {
      id: 'F',
      verdict: 'WARN',
      message: `${accumulated} tokens spent since last test improvement`,
      detail: { accumulated, warnThreshold: th.tokensWithoutProgressWarn },
    };
  }

  return null;
}

/**
 * Signal G — Tool call repetition.
 * Within an iteration: count occurrences of (toolName,argsHash). Max repeat
 * count crosses thresholds.
 * Cross-iteration: same sorted set of (toolName,argsHash) across 3 iterations
 * → CRITICAL.
 */
export function signalG_toolRepetition(
  history: LoopIteration[],
  current: LoopIteration,
  th: LoopProgressThresholds,
): ProgressSignalEvidence | null {
  // within-iteration
  const counts = new Map<string, number>();
  for (const tc of current.toolCalls) {
    const key = `${tc.toolName}::${tc.argsHash}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let topKey = '';
  let topCount = 0;
  for (const [k, v] of counts) if (v > topCount) {
    topCount = v;
    topKey = k;
  }

  let verdict: LoopVerdict = 'OK';
  let detail: Record<string, unknown> = {};
  let message = '';

  if (topCount >= th.toolRepeatCriticalPerIteration) {
    verdict = 'CRITICAL';
    message = `Tool ${topKey.split('::')[0]} called ${topCount}× in one iteration`;
    detail = { topKey, topCount };
  } else if (topCount >= th.toolRepeatWarnPerIteration) {
    verdict = 'WARN';
    message = `Tool ${topKey.split('::')[0]} called ${topCount}× in one iteration`;
    detail = { topKey, topCount };
  }

  // cross-iteration: same set across last 3
  const last3 = [...history.slice(-2), current];
  if (last3.length === 3) {
    const sigs = last3.map((it) =>
      [...new Set(it.toolCalls.map((tc) => `${tc.toolName}::${tc.argsHash}`))]
        .sort()
        .join('|'),
    );
    if (sigs.every((s) => s === sigs[0]) && sigs[0].length > 0) {
      verdict = 'CRITICAL';
      message = `Same tool-call set repeated in last 3 iterations`;
      detail = { ...detail, signatureSizes: sigs.map((s) => s.split('|').length) };
    }
  }

  if (verdict === 'OK') return null;
  return { id: 'G', verdict, message, detail };
}

/**
 * Signal H — Output similarity.
 * Mean Jaccard over pairwise comparisons of the last 3 iteration output
 * excerpts. ≥ 0.85 WARN, ≥ 0.92 CRITICAL.
 */
export function signalH_outputSimilarity(
  history: LoopIteration[],
  current: LoopIteration,
  th: LoopProgressThresholds,
): ProgressSignalEvidence | null {
  const last3 = [...history.slice(-2), current];
  if (last3.length < 3) return null;
  const texts = last3.map((it) => it.outputExcerpt);
  if (texts.some((t) => !t || t.length < 20)) return null;
  const mean = meanPairwiseSimilarity(texts);
  if (mean >= th.similarityCriticalMean) {
    return {
      id: 'H',
      verdict: 'CRITICAL',
      message: `Output similarity mean ${mean.toFixed(2)} across last 3 (>= critical ${th.similarityCriticalMean})`,
      detail: { mean, sampleCount: 3 },
    };
  }
  if (mean >= th.similarityWarnMean) {
    return {
      id: 'H',
      verdict: 'WARN',
      message: `Output similarity mean ${mean.toFixed(2)} across last 3`,
      detail: { mean, sampleCount: 3 },
    };
  }
  return null;
}

// ============ aggregator ============

export interface LoopProgressEvaluation {
  verdict: LoopVerdict;
  signals: ProgressSignalEvidence[];
  /**
   * The signal that "caused" the CRITICAL verdict (highest-priority CRITICAL),
   * or undefined if not CRITICAL.
   */
  primary?: ProgressSignalEvidence;
}

/** Order by signal severity then by ID priority. */
const SIGNAL_PRIORITY: ProgressSignalId[] = ['A', 'B', 'D', 'D-prime', 'E', 'C', 'F', 'G', 'H'];

export class LoopProgressDetector {
  /**
   * Evaluate a freshly-completed iteration and return progress verdict +
   * fired signals + primary cause (if CRITICAL).
   */
  evaluate(
    state: LoopState,
    history: LoopIteration[],
    current: LoopIteration,
  ): LoopProgressEvaluation {
    const th = state.config.progressThresholds;
    const candidates: (ProgressSignalEvidence | null)[] = [
      signalA_identicalWorkHash(history, current, th),
      signalB_editChurn(history, current, th),
      signalC_stageStagnation(state, th),
      signalD_testOscillation(history, current),
      signalDPrime_testStagnationWithWrites(history, current, th),
      signalE_errorRepeat(history, current, th),
      signalF_tokenBurn(state, history, current, th),
      signalG_toolRepetition(history, current, th),
      signalH_outputSimilarity(history, current, th),
    ];
    const signals: ProgressSignalEvidence[] = candidates.filter(
      (s): s is ProgressSignalEvidence => s !== null,
    );

    let verdict: LoopVerdict = 'OK';
    for (const s of signals) verdict = maxVerdict(verdict, s.verdict);

    // WARN escalation: count WARN iterations in trailing window. We treat the
    // *current* iteration as WARN-emitting if any signal is WARN (and not
    // already CRITICAL).
    if (verdict === 'WARN') {
      const recent = state.recentWarnIterationSeqs.filter(
        (seq) => current.seq - seq < th.warnEscalationWindow,
      );
      // Include current iteration in count
      const countWithCurrent = recent.length + 1;
      if (countWithCurrent >= th.warnEscalationCount) {
        verdict = 'CRITICAL';
        signals.push({
          id: 'A',
          verdict: 'CRITICAL',
          message: `${countWithCurrent} WARN iterations in last ${th.warnEscalationWindow} — escalated to CRITICAL`,
          detail: { recentWarnSeqs: [...recent, current.seq], window: th.warnEscalationWindow },
        });
      }
    }

    const critical = signals.filter((s) => s.verdict === 'CRITICAL');
    let primary: ProgressSignalEvidence | undefined;
    if (critical.length > 0) {
      // Pick by priority order
      for (const id of SIGNAL_PRIORITY) {
        const found = critical.find((s) => s.id === id);
        if (found) {
          primary = found;
          break;
        }
      }
      if (!primary) primary = critical[0];
    }

    return { verdict, signals, primary };
  }

  /**
   * Pre-iteration kill switch. If the previous N iterations already crossed
   * critical thresholds, refuse to spawn another iteration. Returns the
   * blocking signal or null if it's safe to proceed.
   */
  shouldRefuseToSpawnNext(
    state: LoopState,
    history: LoopIteration[],
  ): ProgressSignalEvidence | null {
    if (history.length < 2) return null;
    const last = history[history.length - 1];
    // Re-run signals A, B, D, D', H against the trailing iterations alone —
    // these are the "looped without progress" signals. C/F are already
    // evaluated as part of state and would have paused the loop already.
    const th = state.config.progressThresholds;
    const candidates: (ProgressSignalEvidence | null)[] = [
      signalA_identicalWorkHash(history.slice(0, -1), last, th),
      signalB_editChurn(history.slice(0, -1), last, th),
      signalD_testOscillation(history.slice(0, -1), last),
      signalDPrime_testStagnationWithWrites(history.slice(0, -1), last, th),
      signalH_outputSimilarity(history.slice(0, -1), last, th),
    ];
    for (const s of candidates) if (s && s.verdict === 'CRITICAL') return s;
    return null;
  }
}
