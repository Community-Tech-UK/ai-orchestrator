import { existsSync, readFileSync } from 'node:fs';

const PROC_SELF_ENVIRON_PATH = '/proc/self/environ';

export interface ProviderEnvReadOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly procEnvironPath?: string;
}

export function readProviderEnv(
  name: string,
  options: ProviderEnvReadOptions = {},
): string | undefined {
  if (!isValidEnvName(name)) {
    return undefined;
  }

  const env = options.env ?? process.env;
  const processEnvValue = env[name];
  if (processEnvValue !== undefined) {
    return processEnvValue;
  }

  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    return undefined;
  }

  return readProcEnvironValue(name, options.procEnvironPath ?? PROC_SELF_ENVIRON_PATH);
}

function isValidEnvName(name: string): boolean {
  return name.length > 0 && !name.includes('=') && !name.includes('\0');
}

function readProcEnvironValue(name: string, procEnvironPath: string): string | undefined {
  try {
    if (!existsSync(procEnvironPath)) {
      return undefined;
    }

    const environ = readFileSync(procEnvironPath, 'utf8');
    return findEnvEntry(environ, name);
  } catch {
    return undefined;
  }
}

function findEnvEntry(environ: string, name: string): string | undefined {
  const prefix = `${name}=`;

  for (const entry of environ.split('\0')) {
    if (entry.startsWith(prefix)) {
      return entry.slice(prefix.length);
    }
  }

  return undefined;
}
