/**
 * D4 (#28) — self-correcting output-envelope re-wrap.
 *
 * When an iteration's output *tries* to declare completion but the marker is
 * malformed for our parsers (a near-miss `<promise>DONE</promise>`, an
 * unclosed tag, a paraphrased promise), the loop would previously just keep
 * iterating with the agent believing it had signalled done. Instead: detect
 * the near-miss and push a ONE-SHOT correction telling the agent to re-emit
 * the marker in the required form, so the next iteration can stop cleanly.
 * Bounded per run so a chronically confused agent cannot ping-pong forever.
 */

export interface MalformedEnvelopeDetection {
  malformed: boolean;
  /** The near-miss text that triggered the detection (for the correction). */
  excerpt?: string;
}

/**
 * Near-miss patterns: things that read as a completion promise but do NOT
 * match the configured done-promise regex. Deliberately conservative — plain
 * prose like "when done" or "I promise" must not trigger.
 */
const NEAR_MISS_PATTERNS: readonly RegExp[] = [
  /<promise>(?![\s\S]*?<\/promise>)[^\n<]{0,40}/i, // unclosed <promise> tag
  /<\s*promise\s+done\s*\/?\s*>/i,                 // <promise done/> style
  /\bpromise\s*[:=]\s*done\b/i,                    // promise: DONE
  /<\/?promsie>|<\/?promis>/i,                     // common misspellings
];

export function detectMalformedCompletionEnvelope(
  output: string,
  donePromiseRegexSource: string,
): MalformedEnvelopeDetection {
  if (!output) return { malformed: false };

  // A well-formed marker means nothing to correct (whether or not the signal
  // fired for other reasons).
  try {
    if (new RegExp(donePromiseRegexSource, 'i').test(output)) {
      return { malformed: false };
    }
  } catch {
    // Invalid configured regex — the detector already warns; nothing to do.
    return { malformed: false };
  }

  for (const pattern of NEAR_MISS_PATTERNS) {
    const match = output.match(pattern);
    if (match) {
      return { malformed: true, excerpt: match[0].slice(0, 120) };
    }
  }
  return { malformed: false };
}

/** The one-shot correction pushed as a pending input after a near-miss. */
export function buildEnvelopeRewrapCorrection(excerpt: string): string {
  return (
    `Your completion marker was malformed and could not be parsed ` +
    `(saw: "${excerpt}"). If the work is genuinely complete, re-emit the ` +
    `marker in the EXACT required form — \`<promise>DONE</promise>\` on its ` +
    `own line at the end of your output, after the durable completion ` +
    `artifacts exist. If the work is NOT complete, continue working and do ` +
    `not emit any completion marker.`
  );
}
