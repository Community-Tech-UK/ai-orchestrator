#!/usr/bin/env node

const { spawnSync } = require("node:child_process");

// Reviewed 2026-07-25. These findings are confined to development/build
// consumers and are not present in the shipped production dependency graph.
// Keep the list narrow: removing a dependency may remove an entry, while any
// new high advisory must be reviewed before it can be added.
const KNOWN_HIGH_ADVISORIES = new Set([
  // Angular development proxy request-body handling.
  "https://github.com/advisories/GHSA-gcq2-9pq2-cxqm",
  // Legacy Minimatch consumers cannot use Brace Expansion v5; every installed
  // copy is pinned to the latest release in its compatible major and exercised.
  "https://github.com/advisories/GHSA-mh99-v99m-4gvg",
  // Angular build-time source-map loading.
  "https://github.com/advisories/GHSA-r28c-9q8g-f849",
  // Sass's build-time Immutable.js implementation.
  "https://github.com/advisories/GHSA-v56q-mh7h-f735",
  "https://github.com/advisories/GHSA-xvcm-6775-5m9r",
  // Angular build-worker option handling.
  "https://github.com/advisories/GHSA-x9g3-xrwr-cwfg",
]);

function evaluateAuditReport(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return ["npm audit did not return a JSON object"];
  }
  if (report.error && typeof report.error === "object") {
    const message = report.error.summary ?? report.error.detail ?? report.error.code ?? "unknown error";
    return [`npm audit failed: ${String(message)}`];
  }

  const counts = report.metadata?.vulnerabilities;
  if (!counts || typeof counts !== "object") {
    return ["npm audit output is missing vulnerability metadata"];
  }

  const errors = [];
  const criticalCount = Number(counts.critical);
  if (!Number.isFinite(criticalCount)) {
    errors.push("npm audit output has an invalid critical vulnerability count");
  } else if (criticalCount > 0) {
    errors.push(
      `Build dependency audit reports ${criticalCount} critical ${criticalCount === 1 ? "vulnerability" : "vulnerabilities"}`,
    );
  }

  const highCount = Number(counts.high);
  const highAdvisories = new Set();
  for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
    if (!vulnerability || typeof vulnerability !== "object") continue;
    for (const via of vulnerability.via ?? []) {
      if (!via || typeof via !== "object" || via.severity !== "high") continue;
      if (typeof via.url !== "string" || via.url.length === 0) {
        errors.push("npm audit returned a high-severity advisory without a URL");
        continue;
      }
      highAdvisories.add(via.url);
    }
  }

  if (!Number.isFinite(highCount)) {
    errors.push("npm audit output has an invalid high vulnerability count");
  } else if (highCount > 0 && highAdvisories.size === 0) {
    errors.push("npm audit reported high vulnerabilities without advisory details");
  }
  for (const advisoryUrl of highAdvisories) {
    if (!KNOWN_HIGH_ADVISORIES.has(advisoryUrl)) {
      errors.push(`Unreviewed high-severity build advisory: ${advisoryUrl}`);
    }
  }
  return errors;
}

function main() {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(
    npmCommand,
    ["audit", "--package-lock-only", "--json"],
    { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
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
    console.error("npm audit did not return valid JSON");
    process.exitCode = 1;
    return;
  }

  const errors = evaluateAuditReport(report);
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
    return;
  }

  const counts = report.metadata.vulnerabilities;
  console.log(
    `Build dependency audit passed: ${counts.critical} critical; `
    + `${KNOWN_HIGH_ADVISORIES.size} reviewed high-advisory baseline entries`,
  );
}

if (require.main === module) main();

module.exports = {
  KNOWN_HIGH_ADVISORIES,
  evaluateAuditReport,
};
