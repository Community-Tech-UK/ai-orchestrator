/**
 * Which browser computer a session's browser work goes to when it names none. A session keeps the computer it used
 * last, so its tabs stay together. A session choosing afresh goes where a tab on the same website is already open,
 * since that website's sign-in is likely there; otherwise to the computer the fewest sessions are using, then the
 * Computers page's order, then a Windows computer, as it was before there were several. As with the rest of the
 * Computers page, pausing a computer stops new sessions going there; a session already using it stays.
 *
 * Held in memory only: after a restart every session chooses afresh, which loses nothing that matters.
 */
import type { BrowserTarget } from '@contracts/types/browser';
import type { ComputerChoice } from '../../shared/types/settings.types';
import type { WorkerNodeInfo } from '../../shared/types/worker-node.types';

/** A session that has used no browser for this long chooses afresh, and stops counting towards its computer. */
export const BROWSER_SESSION_IDLE_MS = 30 * 60_000;

interface BrowserUse {
  nodeId: string;
  lastUsedAt: number;
}

export interface BrowserComputerRequest {
  instanceId: string;
  /** Connected computers; only those with browser automation are chosen, and only unpaused ones for a new session. */
  nodes: readonly WorkerNodeInfo[];
  choices: readonly ComputerChoice[];
  targets: readonly BrowserTarget[];
  /** The website the request is about, when it names one. */
  origin?: string;
  now: number;
}

/** Connected computers with browser automation, paused or not. */
export function browserComputers(nodes: readonly WorkerNodeInfo[]): WorkerNodeInfo[] {
  return nodes.filter(node => node.capabilities.hasBrowserMcp);
}

/** Of those, the ones a new session may go to. */
function unpaused(computers: readonly WorkerNodeInfo[], choices: readonly ComputerChoice[]): WorkerNodeInfo[] {
  const paused = new Set(choices.filter(choice => choice.paused).map(choice => choice.id));
  return computers.filter(node => !paused.has(node.id));
}

export class BrowserComputerBalancer {
  private readonly uses = new Map<string, BrowserUse>();

  /** A session used this computer, by choice or by name, so it stays there. */
  noteUse(instanceId: string, nodeId: string, now: number): void {
    this.uses.set(instanceId, { nodeId, lastUsedAt: now });
  }

  /** The computer for this request, remembered for the session; none when no computer can take a new session. */
  choose(request: BrowserComputerRequest): WorkerNodeInfo | undefined {
    this.forgetIdle(request.now);
    const own = this.uses.get(request.instanceId);
    const open = unpaused(browserComputers(request.nodes), request.choices);
    const chosen = browserComputers(request.nodes).find(node => node.id === own?.nodeId)
      ?? this.leastUsed(open.filter(node => hasOpenTab(request.targets, node.id, request.origin)), request)
      ?? this.leastUsed(open, request);
    if (chosen) this.noteUse(request.instanceId, chosen.id, request.now);
    return chosen;
  }

  /** The computer this session would keep, if it still can take browser work. Chooses nothing new. */
  current(instanceId: string, computers: readonly WorkerNodeInfo[], now: number): WorkerNodeInfo | undefined {
    this.forgetIdle(now);
    const own = this.uses.get(instanceId);
    return computers.find(node => node.id === own?.nodeId);
  }

  private leastUsed(computers: readonly WorkerNodeInfo[], request: BrowserComputerRequest): WorkerNodeInfo | undefined {
    const sessions = (nodeId: string) => [...this.uses].filter(([id, use]) => id !== request.instanceId && use.nodeId === nodeId).length;
    const rank = (nodeId: string) => {
      const at = request.choices.findIndex(choice => choice.id === nodeId);
      return at < 0 ? Number.MAX_SAFE_INTEGER : at;
    };
    return [...computers].sort((a, b) =>
      sessions(a.id) - sessions(b.id)
      || rank(a.id) - rank(b.id)
      || Number(b.capabilities.platform === 'win32') - Number(a.capabilities.platform === 'win32')
      || a.name.localeCompare(b.name))[0];
  }

  private forgetIdle(now: number): void {
    for (const [instanceId, use] of this.uses) {
      if (now - use.lastUsedAt >= BROWSER_SESSION_IDLE_MS) this.uses.delete(instanceId);
    }
  }
}

function hasOpenTab(targets: readonly BrowserTarget[], nodeId: string, origin: string | undefined): boolean {
  return origin !== undefined && targets.some(target => target.nodeId === nodeId && target.origin === origin && !target.stale);
}

/** The website a URL is on, or none for anything that isn't one. */
export function originOf(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  try {
    const { origin } = new URL(url);
    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
}
