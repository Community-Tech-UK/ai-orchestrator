import { describe, expect, it } from 'vitest';
import {
  buildCredentialAuthorizationDenial,
  formatAuthorizeCommand,
  formatAuthorizedOriginHosts,
  formatCredentialAuthorizationDenial,
} from './browser-credential-authorization-denial';

const NODE_ID = 'bb62e3ee-ccd7-4ea4-93f1-4ac0a0cd04be';
const ORIGIN = 'https://education.app.jaggaer.com';

describe('formatAuthorizeCommand', () => {
  it('uses --local for the coordinator shared-tab scope', () => {
    expect(formatAuthorizeCommand('local', ORIGIN, 'login')).toBe(
      `$AIO_MCP browser-credentials authorize --local --origin ${ORIGIN} --purpose login --vault-folder AIO-Agent --expires-in 90d`,
    );
  });

  it('uses --node for a worker UUID (the fill-time shared-tab scope)', () => {
    expect(formatAuthorizeCommand(NODE_ID, ORIGIN, 'login')).toContain(`--node ${NODE_ID}`);
    expect(formatAuthorizeCommand(NODE_ID, ORIGIN, 'login')).not.toContain('--profile');
  });

  it('uses --profile for a managed browser profile id', () => {
    expect(formatAuthorizeCommand('aio-procurement', ORIGIN, 'login')).toContain(
      '--profile aio-procurement',
    );
  });
});

describe('formatAuthorizedOriginHosts', () => {
  it('renders exact hosts and wildcard grants, de-duplicated', () => {
    expect(
      formatAuthorizedOriginHosts([
        {
          allowedOrigins: [
            { scheme: 'https', hostPattern: 'uktrade.app.jaggaer.com', includeSubdomains: false },
            { scheme: 'https', hostPattern: 'example.gov.uk', includeSubdomains: true },
          ],
        },
        {
          allowedOrigins: [
            { scheme: 'https', hostPattern: 'uktrade.app.jaggaer.com', includeSubdomains: false },
          ],
        },
      ]),
    ).toEqual([
      'https://uktrade.app.jaggaer.com',
      'https://*.example.gov.uk',
    ]);
  });
});

describe('formatCredentialAuthorizationDenial', () => {
  it('keeps the machine prefix and tells the agent how to mint the missing grant', () => {
    const denial = formatCredentialAuthorizationDenial({
      toolName: 'browser.fill_credential',
      origin: ORIGIN,
      purpose: 'login',
      reason: 'origin_not_authorized',
      scope: NODE_ID,
      authorizedOrigins: ['https://uktrade.app.jaggaer.com'],
    });

    expect(denial.reason.startsWith('credential_not_authorized:origin_not_authorized:')).toBe(true);
    expect(denial.reason).toContain('browser.request_grant does not cover credential fill');
    expect(denial.reason).toContain('This scope already covers: https://uktrade.app.jaggaer.com');
    expect(denial.reason).toContain(`$AIO_MCP browser-credentials authorize --node ${NODE_ID}`);
    expect(denial.reason).toContain(`--origin ${ORIGIN}`);
    expect(denial.summary).not.toContain('credential_not_authorized');
    expect(denial.reason.length).toBeLessThanOrEqual(1000);
  });

  it('does not advertise the CLI for secret_fill (the CLI cannot mint it)', () => {
    const denial = formatCredentialAuthorizationDenial({
      toolName: 'browser.fill_secret',
      origin: ORIGIN,
      purpose: 'secret_fill',
      reason: 'origin_not_authorized',
      scope: 'local',
      detail: 'iban',
    });

    expect(denial.reason.startsWith('secret_not_authorized:origin_not_authorized:')).toBe(true);
    expect(denial.reason).toContain('(iban)');
    expect(denial.reason).toContain('the CLI cannot mint secret_fill');
    expect(denial.reason).not.toContain('browser-credentials authorize');
  });
});

describe('buildCredentialAuthorizationDenial', () => {
  it('pulls standing origins from list() so a sibling Jaggaer tenant is visible', () => {
    const denial = buildCredentialAuthorizationDenial(
      () => [
        {
          allowedOrigins: [
            { scheme: 'https', hostPattern: 'uktrade.app.jaggaer.com', includeSubdomains: false },
          ],
        },
      ],
      {
        toolName: 'browser.fill_credential',
        origin: ORIGIN,
        purpose: 'login',
        reason: 'origin_not_authorized',
        scope: NODE_ID,
      },
    );

    expect(denial.reason).toContain('https://uktrade.app.jaggaer.com');
    expect(denial.reason).toContain(ORIGIN);
  });
});
