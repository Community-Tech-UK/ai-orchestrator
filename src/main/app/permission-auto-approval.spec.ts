import { afterEach, describe, expect, it } from 'vitest';
import type { PermissionRequest } from '../../shared/types/permission-registry.types';
import { getPermissionRegistry, PermissionRegistry } from '../orchestration/permission-registry';
import {
  registerAcpYoloAutoApproval,
  shouldAutoApproveAcpPermissionRequest,
} from './permission-auto-approval';

const BASE_REQUEST: PermissionRequest = {
  id: 'permission-1',
  instanceId: 'instance-1',
  action: 'write_file',
  description: 'Write a project file',
  details: { transport: 'acp' },
  createdAt: 1,
  timeoutMs: 60_000,
};

describe('shouldAutoApproveAcpPermissionRequest', () => {
  afterEach(() => PermissionRegistry._resetForTesting());

  it('auto-approves only ACP transport requests for a YOLO instance', () => {
    expect(shouldAutoApproveAcpPermissionRequest(BASE_REQUEST, true)).toBe(true);
    expect(shouldAutoApproveAcpPermissionRequest(BASE_REQUEST, false)).toBe(false);
  });

  it('never treats a Desktop Computer Use grant as an ACP YOLO request', () => {
    const desktopGrant: PermissionRequest = {
      ...BASE_REQUEST,
      action: 'desktop_computer_use_grant',
      toolName: 'computer.request_app_grant',
      details: {
        appId: 'darwin-app:com.example.Editor',
        capability: 'observeAndInput',
        duration: 'boundedMinutes',
        minutes: 10,
      },
    };

    expect(shouldAutoApproveAcpPermissionRequest(desktopGrant, true)).toBe(false);
  });

  it('does not auto-approve requests with missing or non-ACP transport metadata', () => {
    expect(shouldAutoApproveAcpPermissionRequest({ ...BASE_REQUEST, details: undefined }, true)).toBe(false);
    expect(shouldAutoApproveAcpPermissionRequest({
      ...BASE_REQUEST,
      details: { transport: 'desktop' },
    }, true)).toBe(false);
  });

  it('leaves a Desktop Computer Use grant pending while resolving ACP requests in YOLO mode', async () => {
    const registry = getPermissionRegistry();
    registerAcpYoloAutoApproval(registry, () => true);
    const desktopGrant: PermissionRequest = {
      ...BASE_REQUEST,
      id: 'desktop-grant',
      action: 'desktop_computer_use_grant',
      details: { capability: 'observeAndInput' },
    };

    const pendingDesktopDecision = registry.requestPermission(desktopGrant);
    await Promise.resolve();
    expect(registry.listPending()).toContainEqual(desktopGrant);

    registry.resolve(desktopGrant.id, false, 'user');
    await expect(pendingDesktopDecision).resolves.toMatchObject({
      granted: false,
      decidedBy: 'user',
    });

    await expect(registry.requestPermission({
      ...BASE_REQUEST,
      id: 'acp-request',
    })).resolves.toMatchObject({
      granted: true,
      decidedBy: 'auto_approve',
    });
  });
});
