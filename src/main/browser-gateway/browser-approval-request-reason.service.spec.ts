import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserGatewayService } from './browser-gateway-service';
import { stopBrowserCampaignRuntime } from './browser-campaign-runtime';
import { makeGrant, makeProfile, makeService } from './browser-gateway-service.test-helpers';
import { WorkerNodeRegistry } from '../remote-node/worker-node-registry';

/**
 * Each place the gateway can raise an approval takes the reason the agent gave
 * for the action. These go through the real service, so they cover the typed
 * request, the guard and the operation that records the approval.
 */

const reason = 'Placing the order you asked for';

const sharedTab = {
  profileId: 'existing-tab:n.windows-pc:7:42',
  targetId: 'existing-tab:n.windows-pc:7:42:target',
  tabId: 42,
  windowId: 7,
  nodeId: 'windows-pc',
  title: 'Shop',
  url: 'https://shop.example.com/checkout',
  origin: 'https://shop.example.com',
  allowedOrigins: [{ scheme: 'https' as const, hostPattern: 'shop.example.com', includeSubdomains: false }],
};

describe('a stated reason on each action that can raise an approval', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    BrowserGatewayService._resetForTesting();
    stopBrowserCampaignRuntime();
    WorkerNodeRegistry._resetForTesting();
  });

  it.each([
    ['click', (service: ReturnType<typeof makeService>['service']) => service.click({
      profileId: 'profile-1', targetId: 'target-1', selector: 'button.continue',
      instanceId: 'instance-1', provider: 'claude', reason,
    })],
    ['type', (service: ReturnType<typeof makeService>['service']) => service.type({
      profileId: 'profile-1', targetId: 'target-1', selector: 'input[name="title"]', value: 'Release notes',
      instanceId: 'instance-1', provider: 'claude', reason,
    })],
    ['select', (service: ReturnType<typeof makeService>['service']) => service.select({
      profileId: 'profile-1', targetId: 'target-1', selector: 'select.track', value: 'production',
      instanceId: 'instance-1', provider: 'claude', reason,
    })],
    ['fill_form', (service: ReturnType<typeof makeService>['service']) => service.fillForm({
      profileId: 'profile-1', targetId: 'target-1', fields: [{ selector: '#one', value: 'One' }],
      instanceId: 'instance-1', provider: 'claude', reason,
    })],
    ['evaluate', (service: ReturnType<typeof makeService>['service']) => service.evaluate({
      profileId: 'profile-1', targetId: 'target-1', expression: 'document.title',
      instanceId: 'instance-1', provider: 'claude', reason,
    })],
  ])('%s on a managed profile records the agent’s reason on the approval it raises', async (_tool, act) => {
    const { service, approvalRequests, driver } = makeService();

    const outcome = await act(service);

    expect(outcome).toMatchObject({ decision: 'requires_user', outcome: 'not_run' });
    expect(approvalRequests).toHaveLength(1);
    expect(approvalRequests[0]?.requestReason).toBe(reason);
    expect(driver.click).not.toHaveBeenCalled();
  });

  it('click on a shared tab records the agent’s reason on the approval it raises', async () => {
    const sendCommand = vi.fn();
    const { service, approvalRequests } = makeService({
      profile: null, existingTab: sharedTab, extensionCommandStore: { sendCommand },
    });

    const outcome = await service.click({
      profileId: sharedTab.profileId, targetId: sharedTab.targetId, selector: '#buy', actionHint: 'Submit order',
      instanceId: 'instance-1', provider: 'claude', reason,
    });

    expect(outcome).toMatchObject({ decision: 'requires_user' });
    expect(approvalRequests[0]?.requestReason).toBe(reason);
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('cross-site navigation records the agent’s reason on the approval it raises', async () => {
    const sendCommand = vi.fn();
    const { service, approvalRequests } = makeService({
      profile: null, existingTab: sharedTab, extensionCommandStore: { sendCommand },
    });

    const outcome = await service.navigate({
      profileId: sharedTab.profileId, targetId: sharedTab.targetId,
      url: 'https://payments.example.net/pay', instanceId: 'instance-1', provider: 'claude',
      reason: 'Taking you to the payment page',
    });

    expect(outcome).toMatchObject({ decision: 'requires_user', reason: 'cross_origin_navigation_requires_user_approval' });
    expect(approvalRequests[0]).toMatchObject({ toolName: 'browser.navigate', requestReason: 'Taking you to the payment page' });
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('file upload records the agent’s reason on the approval it raises', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-upload-reason-'));
    cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'invoice.txt');
    fs.writeFileSync(file, 'test');
    const { service, approvalRequests, driver } = makeService({
      profile: makeProfile({ userDataDir: path.join(directory, 'profile') }),
      grants: [makeGrant({ mode: 'session', allowedActionClasses: ['file-upload'] })],
    });

    // The session already allows file uploads on this site, so the action guard
    // lets it through and it is the upload check on the file itself that asks.
    const outcome = await service.uploadFile({
      profileId: 'profile-1', targetId: 'target-1', selector: 'input[type="file"]', filePath: file,
      instanceId: 'instance-1', provider: 'copilot', reason: 'Attaching the invoice you chose',
    });

    expect(outcome).toMatchObject({ decision: 'requires_user', outcome: 'not_run' });
    expect(approvalRequests).toHaveLength(1);
    expect(approvalRequests[0]).toMatchObject({
      toolName: 'browser.upload_file',
      filePath: fs.realpathSync(file),
      requestReason: 'Attaching the invoice you chose',
    });
    expect(driver.uploadFile).not.toHaveBeenCalled();
  });
});
