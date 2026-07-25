import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  KNOWN_HIGH_ADVISORIES,
  evaluateAuditReport,
} = require('../audit-build-dependencies.js') as {
  KNOWN_HIGH_ADVISORIES: ReadonlySet<string>;
  evaluateAuditReport: (report: unknown) => string[];
};

function reportWith(
  advisories: Array<{ severity: 'high' | 'critical'; url: string }>,
): unknown {
  return {
    auditReportVersion: 2,
    vulnerabilities: Object.fromEntries(
      advisories.map((advisory, index) => [
        `package-${index}`,
        {
          severity: advisory.severity,
          via: [{
            severity: advisory.severity,
            title: `advisory ${index}`,
            url: advisory.url,
          }],
        },
      ]),
    ),
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high: advisories.filter(({ severity }) => severity === 'high').length,
        critical: advisories.filter(({ severity }) => severity === 'critical').length,
        total: advisories.length,
      },
    },
  };
}

describe('evaluateAuditReport', () => {
  it('accepts only the explicitly reviewed high-advisory baseline', () => {
    expect(KNOWN_HIGH_ADVISORIES.size).toBeGreaterThan(0);
    expect(evaluateAuditReport(reportWith(
      [...KNOWN_HIGH_ADVISORIES].map((url) => ({ severity: 'high', url })),
    ))).toEqual([]);
  });

  it('rejects new high advisories and every critical finding', () => {
    expect(evaluateAuditReport(reportWith([{
      severity: 'high',
      url: 'https://github.com/advisories/GHSA-new1-new2-new3',
    }]))).toContain(
      'Unreviewed high-severity build advisory: https://github.com/advisories/GHSA-new1-new2-new3',
    );
    expect(evaluateAuditReport(reportWith([{
      severity: 'critical',
      url: 'https://github.com/advisories/GHSA-crit-ical-test',
    }]))).toContain('Build dependency audit reports 1 critical vulnerability');
  });

  it('fails closed on malformed or incomplete audit output', () => {
    expect(evaluateAuditReport({ error: { summary: 'registry unavailable' } }))
      .toContain('npm audit failed: registry unavailable');
    expect(evaluateAuditReport({ vulnerabilities: {} }))
      .toContain('npm audit output is missing vulnerability metadata');
  });
});
