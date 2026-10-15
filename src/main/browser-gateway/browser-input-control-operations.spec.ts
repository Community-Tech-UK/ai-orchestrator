import { describe, expect, it, vi } from 'vitest';
import { makeGrant, makeService } from './browser-gateway-service.test-helpers';
import {
  WINDOW_VIEWPORT_UNSUPPORTED_MANAGED_REASON,
  ZOOM_UNSUPPORTED_MANAGED_REASON,
} from './browser-input-control-operations';

const fixtureTab = {
  profileId: 'existing-tab:7:42',
  targetId: 'existing-tab:7:42:target',
  tabId: 42,
  windowId: 7,
  title: 'Fixture',
  url: 'https://fixture.test/page',
  origin: 'https://fixture.test',
  allowedOrigins: [
    { scheme: 'https' as const, hostPattern: 'fixture.test', includeSubdomains: false },
  ],
};

function inputGrant() {
  return makeGrant({
    profileId: fixtureTab.profileId,
    targetId: fixtureTab.targetId,
    allowedOrigins: fixtureTab.allowedOrigins,
    allowedActionClasses: ['input'],
  });
}

describe('browser input control operations', () => {
  describe('browser.press_key', () => {
    it('presses Shift+Tab in an existing tab through the extension with focus read-back', async () => {
      const sendCommand = vi.fn(async () => ({
        applied: true,
        key: 'Tab',
        modifiers: ['Shift'],
        focus: { tagName: 'A', role: 'link', text: 'Help', href: 'https://fixture.test/help' },
        url: 'https://fixture.test/page',
        title: 'Fixture',
      }));
      const { service } = makeService({
        existingTab: fixtureTab,
        extensionCommandStore: { sendCommand },
        grants: [inputGrant()],
      });

      const result = await service.pressKey({
        instanceId: 'instance-1',
        provider: 'copilot',
        profileId: fixtureTab.profileId,
        targetId: fixtureTab.targetId,
        key: 'Tab',
        modifiers: ['Shift'],
        actionHint: 'move focus to the previous control',
      });

      expect(result).toMatchObject({ decision: 'allowed', outcome: 'succeeded' });
      expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
        command: 'press_key',
        payload: {
          key: 'Tab',
          modifiers: ['Shift'],
        },
      }));
      expect(result.data).toMatchObject({
        applied: true,
        key: 'Tab',
        modifiers: ['Shift'],
        focus: { tagName: 'A', role: 'link' },
      });
    });

    it('passes the idempotencyKey and surfaces a deduplicated retry without a second press', async () => {
      const sendCommand = vi.fn(async () => ({
        applied: true,
        key: 'Enter',
        modifiers: [],
        deduplicated: true,
        url: 'https://fixture.test/next',
        title: 'Next',
      }));
      const { service } = makeService({
        existingTab: fixtureTab,
        extensionCommandStore: { sendCommand },
        // The activation gate is evaluate-style: it takes an explicit approved
        // grant or an auto-approve predicate (YOLO) — never a silent default.
        autoApproveRequests: () => true,
      });

      const result = await service.pressKey({
        instanceId: 'instance-1',
        provider: 'copilot',
        profileId: fixtureTab.profileId,
        targetId: fixtureTab.targetId,
        key: 'Enter',
        idempotencyKey: 'activate-help-1',
      });

      expect(result).toMatchObject({ decision: 'allowed', outcome: 'succeeded' });
      expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
        command: 'press_key',
        payload: { key: 'Enter', idempotencyKey: 'activate-help-1' },
      }));
      expect(result.data?.deduplicated).toBe(true);
    });

    it('never activates Enter without explicit authority: no grant means no dispatch', async () => {
      const sendCommand = vi.fn(async () => ({ applied: true, key: 'Enter', modifiers: [] }));
      const { service } = makeService({
        existingTab: fixtureTab,
        extensionCommandStore: { sendCommand },
      });

      const result = await service.pressKey({
        instanceId: 'instance-1',
        provider: 'copilot',
        profileId: fixtureTab.profileId,
        targetId: fixtureTab.targetId,
        key: 'Enter',
      });

      expect(result).toMatchObject({ decision: 'requires_user', outcome: 'not_run' });
      expect(sendCommand).not.toHaveBeenCalled();
    });

    it('classifies an unhinted Tab as ordinary input and runs under an input grant', async () => {
      const sendCommand = vi.fn(async () => ({
        applied: true,
        key: 'Tab',
        modifiers: [],
        focus: { tagName: 'INPUT', type: 'text' },
      }));
      const { service } = makeService({
        existingTab: fixtureTab,
        extensionCommandStore: { sendCommand },
        grants: [inputGrant()],
      });

      const result = await service.pressKey({
        instanceId: 'instance-1',
        provider: 'copilot',
        profileId: fixtureTab.profileId,
        targetId: fixtureTab.targetId,
        key: 'Tab',
      });

      expect(result).toMatchObject({ decision: 'allowed', outcome: 'succeeded' });
    });

    it('routes managed profiles to the driver keyboard, not the extension', async () => {
      const pressKey = vi.fn(async () => ({
        applied: true as const,
        key: 'ArrowDown' as const,
        modifiers: [] as never[],
        focus: { tagName: 'BUTTON', text: 'Next' },
        url: 'http://localhost:4567',
        title: 'Local',
      }));
      const sendCommand = vi.fn(async () => ({ ok: true }));
      const { service } = makeService({
        pressKey,
        extensionCommandStore: { sendCommand },
        grants: [makeGrant({
          profileId: 'profile-1',
          targetId: 'target-1',
          allowedActionClasses: ['input'],
        })],
      });

      const result = await service.pressKey({
        instanceId: 'instance-1',
        provider: 'copilot',
        profileId: 'profile-1',
        targetId: 'target-1',
        key: 'ArrowDown',
      });

      expect(result).toMatchObject({ decision: 'allowed', outcome: 'succeeded' });
      expect(pressKey).toHaveBeenCalledWith('profile-1', 'target-1', 'ArrowDown', []);
      expect(sendCommand).not.toHaveBeenCalled();
    });

    it('refuses Enter that describes credential work instead of routing it around the hard stops', async () => {
      const sendCommand = vi.fn(async () => ({ applied: true, key: 'Enter', modifiers: [] }));
      const { service } = makeService({
        existingTab: fixtureTab,
        extensionCommandStore: { sendCommand },
        autoApproveRequests: () => true,
      });

      const result = await service.pressKey({
        instanceId: 'instance-1',
        provider: 'copilot',
        profileId: fixtureTab.profileId,
        targetId: fixtureTab.targetId,
        key: 'Enter',
        actionHint: 'submit the password field',
      });

      // Password words hard-stop as credential-class even under auto-approve.
      expect(result.decision).not.toBe('allowed');
      expect(sendCommand).not.toHaveBeenCalled();
    });

    it('suppresses a managed-profile Enter retry under the same idempotencyKey', async () => {
      const pressKey = vi.fn(async () => ({
        applied: true as const,
        key: 'Enter' as const,
        modifiers: [] as never[],
        url: 'http://localhost:4567',
        title: 'Local',
      }));
      const { service } = makeService({
        pressKey,
        autoApproveRequests: () => true,
      });
      const request = {
        instanceId: 'instance-1',
        provider: 'copilot' as const,
        profileId: 'profile-1',
        targetId: 'target-1',
        key: 'Enter' as const,
        idempotencyKey: 'managed-enter-1',
      };

      const first = await service.pressKey(request);
      const second = await service.pressKey(request);

      expect(first).toMatchObject({ decision: 'allowed', outcome: 'succeeded' });
      expect(first.data).toMatchObject({ applied: true });
      expect(pressKey).toHaveBeenCalledTimes(1);
      // The retry neither presses again nor claims a fresh success.
      expect(second.data).toMatchObject({ applied: true, deduplicated: true });
      expect(second.data?.deduplicated).toBe(true);
    });

    it('never re-fires a failed activation and never claims the retry succeeded', async () => {
      const pressKey = vi.fn(async () => {
        throw new Error('channel died mid-press');
      });
      const { service } = makeService({
        pressKey,
        autoApproveRequests: () => true,
      });
      const request = {
        instanceId: 'instance-1',
        provider: 'copilot' as const,
        profileId: 'profile-1',
        targetId: 'target-1',
        key: 'Enter' as const,
        idempotencyKey: 'managed-enter-fail-1',
      };

      const first = await service.pressKey(request);
      const retry = await service.pressKey(request);

      expect(first).toMatchObject({ outcome: 'failed' });
      expect(pressKey).toHaveBeenCalledTimes(1);
      // The retry is suppressed: applied=false, explicit reason, no second press.
      expect(retry).toMatchObject({
        outcome: 'failed',
        reason: 'press_key_prior_attempt_outcome_unknown',
      });
      expect(retry.data).toMatchObject({ applied: false, deduplicated: true });
      expect(pressKey).toHaveBeenCalledTimes(1);
    });

    it('lets a deliberate re-press through under a NEW idempotencyKey', async () => {
      const pressKey = vi.fn(async () => ({
        applied: true as const,
        key: 'Enter' as const,
        modifiers: [] as never[],
        url: 'http://localhost:4567',
        title: 'Local',
      }));
      const { service } = makeService({
        pressKey,
        autoApproveRequests: () => true,
      });
      const base = {
        instanceId: 'instance-1',
        provider: 'copilot' as const,
        profileId: 'profile-1',
        targetId: 'target-1',
        key: 'Enter' as const,
      };

      await service.pressKey({ ...base, idempotencyKey: 'enter-a' });
      await service.pressKey({ ...base, idempotencyKey: 'enter-b' });

      expect(pressKey).toHaveBeenCalledTimes(2);
    });

    it('treats an executing-side suppression of an unconfirmed press as failed, never success', async () => {
      // The extension-side memory (e.g. surviving a coordinator restart)
      // suppresses a retry of an unfinished/failed original and reports
      // applied:false + deduplicated:true.
      const sendCommand = vi.fn(async () => ({
        applied: false,
        key: 'Enter',
        modifiers: [],
        deduplicated: true,
      }));
      const { service } = makeService({
        existingTab: fixtureTab,
        extensionCommandStore: { sendCommand },
        autoApproveRequests: () => true,
      });

      const result = await service.pressKey({
        instanceId: 'instance-1',
        provider: 'copilot',
        profileId: fixtureTab.profileId,
        targetId: fixtureTab.targetId,
        key: 'Enter',
        idempotencyKey: 'ext-suppressed-1',
      });

      expect(result).toMatchObject({
        outcome: 'failed',
        reason: 'press_key_prior_attempt_outcome_unknown',
      });
      expect(result.data).toMatchObject({ applied: false, deduplicated: true });
    });

    it('does not upgrade an effect-verified failure to success on a same-key retry', async () => {
      const sendCommand = vi.fn(async (request: { command: string }) => {
        if (request.command === 'snapshot') {
          return {
            tabId: 42,
            windowId: 7,
            url: 'https://fixture.test/page',
            title: 'Fixture',
            text: 'unchanged',
            inspectionState: 'readable',
          };
        }
        return { applied: true, key: 'Enter', modifiers: [] };
      });
      const { service } = makeService({
        existingTab: fixtureTab,
        extensionCommandStore: { sendCommand },
        autoApproveRequests: () => true,
      });
      const request = {
        instanceId: 'instance-1',
        provider: 'copilot' as const,
        profileId: fixtureTab.profileId,
        targetId: fixtureTab.targetId,
        key: 'Enter' as const,
        idempotencyKey: 'enter-no-effect-1',
        expectUrlChange: true,
      };

      const first = await service.pressKey(request);
      const retry = await service.pressKey(request);

      // The press landed but the requested effect never occurred: failed.
      expect(first).toMatchObject({ outcome: 'failed' });
      // The retry is suppressed and reports the same failure class — it must
      // not report success over the effect-verified failure.
      expect(retry).toMatchObject({
        outcome: 'failed',
        reason: 'press_key_prior_attempt_outcome_unknown',
      });
      expect(retry.data).toMatchObject({ applied: false, deduplicated: true });
    });
  });

  describe('browser.set_viewport', () => {
    it('emulates a tablet viewport on an existing tab and reports requested vs actual', async () => {
      const sendCommand = vi.fn(async () => ({
        mode: 'tab_emulation',
        scope: 'tab',
        requested: { width: 768, height: 1024 },
        actual: { innerWidth: 768, innerHeight: 1024 },
        emulation: { width: 768, height: 1024, deviceScaleFactor: 1 },
        previous: { emulationActive: false },
      }));
      const { service } = makeService({
        existingTab: fixtureTab,
        extensionCommandStore: { sendCommand },
        grants: [inputGrant()],
      });

      const result = await service.setViewport({
        instanceId: 'instance-1',
        provider: 'copilot',
        profileId: fixtureTab.profileId,
        targetId: fixtureTab.targetId,
        width: 768,
        height: 1024,
      });

      expect(result).toMatchObject({ decision: 'allowed', outcome: 'succeeded' });
      expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
        command: 'set_viewport',
        payload: { width: 768, height: 1024, scope: 'tab' },
      }));
      expect(result.data).toMatchObject({
        mode: 'tab_emulation',
        scope: 'tab',
        actual: { innerWidth: 768, innerHeight: 1024 },
      });
    });

    it('reads viewport dimensions without any grant (read class)', async () => {
      const sendCommand = vi.fn(async () => ({
        mode: 'read',
        scope: 'tab',
        actual: { innerWidth: 1280, innerHeight: 800 },
        emulation: { width: 0, height: 0, deviceScaleFactor: 0 },
      }));
      const { service } = makeService({
        existingTab: fixtureTab,
        extensionCommandStore: { sendCommand },
      });

      const result = await service.setViewport({
        instanceId: 'instance-1',
        provider: 'copilot',
        profileId: fixtureTab.profileId,
        targetId: fixtureTab.targetId,
      });

      expect(result).toMatchObject({ decision: 'allowed', outcome: 'succeeded' });
      expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
        command: 'set_viewport',
        payload: { scope: 'tab' },
      }));
      expect(result.data?.mode).toBe('read');
    });

    it('reads window bounds with scope window without any grant', async () => {
      const sendCommand = vi.fn(async () => ({
        mode: 'read',
        scope: 'window',
        actual: { innerWidth: 1280, innerHeight: 800 },
        window: {
          windowId: 7,
          otherTabIds: [43],
          bounds: { left: 10, top: 20, width: 1280, height: 800 },
        },
      }));
      const { service } = makeService({
        existingTab: fixtureTab,
        extensionCommandStore: { sendCommand },
      });

      const result = await service.setViewport({
        instanceId: 'instance-1',
        provider: 'copilot',
        profileId: fixtureTab.profileId,
        targetId: fixtureTab.targetId,
        scope: 'window',
      });

      expect(result).toMatchObject({ decision: 'allowed', outcome: 'succeeded' });
      expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
        command: 'set_viewport',
        payload: { scope: 'window' },
      }));
      expect(result.data).toMatchObject({
        mode: 'read',
        scope: 'window',
        window: { windowId: 7, otherTabIds: [43] },
      });
    });

    it('refuses window-scope resize on managed profiles with a clear capability reason', async () => {
      const viewport = vi.fn();
      const { service } = makeService({ viewport });

      const result = await service.setViewport({
        instanceId: 'instance-1',
        provider: 'copilot',
        profileId: 'profile-1',
        targetId: 'target-1',
        width: 1024,
        height: 768,
        scope: 'window',
      });

      expect(result).toMatchObject({
        decision: 'denied',
        outcome: 'not_run',
        reason: WINDOW_VIEWPORT_UNSUPPORTED_MANAGED_REASON,
      });
      expect(viewport).not.toHaveBeenCalled();
    });

    it('routes tab-scope emulation on managed profiles to the driver', async () => {
      const viewport = vi.fn(async () => ({
        mode: 'tab_emulation' as const,
        scope: 'tab' as const,
        requested: { width: 820, height: 1180 },
        actual: { innerWidth: 820, innerHeight: 1180 },
        emulation: { width: 820, height: 1180, deviceScaleFactor: 1 },
        previous: { emulationActive: false },
      }));
      const { service } = makeService({
        viewport,
        grants: [makeGrant({
          profileId: 'profile-1',
          targetId: 'target-1',
          allowedActionClasses: ['input'],
        })],
      });

      const result = await service.setViewport({
        instanceId: 'instance-1',
        provider: 'copilot',
        profileId: 'profile-1',
        targetId: 'target-1',
        width: 820,
        height: 1180,
      });

      expect(result).toMatchObject({ decision: 'allowed', outcome: 'succeeded' });
      expect(viewport).toHaveBeenCalledWith('profile-1', 'target-1', { width: 820, height: 1180 });
      expect(result.data).toMatchObject({ mode: 'tab_emulation', scope: 'tab' });
    });
  });

  describe('browser.set_zoom', () => {
    it('sets real Chrome zoom on an existing tab and reads the actual factor back', async () => {
      const sendCommand = vi.fn(async () => ({
        mode: 'set',
        zoomFactor: 2,
        zoomPercent: 200,
        previousZoomFactor: 1,
        zoomScope: 'per-tab',
        previousZoomScope: 'per-origin',
        viewport: { innerWidth: 640, innerHeight: 512 },
      }));
      const { service } = makeService({
        existingTab: fixtureTab,
        extensionCommandStore: { sendCommand },
        grants: [inputGrant()],
      });

      const result = await service.setZoom({
        instanceId: 'instance-1',
        provider: 'copilot',
        profileId: fixtureTab.profileId,
        targetId: fixtureTab.targetId,
        zoomFactor: 2,
      });

      expect(result).toMatchObject({ decision: 'allowed', outcome: 'succeeded' });
      expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
        command: 'set_zoom',
        payload: { zoomFactor: 2 },
      }));
      expect(result.data).toMatchObject({
        mode: 'set',
        zoomFactor: 2,
        zoomPercent: 200,
        viewport: { innerWidth: 640, innerHeight: 512 },
      });
    });

    it('reads zoom on an existing tab without a grant', async () => {
      const sendCommand = vi.fn(async () => ({
        mode: 'read',
        zoomFactor: 1.25,
        zoomPercent: 125,
        zoomScope: 'per-tab',
        viewport: { innerWidth: 1024, innerHeight: 768 },
      }));
      const { service } = makeService({
        existingTab: fixtureTab,
        extensionCommandStore: { sendCommand },
      });

      const result = await service.setZoom({
        instanceId: 'instance-1',
        provider: 'copilot',
        profileId: fixtureTab.profileId,
        targetId: fixtureTab.targetId,
      });

      expect(result).toMatchObject({ decision: 'allowed', outcome: 'succeeded' });
      expect(result.data?.mode).toBe('read');
    });

    it('fails clearly on managed profiles instead of substituting CSS zoom or device scale', async () => {
      const sendCommand = vi.fn(async () => ({ ok: true }));
      const { service } = makeService({ extensionCommandStore: { sendCommand } });

      for (const request of [{ zoomFactor: 2 }, {}] as const) {
        const result = await service.setZoom({
          instanceId: 'instance-1',
          provider: 'copilot',
          profileId: 'profile-1',
          targetId: 'target-1',
          ...request,
        });
        expect(result).toMatchObject({
          decision: 'denied',
          outcome: 'not_run',
          reason: ZOOM_UNSUPPORTED_MANAGED_REASON,
        });
      }
      expect(sendCommand).not.toHaveBeenCalled();
    });

    it('reports a lost zoom baseline explicitly on reset instead of claiming restoration', async () => {
      const sendCommand = vi.fn(async () => ({
        mode: 'reset',
        zoomFactor: 1,
        zoomPercent: 100,
        previousZoomFactor: 1,
        viewport: { innerWidth: 1280, innerHeight: 800 },
        restorationFailed: 'browser_zoom_baseline_lost',
      }));
      const { service } = makeService({
        existingTab: fixtureTab,
        extensionCommandStore: { sendCommand },
        grants: [inputGrant()],
      });

      const result = await service.setZoom({
        instanceId: 'instance-1',
        provider: 'copilot',
        profileId: fixtureTab.profileId,
        targetId: fixtureTab.targetId,
        reset: true,
      });

      expect(result.data?.restorationFailed).toBe('browser_zoom_baseline_lost');
      expect(result.data?.mode).toBe('reset');
    });
  });
});
