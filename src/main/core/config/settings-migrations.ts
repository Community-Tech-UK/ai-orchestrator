/**
 * Settings migrations — one-shot upgrade routines run by SettingsManager at
 * construction time. Extracted from settings-manager.ts so the manager stays
 * focused on persistence, caching, and dirty-field merging.
 *
 * Each migration is idempotent: either it is guarded by a raw marker key
 * (`__migration_*`) persisted after the first run, or it only rewrites values
 * that still hold an old default.
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import type { AppSettings } from '../../../shared/types/settings.types';
import { DEFAULT_REVIEWER_MODEL_BY_PROVIDER } from '../../../shared/types/settings.types';
import {
  backfillSlotTiers,
  mergeMissingDefaultSlots,
  raiseSlotOutputBudget,
} from '../../rlm/auxiliary-llm-utils';
import { getLogger } from '../../logging/logger';
import { migrateLegacyCustomModelOverride } from './settings-custom-models';

const logger = getLogger('SettingsMigrations');

/**
 * Legacy app name for migration purposes
 */
const LEGACY_APP_NAME = 'claude-orchestrator';
const CODEBASE_AUTOINDEX_DISABLED_MIGRATION_KEY =
  '__migration_codebase_auto_index_disabled_20260527';
const AUX_SLOT_TIMEOUT_MIGRATION_KEY =
  '__migration_auxiliary_slot_timeouts_20260606';
const AUX_FRONTIER_FALLBACK_MIGRATION_KEY =
  '__migration_auxiliary_frontier_fallback_20260606';
const AUX_SLOT_TIERS_MIGRATION_KEY =
  '__migration_auxiliary_slot_tiers_20260609';
const AUX_TITLE_BUDGET_MIGRATION_KEY =
  '__migration_auxiliary_title_budget_20260609';
const REVIEWER_MODEL_DEFAULTS_MIGRATION_KEY =
  '__migration_reviewer_model_defaults_20260712';

/**
 * Narrow store surface the migrations need. `get` reads both AppSettings keys
 * and raw `__migration_*` marker keys; `persistSetting` routes through the
 * manager's locked dirty-field write so events and conflict detection apply;
 * `persistRawSetting` writes marker keys verbatim under the file lock.
 */
export interface SettingsMigrationStore {
  get(key: string): unknown;
  persistSetting(key: string, value: unknown): void;
  persistRawSetting(key: string, value: unknown): void;
}

/**
 * Migrate old full model IDs (e.g. 'claude-opus-4-5') to bare shorthand names ('opus').
 * electron-store persists values, so changing DEFAULT_SETTINGS alone won't update
 * already-persisted values.
 */
function migrateModelNames(store: SettingsMigrationStore): void {
  const MODEL_MIGRATION: Record<string, string> = {
    'claude-opus-4-5': 'opus',
    'claude-opus-4-5-20250918': 'opus',
    'claude-sonnet-4-5': 'sonnet',
    'claude-sonnet-4-5-20250929': 'sonnet',
    'claude-haiku-4-5': 'haiku',
    'claude-haiku-4-5-20251001': 'haiku',
    'claude-opus-4-6': 'opus',
    'claude-opus-4-6-20260401': 'opus',
    'claude-sonnet-4-6': 'sonnet',
    'claude-sonnet-4-6-20260401': 'sonnet',
    'claude-haiku-4-6': 'haiku',
    'claude-haiku-4-6-20260401': 'haiku',
    // Older generation
    'claude-sonnet-4-20250514': 'sonnet',
    'claude-opus-4-20250514': 'opus',
    'claude-3-5-sonnet-20241022': 'sonnet',
    'claude-3-5-haiku-20241022': 'haiku',
    // Previous OpenAI/Codex defaults
    'gpt-5.4': 'gpt-5.5',
    'gpt-5.4-mini': 'gpt-5.5-mini',
    // Legacy Codex alias
    'codex-mini-latest': 'gpt-5.3-codex',
  };

  const currentModel = store.get('defaultModel');
  if (typeof currentModel === 'string' && MODEL_MIGRATION[currentModel]) {
    const newModel = MODEL_MIGRATION[currentModel];
    logger.info('Migrating defaultModel', { currentModel, newModel });
    store.persistSetting('defaultModel', newModel);
  }
}

