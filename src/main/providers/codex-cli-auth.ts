import { execFile } from 'child_process';
import { buildCliSpawnOptions } from '../cli/cli-environment';

export interface CodexCliAuthCheckResult {
  authenticated: boolean;
  message: string;
  metadata?: Record<string, unknown>;
}

async function execFileAsync(
  file: string,
  args: string[],
  timeout = 5000
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      timeout,
      ...buildCliSpawnOptions(process.env),
    }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

function parseCodexAuthOutput(output: string): CodexCliAuthCheckResult | null {
  const trimmed = output.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.toLowerCase();
  if (normalized.includes('logged in')) {
    const authMethod = normalized.includes('chatgpt')
      ? 'chatgpt'
      : normalized.includes('api key')
        ? 'api-key'
        : null;

    const authMethodMessage = authMethod === 'chatgpt'
      ? ' via ChatGPT'
      : authMethod === 'api-key'
        ? ' via API key'
        : '';

    return {
      authenticated: true,
      message: `Codex CLI authenticated${authMethodMessage}`,
      metadata: {
        authMethod,
        rawOutput: trimmed,
      },
    };
  }

  if (
    normalized.includes('not logged in')
    || normalized.includes('login required')
    || normalized.includes('logged out')
  ) {
    return {
      authenticated: false,
      message: 'Codex CLI is not logged in',
      metadata: {
        rawOutput: trimmed,
      },
    };
  }

  return null;
}

export async function checkCodexCliAuthentication(): Promise<CodexCliAuthCheckResult> {
  try {
    const { stdout, stderr } = await execFileAsync('codex', ['login', 'status']);
    const parsed = parseCodexAuthOutput([stdout, stderr].filter(Boolean).join('\n'));
    return parsed ?? {
      authenticated: false,
      message: 'Unable to read Codex CLI login status',
      metadata: {
        rawOutput: [stdout, stderr].filter(Boolean).join('\n').trim() || null,
      },
    };
  } catch (error) {
    const stdout = typeof error === 'object' && error !== null && 'stdout' in error
      ? String(error.stdout)
      : '';
    const stderr = typeof error === 'object' && error !== null && 'stderr' in error
      ? String(error.stderr)
      : '';
    const parsed = parseCodexAuthOutput([stdout, stderr].filter(Boolean).join('\n'));
    return parsed ?? {
      authenticated: false,
      message: 'Unable to read Codex CLI login status',
      metadata: {
        rawOutput: [stdout, stderr].filter(Boolean).join('\n').trim() || null,
      },
    };
  }
}
