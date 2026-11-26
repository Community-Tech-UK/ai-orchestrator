import type { InstanceCreateConfig } from '../../../shared/types/instance.types';
import type { ExecutionLocation, WorkerNodeInfo } from '../../../shared/types/worker-node.types';
import { providerName } from '../../../shared/display-names';
import type { WorkerNodeRegistry } from '../../remote-node/worker-node-registry';
import { nodeHasFolder, nodeSignInState } from '../../remote-node/node-eligibility';
import { getProviderAccountRoutingService } from '../../providers/account-pool/provider-account-routing-service';
import { resolveExecutionLocation } from './execution-location-resolver';
import { resolveModelCandidate } from './model-selection-resolver';
import { getLogger } from '../../logging/logger';

const logger = getLogger('DefaultComputerPlacement');

type PlacementRegistry = Pick<WorkerNodeRegistry, 'getNode' | 'selectNode' | 'getHealthyNodes' | 'getComputerChoices'>;

export interface SessionPlacement {
  location: ExecutionLocation;
  /**
   * Set when a computer was chosen because it is signed in to this account. The session must run on exactly this
   * account: the pool picks again at spawn time with the model it resolves by then, and could pick another account
   * that this computer isn't signed in to.
   */
  accountProfileId?: string;
  /** Set when the session asked for another computer and ended up on this Mac: one plain sentence saying why. */
  stayedHereBecause?: string;
  /** True with `stayedHereBecause` when the computers are only busy, paused or away, so waiting for one could work. */
  mightWaitForComputer?: boolean;
}

/** Why no computer can run the session, and whether that may pass (busy, paused, away) or is lasting (no tool, sign-in or folder). */
interface NoComputer { reason: string; soon: boolean }

/** The first thing that rules out every computer, in the order the session needs them. */
function whyNoComputer(
  nodes: readonly WorkerNodeInfo[],
  choices: ReturnType<PlacementRegistry['getComputerChoices']>,
  tool: 'claude' | 'codex',
  profileId: string,
  folder: string,
): NoComputer {
  if (nodes.length === 0) return { reason: 'no other computer is connected', soon: true };
  const choiceOf = (node: WorkerNodeInfo) => choices.find(entry => entry.id === node.id);
  const takes = nodes.filter(node => !choiceOf(node)?.paused && choiceOf(node)?.sessions !== false);
  if (takes.length === 0) {
    return { reason: 'no other computer is set to take agent sessions', soon: nodes.some(node => choiceOf(node)?.paused) };
  }
  const room = takes.filter(node => node.activeInstances < node.capabilities.maxConcurrentInstances);
  if (room.length === 0) return { reason: 'every other computer that takes sessions is full', soon: true };
  const hasTool = room.filter(node => node.capabilities.supportedClis.includes(tool));
  if (hasTool.length === 0) return { reason: `${providerName(tool)} isn't installed on any other computer that has room`, soon: false };
  const states = hasTool.map(node => nodeSignInState(node.capabilities, tool, profileId));
  if (!states.includes('signed-in')) {
    return states.every(state => state === 'signed-out')
      ? { reason: `${providerName(tool)} isn't signed in on any other computer that has room`, soon: false }
      : { reason: `Harness can't tell yet whether ${providerName(tool)} is signed in on the other computers`, soon: true };
  }
  if (!hasTool.some(node => nodeSignInState(node.capabilities, tool, profileId) === 'signed-in' && nodeHasFolder(node.capabilities, folder))) {
    return { reason: "no other computer that's signed in has this folder", soon: false };
  }
  return { reason: 'no other computer suited it', soon: false };
}

/**
 * Where a brand-new session starts. A session that names a computer, or a placement, is placed as before. One that only
 * asked for "a computer that takes agent sessions" gets one that can run it now: it takes sessions, has room, has the
 * tool signed in for the account the session would use, and has the folder. Otherwise it stays on this Mac and says why.
 *
 * `agentModelOverride` is the model the session's agent pins. The pool is asked about the model the session will really
 * run with on another computer (the one it named, else the agent's), because that decides which account it picks.
 *
 * Only Claude and Codex sessions qualify, because they are the two whose sign-in a computer reports. A session that
 * can't be moved safely never asks: restored and resumed sessions, and anything that needs this Mac's own tools.
 */
