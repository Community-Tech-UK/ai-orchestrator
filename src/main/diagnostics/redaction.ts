import * as os from 'os';
import { detectSecretsInContent } from '../security/secret-detector';

export interface RedactionOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  redactSessionBodies?: boolean;
  /**
   * Keys (case-insensitive) that are known-safe operational fields and must NOT
   * be redacted even when their name matches `SECRET_KEY_PATTERN` — e.g.
   * `tokenCount`/`promptTokens` (the substring "token" would otherwise trip the
   * secret-key heuristic). Their string values are still scanned for inline
   * secrets; only the key-name-based blanket redaction is skipped.
   */
  allowKeys?: readonly string[];
}

/**
 * Task 14 — policy for redacting a value on its way to an observability sink
 * (logger, trace exporter, span attributes). `safe-default` redacts everything
 * secret-shaped (via `redactValue`) while preserving an allowlist of known-safe
 * operational keys so diagnostics stay useful.
 */
export interface RedactionPolicy {
  readonly mode: 'safe-default';
  readonly allowKeys: readonly string[];
}

/**
 * Operational fields that are safe to keep verbatim even though their key name
 * contains a secret-shaped substring (`token`). Everything here is a count / id /
 * status, never a credential.
 */
const DEFAULT_SINK_ALLOW_KEYS: readonly string[] = [
  'tokens',
  'tokencount',
  'token_count',
  'tokensused',
  'tokens_used',
  'prompttokens',
  'prompt_tokens',
  'completiontokens',
  'completion_tokens',
  'inputtokens',
  'input_tokens',
  'outputtokens',
  'output_tokens',
  'totaltokens',
  'total_tokens',
  'maxtokens',
  'max_tokens',
  'cachetokens',
  'cache_tokens',
];

export const DEFAULT_SINK_REDACTION_POLICY: RedactionPolicy = {
  mode: 'safe-default',
  allowKeys: DEFAULT_SINK_ALLOW_KEYS,
};

/**
 * Redact a structured value (object/array/string) for an observability sink that
 * JSON-serializes its output (logger data, trace-file exporter). Delegates to
 * `redactValue` with the sink allowlist applied. Fail-open is NOT used — callers
 * that must never crash (the logger) wrap this in their own try/catch.
 */
export function redactForSink<T>(value: T, policy: RedactionPolicy = DEFAULT_SINK_REDACTION_POLICY): T {
  return redactValue(value, { allowKeys: policy.allowKeys });
}

/**
 * Redact OpenTelemetry span attributes, which MUST remain primitives
 * (`string | number | boolean`) — so unlike `redactForSink` this never converts a
 * value into an `{ env, isSet }` object. Secret-keyed string values become the
 * `<redacted-secret>` string; numbers/booleans under secret-shaped keys (e.g. a
 * numeric token count) pass through; all string values are scanned for inline
 * secrets.
 */
export function redactSpanAttributes(
  attributes: Record<string, string | number | boolean>,
  policy: RedactionPolicy = DEFAULT_SINK_REDACTION_POLICY,
): Record<string, string | number | boolean> {
  const env = process.env;
  const homeDir = os.homedir();
  const secretValues = collectSecretEnvValues(env);
  const allow = new Set(policy.allowKeys.map((k) => k.toLowerCase()));
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!allow.has(key.toLowerCase()) && SECRET_KEY_PATTERN.test(key)) {
      out[key] = typeof value === 'string' ? '<redacted-secret>' : value;
      continue;
    }
    out[key] = typeof value === 'string' ? redactString(value, homeDir, secretValues, env) : value;
  }
  return out;
}

const SECRET_KEY_PATTERN = /(api[_-]?key|token|secret|password|credential|authorization|cookie)/i;
const SESSION_BODY_KEYS = new Set([
  'body',
  'content',
  'message',
  'messages',
  'output',
  'prompt',
  'response',
  'text',
  'transcript',
]);

