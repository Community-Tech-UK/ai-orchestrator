# Token accounting improvements for AI Orchestrator

## Why the current implementation feels broken

- The shared token counter is better than most of the sibling projects, but the feedback loop is disconnected: `TokenCounter.calibrate()` exists in `src/main/rlm/token-counter.ts` and is never called anywhere else.
- The provider usage normalizer in `src/shared/util/usage-normalization.ts` is also not wired into live callers, so the codebase is not consistently using normalized provider truth.
- Large parts of the app still bypass the shared counter and fall back to local `chars / 4` estimates, for example:
  - `src/main/session/fallback-history.ts`
  - `src/main/memory/r1-memory-manager.ts`
  - `src/main/memory/wake-context-builder.ts`
  - `src/main/memory/answer-agent.ts`
  - `src/main/memory/unified-controller.ts`
  - `src/main/instance/context-worker-client.ts`
  - `src/main/context/context-compactor.ts`
  - `src/main/instance/instance-context.ts`
  - `src/main/providers/anthropic-api-provider.ts`
  - `src/main/rlm/context/context.utils.ts`
  - `src/main/routing/hot-model-switcher.ts`
  - `src/main/indexing/indexed-codebase-context.ts`
  - `src/main/indexing/context-assembler.ts`
- Other projects are more reliable because they either trust provider-reported usage directly (`t3code`, `opencode`) or they use API-first counting with heuristic fallback (`Actual Claude`).

## Improvements to make

1. **Wire real provider usage into the shared counter**
   - Feed provider-reported token usage back into `TokenCounter.calibrate()`.
   - Without this, the calibration design never improves the estimate in production.

2. **Make `usage-normalization.ts` the single entry point for provider usage payloads**
   - Route Anthropic, OpenAI, Codex, and CLI usage events through `normalizeUsage()`.
   - Use one canonical shape for `input`, `output`, `cacheRead`, `cacheWrite`, and `total`.

3. **Replace scattered `chars / 4` helpers with the shared token counter**
   - Centralize on `src/main/rlm/token-counter.ts`.
   - Today the app mixes model-aware estimation in one place with crude estimates everywhere else, which guarantees drift.

4. **Separate live context-window usage from cumulative processed tokens**
   - Copy the distinction used in `t3code`: current window usage vs lifetime processed usage.
   - Do not let accumulated provider totals masquerade as current context pressure.

5. **Trust provider-reported totals when they exist**
   - Follow the defensive pattern in `opencode/packages/llm/src/protocols/shared.ts`.
   - Prefer provider `total` as source of truth, otherwise derive cautiously from known fields.
   - Preserve `undefined` when data is unknown instead of silently fabricating `0`.

6. **Account explicitly for cache and reasoning tokens**
   - Include cache read/write tokens consistently in prompt-side and total usage.
   - Add explicit reasoning-token support where providers expose it.

7. **Add API-first counting where providers support it**
   - `Actual Claude` uses native token-count APIs first and only falls back to heuristics.
   - AI Orchestrator should do the same for providers that can return authoritative counts.

8. **Improve heuristics for structured payloads and non-Latin text**
   - Copy the useful parts of `openclaw` and `Actual Claude`:
     - denser ratios for JSON/tool payloads
     - CJK-aware estimation
     - fixed-cost handling for images/documents when exact counts are unavailable

9. **Make model-aware estimation actually model-aware across the whole app**
   - Pass model IDs through more call sites instead of dropping back to generic text-length logic.
   - The current shared counter can vary by model family, but many consumers never use that capability.

10. **Add estimate-vs-actual telemetry**
    - Log both the estimate and the real provider usage per request.
    - Surface per-model error rates so we can see where the heuristic is drifting.

11. **Add fixture-based tests for real provider payloads**
    - Cover Anthropic cache fields, OpenAI prompt/completion fields, Codex `last` vs `total`, and missing-total cases.
    - Add regression tests proving that current-window calculations do not use cumulative totals by mistake.

12. **Document the token accounting contract**
    - Define what each number means:
      - current context window
      - last-turn usage
      - cumulative processed tokens
      - billable tokens
    - Several sibling projects are safer because they are explicit about these distinctions in code and comments.

## Peer-project patterns worth copying

- **Actual Claude:** API-first counting, cache-aware totals, better fallbacks for files/tools/thinking blocks.
- **t3code:** clean separation between current window usage and accumulated totals.
- **opencode:** defensive aggregation that does not invent zeroes when data is absent.
- **openclaw:** better heuristics for JSON/tool output and CJK text.
