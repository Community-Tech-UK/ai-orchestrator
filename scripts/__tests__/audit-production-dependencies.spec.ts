import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  KNOWN_HIGH_ADVISORIES,
  evaluateAuditReport,
} = require('../audit-production-dependencies.js') as {
  KNOWN_HIGH_ADVISORIES: ReadonlySet<string>;
  evaluateAuditReport: (report: unknown) => string[];
};
const { ADVISORY_REVIEWS, reviewedAdvisoriesFor } = require('../security-advisory-reviews.js') as {
  ADVISORY_REVIEWS: ReadonlyMap<
    string,
    { package: string; scope: string; reviewed: string; rationale: string; retiredBy?: string }
  >;
  reviewedAdvisoriesFor: (scope: string) => ReadonlySet<string>;
};

function reportWith(
  via: { severity: string; url: string }[],
  counts: Record<string, number> = {},
): unknown {
  const high = via.filter((entry) => entry.severity === 'high').length;
  return {
    metadata: { vulnerabilities: { critical: 0, high, moderate: 0, low: 0, info: 0, ...counts } },
    vulnerabilities: { 'some-package': { via } },
  };
}

describe('security advisory reviews', () => {
  it('records a rationale and a reviewed date for every entry', () => {
    expect(ADVISORY_REVIEWS.size).toBeGreaterThan(0);
    for (const [url, review] of ADVISORY_REVIEWS) {
      expect(url, 'advisory keys should be GitHub advisory URLs').toMatch(
        /^https:\/\/github\.com\/advisories\/GHSA-/,
      );
      expect(review.package, `${url} needs a package`).toBeTruthy();
      // Guards against an empty or placeholder rationale, not against brevity.
      expect(review.rationale.trim().length, `${url} needs a rationale`).toBeGreaterThan(20);
      expect(review.reviewed, `${url} needs a review date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(['build', 'production']).toContain(review.scope);
    }
  });

  it('records what retires each production-scoped entry', () => {
    // A finding that ships must name the change that removes it, so the
    // acceptance cannot quietly become permanent.
    for (const [url, review] of ADVISORY_REVIEWS) {
      if (review.scope !== 'production') continue;
      expect(review.retiredBy, `${url} ships and needs a retirement plan`).toBeTruthy();
    }
  });

  it('never lets a build-scoped review excuse a production finding', () => {
    const production = reviewedAdvisoriesFor('production');
    for (const [url, review] of ADVISORY_REVIEWS) {
      if (review.scope === 'build') expect(production.has(url)).toBe(false);
    }
  });

  it('lets the build gate accept both scopes', () => {
    const build = reviewedAdvisoriesFor('build');
    for (const url of ADVISORY_REVIEWS.keys()) expect(build.has(url)).toBe(true);
  });
});

describe('production evaluateAuditReport', () => {
  it('accepts the reviewed production baseline', () => {
    expect(KNOWN_HIGH_ADVISORIES.size).toBeGreaterThan(0);
    expect(
      evaluateAuditReport(
        reportWith([...KNOWN_HIGH_ADVISORIES].map((url) => ({ severity: 'high', url }))),
      ),
    ).toEqual([]);
  });

  it('rejects an unreviewed high advisory', () => {
    expect(
      evaluateAuditReport(
        reportWith([{ severity: 'high', url: 'https://github.com/advisories/GHSA-new1-new2-new3' }]),
      ),
    ).toContain(
      'Unreviewed high-severity production advisory: https://github.com/advisories/GHSA-new1-new2-new3',
    );
  });

  it('rejects any critical vulnerability even when every high is reviewed', () => {
    expect(evaluateAuditReport(reportWith([], { critical: 1 }))).toContain(
      'Production dependency audit reports 1 critical vulnerability',
    );
  });

  it('does not gate on moderate findings', () => {
    expect(
      evaluateAuditReport(
        reportWith([{ severity: 'moderate', url: 'https://github.com/advisories/GHSA-mod1-mod2-mod3' }], {
          moderate: 1,
        }),
      ),
    ).toEqual([]);
  });

  it('surfaces a failed or malformed audit run rather than passing silently', () => {
    expect(evaluateAuditReport({ error: { summary: 'registry unavailable' } })).toContain(
      'npm audit failed: registry unavailable',
    );
    expect(evaluateAuditReport({ vulnerabilities: {} })).toContain(
      'npm audit output is missing vulnerability metadata',
    );
    expect(evaluateAuditReport(null)).toContain('npm audit did not return a JSON object');
  });
});
