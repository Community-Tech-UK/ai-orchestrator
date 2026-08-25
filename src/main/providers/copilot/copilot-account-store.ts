/**
 * Profile and routing-rule mutation for GitHub Copilot account routing.
 *
 * The single write path for `copilotAccountProfiles` and
 * `copilotAccountRoutingRules`. Both settings are operator-only
 * (`PRIVILEGED_CLI_OPERATOR_ONLY_KEYS`), so this is reached from the Settings
 * UI over IPC — never from an agent tool or the repair CLI.
 *
 * Every mutation re-validates the WHOLE resulting array through the shared Zod
 * schema before persisting, so an invariant (one default, default is
 * default-eligible, no duplicate matcher, no orphan rule) cannot be broken by a
 * partial update that looked locally fine.
 */

import type {
  CopilotAccountKind,
  CopilotAccountProfile,
  CopilotAccountRoutingRule,
  CopilotAccountScopePolicy,
  CopilotAutomationPolicy,
  CopilotRoutingMatcher,
} from '../../../shared/types/copilot-account.types';
import {
  COPILOT_DEFAULT_HOST,
  COPILOT_PROFILE_ID_PATTERN,
} from '../../../shared/types/copilot-account.types';
import {
  CopilotAccountProfilesSchema,
  CopilotAccountRoutingRulesSchema,
  assertCopilotRoutingConsistency,
  copilotMatcherKey,
} from '@contracts/schemas/copilot-account';
import { getSettingsManager } from '../../core/config/settings-manager';
import { getLogger } from '../../logging/logger';
import { getCopilotAccountBindingService } from './copilot-account-binding-service';
import { getCopilotAccountRoutingService } from './copilot-account-routing-service';

const logger = getLogger('CopilotAccountStore');

export interface CopilotAccountStoreDeps {
  read?: () => {
    profiles: CopilotAccountProfile[];
    rules: CopilotAccountRoutingRule[];
  };
  write?: (update: {
    profiles?: CopilotAccountProfile[];
    rules?: CopilotAccountRoutingRule[];
  }) => void;
  now?: () => number;
  /** Profile IDs currently in use by a live session. Removal is refused for these. */
  profilesInUse?: () => string[];
  onChanged?: () => void;
}