/**
 * Migrate legacy defaultCli alias ("openai") to canonical runtime provider ("codex").
 */
function migrateCliProviderAlias(store: SettingsMigrationStore): void {
  if (store.get('defaultCli') === 'openai') {
    store.persistSetting('defaultCli', 'codex');
  }
}

/**
 * Disable the legacy RLM codebase auto-indexer once for existing installs.
 *
 * Changing DEFAULT_SETTINGS protects new installs, but electron-store keeps
 * older persisted values. This one-shot migration clears the old heavy
 * default while still allowing the user to explicitly re-enable the legacy path
 * later for diagnostics.
 */
function migrateLegacyCodebaseAutoIndexDefault(store: SettingsMigrationStore): void {
  if (store.get(CODEBASE_AUTOINDEX_DISABLED_MIGRATION_KEY) === true) {
    return;
  }

  if (store.get('codebaseAutoIndexEnabled') === true) {
    logger.info('Disabling persisted legacy codebase auto-index default');
    store.persistSetting('codebaseAutoIndexEnabled', false);
  }

  store.persistRawSetting(CODEBASE_AUTOINDEX_DISABLED_MIGRATION_KEY, true);
}

/**
 * Backfill explicit reviewer models for existing installs.
 *
 * `crossModelReviewModelByProvider` already exists in every persisted store
 * (it shipped as `{ cursor: 'composer-2.5' }`), and electron-store only
 * applies DEFAULT_SETTINGS to ABSENT keys — so widening the default alone
 * would reach new installs and nobody else. Existing installs would keep
 * every other reviewer on "auto", which is precisely the state that let codex
 * reviews silently inherit a flagship CLI default.
 *
 * Only missing providers are filled; an explicitly chosen model is never
 * overwritten. Caveat, deliberately accepted: "auto" is stored as key
 * ABSENCE, so this one-shot cannot distinguish "never configured" from
 * "deliberately on auto" and will pin the latter too. It runs exactly once,
 * so an auto chosen after the upgrade sticks.
 */
function migrateReviewerModelDefaults(store: SettingsMigrationStore): void {
  if (store.get(REVIEWER_MODEL_DEFAULTS_MIGRATION_KEY) === true) {
    return;
  }

  const current =
    (store.get('crossModelReviewModelByProvider') as Record<string, string> | undefined) ?? {};
  const next = { ...current };
  const backfilled: string[] = [];

  for (const [provider, model] of Object.entries(DEFAULT_REVIEWER_MODEL_BY_PROVIDER)) {
    if (!next[provider]) {
      next[provider] = model;
      backfilled.push(`${provider}=${model}`);
    }
  }

  if (backfilled.length > 0) {
    logger.info('Backfilling explicit reviewer models', { backfilled });
    store.persistSetting('crossModelReviewModelByProvider', next);
  }

  store.persistRawSetting(REVIEWER_MODEL_DEFAULTS_MIGRATION_KEY, true);
}

/**
 * Claude steering should abort the turn through the resident stream protocol,
 * not SIGINT + respawn. The setting is read-only, so old persisted `false`
 * values are stale rollout state rather than user intent.
 */
function migrateResidentClaudeDefault(store: SettingsMigrationStore): void {
  if (store.get('residentClaudeSession') !== true) {
    logger.info('Enabling resident Claude sessions for no-respawn steering');
    store.persistSetting('residentClaudeSession', true);
  }
}

