import { describe, expect, it } from 'vitest';

import {
  findTrailingProviderRefusal,
  findTrailingTransportFailure,
  isTransportFailureOnlyOutput,
  MAX_REFUSAL_DETAIL_WORDS,
  MAX_TRANSPORT_FAILURE_TAIL_CHARS,
} from './transport-failure';

/**
 * The four transport-failure variants observed from `cursor-agent` between
 * 2026-09-01 and 2026-09-03 (34 events across 8 instances), verbatim.
 */
const OBSERVED_FAILURES = [
  'Error: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)',
  'Error: RetriableError: [unavailable] PING timed out',
  'Error: RetriableError: [internal] read EHOSTUNREACH',
  'Error: RetriableError: [unavailable] getaddrinfo ENOTFOUND agentn.global.api5.cursor.sh',
];

/** Abridged shape of the real 36-minute turn that ended on CANCEL (0x8). */
const REAL_TURN_PREFIX =
  'The stuck card is asking for a hint instead of recovering on its own. '
  + "I'll trace how stuck detection and recovery are wired so we can see whether "
  + 'auto-unstick is missing or just not firing. The card is hint-first by design. '
  + 'Next I’ll run the project gates and confirm the coordinator stayed inside its '
  + 'line-count ceiling. Those two failures are on signal A (same work hash).';

