/** Local refusal provenance; never serialized or inferred from error text. */
const undispatched = new WeakSet<Error>();

export function markProviderDispatchNotStarted(error: Error): Error {
  undispatched.add(error);
  return error;
}

export function isProviderDispatchNotStarted(error: unknown): boolean {
  return error instanceof Error && undispatched.has(error);
}

/** Explicit native usage proves a call, including a provider-reported zero bill. */
export function hasProviderUsage(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const usage = value as Record<string, unknown>;
  const dollars = ["cost", "total_cost_usd", "providerSessionTotalUsd"];
  const tokens = [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "totalTokens",
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "total_tokens",
  ];
  return (
    dollars.some(
      (key) =>
        typeof usage[key] === "number" &&
        Number.isFinite(usage[key]) &&
        usage[key] >= 0,
    ) ||
    tokens.some(
      (key) =>
        typeof usage[key] === "number" &&
        Number.isFinite(usage[key]) &&
        usage[key] > 0,
    )
  );
}
