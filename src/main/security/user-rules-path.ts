import * as path from 'path';

/**
 * Where the saved permission decisions live. An unpackaged app started with `AIO_DEV_USER_DATA_PATH` keeps them in
 * that profile, so a throwaway dev app can neither list nor remove the saved rules in the real
 * `~/.orchestrator/permissions.json`. A packaged app ignores the override, like `resolveHarnessUserDataPath`.
 */
export function resolveUserRulesFilePath(options: {
  home: string | null;
  isPackaged: boolean;
  env: Record<string, string | undefined>;
}): string | null {
  const devProfile = options.env['AIO_DEV_USER_DATA_PATH'];
  if (!options.isPackaged && devProfile) return path.join(devProfile, 'permissions.json');
  return options.home ? path.join(options.home, '.orchestrator', 'permissions.json') : null;
}
