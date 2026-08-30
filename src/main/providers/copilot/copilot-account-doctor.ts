/**
 * Doctor reporting for GitHub Copilot account routing (spec §14.1, §14.2).
 *
 * Two distinct notions of "is Copilot authenticated?" live here, and conflating
 * them is the bug this file exists to avoid:
 *
 *  - the AGGREGATE provider status shown on the Doctor card — available /
 *    partially configured / auth-required across all profiles; and
 *  - the PER-PROFILE status, which is what session admission uses.
 *
 * A session is admitted on its resolved profile's status, never the aggregate.
 * "Some account is signed in" is not permission to run this workspace's
 * request through it.
 *
 * Everything reported here is secret-free: profile labels, logins, hosts,
 * policy names, and the NAMES (never values) of ambient token variables.
 */

import type {
  CopilotAccountBindingStatus,
  CopilotAccountProfile,
  CopilotAccountRoutingRule,
} from '../../../shared/types/copilot-account.types';
import {
  COPILOT_LEGACY_PROFILE_ID,
  normalizeCopilotProfileHost,
  normalizeCopilotRuleHost,
} from '../../../shared/types/copilot-account.types';
import { COPILOT_STRIPPED_AUTH_ENV_VARS } from '../../cli/adapters/adapter-spawn-helpers';
import { getSettingsManager } from '../../core/config/settings-manager';
import {
  LOCAL_COPILOT_NODE_ID,
  getCopilotAccountBindingService,
} from './copilot-account-binding-service';

export type CopilotAggregateAuthState =
  | 'available'
  | 'partially-configured'
  | 'auth-required'
  | 'not-configured';

export interface CopilotProfileDoctorEntry {
  profileId: string;
  label: string;
  /** Identity AIO expects; `null` until the first verified login. */
  expectedLogin: string | null;
  host: string;
  accountKind: CopilotAccountProfile['accountKind'];
  scopePolicy: CopilotAccountProfile['scopePolicy'];
  automationPolicy: CopilotAccountProfile['automationPolicy'];
  isDefault: boolean;
  /** Node-local binding state on the node this report was produced on. */
  bindingState: CopilotAccountBindingStatus['state'];
  observedLogin?: string;
  observedHost?: string;
  /** F4: this profile writes tokens to disk in plaintext. */
  storesTokenPlaintext?: boolean;
  /** True for the migration-created profile bound to the pre-existing home. */
  isLegacy: boolean;
}

export interface CopilotAccountDoctorReport {
  aggregate: CopilotAggregateAuthState;
  nodeId: string;
  profiles: CopilotProfileDoctorEntry[];
  /** Rules pointing at a profile that no longer exists. */
  unreachableRuleIds: string[];
  /** Rule IDs sharing a matcher with another rule for a DIFFERENT profile. */
  conflictingRuleIds: string[];
  /** Set when a default is configured but cannot serve unmatched workspaces. */
  invalidDefaultReason?: string;
  /**
   * Ambient GitHub token variables present in this process, BY NAME ONLY.
   * They are stripped from every Copilot child (see
   * `COPILOT_STRIPPED_AUTH_ENV_VARS`); reporting them explains why a token the
   * user set has no effect.
   */
  ambientTokenVariablesPresent: string[];
  /** True while the pre-multi-profile `copilot-cli-home` is still in use. */
  legacyMigrationInUse: boolean;
  warnings: string[];
}

function readSettings(): {
  profiles: CopilotAccountProfile[];
  rules: CopilotAccountRoutingRule[];
} {
  try {
    const settings = getSettingsManager().getAll();
    return {
      profiles: Array.isArray(settings.copilotAccountProfiles)
        ? settings.copilotAccountProfiles
        : [],
      rules: Array.isArray(settings.copilotAccountRoutingRules)
        ? settings.copilotAccountRoutingRules
        : [],
    };
  } catch {
    return { profiles: [], rules: [] };
  }
}

function matcherKey(rule: CopilotAccountRoutingRule): string {
  const matcher = rule.matcher;
  switch (matcher.type) {
    case 'repository':
      return `repository:${matcher.host}/${matcher.owner}/${matcher.repo}`.toLowerCase();
    case 'owner':
      return `owner:${matcher.host}/${matcher.owner}`.toLowerCase();
    case 'path-prefix':
      return `path-prefix:${matcher.canonicalPath}`;
  }
}

/** Ambient GitHub token variables present, by NAME only — never a value. */
export function detectAmbientCopilotTokenVariables(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return COPILOT_STRIPPED_AUTH_ENV_VARS.filter((name) => {
    const value = env[name];
    return typeof value === 'string' && value.length > 0;
  });
}

export interface CopilotAccountDoctorDeps {
  readSettings?: typeof readSettings;
  checkBinding?: (
    profile: CopilotAccountProfile,
    nodeId: string,
  ) => Promise<CopilotAccountBindingStatus>;
  env?: NodeJS.ProcessEnv;
  nodeId?: string;
}