/**
 * Raise auxiliary slot timeouts that still hold the old 15s default.
 *
 * A cold local-model load (e.g. a ~20GB Ollama model into VRAM) can take
 * ~17-22s, which exceeds the original 15s timeout used for titleGeneration,
 * routingClassification, and approvalScoring — so the first call after the
 * model unloads always aborts. DEFAULT_SETTINGS now ships 45s, but
 * electron-store keeps already-persisted values. This one-shot migration only
 * touches slots that still equal the exact old default (15000), so it never
 * clobbers a value the user intentionally customised.
 */
function migrateAuxiliarySlotTimeouts(store: SettingsMigrationStore): void {
  if (store.get(AUX_SLOT_TIMEOUT_MIGRATION_KEY) === true) {
    return;
  }

  const OLD_DEFAULT_MS = 15000;
  const NEW_DEFAULT_MS = 45000;
  const SLOTS_TO_RAISE = ['titleGeneration', 'routingClassification', 'approvalScoring'];

  const raw = store.get('auxiliaryLlmSlotsJson');
  if (typeof raw === 'string') {
    try {
      const slots = JSON.parse(raw) as Record<string, { timeoutMs?: number } | undefined>;
      let changed = false;
      for (const name of SLOTS_TO_RAISE) {
        const slot = slots[name];
        if (slot && slot.timeoutMs === OLD_DEFAULT_MS) {
          slot.timeoutMs = NEW_DEFAULT_MS;
          changed = true;
        }
      }
      if (changed) {
        logger.info('Raising persisted auxiliary slot timeouts for cold local-model loads');
        store.persistSetting('auxiliaryLlmSlotsJson', JSON.stringify(slots));
      }
    } catch {
      // Malformed JSON — leave as-is; AuxiliaryLlmService falls back to defaults.
    }
  }

  store.persistRawSetting(AUX_SLOT_TIMEOUT_MIGRATION_KEY, true);
}

/**
 * `allowFrontierFallback` used to be an inert flag persisted as `false` for
 * every slot. It is now enforced: when `false`, a slot will never escalate to
 * the primary (cloud) model and instead uses a deterministic local summary.
 *
 * For the two text slots (compression, memoryDistillation) the new default is
 * `true` so behavior is unchanged for users without a local model. This
 * one-shot migration flips persisted `false → true` for exactly those two
 * slots when they still hold the old default, so existing installs don't get a
 * silent compaction/memory quality regression on upgrade. Slots the user
 * intentionally set to `false` after this lands are preserved (the migration
 * runs once). Advisory slots (titles/classification/scoring) are left as-is.
 */
function migrateAuxiliaryFrontierFallbackDefault(store: SettingsMigrationStore): void {
  if (store.get(AUX_FRONTIER_FALLBACK_MIGRATION_KEY) === true) {
    return;
  }

  const SLOTS_TO_ENABLE = ['compression', 'memoryDistillation'];

  const raw = store.get('auxiliaryLlmSlotsJson');
  if (typeof raw === 'string') {
    try {
      const slots = JSON.parse(raw) as Record<string, { allowFrontierFallback?: boolean } | undefined>;
      let changed = false;
      for (const name of SLOTS_TO_ENABLE) {
        const slot = slots[name];
        if (slot && slot.allowFrontierFallback === false) {
          slot.allowFrontierFallback = true;
          changed = true;
        }
      }
      if (changed) {
        logger.info('Enabling frontier fallback for compression/memoryDistillation (new default)');
        store.persistSetting('auxiliaryLlmSlotsJson', JSON.stringify(slots));
      }
    } catch {
      // Malformed JSON — leave as-is; AuxiliaryLlmService falls back to defaults.
    }
  }

  store.persistRawSetting(AUX_FRONTIER_FALLBACK_MIGRATION_KEY, true);
}

function migrateAuxiliarySlotTiers(store: SettingsMigrationStore): void {
  if (store.get(AUX_SLOT_TIERS_MIGRATION_KEY) === true) {
    return;
  }

  const raw = store.get('auxiliaryLlmSlotsJson');
  if (typeof raw === 'string') {
    const updated = backfillSlotTiers(raw);
    if (updated !== null) {
      logger.info('Backfilling auxiliary slot tiers (quick/quality) for existing config');
      store.persistSetting('auxiliaryLlmSlotsJson', updated);
    }
  }

  store.persistRawSetting(AUX_SLOT_TIERS_MIGRATION_KEY, true);
}

