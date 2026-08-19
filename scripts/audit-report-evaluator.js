#!/usr/bin/env node

/**
 * Shared `npm audit --json` gate used by the build and production audit scripts.
 *
 * Both gate the same way: any critical vulnerability fails, and any
 * high-severity advisory fails unless its URL has a hand-written review in
 * scripts/security-advisory-reviews.js. Moderate and below are not gated,
 * matching the `--audit-level=high` this replaced.
 */
function evaluateAuditReport(report, allowedAdvisories, label) {
  const Label = label.charAt(0).toUpperCase() + label.slice(1);
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return ['npm audit did not return a JSON object'];
  }
  if (report.error && typeof report.error === 'object') {
    const message = report.error.summary ?? report.error.detail ?? report.error.code ?? 'unknown error';
    return [`npm audit failed: ${String(message)}`];
  }

  const counts = report.metadata?.vulnerabilities;
  if (!counts || typeof counts !== 'object') {
    return ['npm audit output is missing vulnerability metadata'];
  }

  const errors = [];
  const criticalCount = Number(counts.critical);
  if (!Number.isFinite(criticalCount)) {
    errors.push('npm audit output has an invalid critical vulnerability count');
  } else if (criticalCount > 0) {
    errors.push(
      `${Label} dependency audit reports ${criticalCount} critical `
      + `${criticalCount === 1 ? 'vulnerability' : 'vulnerabilities'}`,
    );
  }

  const highCount = Number(counts.high);
  const highAdvisories = new Set();
  for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
    if (!vulnerability || typeof vulnerability !== 'object') continue;
    for (const via of vulnerability.via ?? []) {
      if (!via || typeof via !== 'object' || via.severity !== 'high') continue;
      if (typeof via.url !== 'string' || via.url.length === 0) {
        errors.push('npm audit returned a high-severity advisory without a URL');
        continue;
      }
      highAdvisories.add(via.url);
    }
  }

  if (!Number.isFinite(highCount)) {
    errors.push('npm audit output has an invalid high vulnerability count');
  } else if (highCount > 0 && highAdvisories.size === 0) {
    errors.push('npm audit reported high vulnerabilities without advisory details');
  }
  for (const advisoryUrl of highAdvisories) {
    if (!allowedAdvisories.has(advisoryUrl)) {
      errors.push(`Unreviewed high-severity ${label} advisory: ${advisoryUrl}`);
    }
  }
  return errors;
}

/** Runs `npm audit --json` with `extraArgs` and reports gate failures. */
function runAuditGate({ extraArgs, allowedAdvisories, label }) {
  const { spawnSync } = require('node:child_process');
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(
    npmCommand,
    ['audit', '--package-lock-only', '--json', ...extraArgs],
    { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
  );
  if (result.error) {
    console.error(`Failed to run npm audit: ${result.error.message}`);
    process.exitCode = 1;
    return;
  }

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    console.error('npm audit did not return valid JSON');
    process.exitCode = 1;
    return;
  }

  const errors = evaluateAuditReport(report, allowedAdvisories, label);
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
    return;
  }

  const counts = report.metadata.vulnerabilities;
  console.log(
    `${label.charAt(0).toUpperCase() + label.slice(1)} dependency audit passed: `
    + `${counts.critical} critical; `
    + `${allowedAdvisories.size} reviewed high-advisory baseline entries`,
  );
}

module.exports = { evaluateAuditReport, runAuditGate };
