export type OpenCodeLatestVersionResolver = (currentVersion: string) => Promise<string | null>;

type UpdateArguments = { args: string[]; reason?: never } | { args?: never; reason: string };

function stableVersion(value: string | undefined | null): RegExpExecArray | null {
  if (!value || value !== value.trim()) return null;
  return /^(?:v)?(1|2)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
}

async function defaultResolveLatestVersion(currentVersion: string): Promise<string | null> {
  // cli-latest-version imports the update specifications. Load it only when a
  // v2 plan needs a target, after the update-service module has initialized.
  const { getCliLatestVersionService } = await import('./cli-latest-version');
  return getCliLatestVersionService().resolveLatestVersion('opencode', false, currentVersion);
}

/** Unlike v1, OpenCode 2's native updater accepts future majors without a flag. */
export async function resolveOpenCodeUpdateArgs(params: {
  activePath?: string;
  currentVersion?: string;
  realpath: (path: string) => string;
  resolveLatestVersion?: OpenCodeLatestVersionResolver;
}): Promise<UpdateArguments> {
  const paths = params.activePath ? [params.activePath] : [];
  if (params.activePath) {
    try { paths.push(params.realpath(params.activePath)); } catch { /* Keep the original path when it cannot be resolved. */ }
  }
  const normalizedPaths = paths.map((path) => path.replaceAll('\\', '/').toLowerCase());
  if (normalizedPaths.some((path) => /\.app\/contents\//.test(path) || /ai\.opencode\.desktop\/cli\//.test(path))) {
    return { reason: 'This OpenCode is managed by the desktop app. Update it through the desktop app.' };
  }
  const current = stableVersion(params.currentVersion);
  if (!current) return { reason: 'The installed version of OpenCode could not be confirmed as a stable 1.x or 2.x release. Check the install before updating.' };
  // OpenCode 1's native updater independently refuses a major upgrade unless
  // --major is supplied. Preserve that established update path.
  if (current[1] === '1') return { args: ['upgrade'] };
  if (normalizedPaths.some((path) => path.includes('/cellar/'))) {
    return { reason: 'Homebrew OpenCode updates cannot guarantee the same major version. Review and update this install through Homebrew.' };
  }
  let latest: string | null;
  try { latest = await (params.resolveLatestVersion ?? defaultResolveLatestVersion)(params.currentVersion!); }
  catch { latest = null; }
  const target = stableVersion(latest);
  if (target?.[1] !== '2') {
    return { reason: 'A stable OpenCode 2.x update could not be confirmed. No update was run.' };
  }
  const installedParts = current.slice(1).map(Number);
  const targetParts = target.slice(1).map(Number);
  const difference = targetParts.map((part, index) => part - installedParts[index]!).find((delta) => delta !== 0) ?? 0;
  if (difference < 0) return { reason: 'The published OpenCode 2.x version is older than the installed version. No downgrade was run.' };
  return { args: ['upgrade', latest!.replace(/^v/, '')] };
}
