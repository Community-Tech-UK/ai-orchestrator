import { execFile } from 'child_process';
import { buildCliSpawnOptions } from '../cli/cli-environment';

export interface ClaudeCliAuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  apiProvider?: string;
  subscriptionType?: string;
}

export interface ClaudeCliAuthCheckResult {
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

function parseAuthStatus(stdout: string): ClaudeCliAuthStatus | null {
  try {
    const parsed = JSON.parse(stdout) as Partial<ClaudeCliAuthStatus>;

    if (typeof parsed !== 'object' || parsed === null || typeof parsed.loggedIn !== 'boolean') {
      return null;
    }

    return {
      loggedIn: parsed.loggedIn,
      authMethod: typeof parsed.authMethod === 'string' ? parsed.authMethod : undefined,
      apiProvider: typeof parsed.apiProvider === 'string' ? parsed.apiProvider : undefined,
      subscriptionType: typeof parsed.subscriptionType === 'string' ? parsed.subscriptionType : undefined,
    };
  } catch {
    return null;
  }
}

interface ClaudeCliAuthRead {
  status: ClaudeCliAuthStatus | null;
  /** Short, non-secret explanation of why the status could not be read. */
  reason?: string;
}

/**
 * Reads `claude auth status`. A non-zero exit is not automatically a probe
 * failure — the CLI may still have printed a valid `{"loggedIn": false}`
 * payload — so the error path re-parses stdout before giving up, and reports
 * *why* it gave up rather than a bare "unable to read".
 */
async function readClaudeCliAuthStatus(): Promise<ClaudeCliAuthRead> {
  try {
    const { stdout } = await execFileAsync('claude', ['auth', 'status']);
    const status = parseAuthStatus(stdout);
    return status
      ? { status }
      : { status: null, reason: 'unexpected output from `claude auth status`' };
  } catch (error) {
    const failure = error as Error & { stdout?: string };
    const status = parseAuthStatus(failure.stdout ?? '');
    if (status) {
      return { status };
    }
    return { status: null, reason: failure.message || 'the CLI could not be run' };
  }
}

export async function getClaudeCliAuthStatus(): Promise<ClaudeCliAuthStatus | null> {
  return (await readClaudeCliAuthStatus()).status;
}

export async function checkClaudeCliAuthentication(): Promise<ClaudeCliAuthCheckResult> {
  const { status: authStatus, reason } = await readClaudeCliAuthStatus();
  if (!authStatus) {
    return {
      authenticated: false,
      message: reason
        ? `Unable to read Claude CLI auth status — ${reason}`
        : 'Unable to read Claude CLI auth status',
    };
  }

  if (!authStatus.loggedIn) {
    return {
      authenticated: false,
      message: 'Claude CLI is not logged in',
      metadata: {
        authMethod: authStatus.authMethod ?? null,
        apiProvider: authStatus.apiProvider ?? null,
      },
    };
  }

  const viaAuthMethod = authStatus.authMethod ? ` via ${authStatus.authMethod}` : '';
  const withPlan = authStatus.subscriptionType ? ` (${authStatus.subscriptionType})` : '';

  return {
    authenticated: true,
    message: `Claude CLI authenticated${viaAuthMethod}${withPlan}`,
    metadata: {
      authMethod: authStatus.authMethod ?? null,
      apiProvider: authStatus.apiProvider ?? null,
      subscriptionType: authStatus.subscriptionType ?? null,
    },
  };
}
