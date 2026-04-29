import * as os from 'os';

export interface RedactionOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  redactSessionBodies?: boolean;
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

      if (SECRET_KEY_PATTERN.test(key)) {
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
    ? input.split(homeDir).join('~')
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

  output = output.replace(/process\.env\.([A-Z0-9_]+)/gi, (_match, name: string) => {
    const isSet = env[name] != null;
    return `<env:${name}:${isSet ? 'set' : 'unset'}>`;
  });

  return output;
}
