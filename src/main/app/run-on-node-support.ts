import { detectAndroidIntent } from '../channels/android-intent';
import { isAndroidAutomationReady } from '../remote-node';
import type { Instance } from '../../shared/types/instance.types';
import type { CanonicalCliType, CliType as ConfiguredCliType } from '../../shared/types/settings.types';
import type { NodePlacementPrefs, WorkerNodeInfo } from '../../shared/types/worker-node.types';
import { filterProvidersForAutomation } from '../providers/automation-provider-exclusions';
export { assertNodeExecArgvPolicy } from './run-on-node-exec-policy';

/**
 * Pure support helpers for the `run_on_node` MCP tool implementation in
 * orchestrator-tools-step.ts, extracted to keep that file under the LOC
 * ceiling and to make spawn-time validation directly unit-testable.
 */

/**
 * Effective spawn depth of an instance for the recursion guard (claude2_todo
 * #18). Unifies the two lineage systems: locally-orchestrated children carry a
 * real `depth` (set from `parent.depth + 1`), while `run_on_node`-spawned
 * instances record their depth in `metadata.spawnDepth` (they deliberately
 * don't set `parentId`, to avoid coupling remote spawns to parent-termination
 * / hibernation cascades). The larger of the two wins.
 */
export function effectiveSpawnDepth(instance: Instance | undefined): number {
  if (!instance) return 0;
  const metaDepth = instance.metadata?.['spawnDepth'];
  const fromMeta = typeof metaDepth === 'number' && Number.isFinite(metaDepth) ? metaDepth : 0;
  const fromField = typeof instance.depth === 'number' && Number.isFinite(instance.depth) ? instance.depth : 0;
  return Math.max(fromMeta, fromField, 0);
}

export interface RunOnNodePlacementArgs {
  prompt: string;
  requiresBrowser?: boolean;
  requiresAndroid?: boolean;
  androidDeviceKind?: 'emulator' | 'physical' | 'any';
}

