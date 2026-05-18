#!/usr/bin/env node
/**
 * check-provider-parity.js
 *
 * Validates that every canonical provider ID found in the settings types
 * appears in docs/provider-parity-checklist.md.
 *
 * Usage:  node scripts/check-provider-parity.js
 * Exit:   0 on success, 1 on missing entries.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SETTINGS_FILE = path.join(ROOT, 'src/shared/types/settings.types.ts');
const CHECKLIST_FILE = path.join(ROOT, 'docs/provider-parity-checklist.md');

// ---------------------------------------------------------------------------
// Extract canonical CLI types from the settings file
// ---------------------------------------------------------------------------

const settingsSource = fs.readFileSync(SETTINGS_FILE, 'utf8');

// Match: export type CanonicalCliType = 'claude' | 'gemini' | ...
const match = settingsSource.match(/CanonicalCliType\s*=\s*([^;]+);/);
if (!match) {
  console.error('ERROR: Could not find CanonicalCliType in', SETTINGS_FILE);
  process.exit(1);
}

const providerIds = [...match[1].matchAll(/'([a-z][a-z0-9-]*)'/g)]
  .map((m) => m[1])
  .filter((id) => id !== 'auto'); // 'auto' is not a real provider

// ---------------------------------------------------------------------------
// Check the checklist contains each provider
// ---------------------------------------------------------------------------

const checklist = fs.readFileSync(CHECKLIST_FILE, 'utf8');

const missing = [];
for (const id of providerIds) {
  // The checklist must contain the provider ID as a table column header
  // (e.g., "| claude |") — a simple substring match on the ID suffices.
  if (!checklist.includes(id)) {
    missing.push(id);
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

if (missing.length === 0) {
  console.log(`✓ Provider parity checklist covers all ${providerIds.length} providers: ${providerIds.join(', ')}`);
  process.exit(0);
} else {
  console.error(`✗ Provider parity checklist is missing entries for: ${missing.join(', ')}`);
  console.error(`  Add rows for these providers to ${path.relative(ROOT, CHECKLIST_FILE)}`);
  process.exit(1);
}
