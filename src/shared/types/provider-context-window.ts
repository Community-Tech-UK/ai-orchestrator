/**
 * Return the expected context window for a provider + model combination.
 *
 * Claude Code CLI defaults to 200k for most models. Opus 4.6+ and Sonnet 4.6+
 * natively expose 1M. For older models the `[1m]` suffix requests the
 * `context-1m-2025-08-07` beta header, which also yields 1M.
 *
 * NOTE: Claude Code CLI has known bugs where it reports 200k even for
 * 1M-capable models (see GitHub issues #23432, #34083, #36649).  The
 * adapter should use `Math.max(cliReported, thisValue)` to avoid being
 * downgraded by a buggy CLI report.
 */
export function getProviderModelContextWindow(
  provider: string,
  modelId?: string
): number {
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedModel = modelId?.trim().toLowerCase() ?? '';
  const isClaudeProvider =
    normalizedProvider === 'claude' ||
    normalizedProvider === 'claude-cli' ||
    normalizedProvider === 'anthropic' ||
    normalizedProvider === 'anthropic-api';

  // Codex / OpenAI providers — model-specific windows.
  const isCodexProvider =
    normalizedProvider === 'codex' ||
    normalizedProvider === 'codex-cli' ||
    normalizedProvider === 'openai';
  if (isCodexProvider) {
    // GPT-5 family and unspecified models default to 200k.
    return 200000;
  }

  if (!isClaudeProvider) {
    return 200000;
  }

  // Explicit 1M request via [1m] suffix (e.g. "opus[1m]", "sonnet[1m]")
  if (normalizedModel.includes('[1m]')) {
    return 1000000;
  }

  // Models that natively support 1M context (no beta header needed).
  // Bare "opus" / "sonnet" resolve server-side to the latest (4.6+),
  // which has native 1M support.
  //
  // Opus 4.8/4.7/4.6 and Sonnet 4.6 support 1M context at standard pricing.
  if (
    normalizedModel === 'opus' ||
    normalizedModel === 'sonnet' ||
    normalizedModel.includes('opus-4-6') ||
    normalizedModel.includes('opus-4.6') ||
    normalizedModel.includes('opus-4-8') ||
    normalizedModel.includes('opus-4.8') ||
    normalizedModel.includes('opus-4-7') ||
    normalizedModel.includes('opus-4.7') ||
    normalizedModel.includes('sonnet-4-6') ||
    normalizedModel.includes('sonnet-4.6')
  ) {
    return 1000000;
  }

  // When model is unspecified (empty string), bare "opus"/"sonnet" is the
  // server-side default and resolves to 4.6+ which natively supports 1M.
  // Only fall back to 200k for explicitly pinned older models or haiku.
  if (normalizedModel === '' || normalizedModel === 'default') {
    return 1000000;
  }

  // All other Claude models (haiku, pinned older versions) default to 200k
  return 200000;
}
