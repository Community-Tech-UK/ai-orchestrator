import type { CliUpdatePlan } from './cli-update-service';
import { resolveOpenCodeUpdateArgs } from './opencode-update-policy';

function stableVersion(output: string | undefined): string | undefined {
  const match = /^(?:opencode\s+)?v?((?:1|2)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/i.exec(output?.trim() ?? '');
  return match?.[1];
}

/** Called inside both update locks; never rediscover or substitute another install. */
export async function validateOpenCodeUpdateExecution(params: {
  plan: Pick<CliUpdatePlan, 'activePath' | 'command' | 'args' | 'currentVersion'>;
  exists: (path: string) => boolean;
  realpath: (path: string) => string;
  version: (command: string) => Promise<string>;
}): Promise<void> {
  const { plan } = params;
  const selected = plan.activePath;
  if (!selected || selected !== plan.command || !params.exists(selected)) {
    throw new Error('The selected OpenCode install changed or is missing. Check the install and retry the update.');
  }
  let resolved: string;
  let current: string | undefined;
  try {
    resolved = params.realpath(selected);
    current = stableVersion(await params.version(selected));
    if (!params.exists(selected) || params.realpath(selected) !== resolved) {
      throw new Error('Selected install changed during its version check.');
    }
  } catch {
    // A native failure can include arbitrary stdout/stderr. Keep it private.
    throw new Error('The selected OpenCode install or its version could not be confirmed. Check the install and retry the update.');
  }
  if (!current || current !== stableVersion(plan.currentVersion)) {
    throw new Error('The selected OpenCode version changed or could not be confirmed. Check the install and retry the update.');
  }
  const policy = await resolveOpenCodeUpdateArgs({
    activePath: selected, currentVersion: current, realpath: () => resolved,
    // Revalidate the already approved target, without a second registry lookup.
    resolveLatestVersion: async () => plan.args?.[1] ?? null,
  });
  if (!policy.args) throw new Error(policy.reason);
  if (!plan.args || policy.args.length !== plan.args.length || policy.args.some((arg, index) => arg !== plan.args![index])) {
    throw new Error('The OpenCode update target changed. Check the install and retry the update.');
  }
}
