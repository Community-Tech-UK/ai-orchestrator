import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import {
  CopilotUsageEndpointProbe,
  defaultCopilotAppsPaths,
  parseCopilotInternalUserPayload,
  type CopilotAppsReader,
  type CopilotUsageFetch,
} from './copilot-usage-endpoint-probe';

const APPS_JSON = JSON.stringify({
  'github.com': {
    oauth_token: 'copilot-oauth-token',
  },
});

function reader(content: string | null): CopilotAppsReader {
  return async () => {
    if (content === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return content;
  };
}

describe('CopilotUsageEndpointProbe', () => {
  it('reads the Copilot OAuth token and returns premium-interaction percent windows', async () => {
    const tokens: string[] = [];
    const fetchUsage: CopilotUsageFetch = async (token) => {
      tokens.push(token);
      return {
        status: 200,
        body: {
          copilot_plan: 'copilot-pro',
          quota_reset_date_utc: '2026-07-01T00:00:00Z',
          quota_snapshots: {
            premium_interactions: {
              percent_remaining: 23,
              entitlement: 300,
              remaining: 69,
            },
            chat: { unlimited: true, percent_remaining: 100 },
          },
        },
      };
    };

    const probe = new CopilotUsageEndpointProbe({
      readFile: reader(APPS_JSON),
      fetchUsage,
    });

    const snap = await probe.probe({ signal: new AbortController().signal });

    expect(tokens).toEqual(['copilot-oauth-token']);
    expect(snap).toMatchObject({ provider: 'copilot', ok: true, plan: 'copilot-pro', source: 'admin-api' });
    expect(snap!.windows).toEqual([
      expect.objectContaining({
        id: 'copilot.premium-interactions',
        label: 'Premium interactions',
        used: 77,
        limit: 100,
        remaining: 23,
        resetsAt: Date.parse('2026-07-01T00:00:00Z'),
      }),
    ]);
  });

  it('parses every finite metered quota bucket and skips unlimited buckets', () => {
    const windows = parseCopilotInternalUserPayload({
      quota_snapshots: {
        premium_interactions: { percent_remaining: 80 },
        chat: { percent_remaining: 90 },
        completions: { unlimited: true, percent_remaining: 5 },
      },
    });

    expect(windows.map((w) => `${w.id}:${w.used}%`)).toEqual([
      'copilot.premium-interactions:20%',
      'copilot.chat:10%',
    ]);
  });

  it('returns ok=false when apps.json is absent', async () => {
    const probe = new CopilotUsageEndpointProbe({ readFile: reader(null) });
    const snap = await probe.probe({ signal: new AbortController().signal });
    expect(snap!.ok).toBe(false);
    expect(snap!.error).toMatch(/not signed in|apps\.json/i);
  });

  it('tries Windows LocalAppData apps.json when the POSIX config path is absent', async () => {
    const calls: string[] = [];
    const localAppsPath = path.join('C:\\Users\\u\\AppData\\Local', 'github-copilot', 'apps.json');
    const fetchUsage: CopilotUsageFetch = async () => ({
      status: 200,
      body: {
        copilot_plan: 'copilot-pro',
        quota_snapshots: { premium_interactions: { percent_remaining: 50 } },
      },
    });
    const probe = new CopilotUsageEndpointProbe({
      env: {
        LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
        APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
      } as NodeJS.ProcessEnv,
      readFile: async (p) => {
        calls.push(p);
        if (p === localAppsPath) return APPS_JSON;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      fetchUsage,
    });

    const snap = await probe.probe({ signal: new AbortController().signal });

    expect(snap!.ok).toBe(true);
    expect(calls).toContain(localAppsPath);
  });

  it('builds de-duplicated platform token path candidates', () => {
    const paths = defaultCopilotAppsPaths({
      XDG_CONFIG_HOME: '/home/u/.config',
      LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
      APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
    } as NodeJS.ProcessEnv, '/home/u');

    expect(paths).toEqual([
      path.join('/home/u/.config', 'github-copilot', 'apps.json'),
      path.join('C:\\Users\\u\\AppData\\Local', 'github-copilot', 'apps.json'),
      path.join('C:\\Users\\u\\AppData\\Roaming', 'github-copilot', 'apps.json'),
    ]);
  });
});
