/**
 * Advanced tab section data — the Runtime/Security/Data groupings and the
 * per-card setting-key definitions the tab renders. Pure data, no behaviour;
 * kept out of `advanced-settings-tab.component.ts` to stay under the repo's
 * LOC ratchet (`scripts/check-ts-max-loc.ts`).
 */

import type { AppSettings } from '../../../../shared/types/settings.types';
import type { SettingsSectionTab } from './settings-navigation';

export type AdvancedSection = 'runtime' | 'security' | 'data';

export const ADVANCED_SECTION_TABS: readonly SettingsSectionTab[] = [
  { id: 'runtime', label: 'Runtime', panelId: 'advanced-panel-runtime' },
  { id: 'security', label: 'Security', panelId: 'advanced-panel-security' },
  { id: 'data', label: 'Data', panelId: 'advanced-panel-data' },
];

export interface AdvancedSectionDefinition {
  id: string;
  title: string;
  description: string;
  group: AdvancedSection;
  keys: readonly (keyof AppSettings)[];
  /**
   * Credential-sensitive: rendered inside the danger-zone treatment at the
   * bottom of its group, per the plan's shared interaction rule 4.
   */
  dangerous?: boolean;
}

export const ADVANCED_SECTION_DEFINITIONS: readonly AdvancedSectionDefinition[] = [
  // --- Runtime ---
  {
    id: 'runtime-controls-heading',
    title: 'Runtime controls',
    description: 'Low-level tuning for the model, output parser, diagnostics, and how far instruction files scan. Leave these unless you\'re debugging a specific issue.',
    group: 'runtime',
    keys: [
      // 'customModelOverride' retired (S1.9): nothing reads it at runtime —
      // `migrateLegacyCustomModelOverride` moves any value into
      // `customModelsByProvider` and then clears it, so a value typed here
      // did nothing and then vanished. The key and its migration stay for
      // existing installs; only the control is gone.
      'parserBufferMaxKB',
      'commandDiagnosticsAvailable',
      'broadRootFileThreshold',
    ],
  },
  {
    id: 'chrome-devtools-attach-heading',
    title: 'Browser DevTools attach',
    description: 'Let agents drive a managed browser profile with the richer chrome-devtools tools after they sign in through the browser tools. Open and log into the managed profile first, then chrome-devtools connects to that same browser.',
    group: 'runtime',
    keys: [
      'chromeDevtoolsAttachEnabled',
      'chromeDevtoolsAttachProfileId',
    ],
  },
  {
    id: 'codemem-indexing-heading',
    title: 'Code memory indexing',
    description: 'Controls how agents look up symbols and structure in your code. Leave the defaults on unless the indexer is causing performance problems.',
    group: 'runtime',
    keys: [
      'codememEnabled',
      'codememIndexingEnabled',
      'codememLspWorkerEnabled',
      'codememPrewarmEnabled',
      'codememPrewarmMaxConcurrent',
      'codememPrewarmDebounceMs',
      'codememPrewarmStartupHint',
    ],
  },
  {
    id: 'legacy-codebase-index-heading',
    title: 'Legacy search index',
    description: 'An older, heavier full-text and embedding index. Most people should leave this off — it\'s mainly useful when debugging the legacy search path.',
    group: 'runtime',
    keys: [
      'codebaseAutoIndexEnabled',
      'codebaseAutoIndexMaxFiles',
      'codebaseAutoIndexMaxBytes',
      'codebaseAutoIndexConcurrent',
      'codebaseAutoIndexDebounceMs',
      'codebaseAutoIndexStartupHint',
    ],
  },
  {
    id: 'quota-pacing-heading',
    title: 'Quota pacing',
    description: 'Early warnings when a known provider quota window is being used faster than its time budget. Calendar and unknown windows are excluded because their elapsed time cannot be measured reliably.',
    group: 'runtime',
    keys: [
      'quotaPacingWarningEnabled',
      'quotaPacingUtilizationThresholdPercent',
      'quotaPacingLatestElapsedPercent',
    ],
  },
  {
    id: 'project-knowledge-mirror-heading',
    title: 'Knowledge Graph auto-build',
    description: 'Keeps the Knowledge Graph up to date as you work by copying code structure into it automatically. Leave the defaults unless the auto-build is too slow on large projects.',
    group: 'runtime',
    keys: [
      'projectKnowledgeAutoMirrorEnabled',
      'projectKnowledgeAutoMirrorDebounceMs',
      'projectKnowledgeAutoMirrorMaxConcurrent',
      'projectKnowledgeAutoMirrorSkipWithinMs',
      'projectKnowledgeAutoMirrorStartupHint',
    ],
  },
  {
    id: 'session-failover-heading',
    title: 'Session failover & handoff',
    description: 'How a session recovers when its current provider goes down or hits a limit: which providers to fall back to, how many automatic switches to allow, and how session context carries across a switch.',
    group: 'runtime',
    keys: [
      'sessionFailoverProviders',
      'sessionFailoverMaxSwitches',
      'sessionFailoverOfferAfterMinutes',
      'sessionHandoffStateEnabled',
      'claudeFallbackModel',
    ],
  },
  {
    id: 'tool-loading-heading',
    title: 'Tool loading',
    description: 'Loads a small core set of browser/orchestrator tool schemas up front and the rest on demand, to cut per-session context cost. Leave on unless an agent needs the full tool list every time.',
    group: 'runtime',
    keys: [
      'browserMcpToolDeferral',
      'orchestratorMcpToolDeferral',
    ],
  },
  {
    id: 'model-catalog-heading',
    title: 'Model catalog',
    description: 'Optional remote JSON catalog used to refresh available models instead of the built-in list. Requests still go through the app network policy.',
    group: 'runtime',
    keys: [
      'modelCatalogRemoteOverrideUrl',
    ],
  },
  // --- Security ---
  {
    id: 'instruction-trust-heading',
    title: 'Instruction & memory trust',
    description: 'Guards against prompt injection: the trust gate for repo instruction files (CLAUDE.md, AGENTS.md, …), and whether an agent\'s own memories can be treated as authoritative instructions.',
    group: 'security',
    keys: [
      'instructionTrustGate',
      'memoryInstructionGate',
    ],
  },
  {
    id: 'subprocess-environment-heading',
    title: 'Subprocess environment',
    description: 'Strips sensitive environment variables from commands the Claude CLI runs. Off by default because the scrub can also remove variables the approval hook and RTK rely on — verify those still work before enabling.',
    group: 'security',
    keys: [
      'claudeSubprocessEnvScrub',
    ],
  },
  {
    id: 'local-ai-guard-heading',
    title: 'Local AI paid-fallback guard',
    description: 'Guards against unexpected spend when a routed helper call falls back from a local model to a paid one: the fallback policy, an optional daily budget, and a confirmation threshold by input size.',
    group: 'security',
    keys: [
      'localAiGuardDefaultFallbackPolicy',
      'localAiGuardDailyFallbackBudgetUsd',
      'localAiGuardConfirmAboveInputTokens',
    ],
  },
  {
    id: 'credential-vault-heading',
    title: 'Credential vault',
    description: 'Where the browser credential vault reads its master password from, and whether it unlocks automatically at startup. Only the file path is stored here; the password itself is read at unlock time, kept in memory only, and never logged or shown.',
    group: 'security',
    dangerous: true,
    keys: [
      'browserVaultMasterPasswordFile',
      'browserVaultAutoUnlock',
    ],
  },
  {
    id: 'workspace-secrets-heading',
    title: 'Workspace secrets',
    description: 'Lets a session request a masked secret card instead of a plaintext value. Off refuses new requests and fails closed.',
    group: 'security',
    dangerous: true,
    keys: [
      'workspaceSecretsEnabled',
      'workspaceSecretsAllowAgentRequests',
    ],
  },
  {
    id: 'shared-tab-credentials-heading',
    title: 'Shared browser tab credentials',
    description: 'Whether an agent may fill saved credentials on your own shared Chrome tabs (not just its managed profiles), and whether a filled tab locks itself until you clear protection in the Harness extension.',
    group: 'security',
    dangerous: true,
    keys: [
      'browserAllowSharedTabCredentialFill',
      'browserSecretObservationProtectionEnabled',
    ],
  },
];
