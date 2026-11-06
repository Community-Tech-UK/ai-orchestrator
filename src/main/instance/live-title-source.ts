/** Ask the resident Claude process for a title; Harness owns persistence. */
import type { ClaudeControlReply } from '../cli/adapters/claude-control-channel';
import { recordModelCall } from '../core/system/model-call-recorder';

interface ControlCapableAdapter {
  requestControl?: (subtype: string, fields: Record<string, unknown>, timeoutMs: number) => Promise<ClaudeControlReply>;
  getAdapterCapabilities?: () => { residentSession?: boolean };
}

export interface LiveTitleAdapterSource {
  getAdapter(instanceId: string): unknown;
  /**
   * When provided, a Claude session that is still starting is waited for.
   * Without it only an adapter that is resident right now is asked.
   */
  getInstance?(instanceId: string): { provider?: string; status?: string; isRenamed?: boolean } | undefined;
}

/**
 * `createInstance` asks for the title before the adapter is registered and
 * before its process has a live pipe, so the first look finds no resident
 * session. Check again until it is resident, for at most this long.
 */
const RESIDENT_WAIT_MS = 120_000;
const RESIDENT_POLL_MS = 500;
/** A session in one of these states will not become resident for this title. */
const SESSION_GONE = new Set(['error', 'failed', 'terminated', 'cancelled', 'superseded',
  'hibernating', 'hibernated']);

type ResidentAdapter = ControlCapableAdapter & Required<Pick<ControlCapableAdapter, 'requestControl'>>;

function isResident(adapter: ControlCapableAdapter | undefined): adapter is ResidentAdapter {
  return Boolean(adapter?.requestControl && adapter.getAdapterCapabilities?.().residentSession);
}

/** A new instance carries 'auto' (or nothing) until init resolves its provider. */
function isUnresolvedProvider(provider: string | undefined): boolean {
  return !provider || provider === 'auto';
}

/**
 * Resolves the resident adapter, waiting while a Claude session is still being
 * created, including while its provider is still unresolved. Returns undefined
 * when there is none and none is coming: a provider resolved to another CLI, a
 * missing or ended instance, a rename, or the wait ran out.
 */
async function awaitResidentAdapter(
  source: LiveTitleAdapterSource,
  instanceId: string,
): Promise<ResidentAdapter | undefined> {
  const deadline = Date.now() + RESIDENT_WAIT_MS;
  for (;;) {
    const adapter = source.getAdapter(instanceId) as ControlCapableAdapter | undefined;
    const instance = source.getInstance?.(instanceId);
    // The user's name wins: do not spend a request on a title nobody will use.
    if (instance?.isRenamed) return undefined;
    if (isResident(adapter)) return adapter;
    if (!instance || SESSION_GONE.has(instance.status ?? '')) return undefined;
    // `createInstance` seeds the provider as 'auto' and writes the real one
    // later, during init; stop only once it is known not to be Claude.
    if (!isUnresolvedProvider(instance.provider) && instance.provider !== 'claude') return undefined;
    if (Date.now() >= deadline) return undefined;
    await new Promise<void>((resolve) => { setTimeout(resolve, RESIDENT_POLL_MS).unref?.(); });
  }
}

/**
 * Returns the title, or null when none was produced. The `helper/claude`
 * ledger row is recorded here, where it is known a request actually went to
 * the resident session: a chat with no resident Claude channel (a Codex chat,
 * a stopped session) makes no request and must leave no row behind.
 */
export async function requestLiveTitle(
  source: LiveTitleAdapterSource,
  instanceId: string,
  description: string,
): Promise<string | null> {
  const adapter = await awaitResidentAdapter(source, instanceId);
  if (!isResident(adapter)) return null;
  let title: string | null = null;
  try {
    const reply = await adapter.requestControl('generate_session_title',
      { description, persist: false }, 30_000);
    // `not-running` means the request never reached the CLI.
    if (!reply.ok && reply.code === 'not-running') return null;
    if (reply.ok) {
      const candidate = reply.payload['title'];
      title = typeof candidate === 'string' && candidate.trim() ? candidate : null;
    }
  } catch {
    title = null;
  }
  recordModelCall({ purpose: 'helper', taskType: 'aux:titleGeneration',
    provider: 'claude', instanceId, outcome: title ? 'success' : 'error' });
  return title;
}
