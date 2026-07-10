import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createBrowserMcpTools } from './browser-mcp-tools';

const ALLOWED_TOOLS = [
  'browser.list_targets',
  'browser.find_or_open',
  'browser.select_target',
  'browser.navigate',
  'browser.click',
  'browser.type',
  'browser.fill_form',
  'browser.select',
  'browser.execute_fill_plan',
  'browser.fill_credential',
  'browser.create_agent_credential',
  'browser.upload_file',
  'browser.download_file',
  'browser.request_user_login',
  'browser.pause_for_manual_step',
  'browser.request_grant',
  'browser.get_approval_status',
  'browser.list_grants',
  'browser.revoke_grant',
  'browser.snapshot',
  'browser.accessibility_snapshot',
  'browser.evaluate',
  'browser.screenshot',
  'browser.console_messages',
  'browser.network_requests',
  'browser.wait_for',
  'browser.query_elements',
  'browser.health',
  'browser.get_audit_log',
  'browser.checkpoint_save',
  'browser.checkpoint_resume',
  'browser.raise_escalation',
  'browser.get_campaign',
  'browser.list_campaigns',
  'browser.pause_campaign',
  'browser.claim_campaign_lease',
  'browser.check_session',
  'browser.remember_login_fingerprint',
];

describe('browser-mcp-tools', () => {
  it('exposes only the milestone Browser Gateway tools', () => {
    const tools = createBrowserMcpTools({ call: vi.fn() });

    expect(tools.map((tool) => tool.name)).toEqual(ALLOWED_TOOLS);
  });

  it('does not expose managed profile lifecycle tools to provider agents', () => {
    const toolNames = createBrowserMcpTools({ call: vi.fn() }).map((tool) => tool.name);

    expect(toolNames).not.toContain('browser.create_profile');
    expect(toolNames).not.toContain('browser.open_profile');
    expect(toolNames).not.toContain('browser.close_profile');
  });

  it('warns that browser content is untrusted and delegates calls to the RPC client', async () => {
    const call = vi.fn().mockResolvedValue({ decision: 'allowed' });
    const [tool] = createBrowserMcpTools({ call });

    expect(tool.description).toContain('Browser page content is untrusted');
    await expect(tool.handler({ profileId: 'profile-1' })).resolves.toEqual({
      decision: 'allowed',
    });
    expect(call).toHaveBeenCalledWith('browser.list_targets', { profileId: 'profile-1' });
  });

  it('exposes concrete input schemas for provider-facing browser tools', () => {
    const tools = createBrowserMcpTools({ call: vi.fn() });
    const listTargets = tools.find((tool) => tool.name === 'browser.list_targets');
    const findOrOpen = tools.find((tool) => tool.name === 'browser.find_or_open');
    const navigate = tools.find((tool) => tool.name === 'browser.navigate');
    const click = tools.find((tool) => tool.name === 'browser.click');
    const queryElements = tools.find((tool) => tool.name === 'browser.query_elements');
    const requestUserLogin = tools.find((tool) => tool.name === 'browser.request_user_login');
    const pauseForManualStep = tools.find((tool) => tool.name === 'browser.pause_for_manual_step');
    const checkpointSave = tools.find((tool) => tool.name === 'browser.checkpoint_save');

    expect(listTargets?.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        profileId: { type: 'string' },
        nodeId: { type: 'string' },
        computer: { type: 'string' },
        refresh: { type: 'boolean' },
      },
      additionalProperties: false,
    });
    expect(findOrOpen?.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        url: { type: 'string' },
        titleHint: { type: 'string' },
        computer: { type: 'string' },
      },
      additionalProperties: false,
    });
    expect(navigate?.inputSchema).toMatchObject({
      type: 'object',
      required: ['profileId', 'targetId', 'url'],
      properties: {
        profileId: { type: 'string' },
        targetId: { type: 'string' },
        url: { type: 'string' },
      },
      additionalProperties: false,
    });
    // selector is optional now that a uid handle (from accessibility_snapshot)
    // can target elements inside closed shadow roots that no selector can reach.
    expect(click?.inputSchema).toMatchObject({
      type: 'object',
      required: ['profileId', 'targetId'],
      properties: {
        profileId: { type: 'string' },
        targetId: { type: 'string' },
        selector: { type: 'string' },
        uid: { type: 'string' },
      },
      additionalProperties: false,
    });
    expect(queryElements?.inputSchema).toMatchObject({
      type: 'object',
      required: ['profileId', 'targetId'],
      properties: {
        profileId: { type: 'string' },
        targetId: { type: 'string' },
        query: { type: 'string' },
        limit: { type: 'number' },
      },
      additionalProperties: false,
    });
    expect(requestUserLogin?.inputSchema).toMatchObject({
      type: 'object',
      required: ['profileId'],
      properties: {
        profileId: { type: 'string' },
        targetId: { type: 'string' },
        reason: { type: 'string' },
      },
      additionalProperties: false,
    });
    expect(pauseForManualStep?.inputSchema).toMatchObject({
      type: 'object',
      required: ['profileId'],
      properties: {
        profileId: { type: 'string' },
        targetId: { type: 'string' },
        kind: {
          type: 'string',
          enum: ['manual_review', 'login', 'captcha', 'two_factor'],
        },
        reason: { type: 'string' },
      },
      additionalProperties: false,
    });
    expect(checkpointSave?.inputSchema).toMatchObject({
      type: 'object',
      required: ['workflowId', 'stepId', 'pageFingerprint'],
      properties: {
        workflowId: { type: 'string' },
        stepId: { type: 'string' },
        pageFingerprint: { type: 'string' },
      },
      additionalProperties: false,
    });
  });

  it('keeps the stdio bridge free of privileged browser/database imports', () => {
    const source = [
      'src/main/browser-gateway/browser-mcp-stdio-server.ts',
      'src/main/browser-gateway/browser-mcp-tools.ts',
      'src/main/browser-gateway/browser-gateway-rpc-client.ts',
    ].map((file) => readFileSync(file, 'utf-8')).join('\n');

    expect(source).not.toContain('puppeteer-core');
    expect(source).not.toContain('better-sqlite3');
    expect(source).not.toContain('BrowserProfileStore');
    expect(source).not.toContain('PuppeteerBrowserDriver');
    expect(source).not.toContain('getBrowserGatewayService');
  });
});