describe('findTrailingTransportFailure', () => {
  it('finds each observed failure appended to a long, productive turn', () => {
    for (const failure of OBSERVED_FAILURES) {
      const output = `${REAL_TURN_PREFIX}\n\n${failure}`;
      expect(findTrailingTransportFailure(output), failure).toBe(failure);
    }
  });

  it('finds a failure that is the entire output', () => {
    for (const failure of OBSERVED_FAILURES) {
      expect(findTrailingTransportFailure(failure), failure).toBe(failure);
    }
  });

  it('ignores trailing whitespace after the failure', () => {
    const failure = OBSERVED_FAILURES[0];
    expect(findTrailingTransportFailure(`${REAL_TURN_PREFIX}\n\n${failure}\n\n  `)).toBe(failure);
  });

  it('returns null for a turn that ended normally', () => {
    expect(findTrailingTransportFailure(`${REAL_TURN_PREFIX}\n\nAll gates are green.`)).toBeNull();
    expect(findTrailingTransportFailure('')).toBeNull();
    expect(findTrailingTransportFailure('   \n  ')).toBeNull();
    expect(findTrailingTransportFailure(null)).toBeNull();
    expect(findTrailingTransportFailure(undefined)).toBeNull();
  });

  it('ignores a transport error the model recovered from mid-turn', () => {
    const output = [
      'Error: RetriableError: [unavailable] PING timed out',
      '',
      'That was a blip — retried and the request went through. Tests pass.',
    ].join('\n');
    expect(findTrailingTransportFailure(output)).toBeNull();
  });

  it('does not match prose that merely discusses a network error', () => {
    const cases = [
      `${REAL_TURN_PREFIX}\n\nI fixed the ECONNREFUSED retry path in the adapter.`,
      `${REAL_TURN_PREFIX}\n\nThe getaddrinfo failure was a stale DNS cache, now cleared.`,
      // Error-shaped, but nothing transport-layer about it.
      `${REAL_TURN_PREFIX}\n\nError: expected 3 arguments but received 2.`,
    ];
    for (const output of cases) {
      expect(findTrailingTransportFailure(output), output.slice(-60)).toBeNull();
    }
  });

  it('does not match a closing line that opens like an error AND names an errno', () => {
    // This is the dangerous shape: a completed turn summarising networking work
    // it just finished. It clears ERROR_OPENING and a transport pattern, so only
    // the raw-error-token requirement keeps it out. Flagging it would put a
    // "your reply was cut off" banner on a turn that ended perfectly normally.
    const cases = [
      'Error: the previous handling of ECONNRESET caused silent data loss during retries.',
      'Error: connection reset was being swallowed by the retry wrapper, now rethrown.',
      'Failed to connect was the wrong message here — ETIMEDOUT is the accurate one.',
    ];
    for (const tail of cases) {
      expect(findTrailingTransportFailure(`${REAL_TURN_PREFIX}\n\n${tail}`), tail).toBeNull();
    }
  });

  it('accepts a serialized status chain', () => {
    const withTag = 'Error: [unavailable] connection reset by peer';
    expect(findTrailingTransportFailure(`${REAL_TURN_PREFIX}\n\n${withTag}`)).toBe(withTag);
  });

  it('requires a status tag, so an error-class label alone is not enough', () => {
    // A documented recall gap. An error class in label position is exactly how
    // a developer writes ABOUT an error class, so it cannot carry the weight of
    // "this is machine output". No observed failure lacks a status tag.
    const cases = [
      'Error: TransportError: connection reset by peer',
      'Error: RetriableError: socket hang up',
      'Error: RetriableError: read ECONNRESET',
    ];
    for (const tail of cases) {
      expect(findTrailingTransportFailure(`${REAL_TURN_PREFIX}\n\n${tail}`), tail).toBeNull();
    }
  });

  it('rejects a technical note that keeps describing after the evidence', () => {
    // The round-6 defeat: no narrative deny-list word anywhere, a real status
    // tag, real errnos — but the line goes on in English, which a serialized
    // error never does. A deny-list cannot close this class; requiring the
    // detail to stop at its evidence can.
    const cases = [
      'Error: [internal] ECONNRESET, EPIPE, ETIMEDOUT observed in logs',
      'Error: [internal] ECONNRESET observed during final health check sweep',
      'Error: [unavailable] ETIMEDOUT seen repeatedly across every worker node',
    ];
    for (const tail of cases) {
      expect(findTrailingTransportFailure(`${REAL_TURN_PREFIX}\n\n${tail}`), tail).toBeNull();
    }
  });

  it('counts a sentence-final word instead of mistaking it for a hostname', () => {
    // The round-7 defeat: `restart.` survived punctuation stripping with its
    // full stop, matched the dotted-token exemption meant for hostnames, and
    // bought the sentence a free word. All of these are ordinary closing
    // remarks on turns that finished.
    const cases = [
      'Error: [internal] ECONNRESET during nightly restart.',
      'Error: [internal] ECONNRESET logged during rollout.',
      'Error: RetriableError: [unavailable] socket hang up noted post-deploy.',
      'Error: [internal] EPIPE detected overnight.',
    ];
    for (const tail of cases) {
      expect(findTrailingTransportFailure(`${REAL_TURN_PREFIX}\n\n${tail}`), tail).toBeNull();
    }
  });

  it('counts joined words separately, whatever the joiner', () => {
    // Any joining character merges a whole prose phrase into one token, which
    // would otherwise ride under the budget with no bound on word count. The
    // unicode dashes matter because the punctuation strip is ASCII-only and
    // would DELETE them, merging the words rather than separating them.
    const cases = [
      'Error: [internal] ECONNRESET logged-during-rollout',
      'Error: [unavailable] socket hang up noted-post-deploy',
      'Error: [internal] ECONNRESET logged_during_rollout',
      'Error: [internal] ECONNRESET logged\u2013during\u2013rollout',
      'Error: [internal] ECONNRESET logged\u2014during\u2014rollout',
    ];
    for (const tail of cases) {
      expect(findTrailingTransportFailure(`${REAL_TURN_PREFIX}\n\n${tail}`), tail).toBeNull();
    }
  });

  it('keeps hyphenated hostnames exempt', () => {
    // The hyphen split must not break a real host: the dotted test runs first.
    const tail =
      'Error: RetriableError: [unavailable] getaddrinfo ENOTFOUND edge-node.api5.cursor.sh';
    expect(findTrailingTransportFailure(`${REAL_TURN_PREFIX}\n\n${tail}`)).toBe(tail);
  });

  it('misses a host whose name contains a narrative word', () => {
    // Documented consequence of the veto: `my` in `my-host` reads as narration.
    // A miss, never a false alarm — the safe direction, but real.
    const tail = 'Error: RetriableError: [unavailable] getaddrinfo ENOTFOUND my-host.internal';
    expect(findTrailingTransportFailure(`${REAL_TURN_PREFIX}\n\n${tail}`)).toBeNull();
  });

  it('allows the short fixed idioms a serializer does emit', () => {
    // `by peer` trails the evidence but is part of the error string itself, so
    // the trailing-word bound has to admit it.
    const cases = [
      'Error: [unavailable] connection reset by peer',
      'Error: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)',
      'Error: RetriableError: [unavailable] getaddrinfo ENOTFOUND agentn.global.api5.cursor.sh',
    ];
    for (const tail of cases) {
      expect(findTrailingTransportFailure(`${REAL_TURN_PREFIX}\n\n${tail}`), tail).toBe(tail);
    }
  });

  it('rejects two-clause prose that pairs an error label with a network phrase', () => {
    // The round-5 defeat: both signals are genuinely present, in separate
    // clauses, describing work that COMPLETED. Every one of these is a
    // plausible closing line for a session working on this very file.
    const cases = [
      'Error: RetriableError: fixed the connection reset detection bug.',
      'Error: RetriableError: the getaddrinfo cache invalidation fix landed and tests are green.',
      'Error: ReferenceError: the cache handling caused the connection reset issue when offline; now fixed.',
      'Error: TypeError: the mock\'s fetch failed silently until now.',
      'Error: SocketError: socket hang up warnings are now suppressed in CI logs.',
      // Same shape, but WITH a status tag — the narrative veto has to catch it.
      'Error: [internal] connection reset handling was fixed.',
      'Error: [canceled] the socket hang up path is now guarded.',
    ];
    for (const tail of cases) {
      expect(findTrailingTransportFailure(`${REAL_TURN_PREFIX}\n\n${tail}`), tail).toBeNull();
    }
  });

  it('is not fooled by a second occurrence of an overlapping marker', () => {
    // Every one of these is a plausible closing line for a turn that FINISHED.
    // Each defeated an earlier version of the detector: a repeated class name,
    // a second bracket tag, and a status tag that is simultaneously a raw-error
    // token. They all rely on one substring being allowed to prove both "this
    // is a serialized error" and "this is transport-related".
    const cases = [
      'Error: RetriableError: fixed the RetriableError bug.',
      'Error: [foo] [canceled] happened during rename.',
      'Error: RetriableError: [canceled] flag was renamed for clarity.',
      'Error: [unavailable]: renamed to [canceled] throughout.',
    ];
    for (const tail of cases) {
      expect(findTrailingTransportFailure(`${REAL_TURN_PREFIX}\n\n${tail}`), tail).toBeNull();
    }
  });

  it('does not invent evidence by joining fragments across a removed token', () => {
    // Blanking a token must not splice "connection" onto "reset by peer" and
    // manufacture the phrase pattern out of text the CLI never wrote.
    const tail = 'Error: connection[canceled]reset by peer was the old spelling.';
    expect(findTrailingTransportFailure(`${REAL_TURN_PREFIX}\n\n${tail}`)).toBeNull();
  });

  it('does not treat a status tag alone as transport evidence', () => {
    // A tag is itself a raw-error token, so letting it corroborate the line is
    // what let `[canceled]` satisfy both gates. A known, deliberate recall gap:
    // all four real failures carry an errno, syscall or phrase as well.
    const tail = 'Error: RetriableError: [unavailable] something new we have not seen';
    expect(findTrailingTransportFailure(`${REAL_TURN_PREFIX}\n\n${tail}`)).toBeNull();
  });

  it('requires transport evidence beyond the error class label itself', () => {
    // `RetriableError` is both a raw error class AND a TRANSPORT_FAILURE_PATTERN.
    // If one substring were allowed to satisfy both gates, every one of these —
    // a correctly finished turn — would get a "your reply was cut off" banner.
    const cases = [
      'Error: RetriableError: fixed a bug unrelated to networking, this closes the ticket cleanly.',
      'Error: RetriableError: renamed to ProviderError across the adapter layer.',
      'Error: TransportException: removed, it was dead code.',
    ];
    for (const tail of cases) {
      expect(findTrailingTransportFailure(`${REAL_TURN_PREFIX}\n\n${tail}`), tail).toBeNull();
    }
  });

  it('does not accept a structural marker as network evidence', () => {
    // Error-class names say "something failed", not "the network is why". If
    // TRANSPORT_EVIDENCE_PATTERNS were not disjoint from
    // STRUCTURAL_FAILURE_MARKERS, listing class names after a tag would read as
    // an outage.
    const cases = [
      'Error: [internal] RetriableError, ProviderError, TimeoutError',
      'Error: [internal] RetriableError',
    ];
    for (const tail of cases) {
      expect(findTrailingTransportFailure(`${REAL_TURN_PREFIX}\n\n${tail}`), tail).toBeNull();
    }
  });

  it('matches evidence of every kind when it follows a status tag', () => {
    const cases = [
      'Error: RetriableError: [internal] read ECONNRESET',
      'Error: RetriableError: [unavailable] socket hang up',
      'Error: RetriableError: [internal] TLS handshake failure',
    ];
    for (const tail of cases) {
      expect(findTrailingTransportFailure(`${REAL_TURN_PREFIX}\n\n${tail}`), tail).toBe(tail);
    }
  });

  it('does not match prose naming the very error class this feature detects', () => {
    // `RetriableError` is itself a TRANSPORT_FAILURE_PATTERN, so accepting a
    // bare class name as the raw-error token would let one word satisfy both
    // tests — and a turn describing work on this feature would be flagged as
    // an outage. Only a class in label position (`RetriableError:`) counts.
    const cases = [
      'Error: RetriableError handling was missing a backoff, fixed.',
      'Error: RetriableError retries now succeed after adding a backoff.',
      'Error: TransportException was never thrown on the reconnect path.',
    ];
    for (const tail of cases) {
      expect(findTrailingTransportFailure(`${REAL_TURN_PREFIX}\n\n${tail}`), tail).toBeNull();
    }
  });

  it('rejects a final line too long to be a bare transport error', () => {
    const padded = `Error: RetriableError: ${'x'.repeat(MAX_TRANSPORT_FAILURE_TAIL_CHARS)}`;
    expect(findTrailingTransportFailure(`${REAL_TURN_PREFIX}\n\n${padded}`)).toBeNull();
  });
});