const INLINE_SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{16,}\b/g,
  /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi,
];

export function redactValue<T>(value: T, opts: RedactionOptions = {}): T {
  const env = opts.env ?? process.env;
  const homeDir = opts.homeDir ?? os.homedir();
  const secretValues = collectSecretEnvValues(env);
  const allowKeys = opts.allowKeys ? new Set(opts.allowKeys.map((k) => k.toLowerCase())) : null;
  const seen = new WeakMap<object, unknown>();

  const redact = (input: unknown, keyPath: string[]): unknown => {
    if (input === null || input === undefined) {
      return input;
    }

    if (typeof input === 'string') {
      return redactString(input, homeDir, secretValues, env);
    }

    if (typeof input !== 'object') {
      return input;
    }

    if (seen.has(input)) {
      return '[circular]';
    }

    if (Array.isArray(input)) {
      const arr: unknown[] = [];
      seen.set(input, arr);
      input.forEach((item, index) => {
        arr[index] = redact(item, [...keyPath, String(index)]);
      });
      return arr;
    }

    const out: Record<string, unknown> = {};
    seen.set(input, out);

    for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
      if (opts.redactSessionBodies && SESSION_BODY_KEYS.has(key.toLowerCase())) {
        out[key] = '[omitted-session-body]';
        continue;
      }

      if (!(allowKeys && allowKeys.has(key.toLowerCase())) && SECRET_KEY_PATTERN.test(key)) {
        out[key] = redactSecretField(raw, env);
        continue;
      }

      out[key] = redact(raw, [...keyPath, key]);
    }

    return out;
  };

  return redact(value, []) as T;
}

function redactSecretField(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === 'string') {
    const envName = Object.entries(env).find(([, envValue]) => envValue === value)?.[0];
    if (envName) {
      return { env: envName, isSet: true };
    }
    return '<redacted-secret>';
  }

  if (typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }

  return '<redacted-secret>';
}

function collectSecretEnvValues(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(([name, value]) => Boolean(value) && SECRET_KEY_PATTERN.test(name) && value!.length >= 8)
    .map(([, value]) => value!)
    .sort((a, b) => b.length - a.length);
}

function redactString(
  input: string,
  homeDir: string,
  secretValues: string[],
  env: NodeJS.ProcessEnv,
): string {
  let output = homeDir && input.includes(homeDir)
    ? input.split(homeDir).join('~').replace(/~\\/g, '~/')
    : input;

  for (const secret of secretValues) {
    output = output.split(secret).join('<redacted-secret>');
  }

  for (const pattern of INLINE_SECRET_PATTERNS) {
    output = output.replace(pattern, (match) =>
      match.toLowerCase().startsWith('bearer ')
        ? 'Bearer <redacted-secret>'
        : '<redacted-secret>',
    );
  }

  // Union with the canonical security detector so the bundle catches provider
  // key formats the local patterns above miss (Google/Gemini AIza…, AWS AKIA…,
  // Stripe sk_/rk_, Slack xox…, GitLab glpat-, SendGrid SG., fine-grained
  // GitHub PATs, npm_/pypi- tokens, PEM private keys, db connection strings).
  // The two sets are complementary — the local patterns still cover generic
  // `sk-`/`gh*_`/Bearer tokens the detector does not. Replace highest-index
  // spans first so earlier indices stay valid as we splice.
  const detected = detectSecretsInContent(output);
  if (detected.length > 0) {
    const sorted = [...detected].sort((a, b) => b.startIndex - a.startIndex);
    for (const secret of sorted) {
      output = output.slice(0, secret.startIndex) + '<redacted-secret>' + output.slice(secret.endIndex);
    }
  }

  output = output.replace(/process\.env\.([A-Z0-9_]+)/gi, (_match, name: string) => {
    const isSet = env[name] != null;
    return `<env:${name}:${isSet ? 'set' : 'unset'}>`;
  });

  return output;
}
