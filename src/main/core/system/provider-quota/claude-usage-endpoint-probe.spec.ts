import { describe, it, expect } from 'vitest';
import {
  ClaudeUsageEndpointProbe,
  parseUsagePayload,
  type UsageFetch,
} from './claude-usage-endpoint-probe';
import type { CredentialResult } from './claude-credentials-reader';

function reader(result: CredentialResult): { read: () => Promise<CredentialResult> } {
  return { read: async () => result };
}

const VALID_CREDENTIAL: CredentialResult = {
  credential: { accessToken: 'sk-ant-oat01-x', expiresAt: Date.now() + 1_000_000, subscriptionType: 'max' },
};

/** A realistic oauth/usage payload (utilization is a 0–100 percentage). */
const USAGE_BODY = {
  five_hour: { utilization: 35.0, resets_at: '2026-06-05T15:00:00+00:00' },
  seven_day: { utilization: 14.0, resets_at: '2026-06-12T20:00:00+00:00' },
  seven_day_sonnet: { utilization: 39.0, resets_at: '2026-06-09T14:00:00+00:00' },
  seven_day_opus: null,
  seven_day_oauth_apps: null,
  extra_usage: { is_enabled: true, monthly_limit: 1700, used_credits: 190.0, utilization: 11.18, currency: 'EUR' },
};

function fetchUsage(status: number, body: unknown): UsageFetch {
  return async () => ({ status, body });
}

const signal = () => new AbortController().signal;

describe('ClaudeUsageEndpointProbe', () => {
  describe('happy path', () => {
    it('produces windows for each present bucket', async () => {
      const probe = new ClaudeUsageEndpointProbe({
        credentialsReader: reader(VALID_CREDENTIAL),
        fetchUsage: fetchUsage(200, USAGE_BODY),
      });
      const snap = await probe.probe({ signal: signal() });
      expect(snap!.ok).toBe(true);
      expect(snap!.provider).toBe('claude');
      expect(snap!.source).toBe('admin-api');
      expect(snap!.plan).toBe('max');

      const byId = Object.fromEntries(snap!.windows.map((w) => [w.id, w]));
      expect(byId['claude.5h'].used).toBe(35);
      expect(byId['claude.5h'].limit).toBe(100);
      expect(byId['claude.5h'].remaining).toBe(65);
      expect(byId['claude.5h'].resetsAt).toBe(Date.parse('2026-06-05T15:00:00+00:00'));
      expect(byId['claude.weekly'].used).toBe(14);
      expect(byId['claude.weekly-sonnet'].used).toBe(39);
      // opus is null → no window
      expect(byId['claude.weekly-opus']).toBeUndefined();
      // extra_usage enabled → credits window
      expect(byId['claude.credits'].unit).toBe('usd');
      expect(byId['claude.credits'].used).toBe(190);
      expect(byId['claude.credits'].limit).toBe(1700);
    });

    it('omits the credits window when extra usage is disabled', () => {
      const windows = parseUsagePayload({
        five_hour: { utilization: 5, resets_at: null },
        extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
      });
      expect(windows.find((w) => w.id === 'claude.credits')).toBeUndefined();
      expect(windows).toHaveLength(1);
    });

    it('clamps out-of-range utilization', () => {
      const windows = parseUsagePayload({
        five_hour: { utilization: 130, resets_at: null },
        seven_day: { utilization: -5, resets_at: null },
      });
      expect(windows[0].used).toBe(100);
      expect(windows[1].used).toBe(0);
    });
  });

  describe('credential failures', () => {
    it('reports signed-out when no token is found', async () => {
      const probe = new ClaudeUsageEndpointProbe({
        credentialsReader: reader({ credential: null, reason: 'not-found' }),
        fetchUsage: fetchUsage(200, USAGE_BODY),
      });
      const snap = await probe.probe({ signal: signal() });
      expect(snap!.ok).toBe(false);
      expect(snap!.error).toMatch(/not signed in/i);
    });

    it('reports expired token without attempting a fetch', async () => {
      let fetched = false;
      const probe = new ClaudeUsageEndpointProbe({
        credentialsReader: reader({ credential: null, reason: 'expired' }),
        fetchUsage: async () => {
          fetched = true;
          return { status: 200, body: USAGE_BODY };
        },
      });
      const snap = await probe.probe({ signal: signal() });
      expect(fetched).toBe(false);
      expect(snap!.error).toMatch(/expired/i);
    });
  });

  describe('HTTP failures', () => {
    it('maps 401 to a re-login message', async () => {
      const probe = new ClaudeUsageEndpointProbe({
        credentialsReader: reader(VALID_CREDENTIAL),
        fetchUsage: fetchUsage(401, null),
      });
      const snap = await probe.probe({ signal: signal() });
      expect(snap!.ok).toBe(false);
      expect(snap!.error).toMatch(/rejected|re-login/i);
    });

    it('maps 429 to a rate-limit message', async () => {
      const probe = new ClaudeUsageEndpointProbe({
        credentialsReader: reader(VALID_CREDENTIAL),
        fetchUsage: fetchUsage(429, null),
      });
      const snap = await probe.probe({ signal: signal() });
      expect(snap!.error).toMatch(/rate-limit/i);
    });

    it('maps a thrown fetch error to ok=false', async () => {
      const probe = new ClaudeUsageEndpointProbe({
        credentialsReader: reader(VALID_CREDENTIAL),
        fetchUsage: async () => {
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        },
      });
      const snap = await probe.probe({ signal: signal() });
      expect(snap!.ok).toBe(false);
      expect(snap!.error).toMatch(/abort|timed out/i);
    });

    it('handles a 2xx with a non-object body', async () => {
      const probe = new ClaudeUsageEndpointProbe({
        credentialsReader: reader(VALID_CREDENTIAL),
        fetchUsage: fetchUsage(200, 'not json'),
      });
      const snap = await probe.probe({ signal: signal() });
      expect(snap!.ok).toBe(false);
      expect(snap!.error).toMatch(/unexpected body/i);
    });
  });
});
