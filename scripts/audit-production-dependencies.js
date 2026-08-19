#!/usr/bin/env node

const { evaluateAuditReport: evaluate, runAuditGate } = require('./audit-report-evaluator');
const { reviewedAdvisoriesFor } = require('./security-advisory-reviews');

// Audits only the shipped graph (`--omit=dev`). Unlike the build gate, this one
// accepts *only* production-scoped reviews from
// scripts/security-advisory-reviews.js — a "this never ships" justification
// cannot excuse a finding that, by definition, does ship.
const KNOWN_HIGH_ADVISORIES = reviewedAdvisoriesFor('production');

function evaluateAuditReport(report) {
  return evaluate(report, KNOWN_HIGH_ADVISORIES, 'production');
}

function main() {
  runAuditGate({
    extraArgs: ['--omit=dev'],
    allowedAdvisories: KNOWN_HIGH_ADVISORIES,
    label: 'production',
  });
}

if (require.main === module) main();

module.exports = {
  KNOWN_HIGH_ADVISORIES,
  evaluateAuditReport,
};
