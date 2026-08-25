import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CopilotAccountProfile } from '../../../shared/types/copilot-account.types';
import {
  CopilotAccountBindingService,
  LOCAL_COPILOT_NODE_ID,
  MAX_COPILOT_CONFIG_BYTES,
} from './copilot-account-binding-service';

const { logSpies } = vi.hoisted(() => ({
  logSpies: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const { warn, info, error, debug } = logSpies;

vi.mock('../../logging/logger', () => ({
  getLogger: () => logSpies,
}));

let root = '';

function makeProfile(overrides: Partial<CopilotAccountProfile> = {}): CopilotAccountProfile {
  return {
    id: 'personal',
    label: 'Personal',
    expectedLogin: 'octocat',
    host: 'github.com',
    accountKind: 'personal',
    scopePolicy: 'default-eligible',
    automationPolicy: 'allow-routed',
    isDefault: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeService(): CopilotAccountBindingService {
  return new CopilotAccountBindingService({
    resolveHome: (profile) => join(root, profile.id),
  });
}

function writeConfig(profileId: string, contents: string): void {
  const home = join(root, profileId);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), contents, 'utf8');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'copilot-binding-'));
  warn.mockClear();
  info.mockClear();
  error.mockClear();
  debug.mockClear();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('CopilotAccountBindingService.checkBinding', () => {
  it('reports unauthenticated when the profile home does not exist', async () => {
    const status = await makeService().checkBinding(makeProfile());
    expect(status.state).toBe('unauthenticated');
    expect(status.errorCode).toBe('no-config');
    expect(status.nodeId).toBe(LOCAL_COPILOT_NODE_ID);
  });

  it('reports unauthenticated for a config with no logged-in user', async () => {
    writeConfig('personal', JSON.stringify({ loggedInUsers: [] }));
    const status = await makeService().checkBinding(makeProfile());
    expect(status.state).toBe('unauthenticated');
    expect(status.errorCode).toBe('no-logged-in-user');
  });

  it('reports authenticated when the observed identity matches', async () => {
    writeConfig(
      'personal',
      JSON.stringify({ lastLoggedInUser: { host: 'github.com', login: 'octocat' } }),
    );
    const status = await makeService().checkBinding(makeProfile());
    expect(status.state).toBe('authenticated');
    expect(status.observedLogin).toBe('octocat');
    expect(status.observedHost).toBe('github.com');
  });

  it('matches identity case-insensitively', async () => {
    writeConfig(
      'personal',
      JSON.stringify({ lastLoggedInUser: { host: 'GitHub.com', login: 'OctoCat' } }),
    );
    const status = await makeService().checkBinding(makeProfile());
    expect(status.state).toBe('authenticated');
  });

  it('reports identity-mismatch when the login differs', async () => {
    writeConfig(
      'personal',
      JSON.stringify({ lastLoggedInUser: { host: 'github.com', login: 'someone-else' } }),
    );
    const status = await makeService().checkBinding(makeProfile());
    expect(status.state).toBe('identity-mismatch');
    expect(status.errorCode).toBe('login-mismatch');
  });

  it('reports identity-mismatch when the host differs', async () => {
    writeConfig(
      'personal',
      JSON.stringify({ lastLoggedInUser: { host: 'ghe.example.com', login: 'octocat' } }),
    );
    const status = await makeService().checkBinding(makeProfile());
    expect(status.state).toBe('identity-mismatch');
    expect(status.errorCode).toBe('host-mismatch');
  });

  it('adopts the observed identity on a first, unverified profile', async () => {
    writeConfig(
      'personal',
      JSON.stringify({ lastLoggedInUser: { host: 'github.com', login: 'brand-new' } }),
    );
    const status = await makeService().checkBinding(makeProfile({ expectedLogin: null }));
    expect(status.state).toBe('authenticated');
    expect(status.observedLogin).toBe('brand-new');
  });

  it('falls back to loggedInUsers when lastLoggedInUser is absent', async () => {
    writeConfig(
      'personal',
      JSON.stringify({ loggedInUsers: [{ host: 'github.com', login: 'octocat' }] }),
    );
    const status = await makeService().checkBinding(makeProfile());
    expect(status.state).toBe('authenticated');
  });

  it('tolerates JSONC full-line comments', async () => {
    writeConfig(
      'personal',
      '// auto-managed by copilot\n' +
        JSON.stringify({ lastLoggedInUser: { host: 'github.com', login: 'octocat' } }),
    );
    const status = await makeService().checkBinding(makeProfile());
    expect(status.state).toBe('authenticated');
  });

  it('reports unavailable rather than parsing an oversized config', async () => {
    const padding = 'x'.repeat(MAX_COPILOT_CONFIG_BYTES + 16);
    writeConfig(
      'personal',
      JSON.stringify({ lastLoggedInUser: { host: 'github.com', login: 'octocat' }, padding }),
    );
    const status = await makeService().checkBinding(makeProfile());
    expect(status.state).toBe('unavailable');
    expect(status.errorCode).toBe('config-too-large');
  });

  it('reports unavailable for malformed JSON without echoing file content', async () => {
    writeConfig('personal', '{ this is not json');
    const status = await makeService().checkBinding(makeProfile());
    expect(status.state).toBe('unavailable');
    expect(status.errorCode).toBe('config-unparseable');
  });

  it('never returns or logs a plaintext token found in the config', async () => {
    const secretShaped = 'gho_NOT_A_REAL_TOKEN_placeholder';
    writeConfig(
      'personal',
      JSON.stringify({
        lastLoggedInUser: { host: 'github.com', login: 'octocat' },
        copilotTokens: { 'github.com:octocat': secretShaped },
      }),
    );
    const status = await makeService().checkBinding(makeProfile());
    expect(status.state).toBe('authenticated');
    expect(JSON.stringify(status)).not.toContain(secretShaped);
    expect(JSON.stringify(status)).not.toContain('copilotTokens');
    for (const spy of [warn, info, error, debug]) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(secretShaped);
      }
    }
  });

  it('flags a profile that opts into plaintext token storage', async () => {
    writeConfig(
      'personal',
      JSON.stringify({ lastLoggedInUser: { host: 'github.com', login: 'octocat' } }),
    );
    writeFileSync(
      join(root, 'personal', 'settings.json'),
      JSON.stringify({ storeTokenPlaintext: true }),
      'utf8',
    );
    const status = await makeService().checkBinding(makeProfile());
    expect(status.storesTokenPlaintext).toBe(true);
  });
});

describe('CopilotAccountBindingService caching', () => {
  it('re-reads after the config changes even inside the TTL', async () => {
    writeConfig(
      'personal',
      JSON.stringify({ lastLoggedInUser: { host: 'github.com', login: 'octocat' } }),
    );
    const service = makeService();
    expect((await service.checkBinding(makeProfile())).state).toBe('authenticated');

    // A re-login rewrites config.json, so a changed mtime must defeat the TTL.
    await new Promise((resolve) => setTimeout(resolve, 12));
    writeConfig(
      'personal',
      JSON.stringify({ lastLoggedInUser: { host: 'github.com', login: 'someone-else' } }),
    );
    expect((await service.checkBinding(makeProfile())).state).toBe('identity-mismatch');
  });

  it('drops cached health on explicit invalidation', async () => {
    writeConfig(
      'personal',
      JSON.stringify({ lastLoggedInUser: { host: 'github.com', login: 'octocat' } }),
    );
    const service = makeService();
    const first = await service.checkBinding(makeProfile());
    service.invalidate('personal');
    const second = await service.checkBinding(makeProfile());
    expect(second.state).toBe(first.state);
    expect(second).not.toBe(first);
  });
});