const EXPLICIT_SHARED_BROWSER_MARKERS = [
  'browser gateway',
  'extension-shared',
  'extension shared',
];
const MANAGED_BROWSER_MARKERS = [
  'worker-managed chrome',
  'worker managed chrome',
  'managed chrome profile',
  'chrome-devtools',
];
const MANAGED_EXISTING_TAB = /\bexisting\s+tabs?\s+in\s+(?:the\s+)?worker[- ]managed\s+chrome\s+profile\b/g;
const BROWSER_ACTION = /\b(?:access(?:es|ed|ing)?|click(?:s|ed|ing)?|clos(?:e|es|ed|ing)|control(?:s|led|ling)?|download(?:s|ed|ing)?|drive(?:s|n)?|driving|evaluat(?:e|es|ed|ing)|execut(?:e|es|ed|ing)|extract(?:s|ed|ing)?|fill(?:s|ed|ing)?|focus(?:es|ed|ing)?|input(?:s|ted|ting)?|inspect(?:s|ed|ing)?|list(?:s|ed|ing)?|navigat(?:e|es|ed|ing)|observ(?:e|es|ed|ing)|open(?:s|ed|ing)?|press(?:es|ed|ing)?|read(?:s|ing)?|reload(?:s|ed|ing)?|refresh(?:es|ed|ing)?|sav(?:e|es|ed|ing)|scroll(?:s|ed|ing)?|select(?:s|ed|ing)?|snapshot(?:s|ted|ting)?|screenshot(?:s|ted|ting)?|submit(?:s|ted|ting)?|switch(?:es|ed|ing)?|touch(?:es|ed|ing)?|typ(?:e|es|ed|ing)|upload(?:s|ed|ing)?|us(?:e|es|ed|ing))\b/;
const BENIGN_RECOVERY_PHRASE = /\b(?:do not use browser gateway|without browser gateway)\b/g;
const BENIGN_TAB_RECOVERY_PHRASE = /\b(?:do not touch tabs|without touching tabs)\b/g;
const BENIGN_UNTOUCHED_BROWSER_CLAUSE = /\bleave\s+(?:(?:the|all|every|any|shared|existing|logged\s+(?:in|on)|signed\s+in|authenticated|operator(?:['’]s)?|real|user\s+owned|already\s+open|currently\s+open)\s+)*(?:browser gateway|browsers?|chrome(?:\s+(?:browsers?|tabs?|sessions?|windows?|profiles?|pages?|webpages?))?|tabs?|sessions?|windows?|profiles?|pages?|webpages?|(?:microsoft\s+)?edge)\s+untouched\b/g;
const SAFE_RECOVERY_OPERATION = /\b(?:recover(?:ing)?|repair(?:ing)?|restart(?:ing)?)\s+(?:the\s+)?(?:existing\s+)?(?:(?:browser gateway\s+)?native\s+(?:messaging\s+)?host(?:\s+relay)?(?:\s+(?:process|service))?|extension\s+relay(?:\s+(?:process|service))?|relay(?:\s+(?:process|service))?)\b/g;
const SAFE_RECOVERY_MAINTENANCE = /\b(?:(?:check(?:s|ed|ing)?|inspect(?:s|ed|ing)?|list(?:s|ed|ing)?|read(?:s|ing)?|rotate(?:s|d|ing)?|verif(?:y|ies|ied|ying))\s+(?:the\s+)?(?:(?:native\s+(?:messaging\s+)?host|extension\s+relay|relay)(?:\s+(?:health|logs?|process(?:es)?|service|status(?:\s+files?)?|files?))?|logs?|process(?:es)?|status(?:\s+files?)?|files?)|extract(?:s|ed|ing)?\s+(?:the\s+)?(?:native\s+host|extension\s+relay|relay)\s+logs?|focus(?:es|ed|ing)?\s+on\s+(?:the\s+)?(?:native\s+host|extension\s+relay|relay)(?:\s+health)?)\b/g;
const SAFE_RECOVERY_PRONOUN_ACTION = /\b(?:(?:check(?:s|ed|ing)?|inspect(?:s|ed|ing)?|list(?:s|ed|ing)?|read(?:s|ing)?|rotate(?:s|d|ing)?|verif(?:y|ies|ied|ying))\s+(?:its|their)\s+(?:logs?|process(?:es)?|service|status(?:\s+files?)?|files?)|(?:archiv(?:e|es|ed|ing)|summariz(?:e|es|ed|ing))\s+(?:it|them|those)|report(?:s|ed|ing)?\s+its\s+status)\b/g;
const SAFE_RECOVERY_CONTEXT = /\b(?:during\s+(?:this\s+)?(?:repair|recovery)|for\s+this\s+repair)\b/g;
const SAFE_RECOVERY_CONNECTOR = /\b(?:and|but|only|please|then|while)\b/g;
const PROTECTED_RECOVERY_ANTECEDENT = /\b(?:browser gateway|browsers?|chrome|cookies?|edge|pages?|profiles?|sessions?|tabs?|webpages?|windows?)\b/g;
const PROCESS_RECOVERY_ANTECEDENT = /\b(?:extension\s+relay|files?|logs?|native\s+(?:messaging\s+)?host(?:\s+relay)?|process(?:es)?|relay(?:\s+(?:process|service))?|status(?:\s+files?)?)\b/g;

function normalizeBrowserPolicyPrompt(prompt: string): string {
  return prompt.replace(/[-‐-―−]+/gu, ' ');
}

function namesProtectedBrowserSurface(prompt: string): boolean {
  return /\b(?:browsers?|chrome|tabs?|sessions?|windows?|profiles?|pages?|webpages?|edge)\b/.test(
    normalizeBrowserPolicyPrompt(prompt),
  );
}

function namesProtectedSessionMarker(prompt: string): boolean {
  const normalizedPrompt = normalizeBrowserPolicyPrompt(prompt);
  return /\b(?:shared|existing|authenticated|personal|everyday|real)\b/.test(normalizedPrompt)
    || /\b(?:logged\s+(?:in|on)|signed\s+in)\b/.test(normalizedPrompt)
    || /\boperator(?:['’]s)?\b/.test(normalizedPrompt)
    || /\b(?:already|currently)\s+open\b/.test(normalizedPrompt)
    || /\buser\s+owned\b/.test(normalizedPrompt)
    || /\b(?:user['’]s|users['’])/.test(normalizedPrompt);
}

function namesExplicitSharedSessionSurface(prompt: string): boolean {
  const normalizedPrompt = normalizeBrowserPolicyPrompt(prompt);
  const hasAnyProtectedSurfaceNoun = namesProtectedBrowserSurface(normalizedPrompt);
  const hasAnyProtectedMarker = namesProtectedSessionMarker(normalizedPrompt);
  return hasAnyProtectedMarker && hasAnyProtectedSurfaceNoun;
}

type RecoveryAntecedent = 'process' | 'protected' | undefined;

function latestRecoveryAntecedent(
  clause: string,
  before: number,
  inherited: RecoveryAntecedent,
): RecoveryAntecedent {
  let latestIndex = -1;
  let latest = inherited;
  for (const [pattern, kind] of [
    [PROTECTED_RECOVERY_ANTECEDENT, 'protected'],
    [PROCESS_RECOVERY_ANTECEDENT, 'process'],
  ] as const) {
    for (const match of clause.matchAll(pattern)) {
      const index = match.index ?? 0;
      if (index < before && index >= latestIndex) {
        latestIndex = index;
        latest = kind;
      }
    }
  }
  return latest;
}

function parseSafeRecoveryClause(
  clause: string,
  inherited: RecoveryAntecedent,
): { safe: boolean; antecedent: RecoveryAntecedent } {
  const withoutSafePronouns = clause.replace(
    SAFE_RECOVERY_PRONOUN_ACTION,
    (match, offset: number) => latestRecoveryAntecedent(clause, offset, inherited) === 'process'
      ? ' '
      : match,
  );
  const residue = withoutSafePronouns
    .replace(BENIGN_RECOVERY_PHRASE, ' ')
    .replace(BENIGN_TAB_RECOVERY_PHRASE, ' ')
    .replace(BENIGN_UNTOUCHED_BROWSER_CLAUSE, ' ')
    .replace(SAFE_RECOVERY_OPERATION, ' ')
    .replace(SAFE_RECOVERY_MAINTENANCE, ' ')
    .replace(SAFE_RECOVERY_CONTEXT, ' ')
    .replace(SAFE_RECOVERY_CONNECTOR, ' ')
    .replace(/[,\s]+/g, '');
  return {
    safe: residue === '',
    antecedent: latestRecoveryAntecedent(clause, clause.length, inherited),
  };
}

function isSafeNativeHostRecoveryPrompt(prompt: string): boolean {
  const normalizedPrompt = normalizeBrowserPolicyPrompt(prompt);
  const clauses = normalizedPrompt
    .split(/[.;!?]+/)
    .map((clause) => clause.trim())
    .filter(Boolean);
  if (clauses.length === 0) return false;
  let antecedent: RecoveryAntecedent;
  for (const clause of clauses) {
    const parsed = parseSafeRecoveryClause(clause, antecedent);
    if (!parsed.safe) return false;
    antecedent = parsed.antecedent;
  }
  return true;
}

function isNativeHostRelayRecoveryRequest(prompt: string): boolean {
  const normalizedPrompt = normalizeBrowserPolicyPrompt(prompt);
  const requestsRecovery = /\b(?:recover|repair|restart)\b/.test(normalizedPrompt);
  const namesRelay = /\b(?:native (?:messaging )?host(?: relay)?|extension relay|relay (?:process|service))\b/.test(normalizedPrompt);
  return requestsRecovery && namesRelay;
}

/**
 * `run_on_node` injects worker-managed chrome-devtools. The Browser Gateway
 * and extension-shared tabs remain coordinator-owned even when the extension
 * itself is running on the target worker. Reject impossible placement before
 * creating an instance that can never satisfy its prompt.
 */
export function assertRunOnNodeUsesWorkerBrowserSurface(
  args: Pick<RunOnNodePlacementArgs, 'prompt'> & { node?: string },
): void {
  const prompt = args.prompt.toLowerCase().replace(/\s+/g, ' ').trim();
  const nativeHostRecovery = isNativeHostRelayRecoveryRequest(prompt);
  if (nativeHostRecovery) {
    if (isSafeNativeHostRecoveryPrompt(prompt)) {
      return;
    }
  } else {
    const policyPrompt = prompt;
    const namesBrowserGatewayTool = /\bbrowser\.(?:\*|[a-z][a-z0-9_]*\b)/.test(policyPrompt);
    const explicitlyShared = EXPLICIT_SHARED_BROWSER_MARKERS.some(
      (marker) => policyPrompt.includes(marker),
    );
    const explicitlyManaged = MANAGED_BROWSER_MARKERS.some(
      (marker) => policyPrompt.includes(marker),
    );
    const mentionsTab = /\btabs?\b/.test(policyPrompt);
    const requestsTabControl = BROWSER_ACTION.test(policyPrompt);
    const mentionsBrowserSurface = /\b(?:browser|chrome|tabs?)\b/.test(policyPrompt);
    const withoutManagedExistingTab = policyPrompt.replace(MANAGED_EXISTING_TAB, ' ');
    const removedManagedExistingTab = withoutManagedExistingTab !== policyPrompt;
    const namesSharedSessionSurface = namesExplicitSharedSessionSurface(withoutManagedExistingTab)
      || (removedManagedExistingTab && namesProtectedSessionMarker(withoutManagedExistingTab));
    const hasSharedTabIntent = requestsTabControl
      && mentionsBrowserSurface
      && (
        explicitlyShared
        || (mentionsTab && /\bchrome\b/.test(policyPrompt) && !explicitlyManaged)
      );
    if (
      !namesBrowserGatewayTool
      && !namesSharedSessionSurface
      && !explicitlyShared
      && !hasSharedTabIntent
    ) {
      return;
    }
  }
  const target = args.node?.trim() || 'the target worker';
  throw new Error(
    `run_on_node cannot access Browser Gateway or existing/shared Chrome tabs on ${target}. `
    + `The agent must stay on the coordinator and call Browser Gateway tools with computer: "${target}". `
    + 'Use run_on_node only for the worker-managed Chrome profile exposed through chrome-devtools.',
  );
}

export function buildRunOnNodePlacement(args: RunOnNodePlacementArgs): NodePlacementPrefs | undefined {
  const requiresAndroid = args.requiresAndroid ?? detectAndroidIntent(args.prompt);
  const placement: NodePlacementPrefs = {
    ...(args.requiresBrowser === true ? { requiresBrowser: true } : {}),
    ...(requiresAndroid
      ? {
          requiresAndroid: true,
          androidDeviceKind: args.androidDeviceKind ?? 'any',
        }
      : {}),
  };
  return Object.keys(placement).length > 0 ? placement : undefined;
}

export function assertNodeSatisfiesPlacement(
  node: WorkerNodeInfo,
  placement: NodePlacementPrefs | undefined,
): void {
  if (!placement) {
    return;
  }
  if (placement.requiresBrowser && !node.capabilities.hasBrowserMcp) {
    throw new Error(
      `Worker node "${node.name}" is not browser-automation ready. Enable browser automation or choose a node with hasBrowserMcp=true.`,
    );
  }
  if (placement.requiresAndroid && !isAndroidAutomationReady(node.capabilities)) {
    throw new Error(
      `Worker node "${node.name}" is not Android-automation ready. Enable Android automation and verify adb/AVD/device readiness before running this test.`,
    );
  }
  if (
    placement.requiresAndroid &&
    placement.androidDeviceKind === 'physical' &&
    !node.capabilities.androidAutomation?.connectedDevices.some((device) =>
      (device.kind === 'usb' || device.kind === 'wifi') && device.state === 'device'
    )
  ) {
    throw new Error(
      `Worker node "${node.name}" does not report an online physical Android device.`,
    );
  }
}

/**
 * Reject a run_on_node spawn whose CLI is not installed on the target node.
 *
 * Without this, the worker accepts the spawn RPC (on Windows the shell wrapper
 * even yields a live pid for a missing binary), the first turn dies silently,
 * and the caller gets an instance that goes idle with only its own prompt in
 * the buffer — a healthy node that looks broken. Nodes that predate CLI
 * capability reporting advertise an empty list and fail closed until they are
 * upgraded/reconnected with authoritative capabilities.
 */
export function assertNodeSupportsCli(
  node: WorkerNodeInfo,
  cliType: string,
  requestedExplicitly: boolean,
): void {
  const supported = node.capabilities?.supportedClis ?? [];
  if (supported.length === 0) {
    throw new Error(
      `run_on_node rejected: worker node "${node.name}" does not advertise any supported CLIs. `
      + 'Update/reconnect the worker before remote provider admission.',
    );
  }
  if (supported.some((cli) => cli.toLowerCase() === cliType.toLowerCase())) {
    return;
  }
  const available = supported.join(', ');
  const origin = requestedExplicitly
    ? `provider "${cliType}" is`
    : `no provider was given and the default resolved to "${cliType}", which is`;
  throw new Error(
    `run_on_node rejected: ${origin} not installed on worker node "${node.name}". `
    + `CLIs available on this node: ${available}. Pass one of those via "provider".`,
  );
}

type ConcreteProvider = Exclude<CanonicalCliType, 'auto'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function provesWorkerProviderAuthentication(
  value: unknown,
  expectedProvider: ConcreteProvider,
): boolean {
  if (!isRecord(value) || value['ok'] !== true || !isRecord(value['provider'])) return false;
  const diagnostic = value['provider'];
  return typeof diagnostic['provider'] === 'string'
    && diagnostic['provider'].toLowerCase() === expectedProvider
    && diagnostic['available'] === true
    && diagnostic['authenticated'] === true;
}

const RUN_ON_NODE_PROVIDER_ORDER: readonly ConcreteProvider[] = [
  'claude',
  'codex',
  'antigravity',
  'copilot',
  'cursor',
  'grok',
  'gemini',
];

/** Select and authenticate a provider from worker-local evidence only. */
export async function resolveRunOnNodeProvider(
  node: WorkerNodeInfo,
  requestedProvider: ConcreteProvider | undefined,
  configuredDefault: ConfiguredCliType,
  diagnose: (provider: ConcreteProvider) => Promise<unknown>,
): Promise<ConcreteProvider> {
  const advertised = node.capabilities?.supportedClis ?? [];
  if (advertised.length === 0) {
    assertNodeSupportsCli(node, requestedProvider ?? configuredDefault, requestedProvider !== undefined);
  }
  const advertisedByLower = new Map(
    advertised.map((provider) => [provider.toLowerCase(), provider.toLowerCase() as ConcreteProvider]),
  );
  const candidates = requestedProvider
    ? [requestedProvider]
    : [
        ...(configuredDefault !== 'auto' && advertisedByLower.has(configuredDefault)
          ? [configuredDefault as ConcreteProvider]
          : []),
        ...filterProvidersForAutomation(RUN_ON_NODE_PROVIDER_ORDER, 'run_on_node')
          .filter((provider) => advertisedByLower.has(provider)),
      ];
  const uniqueCandidates = [...new Set(candidates)];

  if (requestedProvider && !advertisedByLower.has(requestedProvider)) {
    assertNodeSupportsCli(node, requestedProvider, true);
  }
  for (const provider of uniqueCandidates) {
    let diagnostic: unknown;
    try {
      diagnostic = await diagnose(provider);
    } catch {
      if (requestedProvider) break;
      continue;
    }
    if (provesWorkerProviderAuthentication(diagnostic, provider)) {
      return provider;
    }
    if (requestedProvider) break;
  }

  const target = requestedProvider ? `Provider "${requestedProvider}"` : 'No advertised provider';
  throw new Error(
    `[cli_not_signed_in] ${target} is not proven signed in on worker node "${node.name}". `
    + 'Sign in on that worker or choose another advertised provider.',
  );
}
