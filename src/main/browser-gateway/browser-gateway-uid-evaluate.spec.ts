import { describe, expect, it, vi } from 'vitest';
import { makeGrant, makeService } from './browser-gateway-service.test-helpers';
import {
  BrowserClickRequestSchema,
  BrowserEvaluateRequestSchema,
  BrowserFillFormFieldSchema,
} from '@contracts/schemas/browser';

const existingTab = {
  profileId: 'existing-tab:7:42',
  targetId: 'existing-tab:7:42:target',
  tabId: 42,
  windowId: 7,
  title: 'Register a domain',
  url: 'https://registrar.example.com/domains',
  origin: 'https://registrar.example.com',
  allowedOrigins: [
    {
      scheme: 'https' as const,
      hostPattern: 'registrar.example.com',
      includeSubdomains: false,
    },
  ],
};

describe('Browser Gateway uid targeting + accessibility snapshot + evaluate', () => {
  describe('uid-targeted acting on existing Chrome tabs', () => {
    it('forwards a uid (and no selector) to the extension for a closed-shadow click', async () => {
      const sendCommand = vi.fn(async () => ({ tagName: 'BUTTON', connected: true }));
      const { service } = makeService({
        existingTab,
        extensionCommandStore: { sendCommand },
        grants: [
          makeGrant({
            profileId: existingTab.profileId,
            targetId: existingTab.targetId,
            allowedOrigins: existingTab.allowedOrigins,
            allowedActionClasses: ['input'],
          }),
        ],
      });

      const result = await service.click({
        instanceId: 'instance-1',
        provider: 'copilot',
        profileId: existingTab.profileId,
        targetId: existingTab.targetId,
        uid: '512',
        actionHint: 'Register',
      });

      expect(result).toMatchObject({ decision: 'allowed', outcome: 'succeeded' });
      expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
        command: 'click',
        payload: { uid: '512' },
      }));
    });

    it('forwards uid + value for type', async () => {
      const sendCommand = vi.fn(async () => ({ tagName: 'INPUT', valueApplied: true }));
      const { service } = makeService({
        existingTab,
        extensionCommandStore: { sendCommand },
        grants: [
          makeGrant({
            profileId: existingTab.profileId,
            targetId: existingTab.targetId,
            allowedOrigins: existingTab.allowedOrigins,
            allowedActionClasses: ['input'],
          }),
        ],
      });

      await service.type({
        instanceId: 'instance-1',
        provider: 'copilot',
        profileId: existingTab.profileId,
        targetId: existingTab.targetId,
        uid: '777',
        value: 'shutupandshave.com',
        actionHint: 'Domain',
      });

      expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
        command: 'type',
        payload: { uid: '777', value: 'shutupandshave.com' },
      }));
    });

  });

  describe('uid targeting against managed profiles is rejected', () => {
    it('denies uid click for a managed (non-existing-tab) target', async () => {
      const { service } = makeService({}); // managed profile, no existing tab
      const result = await service.click({
        instanceId: 'instance-1',
        provider: 'copilot',
        profileId: 'profile-1',
        targetId: 'profile-1:0',
        uid: '512',
      });
      expect(result).toMatchObject({
        decision: 'denied',
        outcome: 'not_run',
        reason: 'uid_targeting_requires_existing_tab',
      });
    });
  });

  describe('accessibility_snapshot', () => {
    it('reads + normalizes nodes from an existing tab', async () => {
      const sendCommand = vi.fn(async () => ({
        nodes: [
          { uid: '12', role: 'textbox', name: 'Domain' },
          { uid: '13', role: 'textbox', name: 'Return URL' },
          { uid: '14', role: 'button', name: 'Register' },
        ],
      }));
      const { service } = makeService({
        existingTab,
        extensionCommandStore: { sendCommand },
      });

      const result = await service.accessibilitySnapshot({
        instanceId: 'instance-1',
        provider: 'copilot',
        profileId: existingTab.profileId,
        targetId: existingTab.targetId,
      });

      expect(result).toMatchObject({ decision: 'allowed', outcome: 'succeeded' });
      expect(result.data).toEqual([
        { uid: '12', role: 'textbox', name: 'Domain' },
        { uid: '13', role: 'textbox', name: 'Return URL' },
        { uid: '14', role: 'button', name: 'Register' },
      ]);
      expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
        command: 'accessibility_snapshot',
        payload: { interestingOnly: true, limit: 2000 },
      }));
    });

    it('reads the accessibility tree from a managed profile via the driver', async () => {
      const accessibilitySnapshot = vi.fn(async () => [
        { uid: '90', role: 'link', name: 'Home' },
      ]);
      const { service } = makeService({ accessibilitySnapshot });

      const result = await service.accessibilitySnapshot({
        instanceId: 'instance-1',
        provider: 'copilot',
        profileId: 'profile-1',
        targetId: 'target-1',
      });

      expect(result).toMatchObject({ decision: 'allowed', outcome: 'succeeded' });
      expect(result.data).toEqual([{ uid: '90', role: 'link', name: 'Home' }]);
      expect(accessibilitySnapshot).toHaveBeenCalled();
    });
  });

  describe('evaluate', () => {
    it('requires user approval when no grant is present', async () => {
      const sendCommand = vi.fn(async () => ({ type: 'string', json: '"x"' }));
      const { service, approvalRequests } = makeService({
        existingTab,
        extensionCommandStore: { sendCommand },
      });

      const result = await service.evaluate({
        instanceId: 'instance-1',
        provider: 'copilot',
        profileId: existingTab.profileId,
        targetId: existingTab.targetId,
        expression: 'document.cookie',
      });

      expect(result.decision).toBe('requires_user');
      expect(sendCommand).not.toHaveBeenCalled();
      // The approving user must be shown the actual expression they are approving.
      const approval = approvalRequests.at(-1);
      expect(approval?.elementContext?.visibleText).toContain('document.cookie');
    });

    it('executes under an auto-approved grant and returns a normalized result', async () => {
      const sendCommand = vi.fn(async () => ({ type: 'string', json: '"Example"', truncated: false }));
      const { service } = makeService({
        existingTab,
        extensionCommandStore: { sendCommand },
        autoApproveRequests: ({ instanceId }) => instanceId === 'instance-1',
      });

      const result = await service.evaluate({
        instanceId: 'instance-1',
        provider: 'copilot',
        profileId: existingTab.profileId,
        targetId: existingTab.targetId,
        expression: 'document.title',
      });

      expect(result).toMatchObject({ decision: 'allowed', outcome: 'succeeded' });
      expect(result.data).toMatchObject({ type: 'string', json: '"Example"' });
      expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
        command: 'evaluate',
        payload: { expression: 'document.title', awaitPromise: true },
      }));
    });
  });

  describe('request schemas', () => {
    it('rejects an action with neither selector nor uid', () => {
      const parsed = BrowserClickRequestSchema.safeParse({
        profileId: 'p',
        targetId: 't',
      });
      expect(parsed.success).toBe(false);
    });

    it('accepts a uid-only action', () => {
      const parsed = BrowserClickRequestSchema.safeParse({
        profileId: 'p',
        targetId: 't',
        uid: '512',
      });
      expect(parsed.success).toBe(true);
    });

    it('accepts a selector-only action (back-compat)', () => {
      const parsed = BrowserClickRequestSchema.safeParse({
        profileId: 'p',
        targetId: 't',
        selector: '#go',
      });
      expect(parsed.success).toBe(true);
    });

    it('rejects a fill field with neither selector nor uid', () => {
      const parsed = BrowserFillFormFieldSchema.safeParse({ value: 'x' });
      expect(parsed.success).toBe(false);
    });

    it('requires an expression for evaluate', () => {
      const parsed = BrowserEvaluateRequestSchema.safeParse({
        profileId: 'p',
        targetId: 't',
      });
      expect(parsed.success).toBe(false);
    });
  });
});
