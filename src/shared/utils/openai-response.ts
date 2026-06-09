/**
 * Helpers for parsing OpenAI-compatible chat completion responses (LM Studio,
 * Ollama's OpenAI shim, vLLM, etc.). Shared by the coordinator's auxiliary
 * model client and the worker-agent's RPC dispatcher so both treat empty /
 * reasoning-truncated responses identically.
 */

export interface OpenAiChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      /** Some reasoning models (e.g. newer Qwen on LM Studio) emit a separate field. */
      reasoning_content?: string | null;
    };
    finish_reason?: string | null;
  }>;
}

/**
 * Extract the assistant text from an OpenAI-compatible chat completion.
 *
 * - Trims surrounding whitespace — reasoning models frequently prefix the answer
 *   with newlines after their hidden thinking, which would otherwise break a
 *   downstream `JSON.parse`.
 * - Throws when the content is empty. This is the common silent failure of
 *   reasoning models under a tight `max_tokens`: the model spends the entire
 *   budget inside `reasoning_content`, hits `finish_reason: "length"`, and
 *   returns an HTTP 200 with `content: ""`. Throwing lets the auxiliary router
 *   fall back deterministically with a clear, logged reason instead of silently
 *   propagating an empty string. The error message names the likely cause so the
 *   fix (raise maxOutputTokens, or use a non-reasoning model) is obvious.
 */
export function extractChatCompletionText(data: unknown): string {
  const choice = (data as OpenAiChatCompletionResponse | null | undefined)?.choices?.[0];
  const content = (choice?.message?.content ?? '').trim();
  if (content) return content;

  const finish = choice?.finish_reason ?? 'unknown';
  const reasoningChars = (choice?.message?.reasoning_content ?? '').length;
  const hint =
    finish === 'length'
      ? 'model exhausted its token budget before emitting content (likely a reasoning model — raise maxOutputTokens or use a non-reasoning model)'
      : 'model returned no content';
  throw new Error(
    `empty content (finish_reason=${finish}, reasoning_content=${reasoningChars} chars): ${hint}`,
  );
}
