import { constants } from 'fs';
import { access, readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

type GeminiAuthType =
  | 'oauth-personal'
  | 'gemini-api-key'
  | 'vertex-ai'
  | 'compute-default-credentials'
  | 'cloud-shell'
  | 'gateway';

interface GeminiCliSettings {
  security?: {
    auth?: {
      selectedType?: string;
    };
  };
}

export interface GeminiCliAuthCheckResult {
  authenticated: boolean;
  message: string;
  metadata?: Record<string, unknown>;
}

function getHomeDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env['HOME'] || env['USERPROFILE'] || homedir();
}

function getGeminiConfigDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return join(getHomeDirectory(env), '.gemini');
}

function getGcloudConfigDirectory(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    return join(env['APPDATA'] || join(getHomeDirectory(env), 'AppData', 'Roaming'), 'gcloud');
  }

  return join(env['XDG_CONFIG_HOME'] || join(getHomeDirectory(env), '.config'), 'gcloud');
}

async function fileExists(path: string | undefined): Promise<boolean> {
  if (!path) {
    return false;
  }

  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readGeminiSettings(
  env: NodeJS.ProcessEnv = process.env,
): Promise<GeminiCliSettings | null> {
  try {
    const file = join(getGeminiConfigDirectory(env), 'settings.json');
    const content = await readFile(file, 'utf8');
    return JSON.parse(content) as GeminiCliSettings;
  } catch {
    return null;
  }
}

function getAuthTypeFromEnvironment(env: NodeJS.ProcessEnv = process.env): GeminiAuthType | null {
  if (env['GOOGLE_GENAI_USE_GCA'] === 'true') {
    return 'oauth-personal';
  }

  if (env['GOOGLE_GENAI_USE_VERTEXAI'] === 'true') {
    return 'vertex-ai';
  }

  if (env['GEMINI_API_KEY']) {
    return 'gemini-api-key';
  }

  if (env['CLOUD_SHELL'] === 'true' || env['GEMINI_CLI_USE_COMPUTE_ADC'] === 'true') {
    return 'compute-default-credentials';
  }

  return null;
}

async function hasGeminiOauthCredentials(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const geminiDir = getGeminiConfigDirectory(env);
  return (
    await fileExists(join(geminiDir, 'oauth_creds.json'))
    || await fileExists(join(geminiDir, 'google_accounts.json'))
  );
}

async function hasGcloudAdc(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  return fileExists(join(getGcloudConfigDirectory(env, platform), 'application_default_credentials.json'));
}

async function getConfiguredGeminiAuthType(
  env: NodeJS.ProcessEnv = process.env,
): Promise<GeminiAuthType | null> {
  const envAuthType = getAuthTypeFromEnvironment(env);
  if (envAuthType) {
    return envAuthType;
  }

  const settings = await readGeminiSettings(env);
  const selectedType = settings?.security?.auth?.selectedType;
  return typeof selectedType === 'string' && selectedType.length > 0
    ? selectedType as GeminiAuthType
    : null;
}

export async function checkGeminiCliAuthentication(): Promise<GeminiCliAuthCheckResult> {
  const authType = await getConfiguredGeminiAuthType();
  if (!authType) {
    return {
      authenticated: false,
      message: 'Gemini CLI has no configured authentication method',
    };
  }

  if (authType === 'oauth-personal') {
    const hasOauthCredentials = await hasGeminiOauthCredentials();
    return hasOauthCredentials
      ? {
        authenticated: true,
        message: 'Gemini CLI authenticated via Google sign-in',
        metadata: { authType },
      }
      : {
        authenticated: false,
        message: 'Gemini CLI is configured for Google sign-in but cached credentials were not found',
        metadata: { authType },
      };
  }

  if (authType === 'gemini-api-key') {
    if (process.env['GEMINI_API_KEY']) {
      return {
        authenticated: true,
        message: 'Gemini CLI authenticated via GEMINI_API_KEY',
        metadata: { authType },
      };
    }

    return {
      authenticated: true,
      message: 'Gemini CLI configured to use a stored Gemini API key',
      metadata: { authType },
    };
  }

  if (authType === 'vertex-ai') {
    const hasProject = Boolean(process.env['GOOGLE_CLOUD_PROJECT'] || process.env['GOOGLE_CLOUD_PROJECT_ID']);
    const hasLocation = Boolean(process.env['GOOGLE_CLOUD_LOCATION']);
    const hasExpressApiKey = Boolean(process.env['GOOGLE_API_KEY']);
    const hasServiceAccount = await fileExists(process.env['GOOGLE_APPLICATION_CREDENTIALS']);
    const hasAdc = await hasGcloudAdc();

    if (hasExpressApiKey || (hasProject && hasLocation && (hasServiceAccount || hasAdc))) {
      return {
        authenticated: true,
        message: 'Gemini CLI authenticated via Vertex AI',
        metadata: {
          authType,
          hasProject,
          hasLocation,
          hasExpressApiKey,
          hasServiceAccount,
          hasAdc,
        },
      };
    }

    return {
      authenticated: false,
      message: 'Gemini CLI is configured for Vertex AI but the required project or credentials were not found',
      metadata: {
        authType,
        hasProject,
        hasLocation,
        hasExpressApiKey,
        hasServiceAccount,
        hasAdc,
      },
    };
  }

  if (authType === 'compute-default-credentials' || authType === 'cloud-shell') {
    const hasAdc = process.env['CLOUD_SHELL'] === 'true' || await hasGcloudAdc();
    return hasAdc
      ? {
        authenticated: true,
        message: 'Gemini CLI authenticated via application default credentials',
        metadata: { authType },
      }
      : {
        authenticated: false,
        message: 'Gemini CLI is configured for application default credentials but none were found',
        metadata: { authType },
      };
  }

  return {
    authenticated: true,
    message: `Gemini CLI configured to use ${authType}`,
    metadata: { authType },
  };
}
