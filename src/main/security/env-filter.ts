/**
 * Environment Variable Filter - Filter sensitive env vars before passing to child processes
 */

import { detectSecretsInKeyValue, SecretType } from './secret-detector';
import { getLogger } from '../logging/logger';

const logger = getLogger('EnvFilter');

/**
 * Environment variable filter configuration
 */
export interface EnvFilterConfig {
  /** Always block these variable names (exact match) */
  blocklist: string[];
  /** Always allow these variable names (exact match) */
  allowlist: string[];
  /** Block variables matching these patterns */
  blockPatterns: RegExp[];
  /** Allow variables matching these patterns (overrides block) */
  allowPatterns: RegExp[];
  /** Secret types to always block */
  blockSecretTypes: SecretType[];
  /** Whether to block all detected secrets */
  blockAllSecrets: boolean;
}

/**
 * Default filter configuration
 */
export const DEFAULT_ENV_FILTER_CONFIG: EnvFilterConfig = {
  blocklist: [
    // AI Provider Keys
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'CLAUDE_API_KEY',
    'GEMINI_API_KEY',
    'MISTRAL_API_KEY',
    'GROQ_API_KEY',
    'COHERE_API_KEY',

    // Cloud Provider Credentials
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AZURE_CLIENT_SECRET',
    'GCP_SERVICE_ACCOUNT_KEY',
    'GOOGLE_APPLICATION_CREDENTIALS',

    // Git/Version Control
    'GITHUB_TOKEN',
    'GITLAB_TOKEN',
    'BITBUCKET_TOKEN',
    'GH_TOKEN',

    // Package Managers
    'NPM_TOKEN',
    'YARN_TOKEN',

    // Database Passwords
    'DB_PASSWORD',
    'DATABASE_PASSWORD',
    'MYSQL_PASSWORD',
    'POSTGRES_PASSWORD',
    'MONGO_PASSWORD',
    'REDIS_PASSWORD',

    // Generic Secrets
    'SECRET_KEY',
    'PRIVATE_KEY',
    'ENCRYPTION_KEY',
    'JWT_SECRET',
    'SESSION_SECRET',
    'COOKIE_SECRET',
  ],

  allowlist: [
    // Safe system variables
    'PATH',
    'HOME',
    'USER',
    'SHELL',
    'TERM',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TZ',
    'TMPDIR',
    'TEMP',
    'TMP',

    // Common development variables
    'NODE_ENV',
    'DEBUG',
    'VERBOSE',
    'LOG_LEVEL',
    'CI',
    'EDITOR',
    'VISUAL',

    // Node.js
    'NODE_PATH',
    'NODE_OPTIONS',
    'NPM_CONFIG_PREFIX',

    // Python
    'PYTHONPATH',
    'VIRTUAL_ENV',
    'CONDA_PREFIX',

    // Go
    'GOPATH',
    'GOROOT',

    // Rust
    'CARGO_HOME',
    'RUSTUP_HOME',

    // Java
    'JAVA_HOME',
    'MAVEN_HOME',

    // Git (non-sensitive)
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL',
  ],

  blockPatterns: [
    /^.*_API_KEY$/i,
    /^.*_SECRET_KEY$/i,
    /^.*_SECRET$/i,
    /^.*_TOKEN$/i,
    /^.*_PASSWORD$/i,
    /^.*_PASSWD$/i,
    /^.*_CREDENTIAL[S]?$/i,
    /^.*_PRIVATE_KEY$/i,
    /^.*_AUTH$/i,
  ],

  allowPatterns: [
    // Allow path-like variables
    /^.*_PATH$/i,
    /^.*_HOME$/i,
    /^.*_ROOT$/i,
    /^.*_DIR$/i,
    // Allow config/settings (but not secrets)
    /^.*_CONFIG$/i,
    /^.*_SETTINGS$/i,
    /^.*_OPTIONS$/i,
  ],

  blockSecretTypes: ['api_key', 'token', 'password', 'private_key', 'credential'],

  blockAllSecrets: true,
};

/**
 * Filter result for a single variable
 */
export interface FilterResult {
  name: string;
  allowed: boolean;
  reason: 'allowlist' | 'blocklist' | 'allow_pattern' | 'block_pattern' | 'secret_detected' | 'default';
  secretType?: SecretType;
}

/**
 * Check if a single environment variable should be allowed
 */