describe('isTransportFailureOnlyOutput vs findTrailingTransportFailure', () => {
  it('separates a whole-output outage from a truncated real turn', () => {
    const failure = OBSERVED_FAILURES[0];
    const truncatedRealTurn = `${REAL_TURN_PREFIX}\n\n${failure}`;

    // Whole-output detector: catches the bare outage, not the productive turn.
    expect(isTransportFailureOnlyOutput(failure)).toBe(true);
    expect(isTransportFailureOnlyOutput(truncatedRealTurn)).toBe(false);

    // Trailing detector: catches both.
    expect(findTrailingTransportFailure(failure)).toBe(failure);
    expect(findTrailingTransportFailure(truncatedRealTurn)).toBe(failure);
  });

  it('recognises the newly-added observed markers as whole-output failures', () => {
    for (const failure of OBSERVED_FAILURES) {
      expect(isTransportFailureOnlyOutput(failure), failure).toBe(true);
    }
  });
});

describe('findTrailingProviderRefusal', () => {
  /**
   * Verbatim from instance `uk95fj93z` (cursor/grok-4.6-high-fast, 2026-09-03).
   * A 73.9-minute turn with 1411 tool calls ended on this line, reported
   * `stopReason: 'end_turn'`, and was recorded as a clean `busy → idle`. The
   * detail after the status tag is the single word `Error` — the CLI serialized
   * the status with no message — which is why the transport detector cannot see
   * it and this one has to key on the status code.
   */
  const OBSERVED_REFUSAL = 'Error: RetriableError: [resource_exhausted] Error';

  it('finds the observed refusal appended to a long, productive turn', () => {
    expect(findTrailingProviderRefusal(`${REAL_TURN_PREFIX}\n\n${OBSERVED_REFUSAL}`))
      .toBe(OBSERVED_REFUSAL);
  });

  it('finds a refusal that is the entire output', () => {
    expect(findTrailingProviderRefusal(OBSERVED_REFUSAL)).toBe(OBSERVED_REFUSAL);
  });

  it('admits a refusal that carries a terse reason', () => {
    // Not captured, but inside the word budget on purpose: a serializer that
    // does fill in a message writes a noun phrase, not a sentence.
    const tail = 'Error: RetriableError: [resource_exhausted] quota exceeded';
    expect(findTrailingProviderRefusal(`${REAL_TURN_PREFIX}\n\n${tail}`)).toBe(tail);
  });

  it('rejects prose about a refusal', () => {
    // Every one of these is a plausible closing line for a turn that FINISHED
    // while working on this very file.
    const cases = [
      'Error: RetriableError: [resource_exhausted] was fixed by raising the cap.',
      'Error: RetriableError: [resource_exhausted] is now parked and resumed.',
      'Error: RetriableError: resource_exhausted handling now retries once.',
      'The provider returned [resource_exhausted] so I added a detector.',
    ];
    for (const tail of cases) {
      expect(findTrailingProviderRefusal(`${REAL_TURN_PREFIX}\n\n${tail}`), tail).toBeNull();
    }
  });

  it('rejects a detail longer than the word budget', () => {
    const words = Array.from({ length: MAX_REFUSAL_DETAIL_WORDS + 1 }, () => 'reason').join(' ');
    const tail = `Error: RetriableError: [resource_exhausted] ${words}`;
    expect(findTrailingProviderRefusal(`${REAL_TURN_PREFIX}\n\n${tail}`)).toBeNull();
  });

  it('does not fire on statuses outside the captured allowlist', () => {
    // Admitting these would resurrect the false positives the transport
    // detector spent five review rounds learning to reject.
    const cases = [
      'Error: [foo] [canceled] happened during rename.',
      'Error: [internal] RetriableError',
      'Error: RetriableError: [deadline_exceeded] Error',
    ];
    for (const tail of cases) {
      expect(findTrailingProviderRefusal(`${REAL_TURN_PREFIX}\n\n${tail}`), tail).toBeNull();
    }
  });

  it('inherits the guards the transport detector earned', () => {
    expect(findTrailingProviderRefusal('')).toBeNull();
    expect(findTrailingProviderRefusal(null)).toBeNull();
    expect(findTrailingProviderRefusal(undefined)).toBeNull();
    // Not the final line: the model kept going, so the turn was not truncated.
    expect(
      findTrailingProviderRefusal(`${OBSERVED_REFUSAL}\n\nRetried and it went through.`),
    ).toBeNull();
    // No error-shaped opening.
    expect(
      findTrailingProviderRefusal(`${REAL_TURN_PREFIX}\n\nDone: [resource_exhausted] Error`),
    ).toBeNull();
    // Over the tail length ceiling.
    const padded = `Error: RetriableError: [resource_exhausted] ${'x'.repeat(MAX_TRANSPORT_FAILURE_TAIL_CHARS)}`;
    expect(findTrailingProviderRefusal(`${REAL_TURN_PREFIX}\n\n${padded}`)).toBeNull();
  });

  it('stays disjoint from the transport detector', () => {
    // The split is the point: a refusal has no transport evidence to find, and
    // a severed stream is not an allowlisted refusal code.
    expect(findTrailingTransportFailure(`${REAL_TURN_PREFIX}\n\n${OBSERVED_REFUSAL}`)).toBeNull();
    for (const failure of OBSERVED_FAILURES) {
      expect(findTrailingProviderRefusal(`${REAL_TURN_PREFIX}\n\n${failure}`), failure).toBeNull();
    }
  });

  it('is still caught by the whole-output detector when nothing else happened', () => {
    // The loop coordinator's path was already covered — a refusal on its own
    // carries the `RetriableError` structural marker — and must stay that way.
    expect(isTransportFailureOnlyOutput(OBSERVED_REFUSAL)).toBe(true);
  });
});
