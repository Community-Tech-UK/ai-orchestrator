/**
 * Decision 15(a), 20 Oct 2026 (LT-1156): turn the stored cost display on once.
 * Installs that had persisted `showCost: false` kept hiding session cost. The
 * marker makes this a single upgrade, so a later explicit opt-out survives.
 * Split out of settings-migrations.ts, like the provider-account migrations.
 */

import type { SettingsMigrationStore } from './settings-migrations';

const SHOW_COST_MIGRATION_KEY = '__migration_show_cost_enabled_20261020';

export function migrateCostDisplayDecision(store: SettingsMigrationStore): void {
  if (store.get(SHOW_COST_MIGRATION_KEY) === true) return;
  if (store.get('showCost') === false) store.persistSetting('showCost', true);
  store.persistRawSetting(SHOW_COST_MIGRATION_KEY, true);
}