function migrateTitleGenerationBudget(store: SettingsMigrationStore): void {
  if (store.get(AUX_TITLE_BUDGET_MIGRATION_KEY) === true) {
    return;
  }

  const raw = store.get('auxiliaryLlmSlotsJson');
  if (typeof raw === 'string') {
    const updated = raiseSlotOutputBudget(raw, 'titleGeneration', 512);
    if (updated !== null) {
      logger.info('Raising titleGeneration output budget to 512 (was too small for reasoning models)');
      store.persistSetting('auxiliaryLlmSlotsJson', updated);
    }
  }

  store.persistRawSetting(AUX_TITLE_BUDGET_MIGRATION_KEY, true);
}

function migrateAuxiliaryMissingSlots(store: SettingsMigrationStore): void {
  const raw = store.get('auxiliaryLlmSlotsJson');
  if (typeof raw !== 'string') return;

  const updated = mergeMissingDefaultSlots(raw);
  if (updated !== null) {
    logger.info('Merging missing default auxiliary slots into existing config');
    store.persistSetting('auxiliaryLlmSlotsJson', updated);
  }
}

/**
 * Seed `defaultModelByProvider` from the legacy `defaultModel` + `defaultCli`
 * on first launch after the per-provider memory feature lands. Subsequent
 * writes are owned by the renderer (ProviderStateService).
 *
 * We do not try to invent values for providers the user has never touched —
 * those fall back to `getPrimaryModelForProvider(provider)` at read time.
 */
function seedDefaultModelByProvider(store: SettingsMigrationStore): void {
  const existing = store.get('defaultModelByProvider');
  if (existing && typeof existing === 'object' && Object.keys(existing).length > 0) {
    return;
  }

  const defaultCli = store.get('defaultCli');
  const defaultModel = store.get('defaultModel');
  if (
    typeof defaultCli !== 'string'
    || defaultCli === 'auto'
    || typeof defaultModel !== 'string'
    || defaultModel.trim().length === 0
  ) {
    store.persistSetting('defaultModelByProvider', {});
    return;
  }

  const seeded: Record<string, string> = { [defaultCli]: defaultModel };
  logger.info('Seeding defaultModelByProvider from legacy defaultModel', {
    defaultCli,
    defaultModel,
  });
  store.persistSetting('defaultModelByProvider', seeded);
}

/**
 * Run every post-store migration in its historical order. Called by the
 * SettingsManager constructor immediately after the electron-store is created
 * and before the dirty-diff baseline snapshot is captured, so migration writes
 * keep their wholesale-write semantics.
 */