export function resolveNewSessionPlacement(
  config: InstanceCreateConfig,
  settingsDefaultCli: string | undefined,
  agentModelOverride?: string | null,
  registryOverride?: PlacementRegistry,
): SessionPlacement {
  if (!config.preferOtherComputer || config.forceNodeId || config.nodePlacement || config.modelRuntimeTarget) {
    return { location: resolveExecutionLocation(config, registryOverride) };
  }
  const here = (reason: string, mightWait = false): SessionPlacement => {
    logger.info('Session stays on this Mac', { reason });
    return { location: { type: 'local' }, stayedHereBecause: reason, ...(mightWait ? { mightWaitForComputer: true } : {}) };
  };
  if (config.computerRule?.stayHere) return here(config.computerRule.stayHere);
  const requested = config.provider && config.provider !== 'auto' ? config.provider : settingsDefaultCli;
  if (requested !== 'claude' && requested !== 'codex') {
    return here('only Claude and Codex sessions can start on another computer by themselves');
  }
  if (config.additionalDirectories?.length) return here('it uses extra folders');

  let registry: PlacementRegistry;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    registry = registryOverride ?? require('../../remote-node').getWorkerNodeRegistry();
  } catch {
    return here('the other computers can\'t be reached');
  }
  // The account that will run the session: the one named, else the one the pool picks for a new session. A computer
  // takes no remembered or global default model, so only the session's own and its agent's choice count.
  const model = resolveModelCandidate({
    provider: requested,
    configModelOverride: config.modelOverride,
    agentModelOverride,
  }).model ?? null;
  const profileId = config.accountProfileId ?? getProviderAccountRoutingService().peekNewSessionProfileId({
    provider: requested,
    model,
    origin: config.accountRouteOrigin ?? (config.metadata?.['automationId'] ? 'automation' : 'interactive'),
    restrictTo: config.allowedAccountProfileIds,
    avoid: config.accountPreferences?.avoid,
    useLast: config.accountPreferences?.last,
  });
  if (profileId === null) return here(`no ${providerName(requested)} account can run it`);
  const node = registry.selectNode({
    requiresCli: requested,
    requiresSignIn: { provider: requested, profileId },
    requiresFolderUnder: config.workingDirectory,
    ...(config.computerRule ? { limitToNodeIds: config.computerRule.onlyNodeIds } : {}),
  });
  if (node) {
    logger.info('Resolved execution location', { type: 'remote', reason: 'defaultComputer', nodeId: node.id });
    return { location: { type: 'remote', nodeId: node.id }, accountProfileId: profileId };
  }
  const candidates = registry.getHealthyNodes().filter(candidate => !config.computerRule || config.computerRule.onlyNodeIds.includes(candidate.id));
  const why = whyNoComputer(candidates, registry.getComputerChoices(), requested, profileId, config.workingDirectory);
  return here(why.reason, why.soon);
}

/**
 * The session may use only the computers its `computerRule` names, and every one that could take it is busy, paused or
 * away. Starting it here would break the rule, so creation refuses and the caller puts the job back to waiting.
 */
export class ComputerBusyError extends Error {
  constructor(reason: string) { super(`Waiting for the test Mac: ${reason}`); this.name = 'ComputerBusyError'; }
}

/** Throws `ComputerBusyError` when `placement` would put a rule-bound session on this Mac only because the computers are busy. */
export function refuseToRunHereWhileWaiting(config: InstanceCreateConfig, placement: SessionPlacement): void {
  if (config.computerRule && placement.location.type === 'local' && placement.mightWaitForComputer) {
    throw new ComputerBusyError(placement.stayedHereBecause ?? 'the computers are busy');
  }
}

/** The one quiet line a session shows when it asked for another computer and stayed here. */
export function stayedHereMessage(reason: string): string {
  return `Running on this Mac: ${reason}.`;
}
