/**
 * The live, per-account Copilot model roster.
 *
 * `copilot help config` prints a roster compiled into the CLI build, not what
 * the signed-in seat serves, so it lags GitHub. Measured 2026-09-23 on CLI
 * 1.0.88: it omitted `claude-opus-5.5`, `gpt-6-sol` and `gpt-6-luna` while the
 * seats already served them. The bundled SDK's `models.list` asks GitHub what
 * THIS account may use.
 *
 * That makes it an authenticated request, so the account-routing spec applies:
 * the SDK runtime receives the resolved profile home and a sanitized
 * environment through its constructor options (§10.3, no process-global
 * mutation), and callers cache the result per profile (§14.4). There is no
 * unrouted variant — an ambient `~/.copilot` query would report whichever
 * account last ran `/login` there.
 */

import { buildCopilotSpawnEnv, COPILOT_STRIPPED_AUTH_ENV_VARS } from '../adapter-spawn-helpers';
import { loadCopilotSdk, type LoadedCopilotSdk } from './copilot-sdk-loader';

/** Runtime spawn + auth + one API call measured ~0.6s; this bounds a wedged runtime. */
export const COPILOT_LIVE_MODEL_LIST_TIMEOUT_MS = 10_000;

export interface CopilotLiveModelListOptions {
  /** Resolved profile home (becomes the runtime's `COPILOT_HOME`). */
  homeDir: string;
  /** Normalized profile host, forwarded as `COPILOT_GH_HOST`. */
  host?: string;
  /** Injected for tests; defaults to the SDK bundled with the installed CLI. */
  sdk?: LoadedCopilotSdk | null;
  timeoutMs?: number;
}

/**
 * Ids the seat will serve. A model whose policy is `disabled` or
 * `unconfigured` (awaiting the user's enablement in GitHub) is left out;
 * entries with no policy, such as `auto`, are served unconditionally.
 */
export function liveCopilotModelIds(models: readonly unknown[]): string[] {
  const ids: string[] = [];
  for (const model of models) {
    if (typeof model !== 'object' || model === null) continue;
    const { id, policy } = model as { id?: unknown; policy?: { state?: unknown } };
    if (typeof id !== 'string' || !id.trim()) continue;
    const state = policy?.state;
    if (state !== undefined && state !== 'enabled') continue;
    ids.push(id.trim());
  }
  return ids;
}

export async function listCopilotLiveModelIds(options: CopilotLiveModelListOptions): Promise<string[]> {
  const sdk = options.sdk === undefined ? loadCopilotSdk() : options.sdk;
  if (!sdk) {
    throw new Error('Copilot SDK unavailable');
  }

  const env: Record<string, string | undefined> = {
    ...buildCopilotSpawnEnv(),
    COPILOT_HOME: options.homeDir,
    ...(options.host ? { COPILOT_GH_HOST: options.host } : {}),
  };
  // buildCopilotSpawnEnv already strips these; restated so this function's
  // own contract does not depend on that helper's internals.
  for (const key of COPILOT_STRIPPED_AUTH_ENV_VARS) {
    delete env[key];
  }

  const client = new sdk.CopilotClient({
    connection: { kind: 'stdio', path: sdk.cliPath },
    baseDirectory: options.homeDir,
    env,
    logLevel: 'none',
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error('Timeout listing live Copilot models'));
    }, options.timeoutMs ?? COPILOT_LIVE_MODEL_LIST_TIMEOUT_MS);
  });

  try {
    const models = await Promise.race([
      (async () => {
        if (typeof client.start !== 'function' || typeof client.listModels !== 'function') {
          throw new Error('Copilot SDK does not support listing models');
        }
        await client.start();
        return client.listModels();
      })(),
      timeout,
    ]);
    return liveCopilotModelIds(models);
  } finally {
    clearTimeout(timer);
    // A timed-out runtime may not answer a graceful stop; never leak it.
    const teardown = timedOut && client.forceStop ? client.forceStop() : client.stop();
    await teardown.catch(() => undefined);
  }
}
