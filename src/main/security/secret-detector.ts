/**
 * Secret Detector - Detect and classify sensitive information in content
 */

/**
 * Secret classification
 */
export type SecretType =
  | 'api_key'
  | 'token'
  | 'password'
  | 'private_key'
  | 'certificate'
  | 'connection_string'
  | 'credential'
  | 'unknown';

/**
 * Detected secret information
 */
export interface DetectedSecret {
  type: SecretType;
  name: string;  // Variable/key name if known
  /** Redacted representation -- never stores the raw secret value */
  redactedValue: string;
  line?: number;  // Line number if from file content
  startIndex: number;  // Start position in string
  endIndex: number;  // End position in string
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Secret detection patterns
 */
interface SecretPattern {
  type: SecretType;
  /** Pattern name for the environment variable or key */
  namePattern?: RegExp;
  /** Pattern for the value itself */
  valuePattern?: RegExp;
  /** Confidence level when matched */
  confidence: 'high' | 'medium' | 'low';
  /** Description for logging */
  description: string;
}

/**
 * Common secret patterns
 */
const SECRET_PATTERNS: SecretPattern[] = [
  // API Keys
  {
    type: 'api_key',
    namePattern: /^(ANTHROPIC|OPENAI|CLAUDE|GEMINI|MISTRAL|GROQ|COHERE)_API_KEY$/i,
    confidence: 'high',
    description: 'AI provider API key',
  },
  {
    type: 'api_key',
    namePattern: /^(AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID)$/i,
    confidence: 'high',
    description: 'AWS credentials',
  },
  {
    type: 'api_key',
    namePattern: /^(AZURE_[A-Z_]*KEY|AZURE_[A-Z_]*SECRET)$/i,
    confidence: 'high',
    description: 'Azure credentials',
  },
  {
    type: 'api_key',
    namePattern: /^(GCP_|GOOGLE_)[A-Z_]*(KEY|SECRET|CREDENTIAL)$/i,
    confidence: 'high',
    description: 'Google Cloud credentials',
  },
  {
    type: 'api_key',
    namePattern: /^[A-Z_]*API[_]?KEY$/i,
    confidence: 'medium',
    description: 'Generic API key',
  },
  {
    type: 'api_key',
    namePattern: /^[A-Z_]*SECRET[_]?KEY$/i,
    confidence: 'medium',
    description: 'Generic secret key',
  },

  // Tokens
  {
    type: 'token',
    namePattern: /^(GITHUB|GITLAB|BITBUCKET)_TOKEN$/i,
    confidence: 'high',
    description: 'Git provider token',
  },
  {
    type: 'token',
    namePattern: /^(NPM_TOKEN|YARN_TOKEN)$/i,
    confidence: 'high',
    description: 'Package manager token',
  },
  {
    type: 'token',
    namePattern: /^(SLACK|DISCORD|TELEGRAM)_[A-Z_]*TOKEN$/i,
    confidence: 'high',
    description: 'Messaging platform token',
  },
  {
    type: 'token',
    namePattern: /^[A-Z_]*TOKEN$/i,
    confidence: 'medium',
    description: 'Generic token',
  },
  {
    type: 'token',
    namePattern: /^[A-Z_]*BEARER$/i,
    confidence: 'medium',
    description: 'Bearer token',
  },

  // Passwords
  {
    type: 'password',
    namePattern: /^(DB_|DATABASE_|MYSQL_|POSTGRES_|MONGO_|REDIS_)?PASSWORD$/i,
    confidence: 'high',
    description: 'Database password',
  },
  {
    type: 'password',
    namePattern: /^[A-Z_]*PASSWORD$/i,
    confidence: 'medium',
    description: 'Generic password',
  },
  {
    type: 'password',
    namePattern: /^[A-Z_]*PASSWD$/i,
    confidence: 'medium',
    description: 'Password (passwd variant)',
  },

  // Connection strings
  {
    type: 'connection_string',
    namePattern: /^(DATABASE_URL|REDIS_URL|MONGODB_URI|POSTGRES_URL|MYSQL_URL)$/i,
    confidence: 'high',
    description: 'Database connection string',
  },
  {
    type: 'connection_string',
    valuePattern: /^(postgres|mysql|mongodb|redis|amqp):\/\/[^:]+:[^@]+@/i,
    confidence: 'high',
    description: 'Connection string with credentials',
  },

  // Private keys
  {
    type: 'private_key',
    namePattern: /^[A-Z_]*PRIVATE[_]?KEY$/i,
    confidence: 'high',
    description: 'Private key',
  },
  {
    type: 'private_key',
    valuePattern: /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
    confidence: 'high',
    description: 'PEM private key',
  },

  // Certificates
  {
    type: 'certificate',
    valuePattern: /-----BEGIN CERTIFICATE-----/,
    confidence: 'medium',
    description: 'Certificate',
  },

  // Generic credentials
  {
    type: 'credential',
    namePattern: /^[A-Z_]*(CREDENTIAL|CRED|AUTH)[S]?$/i,
    confidence: 'medium',
    description: 'Generic credential',
  },
  {
    type: 'credential',
    namePattern: /^[A-Z_]*SECRET$/i,
    confidence: 'medium',
    description: 'Generic secret',
  },
];

/**
 * Prefix-based value patterns — matched directly against raw content
 * (not key-value pairs) to catch inline secrets regardless of variable name.
 */
const VALUE_PREFIX_PATTERNS: {
  type: SecretType;
  name: string;
  pattern: RegExp;
  confidence: 'high' | 'medium';
}[] = [
  { type: 'token', name: 'github_pat', pattern: /ghp_[A-Za-z0-9_]{36,}/, confidence: 'high' },
  { type: 'token', name: 'github_fine_grained', pattern: /github_pat_[A-Za-z0-9_]{22,}/, confidence: 'high' },
  { type: 'token', name: 'github_oauth', pattern: /gho_[A-Za-z0-9_]{36,}/, confidence: 'high' },
  { type: 'api_key', name: 'aws_access_key', pattern: /AKIA[0-9A-Z]{16}/, confidence: 'high' },
  { type: 'api_key', name: 'anthropic_api_key', pattern: /sk-ant-api03-[A-Za-z0-9_-]{20,}/, confidence: 'high' },
  { type: 'token', name: 'slack_token', pattern: /xox[bprs]-[0-9a-zA-Z-]{10,}/, confidence: 'high' },
  { type: 'api_key', name: 'stripe_key', pattern: /sk_(test|live)_[A-Za-z0-9]{20,}/, confidence: 'high' },
  { type: 'api_key', name: 'stripe_restricted', pattern: /rk_(test|live)_[A-Za-z0-9]{20,}/, confidence: 'high' },
  { type: 'api_key', name: 'google_api_key', pattern: /AIza[A-Za-z0-9_-]{35}/, confidence: 'high' },
  { type: 'token', name: 'npm_token', pattern: /npm_[A-Za-z0-9]{36,}/, confidence: 'high' },
  { type: 'token', name: 'pypi_token', pattern: /pypi-[A-Za-z0-9_-]{50,}/, confidence: 'high' },
  { type: 'private_key', name: 'pem_private_key', pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/, confidence: 'high' },
  { type: 'token', name: 'gitlab_token', pattern: /glpat-[A-Za-z0-9_-]{20,}/, confidence: 'high' },
  { type: 'api_key', name: 'sendgrid_key', pattern: /SG\.[A-Za-z0-9_-]{22,}\.[A-Za-z0-9_-]{22,}/, confidence: 'high' },
];

/**
 * High-entropy patterns that likely indicate secrets
 */
const HIGH_ENTROPY_PATTERNS = [
  // Base64 encoded secrets (32+ chars)
  /^[A-Za-z0-9+/]{32,}={0,2}$/,
  // Hex encoded secrets (32+ chars)
  /^[a-fA-F0-9]{32,}$/,
  // JWT tokens
  /^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
  // UUID-like patterns
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,
];

/**
 * Detect secrets in key-value pairs (like .env files)
 */
export function detectSecretsInKeyValue(
  name: string,
  value: string,
  lineNumber?: number
): DetectedSecret | null {
  // Skip empty values
  if (!value || value.trim() === '') {
    return null;
  }

  // Check against patterns
  for (const pattern of SECRET_PATTERNS) {
    // Check name pattern
    if (pattern.namePattern && pattern.namePattern.test(name)) {
      return {
        type: pattern.type,
        name,
        redactedValue: '*'.repeat(value.length),
        line: lineNumber,
        startIndex: 0,
        endIndex: value.length,
        confidence: pattern.confidence,
      };
    }

    // Check value pattern
    if (pattern.valuePattern && pattern.valuePattern.test(value)) {
      return {
        type: pattern.type,
        name,
        redactedValue: '*'.repeat(value.length),
        line: lineNumber,
        startIndex: 0,
        endIndex: value.length,
        confidence: pattern.confidence,
      };
    }
  }

  // Check for high-entropy values
  if (value.length >= 16 && HIGH_ENTROPY_PATTERNS.some(p => p.test(value))) {
    // Only flag as secret if name also looks suspicious
    const suspiciousName = /key|secret|token|password|credential|auth/i.test(name);
    if (suspiciousName) {
      return {
        type: 'unknown',
        name,
        redactedValue: '*'.repeat(value.length),
        line: lineNumber,
        startIndex: 0,
        endIndex: value.length,
        confidence: 'low',
      };
    }
  }

  return null;
}

/**
 * Parse .env file content and detect secrets
 */
export function detectSecretsInEnvContent(content: string): DetectedSecret[] {
  const secrets: DetectedSecret[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Skip comments and empty lines
    if (!line || line.startsWith('#')) {
      continue;
    }

    // Parse key=value
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match) {
      const [, name, value] = match;
      // Remove quotes from value
      const cleanValue = value.replace(/^["']|["']$/g, '');

      const secret = detectSecretsInKeyValue(name.trim(), cleanValue, i + 1);
      if (secret) {
        secrets.push(secret);
      }
    }
  }

  return secrets;
}

/**
 * Detect secrets in arbitrary text content
 */
export function detectSecretsInContent(content: string): DetectedSecret[] {
  const secrets: DetectedSecret[] = [];

  // Check for private keys
  const privateKeyMatch = content.match(/-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END \1?PRIVATE KEY-----/g);
  if (privateKeyMatch) {
    for (const match of privateKeyMatch) {
      const index = content.indexOf(match);
      secrets.push({
        type: 'private_key',
        name: 'embedded_private_key',
        redactedValue: '*'.repeat(match.length),
        startIndex: index,
        endIndex: index + match.length,
        confidence: 'high',
      });
    }
  }

  // Check for connection strings with credentials
  const connStringMatch = content.match(/(postgres|mysql|mongodb|redis|amqp):\/\/[^\s"']+:[^\s"'@]+@[^\s"']+/gi);
  if (connStringMatch) {
    for (const match of connStringMatch) {
      const index = content.indexOf(match);
      secrets.push({
        type: 'connection_string',
        name: 'connection_string',
        redactedValue: '*'.repeat(match.length),
        startIndex: index,
        endIndex: index + match.length,
        confidence: 'high',
      });
    }
  }

  // Check for JWT tokens
  const jwtMatch = content.match(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g);
  if (jwtMatch) {
    for (const match of jwtMatch) {
      const index = content.indexOf(match);
      secrets.push({
        type: 'token',
        name: 'jwt_token',
        redactedValue: '*'.repeat(match.length),
        startIndex: index,
        endIndex: index + match.length,
        confidence: 'high',
      });
    }
  }

  // Phase 2: Prefix-based value scanning
  for (const vp of VALUE_PREFIX_PATTERNS) {
    const re = new RegExp(vp.pattern.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      secrets.push({
        type: vp.type,
        name: vp.name,
        redactedValue: '*'.repeat(match[0].length),
        startIndex: match.index,
        endIndex: match.index + match[0].length,
        confidence: vp.confidence,
      });
    }
  }

  return secrets;
}

/**
 * Detect secrets in arbitrary text content.
 * Alias for detectSecretsInContent — preferred for new callers.
 */
export function detectSecrets(content: string): DetectedSecret[] {
  return detectSecretsInContent(content);
}

/**
 * Redact detected secrets in content, replacing each match with a labelled marker.
 */
export function redactSecrets(content: string): string {
  const secrets = detectSecrets(content);
  if (secrets.length === 0) return content;

  const sorted = [...secrets].sort((a, b) => b.startIndex - a.startIndex);
  let result = content;
  for (const secret of sorted) {
    result = result.slice(0, secret.startIndex)
      + `[REDACTED:${secret.name}]`
      + result.slice(secret.endIndex);
  }
  return result;
}

/**
 * Check if a file path is likely to contain secrets
 */
export function isSecretFile(filePath: string): boolean {
  const sensitivePatterns = [
    /\.env$/,
    /\.env\..+$/,
    /\.key$/,
    /\.pem$/,
    /id_rsa/,
    /id_ed25519/,
    /id_ecdsa/,
    /credentials\.json$/,
    /secrets\//,
    /\.secrets$/,
    /\.secret$/,
    /\.password$/,
    /\.htpasswd$/,
    /\.netrc$/,
    /\.npmrc$/,
    /\.pypirc$/,
  ];

  return sensitivePatterns.some(pattern => pattern.test(filePath));
}

/**
 * Get the sensitivity level of a file
 */
export function getFileSensitivity(filePath: string): 'high' | 'medium' | 'low' | 'none' {
  const highSensitivity = [
    /\.key$/,
    /id_rsa/,
    /id_ed25519/,
    /id_ecdsa/,
    /\.pem$/,
    /credentials\.json$/,
  ];

  const mediumSensitivity = [
    /\.env$/,
    /\.env\..+$/,
    /secrets\//,
    /\.npmrc$/,
    /\.pypirc$/,
  ];

  const lowSensitivity = [
    /config\.json$/,
    /settings\.json$/,
    /\.config$/,
  ];

  if (highSensitivity.some(p => p.test(filePath))) return 'high';
  if (mediumSensitivity.some(p => p.test(filePath))) return 'medium';
  if (lowSensitivity.some(p => p.test(filePath))) return 'low';
  return 'none';
}
