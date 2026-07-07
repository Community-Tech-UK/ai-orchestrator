import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, verify } from 'crypto';
import {
  MobileApnsSender,
  buildApnsJwt,
  buildApnsPayload,
  buildLiveActivityPayload,
  apnsHost,
  type ApnsTransport,
} from './mobile-apns-sender';
import type { MobileApnsConfig } from '../../shared/types/mobile-gateway.types';

const keyPair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const P8 = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

function config(overrides: Partial<MobileApnsConfig> = {}): MobileApnsConfig {
  return {
    keyP8: P8,
    keyId: 'KEYID12345',
    teamId: 'TEAMID6789',
    bundleId: 'com.example.app',
    production: false,
    ...overrides,
  };
}

function decodeSegment(seg: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8'));
}

describe('apnsHost', () => {
  it('selects production vs sandbox host', () => {
    expect(apnsHost(true)).toBe('api.push.apple.com');
    expect(apnsHost(false)).toBe('api.sandbox.push.apple.com');
  });
});

describe('buildApnsJwt', () => {
  it('produces a verifiable ES256 JWT with the right header and claims', () => {
    const jwt = buildApnsJwt(config(), 1_700_000_000);
    const [header, claims, signature] = jwt.split('.');
    expect(signature).toBeTruthy();

    expect(decodeSegment(header)).toEqual({ alg: 'ES256', kid: 'KEYID12345', typ: 'JWT' });
    expect(decodeSegment(claims)).toEqual({ iss: 'TEAMID6789', iat: 1_700_000_000 });

    // The signature must verify against the matching public key (proves ES256 R||S).
    const ok = verify(
      'sha256',
      Buffer.from(`${header}.${claims}`),
      { key: keyPair.publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
    );
    expect(ok).toBe(true);
  });
});

describe('buildApnsPayload', () => {
  it('builds the aps alert body and merges custom data', () => {
    const payload = JSON.parse(
      buildApnsPayload({
        title: 'Bash needs approval',
        body: 'Agent · my-repo',
        category: 'AIO_APPROVAL',
        threadId: 'inst-1',
        data: { instanceId: 'inst-1', requestId: 'req-1', kind: 'permission' },
      }),
    );
    expect(payload.aps.alert).toEqual({ title: 'Bash needs approval', body: 'Agent · my-repo' });
    expect(payload.aps.category).toBe('AIO_APPROVAL');
    expect(payload.aps['thread-id']).toBe('inst-1');
    expect(payload.instanceId).toBe('inst-1');
    expect(payload.requestId).toBe('req-1');
  });
});

describe('MobileApnsSender', () => {
  it('isConfigured requires key, keyId, teamId and bundleId', () => {
    expect(new MobileApnsSender({ configProvider: () => config() }).isConfigured()).toBe(true);
    expect(
      new MobileApnsSender({ configProvider: () => config({ keyP8: '' }) }).isConfigured(),
    ).toBe(false);
    expect(
      new MobileApnsSender({ configProvider: () => config({ bundleId: '' }) }).isConfigured(),
    ).toBe(false);
  });

  it('no-ops when unconfigured', async () => {
    let called = false;
    const transport: ApnsTransport = {
      post: async () => {
        called = true;
        return { status: 200 };
      },
    };
    const sender = new MobileApnsSender({ configProvider: () => config({ keyP8: '' }), transport });
    const results = await sender.send(['tok'], { title: 't', body: 'b' });
    expect(results).toEqual([]);
    expect(called).toBe(false);
  });

  it('posts to each device token with the bundle id as topic', async () => {
    const seen: { host: string; topic: string; deviceToken: string }[] = [];
    const transport: ApnsTransport = {
      post: async (args) => {
        seen.push({ host: args.host, topic: args.topic, deviceToken: args.deviceToken });
        return { status: 200 };
      },
    };
    const sender = new MobileApnsSender({
      configProvider: () => config(),
      transport,
      now: () => 1_700_000_000_000,
    });
    const results = await sender.send(['a', 'b'], { title: 't', body: 'b' });
    expect(results.every((r) => r.ok)).toBe(true);
    expect(seen.map((s) => s.deviceToken)).toEqual(['a', 'b']);
    expect(seen[0].topic).toBe('com.example.app');
    expect(seen[0].host).toBe('api.sandbox.push.apple.com');
  });

  it('reports non-200 as a failure with the reason', async () => {
    const transport: ApnsTransport = {
      post: async () => ({ status: 410, reason: 'Unregistered' }),
    };
    const sender = new MobileApnsSender({ configProvider: () => config(), transport, now: () => 1 });
    const [result] = await sender.send(['dead-token'], { title: 't', body: 'b' });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(410);
    expect(result.reason).toBe('Unregistered');
  });

  it('reuses the cached JWT across sends within the TTL', async () => {
    const jwts = new Set<string>();
    const transport: ApnsTransport = {
      post: async (args) => {
        jwts.add(args.jwt);
        return { status: 200 };
      },
    };
    let now = 1_700_000_000_000;
    const sender = new MobileApnsSender({ configProvider: () => config(), transport, now: () => now });
    await sender.send(['a'], { title: 't', body: 'b' });
    now += 60_000; // +1 min, within the 50-min TTL
    await sender.send(['a'], { title: 't', body: 'b' });
    expect(jwts.size).toBe(1);
  });
});

describe('buildLiveActivityPayload', () => {
  it('builds an update payload with timestamp, event and content-state', () => {
    const payload = JSON.parse(
      buildLiveActivityPayload(
        {
          event: 'update',
          contentState: { status: 'working', detail: 'my-repo' },
          staleDate: 1_700_001_800,
        },
        1_700_000_000,
      ),
    );
    expect(payload.aps.timestamp).toBe(1_700_000_000);
    expect(payload.aps.event).toBe('update');
    expect(payload.aps['content-state']).toEqual({ status: 'working', detail: 'my-repo' });
    expect(payload.aps['stale-date']).toBe(1_700_001_800);
    expect(payload.aps['dismissal-date']).toBeUndefined();
  });

  it('includes the dismissal date on end events', () => {
    const payload = JSON.parse(
      buildLiveActivityPayload(
        {
          event: 'end',
          contentState: { status: 'idle', detail: '' },
          dismissalDate: 1_700_000_300,
        },
        1_700_000_000,
      ),
    );
    expect(payload.aps.event).toBe('end');
    expect(payload.aps['dismissal-date']).toBe(1_700_000_300);
  });
});

describe('MobileApnsSender.sendLiveActivity', () => {
  it('posts with the liveactivity push type and topic suffix', async () => {
    const seen: { topic: string; pushType?: string; payload: string }[] = [];
    const transport: ApnsTransport = {
      post: async (args) => {
        seen.push({ topic: args.topic, pushType: args.pushType, payload: args.payload });
        return { status: 200 };
      },
    };
    const sender = new MobileApnsSender({
      configProvider: () => config(),
      transport,
      now: () => 1_700_000_000_000,
    });
    const results = await sender.sendLiveActivity(['activity-token'], {
      event: 'update',
      contentState: { status: 'working', detail: 'repo' },
    });
    expect(results).toEqual([
      { deviceToken: 'activity-token', ok: true, status: 200, reason: undefined },
    ]);
    expect(seen[0].topic).toBe('com.example.app.push-type.liveactivity');
    expect(seen[0].pushType).toBe('liveactivity');
    expect(JSON.parse(seen[0].payload).aps.timestamp).toBe(1_700_000_000);
  });

  it('no-ops when unconfigured', async () => {
    let called = false;
    const transport: ApnsTransport = {
      post: async () => {
        called = true;
        return { status: 200 };
      },
    };
    const sender = new MobileApnsSender({ configProvider: () => config({ keyP8: '' }), transport });
    const results = await sender.sendLiveActivity(['tok'], {
      event: 'update',
      contentState: { status: 'working', detail: '' },
    });
    expect(results).toEqual([]);
    expect(called).toBe(false);
  });
});
