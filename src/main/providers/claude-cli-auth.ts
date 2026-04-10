import { execFile } from 'child_process';

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
    execFile(file, args, { timeout }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

export async function getClaudeCliAuthStatus(): Promise<ClaudeCliAuthStatus | null> {
  try {
    const { stdout } = await execFileAsync('claude', ['auth', 'status']);
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

export async function checkClaudeCliAuthentication(): Promise<ClaudeCliAuthCheckResult> {
  const authStatus = await getClaudeCliAuthStatus();
  if (!authStatus) {
    return {
      authenticated: false,
      message: 'Unable to read Claude CLI auth status',
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