/** Turn a user-facing label into a safe slug, uniquified against existing IDs. */
export function deriveCopilotProfileId(label: string, taken: readonly string[]): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  const seed = COPILOT_PROFILE_ID_PATTERN.test(base) ? base : 'account';
  if (!taken.includes(seed)) {
    return seed;
  }
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${seed}-${suffix}`;
    if (!taken.includes(candidate)) {
      return candidate;
    }
  }
  throw new Error('Could not derive a unique Copilot account profile ID.');
}

function deriveRuleId(taken: readonly string[], now: number): string {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const candidate = `rule-${now.toString(36)}-${attempt}`;
    if (!taken.includes(candidate)) {
      return candidate;
    }
  }
  throw new Error('Could not derive a unique Copilot routing rule ID.');
}

export interface CreateCopilotProfileInput {
  label: string;
  accountKind: CopilotAccountKind;
  host?: string;
  scopePolicy?: CopilotAccountScopePolicy;
  automationPolicy?: CopilotAutomationPolicy;
  /**
   * Make this the default for unmatched workspaces. Ignored for a
   * `matched-only` profile — the schema rejects that combination outright.
   */
  makeDefault?: boolean;
}

export class CopilotAccountStore {
  constructor(private readonly deps: CopilotAccountStoreDeps = {}) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private read(): { profiles: CopilotAccountProfile[]; rules: CopilotAccountRoutingRule[] } {
    if (this.deps.read) {
      return this.deps.read();
    }
    const settings = getSettingsManager().getAll();
    return {
      profiles: Array.isArray(settings.copilotAccountProfiles)
        ? [...settings.copilotAccountProfiles]
        : [],
      rules: Array.isArray(settings.copilotAccountRoutingRules)
        ? [...settings.copilotAccountRoutingRules]
        : [],
    };
  }

  private persist(update: {
    profiles?: CopilotAccountProfile[];
    rules?: CopilotAccountRoutingRule[];
  }): void {
    const current = this.read();
    const profiles = update.profiles ?? current.profiles;
    const rules = update.rules ?? current.rules;

    // Validate the FULL resulting arrays, not the delta: cross-field invariants
    // (exactly one default, no duplicate matcher) are properties of the whole
    // set and a locally-valid edit can still break them.
    const parsedProfiles = CopilotAccountProfilesSchema.safeParse(profiles);
    if (!parsedProfiles.success) {
      throw new Error(
        `Copilot account profiles would become invalid: ${parsedProfiles.error.issues.map((issue) => issue.message).join('; ')}`,
      );
    }
    const parsedRules = CopilotAccountRoutingRulesSchema.safeParse(rules);
    if (!parsedRules.success) {
      throw new Error(
        `Copilot routing rules would become invalid: ${parsedRules.error.issues.map((issue) => issue.message).join('; ')}`,
      );
    }
    assertCopilotRoutingConsistency(parsedProfiles.data, parsedRules.data);

    if (this.deps.write) {
      this.deps.write({ profiles: parsedProfiles.data, rules: parsedRules.data });
    } else {
      const manager = getSettingsManager();
      manager.set('copilotAccountProfiles', parsedProfiles.data);
      manager.set('copilotAccountRoutingRules', parsedRules.data);
    }

    // Any change can move a route, so drop cached decisions and binding health
    // rather than letting a session start on a stale answer (spec §18).
    this.invalidateCaches();
    this.deps.onChanged?.();
  }

  private invalidateCaches(): void {
    try {
      getCopilotAccountRoutingService().invalidate();
      getCopilotAccountBindingService().invalidate();
    } catch (error) {
      logger.warn('Could not invalidate Copilot routing caches after a settings change', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  listProfiles(): CopilotAccountProfile[] {
    return this.read().profiles;
  }

  listRules(): CopilotAccountRoutingRule[] {
    return this.read().rules;
  }

  createProfile(input: CreateCopilotProfileInput): CopilotAccountProfile {
    const { profiles } = this.read();
    const now = this.now();
    const id = deriveCopilotProfileId(input.label, profiles.map((profile) => profile.id));
    // Enterprise profiles are matched-only by default (decision D5): a new
    // enterprise seat must not start servicing unmatched workspaces because
    // someone forgot to add a rule.
    const scopePolicy =
      input.scopePolicy ?? (input.accountKind === 'enterprise' ? 'matched-only' : 'default-eligible');
    const isDefault =
      Boolean(input.makeDefault)
      && scopePolicy === 'default-eligible';
    const profile: CopilotAccountProfile = {
      id,
      label: input.label.trim(),
      expectedLogin: null,
      host: (input.host ?? COPILOT_DEFAULT_HOST).toLowerCase(),
      accountKind: input.accountKind,
      scopePolicy,
      automationPolicy: input.automationPolicy ?? 'allow-routed',
      isDefault,
      createdAt: now,
      updatedAt: now,
    };
    const next = isDefault
      ? [...profiles.map((existing) => ({ ...existing, isDefault: false })), profile]
      : [...profiles, profile];
    this.persist({ profiles: next });
    logger.info('Created a Copilot account profile', {
      profileId: id,
      accountKind: profile.accountKind,
      scopePolicy,
    });
    return profile;
  }

  renameProfile(profileId: string, label: string): CopilotAccountProfile {
    return this.updateProfile(profileId, (profile) => ({ ...profile, label: label.trim() }));
  }

  updatePolicy(
    profileId: string,
    policy: {
      scopePolicy?: CopilotAccountScopePolicy;
      automationPolicy?: CopilotAutomationPolicy;
    },
  ): CopilotAccountProfile {
    return this.updateProfile(profileId, (profile) => ({
      ...profile,
      ...(policy.scopePolicy ? { scopePolicy: policy.scopePolicy } : {}),
      ...(policy.automationPolicy ? { automationPolicy: policy.automationPolicy } : {}),
      // A profile narrowed to matched-only can no longer be the default.
      ...(policy.scopePolicy === 'matched-only' ? { isDefault: false } : {}),
    }));
  }

  /**
   * Adopt the identity the profile is actually signed in as. This is the
   * explicit resolution for an `identity-mismatch`, and the only way
   * `expectedLogin` changes after the first verified login.
   */
  adoptObservedIdentity(
    profileId: string,
    observed: { login: string; host?: string },
  ): CopilotAccountProfile {
    return this.updateProfile(profileId, (profile) => ({
      ...profile,
      expectedLogin: observed.login.toLowerCase(),
      ...(observed.host ? { host: observed.host.toLowerCase() } : {}),
    }));
  }

  setDefault(profileId: string): CopilotAccountProfile {
    const { profiles } = this.read();
    const target = profiles.find((profile) => profile.id === profileId);
    if (!target) {
      throw new Error(`No Copilot account profile "${profileId}".`);
    }
    if (target.scopePolicy !== 'default-eligible') {
      throw new Error(
        `"${target.label}" is matched-only, so it cannot be the default for unmatched workspaces. Change its scope first.`,
      );
    }
    const now = this.now();
    const next = profiles.map((profile) => ({
      ...profile,
      isDefault: profile.id === profileId,
      ...(profile.id === profileId || profile.isDefault ? { updatedAt: now } : {}),
    }));
    this.persist({ profiles: next });
    return next.find((profile) => profile.id === profileId)!;
  }

  /**
   * Remove a profile.
   *
   * Refused while a live session uses it — that session's provider thread
   * belongs to this account and would have nowhere to resume. Its rules go with
   * it, because an orphan rule routes nowhere. Existing history keeps its
   * stamp: those threads simply stop natively resuming, which the UI explains.
   */
  removeProfile(profileId: string): void {
    const inUse = this.deps.profilesInUse?.() ?? [];
    if (inUse.includes(profileId)) {
      throw new Error(
        'That Copilot account is in use by a running session. End or switch that session first.',
      );
    }
    const { profiles, rules } = this.read();
    if (!profiles.some((profile) => profile.id === profileId)) {
      throw new Error(`No Copilot account profile "${profileId}".`);
    }
    this.persist({
      profiles: profiles.filter((profile) => profile.id !== profileId),
      rules: rules.filter((rule) => rule.profileId !== profileId),
    });
    logger.info('Removed a Copilot account profile', { profileId });
  }

  createRule(input: {
    profileId: string;
    matcher: CopilotRoutingMatcher;
    isProtected?: boolean;
  }): CopilotAccountRoutingRule {
    const { profiles, rules } = this.read();
    const profile = profiles.find((candidate) => candidate.id === input.profileId);
    if (!profile) {
      throw new Error(`No Copilot account profile "${input.profileId}".`);
    }
    const key = copilotMatcherKey(input.matcher);
    const existing = rules.find((rule) => copilotMatcherKey(rule.matcher) === key);
    if (existing) {
      throw new Error(
        existing.profileId === input.profileId
          ? 'That routing rule already exists for this account.'
          : `That target is already routed to a different Copilot account. Remove the existing rule first.`,
      );
    }
    const now = this.now();
    const rule: CopilotAccountRoutingRule = {
      id: deriveRuleId(rules.map((existingRule) => existingRule.id), now),
      profileId: input.profileId,
      matcher: input.matcher,
      // Rules created for an enterprise profile default to protected: a failed
      // or ambiguous match inside an employer's scope must block rather than
      // fall through to the personal default.
      isProtected: input.isProtected ?? profile.accountKind === 'enterprise',
      createdAt: now,
      updatedAt: now,
    };
    this.persist({ rules: [...rules, rule] });
    return rule;
  }

  /** Deleting a rule never rewrites an existing instance/history stamp. */
  removeRule(ruleId: string): void {
    const { rules } = this.read();
    if (!rules.some((rule) => rule.id === ruleId)) {
      throw new Error(`No Copilot routing rule "${ruleId}".`);
    }
    this.persist({ rules: rules.filter((rule) => rule.id !== ruleId) });
  }

  private updateProfile(
    profileId: string,
    mutate: (profile: CopilotAccountProfile) => CopilotAccountProfile,
  ): CopilotAccountProfile {
    const { profiles } = this.read();
    const target = profiles.find((profile) => profile.id === profileId);
    if (!target) {
      throw new Error(`No Copilot account profile "${profileId}".`);
    }
    const updated = { ...mutate(target), id: target.id, updatedAt: this.now() };
    this.persist({
      profiles: profiles.map((profile) => (profile.id === profileId ? updated : profile)),
    });
    return updated;
  }
}

let instance: CopilotAccountStore | null = null;

export function getCopilotAccountStore(): CopilotAccountStore {
  if (!instance) {
    instance = new CopilotAccountStore();
  }
  return instance;
}

export function _resetCopilotAccountStoreForTesting(next?: CopilotAccountStore): void {
  instance = next ?? null;
}
