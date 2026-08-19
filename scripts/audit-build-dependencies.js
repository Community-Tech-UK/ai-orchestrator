#!/usr/bin/env node

const { evaluateAuditReport: evaluate, runAuditGate } = require('./audit-report-evaluator');
const { reviewedAdvisoriesFor } = require('./security-advisory-reviews');

// Reviewed advisories accepted by this gate, with per-entry rationale, live in
// scripts/security-advisory-reviews.js. This gate audits the full graph (dev
// and production), so it accepts both build-scoped and production-scoped
// reviews. Keep the list narrow: removing a dependency may remove an entry,
// while any new high advisory must be reviewed before it can be added.
const KNOWN_HIGH_ADVISORIES = reviewedAdvisoriesFor('build');

function evaluateAuditReport(report) {
  return evaluate(report, KNOWN_HIGH_ADVISORIES, 'build');
}

function main() {
  runAuditGate({ extraArgs: [], allowedAdvisories: KNOWN_HIGH_ADVISORIES, label: 'build' });
}

if (require.main === module) main();

module.exports = {
  KNOWN_HIGH_ADVISORIES,
  evaluateAuditReport,
};