export function runSettingsMigrations(store: SettingsMigrationStore): void {
  // Migrate stale model names to bare shorthand names
  migrateModelNames(store);
  // Migrate legacy CLI alias to canonical provider key
  migrateCliProviderAlias(store);
  // Existing installs may have persisted the old, heavy auto-index default.
  migrateLegacyCodebaseAutoIndexDefault(store);
  // Existing installs persisted crossModelReviewModelByProvider before the
  // other reviewers had explicit models, so they'd stay on CLI-default "auto"
  // and keep inheriting whatever model the upstream CLI promotes.
  migrateReviewerModelDefaults(store);
  // Existing installs may have persisted the pre-redesign Claude steer path.
  migrateResidentClaudeDefault(store);
  // Existing installs may have persisted the old 15s auxiliary slot timeouts,
  // which are too short for a cold local-model load.
  migrateAuxiliarySlotTimeouts(store);
  // allowFrontierFallback is now enforced. Existing installs persisted it as
  // `false` while it was inert; flip the two text slots back to the new `true`
  // default so they don't silently lose primary-LLM quality on upgrade.
  migrateAuxiliaryFrontierFallbackDefault(store);
  // Existing installs persisted slot configs before the quick/quality tier
  // feature; backfill each slot's `tier` so the model-tier selection and UI
  // reflect sensible defaults instead of "none".
  migrateAuxiliarySlotTiers(store);
  // titleGeneration shipped with a 128-token budget — too small for reasoning
  // local models, which spend it all thinking and emit an empty title. Raise
  // existing installs to 512 so titles actually generate.
  migrateTitleGenerationBudget(store);
  // Slot additions should appear in existing installs without a one-shot key;
  // this key-based merge self-heals future slot additions without churn.
  migrateAuxiliaryMissingSlots(store);
  // Seed per-provider model memory from existing defaultModel/defaultCli.
  seedDefaultModelByProvider(store);
  migrateLegacyCustomModelOverride({
    // The generic deps read/write concrete AppSettings keys; this store surface
    // is deliberately untyped (it also reads raw migration markers), so bridge
    // with a cast rather than widening the deps interface.
    get: <K extends keyof AppSettings>(key: K) => store.get(key) as AppSettings[K],
    persist: (key, value) => store.persistSetting(key, value),
    logMigrated: (provider, modelId) =>
      logger.info('Migrating customModelOverride into customModelsByProvider', { provider, modelId }),
  });
}

/**
 * Migrate settings from legacy "claude-orchestrator" to "ai-orchestrator"
 * This runs once on first launch after the rename. Runs BEFORE the
 * electron-store is created so the copied settings file is picked up.
 */
export function migrateFromLegacyApp(): void {
  try {
    const currentUserData = app.getPath('userData');
    const legacyUserData = currentUserData.replace(/ai-orchestrator$/i, LEGACY_APP_NAME);

    // Skip if already migrated or no legacy data exists
    if (currentUserData === legacyUserData) return;
    if (!fs.existsSync(legacyUserData)) return;

    // Check if migration already done (current settings exist)
    const currentSettingsPath = path.join(currentUserData, 'settings.json');
    if (fs.existsSync(currentSettingsPath)) return;

    // Ensure current user data directory exists
    if (!fs.existsSync(currentUserData)) {
      fs.mkdirSync(currentUserData, { recursive: true });
    }

    // Migrate settings file
    const legacySettingsPath = path.join(legacyUserData, 'settings.json');
    if (fs.existsSync(legacySettingsPath)) {
      fs.copyFileSync(legacySettingsPath, currentSettingsPath);
      logger.info('Migrated settings from legacy app');
    }

    // Migrate recent directories
    const legacyRecentDirs = path.join(legacyUserData, 'recent-directories.json');
    const currentRecentDirs = path.join(currentUserData, 'recent-directories.json');
    if (fs.existsSync(legacyRecentDirs) && !fs.existsSync(currentRecentDirs)) {
      fs.copyFileSync(legacyRecentDirs, currentRecentDirs);
      logger.info('Migrated recent directories from legacy app');
    }

    // Migrate history database
    const legacyHistory = path.join(legacyUserData, 'history.db');
    const currentHistory = path.join(currentUserData, 'history.db');
    if (fs.existsSync(legacyHistory) && !fs.existsSync(currentHistory)) {
      fs.copyFileSync(legacyHistory, currentHistory);
      logger.info('Migrated history database from legacy app');
    }

    // Migrate RLM database
    const legacyRlm = path.join(legacyUserData, 'rlm.db');
    const currentRlm = path.join(currentUserData, 'rlm.db');
    if (fs.existsSync(legacyRlm) && !fs.existsSync(currentRlm)) {
      fs.copyFileSync(legacyRlm, currentRlm);
      logger.info('Migrated RLM database from legacy app');
    }

    logger.info('Migration from claude-orchestrator complete');
  } catch (error) {
    logger.warn('Migration failed (non-critical)', { error: String(error) });
  }
}