export async function buildCopilotAccountDoctorReport(
  deps: CopilotAccountDoctorDeps = {},
): Promise<CopilotAccountDoctorReport> {
  const nodeId = deps.nodeId ?? LOCAL_COPILOT_NODE_ID;
  // Repaired here rather than inside the default reader so an INJECTED reader
  // gets the same treatment: `matcherKey` below embeds the host, so a
  // scheme-prefixed legacy record keys differently from an equivalent new rule
  // and silently defeats duplicate detection.
  const raw = (deps.readSettings ?? readSettings)();
  const profiles = raw.profiles.map(normalizeCopilotProfileHost);
  const rules = raw.rules.map(normalizeCopilotRuleHost);
  const checkBinding =
    deps.checkBinding
    ?? ((profile: CopilotAccountProfile, node: string) =>
      getCopilotAccountBindingService().checkBinding(profile, node));

  const entries: CopilotProfileDoctorEntry[] = [];
  const warnings: string[] = [];

  for (const profile of profiles) {
    const binding = await checkBinding(profile, nodeId);
    const isLegacy = profile.isLegacy === true || profile.id === COPILOT_LEGACY_PROFILE_ID;
    entries.push({
      profileId: profile.id,
      label: profile.label,
      expectedLogin: profile.expectedLogin,
      host: profile.host,
      accountKind: profile.accountKind,
      scopePolicy: profile.scopePolicy,
      automationPolicy: profile.automationPolicy,
      isDefault: profile.isDefault,
      bindingState: binding.state,
      ...(binding.observedLogin ? { observedLogin: binding.observedLogin } : {}),
      ...(binding.observedHost ? { observedHost: binding.observedHost } : {}),
      ...(binding.storesTokenPlaintext !== undefined
        ? { storesTokenPlaintext: binding.storesTokenPlaintext }
        : {}),
      isLegacy,
    });
    if (binding.storesTokenPlaintext) {
      warnings.push(
        `Copilot account "${profile.label}" is configured to store its token in plaintext on disk. `
        + 'Turn off `storeTokenPlaintext` in that profile’s Copilot settings and sign in again.',
      );
    }
    if (binding.state === 'identity-mismatch') {
      warnings.push(
        `Copilot account "${profile.label}" is signed in as a different GitHub identity than expected. `
        + 'Reauthenticate it, or explicitly adopt the observed account.',
      );
    }
  }

  const profileIds = new Set(profiles.map((profile) => profile.id));
  const unreachableRuleIds = rules
    .filter((rule) => !profileIds.has(rule.profileId))
    .map((rule) => rule.id);

  const byMatcher = new Map<string, CopilotAccountRoutingRule[]>();
  for (const rule of rules) {
    const key = matcherKey(rule);
    byMatcher.set(key, [...(byMatcher.get(key) ?? []), rule]);
  }
  const conflictingRuleIds = [...byMatcher.values()]
    .filter((group) => new Set(group.map((rule) => rule.profileId)).size > 1)
    .flatMap((group) => group.map((rule) => rule.id));

  const defaultProfile = profiles.find((profile) => profile.isDefault);
  const invalidDefaultReason = (() => {
    if (profiles.length === 0) return undefined;
    if (!defaultProfile) {
      return 'No default Copilot account is set, so an unmatched workspace cannot be routed.';
    }
    if (defaultProfile.scopePolicy !== 'default-eligible') {
      return `The default Copilot account "${defaultProfile.label}" is matched-only and cannot service unmatched workspaces.`;
    }
    if (defaultProfile.automationPolicy === 'disabled') {
      return `The default Copilot account "${defaultProfile.label}" is disabled.`;
    }
    return undefined;
  })();
  if (invalidDefaultReason) {
    warnings.push(invalidDefaultReason);
  }
  if (unreachableRuleIds.length > 0) {
    warnings.push(
      `${unreachableRuleIds.length} Copilot routing rule(s) point at an account that no longer exists.`,
    );
  }
  if (conflictingRuleIds.length > 0) {
    warnings.push(
      `${conflictingRuleIds.length} Copilot routing rule(s) map the same target to different accounts; those workspaces are blocked as ambiguous.`,
    );
  }

  const ambientTokenVariablesPresent = detectAmbientCopilotTokenVariables(deps.env);
  if (ambientTokenVariablesPresent.length > 0) {
    warnings.push(
      `These GitHub token environment variables are set and are stripped from every Copilot session so they cannot override the routed account: ${ambientTokenVariablesPresent.join(', ')}.`,
    );
  }

  const healthy = entries.filter((entry) => entry.bindingState === 'authenticated');
  const aggregate: CopilotAggregateAuthState =
    entries.length === 0
      ? 'not-configured'
      : healthy.length === entries.length
        ? 'available'
        : healthy.length === 0
          ? 'auth-required'
          : 'partially-configured';

  return {
    aggregate,
    nodeId,
    profiles: entries,
    unreachableRuleIds,
    conflictingRuleIds,
    ...(invalidDefaultReason ? { invalidDefaultReason } : {}),
    ambientTokenVariablesPresent,
    legacyMigrationInUse: entries.some((entry) => entry.isLegacy) || entries.length === 0,
    warnings,
  };
}

/** One-line summary for the Doctor probe row. */
export function summarizeCopilotAccountReport(report: CopilotAccountDoctorReport): string {
  const base = describeAggregate(report);
  if (report.warnings.length === 0) {
    return base;
  }
  // Appended so the GENERIC Doctor page cannot report a clean bill of health
  // over a plaintext-token, ambient-token-variable, or rule-conflict warning.
  // Only the dedicated Copilot Accounts tab renders the full list; a user who
  // never opens it would otherwise never learn. Warnings are secret-free by
  // construction (labels, logins, hosts, and variable NAMES only).
  return `${base} ${report.warnings.length} warning(s): ${report.warnings.join(' ')}`;
}

function describeAggregate(report: CopilotAccountDoctorReport): string {
  switch (report.aggregate) {
    case 'not-configured':
      return 'Using the existing single Copilot account (no account profiles configured yet).';
    case 'available':
      return `All ${report.profiles.length} Copilot account(s) are signed in on this device.`;
    case 'partially-configured': {
      const unhealthy = report.profiles.filter((entry) => entry.bindingState !== 'authenticated');
      return `Partially configured: ${unhealthy.map((entry) => `${entry.label} (${entry.bindingState})`).join(', ')}.`;
    }
    case 'auth-required':
      return 'No Copilot account is signed in on this device. Sign in from Settings › GitHub Copilot Accounts.';
  }
}