export function shouldAllowEnvVar(
  name: string,
  value: string | undefined,
  config: EnvFilterConfig = DEFAULT_ENV_FILTER_CONFIG
): FilterResult {
  // Check explicit blocklist first (always blocked regardless of value)
  if (config.blocklist.includes(name)) {
    return { name, allowed: false, reason: 'blocklist' };
  }

  // Check block patterns by name
  for (const pattern of config.blockPatterns) {
    if (pattern.test(name)) {
      return { name, allowed: false, reason: 'block_pattern' };
    }
  }

  // Run secret detection BEFORE allowlist/allow-patterns so that a variable
  // whose value looks like a secret is blocked even if its name matches
  // an allow pattern (e.g. MY_CONFIG="sk-proj-...").
  // Codex + GPT-5.4 both flagged the original ordering as a policy gap.
  if (value && config.blockAllSecrets) {
    const secret = detectSecretsInKeyValue(name, value);
    if (secret && config.blockSecretTypes.includes(secret.type)) {
      return { name, allowed: false, reason: 'secret_detected', secretType: secret.type };
    }
  }

  // Check explicit allowlist (high priority after security checks)
  if (config.allowlist.includes(name)) {
    return { name, allowed: true, reason: 'allowlist' };
  }

  // Check allow patterns
  for (const pattern of config.allowPatterns) {
    if (pattern.test(name)) {
      return { name, allowed: true, reason: 'allow_pattern' };
    }
  }

  // Default: allow
  return { name, allowed: true, reason: 'default' };
}

/**
 * Filter environment variables based on configuration
 */
export function filterEnvVars(
  env: Record<string, string | undefined>,
  config: EnvFilterConfig = DEFAULT_ENV_FILTER_CONFIG
): {
  filtered: Record<string, string>;
  blocked: FilterResult[];
  allowed: FilterResult[];
} {
  const filtered: Record<string, string> = {};
  const blocked: FilterResult[] = [];
  const allowed: FilterResult[] = [];

  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;

    const result = shouldAllowEnvVar(name, value, config);

    if (result.allowed) {
      filtered[name] = value;
      allowed.push(result);
    } else {
      blocked.push(result);
    }
  }

  return { filtered, blocked, allowed };
}

/**
 * Get a safe subset of process.env for child processes
 */
export function getSafeEnv(
  additionalEnv?: Record<string, string>,
  config?: Partial<EnvFilterConfig>
): Record<string, string> {
  const mergedConfig: EnvFilterConfig = {
    ...DEFAULT_ENV_FILTER_CONFIG,
    ...config,
    blocklist: [...DEFAULT_ENV_FILTER_CONFIG.blocklist, ...(config?.blocklist || [])],
    allowlist: [...DEFAULT_ENV_FILTER_CONFIG.allowlist, ...(config?.allowlist || [])],
    blockPatterns: [...DEFAULT_ENV_FILTER_CONFIG.blockPatterns, ...(config?.blockPatterns || [])],
    allowPatterns: [...DEFAULT_ENV_FILTER_CONFIG.allowPatterns, ...(config?.allowPatterns || [])],
  };

  const { filtered } = filterEnvVars(process.env as Record<string, string>, mergedConfig);

  // Add any additional env vars (these are not filtered - caller responsibility)
  if (additionalEnv) {
    Object.assign(filtered, additionalEnv);
  }

  return filtered;
}

/**
 * Log blocked environment variables (for debugging)
 */
export function logBlockedEnvVars(blocked: FilterResult[]): void {
  if (blocked.length === 0) return;

  logger.info('Blocked environment variables', {
    count: blocked.length,
    variables: blocked.map(r => ({ name: r.name, reason: r.reason, secretType: r.secretType })),
  });
}

/**
 * API keys that trusted child processes (CLI adapters, MCP servers) need
 * to authenticate with their respective AI/VCS providers.
 *
 * These are added to the allowlist (which has priority over the blocklist)
 * so that CLI adapters and MCP servers can inherit them from process.env.
 * Untrusted or sandboxed processes should use plain getSafeEnv() instead.
 */
const TRUSTED_PROCESS_ALLOWED_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'CLAUDE_API_KEY',
  'GEMINI_API_KEY',
  'MISTRAL_API_KEY',
  'GROQ_API_KEY',
  'COHERE_API_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
];

/**
 * Get a safe environment for trusted child processes (CLI adapters, MCP servers).
 *
 * Same as getSafeEnv() but preserves AI provider API keys and VCS tokens
 * that CLI tools need to authenticate. Use this when spawning CLI adapters
 * and MCP servers; use plain getSafeEnv() for untrusted/sandboxed processes.
 */
export function getSafeEnvForTrustedProcess(
  additionalEnv?: Record<string, string>,
): Record<string, string> {
  return getSafeEnv(additionalEnv, {
    allowlist: TRUSTED_PROCESS_ALLOWED_KEYS,
  });
}

/**
 * Create a minimal safe environment with only essential variables
 */
export function getMinimalSafeEnv(): Record<string, string> {
  const essential = [
    'PATH',
    'HOME',
    'USER',
    'SHELL',
    'TERM',
    'LANG',
    'LC_ALL',
    'TMPDIR',
    'NODE_ENV',
  ];

  const env: Record<string, string> = {};

  for (const key of essential) {
    if (process.env[key]) {
      env[key] = process.env[key]!;
    }
  }

  return env;
}
