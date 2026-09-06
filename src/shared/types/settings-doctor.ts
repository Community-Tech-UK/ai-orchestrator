/**
 * S5 — a lint for the settings themselves.
 *
 * Settings fail quietly. A number outside its own declared range, a JSON key
 * holding unparseable text, a path that no longer exists — none of these throw,
 * and several of them only surface as a feature "not working" hours later. The
 * doctor states the problems in one place, with the key name, so the answer to
 * "why isn't this doing anything?" is a lookup rather than an investigation.
 *
 * Pure: takes a settings snapshot and the metadata, returns findings. That makes
 * it usable from the UI, from a test, and from the CLI with `--json` without
 * three implementations that drift.
 */

import type { SettingMetadata } from './settings-metadata.types';
import { SETTING_SURFACING, type SettingSurfacing } from './settings-surfacing';

export type DoctorSeverity =
  /** The setting cannot work as written. */
  | 'error'
  /** Works, but almost certainly not as intended. */
  | 'warning'
  /** Worth knowing; not a problem. */
  | 'info';

export interface DoctorFinding {
  key: string;
  severity: DoctorSeverity;
  /** What is wrong, in one sentence. */
  problem: string;
  /** What to do about it. Omitted when there is nothing actionable. */
  fix?: string;
}

export interface DoctorInput {
  settings: Record<string, unknown>;
  metadata: readonly SettingMetadata[];
  defaults: Record<string, unknown>;
  /**
   * Optional existence check for path-valued settings. Absent means "cannot
   * check" — and an unchecked path produces NO finding rather than a guess.
   */
  pathExists?: (path: string) => boolean;
}

export interface DoctorReport {
  findings: DoctorFinding[];
  errors: number;
  warnings: number;
  /** True when nothing needs attention. */
  healthy: boolean;
}

/** Keys whose value is a filesystem path worth existence-checking. */
function looksLikePathSetting(meta: SettingMetadata): boolean {
  return meta.type === 'directory';
}

function checkNumericRange(
  meta: SettingMetadata,
  value: unknown,
  out: DoctorFinding[],
): void {
  if (meta.type !== 'number' || typeof value !== 'number' || Number.isNaN(value)) return;
  const { min, max } = meta;
  if (min !== undefined && value < min) {
    out.push({
      key: meta.key,
      severity: 'error',
      problem: `${value} is below the minimum of ${min}.`,
      fix: `Set it to at least ${min}.`,
    });
  }
  if (max !== undefined && value > max) {
    out.push({
      key: meta.key,
      severity: 'error',
      problem: `${value} is above the maximum of ${max}.`,
      fix: `Set it to at most ${max}.`,
    });
  }
}

function checkJson(meta: SettingMetadata, value: unknown, out: DoctorFinding[]): void {
  if (meta.type !== 'json') return;
  if (typeof value !== 'string' || value.trim() === '') return;
  try {
    JSON.parse(value);
  } catch (err) {
    out.push({
      key: meta.key,
      severity: 'error',
      // The parser message names the position, which is the useful part.
      problem: `Not valid JSON: ${err instanceof Error ? err.message : 'parse failed'}`,
      fix: 'Fix the syntax, or clear the field to fall back to the default.',
    });
  }
}

function checkSelectOption(meta: SettingMetadata, value: unknown, out: DoctorFinding[]): void {
  if (meta.type !== 'select' || !meta.options || meta.options.length === 0) return;
  if (value === undefined || value === null) return;
  const allowed = meta.options.map((o) => o.value);
  if (!allowed.includes(value as string | number)) {
    out.push({
      key: meta.key,
      severity: 'error',
      problem: `"${String(value)}" is not one of the available choices.`,
      fix: `Choose one of: ${allowed.join(', ')}.`,
    });
  }
}

function checkEmptyMultiSelect(meta: SettingMetadata, value: unknown, out: DoctorFinding[]): void {
  if (meta.type !== 'multi-select') return;
  if (Array.isArray(value) && value.length === 0) {
    out.push({
      key: meta.key,
      severity: 'info',
      problem: 'Empty, so this feature is off.',
    });
  }
}

function checkPath(
  meta: SettingMetadata,
  value: unknown,
  pathExists: ((p: string) => boolean) | undefined,
  out: DoctorFinding[],
): void {
  if (!looksLikePathSetting(meta) || typeof value !== 'string' || value.trim() === '') return;
  // No checker means we cannot tell. Saying nothing is correct; inventing a
  // "path is fine" would be the confident-wrong-answer failure this whole
  // report exists to prevent.
  if (!pathExists) return;
  if (!pathExists(value)) {
    out.push({
      key: meta.key,
      severity: 'warning',
      problem: `The folder "${value}" does not exist.`,
      fix: 'Pick an existing folder, or clear it to use the default.',
    });
  }
}

/**
 * Keys the type system knows about but that carry no classification. S2.1's
 * registry makes this impossible to reach at compile time, so a hit here means
 * the registry and the settings have drifted at runtime — worth reporting
 * loudly rather than silently tolerating.
 */
function checkUnclassified(settings: Record<string, unknown>, out: DoctorFinding[]): void {
  const surfacing = SETTING_SURFACING as Record<string, SettingSurfacing>;
  for (const key of Object.keys(settings)) {
    if (!(key in surfacing)) {
      out.push({
        key,
        severity: 'warning',
        problem: 'Stored but not declared in the settings registry.',
        fix: 'Classify it in `settings-surfacing.ts`, or remove the stored value.',
      });
    }
  }
}

export function runSettingsDoctor(input: DoctorInput): DoctorReport {
  const findings: DoctorFinding[] = [];

  for (const meta of input.metadata) {
    const value = input.settings[meta.key];
    checkNumericRange(meta, value, findings);
    checkJson(meta, value, findings);
    checkSelectOption(meta, value, findings);
    checkEmptyMultiSelect(meta, value, findings);
    checkPath(meta, value, input.pathExists, findings);
  }

  checkUnclassified(input.settings, findings);

  // Errors first: a report that buries a broken value under six notes is a
  // report nobody reads to the end.
  const order: Record<DoctorSeverity, number> = { error: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.key.localeCompare(b.key));

  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;
  return { findings, errors, warnings, healthy: errors === 0 && warnings === 0 };
}

/** Stable machine-readable form for `--json`. */
export function doctorReportToJson(report: DoctorReport): string {
  return JSON.stringify(
    {
      healthy: report.healthy,
      errors: report.errors,
      warnings: report.warnings,
      findings: report.findings,
    },
    null,
    2,
  );
}
