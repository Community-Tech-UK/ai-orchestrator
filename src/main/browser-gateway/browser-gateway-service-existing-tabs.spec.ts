import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserCampaignService } from './browser-campaign-store';
import {
  initializeBrowserCampaignRuntime,
  stopBrowserCampaignRuntime,
} from './browser-campaign-runtime';
import { makeGrant, makeService } from './browser-gateway-service.test-helpers';

describe('BrowserGatewayService existing Chrome tabs', () => {
  afterEach(() => {
    stopBrowserCampaignRuntime();
  });

  const appStoreConnectTab = {
    profileId: 'existing-tab:7:42',
    targetId: 'existing-tab:7:42:target',
    tabId: 42,
    windowId: 7,
    title: 'App Store Connect',
    url: 'https://appstoreconnect.apple.com/apps',
    origin: 'https://appstoreconnect.apple.com',
    allowedOrigins: [
      {
        scheme: 'https' as const,
        hostPattern: 'appstoreconnect.apple.com',
        includeSubdomains: false,
      },
    ],
  };
  const appleDeveloperTab = {
    ...appStoreConnectTab,
    title: 'Certificates, Identifiers & Profiles',
    url: 'https://developer.apple.com/account/resources/identifiers/list',
    origin: 'https://developer.apple.com',
    allowedOrigins: [
      {
        scheme: 'https' as const,
        hostPattern: 'developer.apple.com',
        includeSubdomains: false,
      },
    ],
  };

  it('executes clicks in existing Chrome tabs through the extension command bridge', async () => {
    const sendCommand = vi.fn(async () => ({ clicked: true }));
    const existingTab = {
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
      tabId: 42,
      windowId: 7,
      title: 'Play Console',
      url: 'https://play.google.com/console',
      origin: 'https://play.google.com',
      allowedOrigins: [
        {
          scheme: 'https' as const,
          hostPattern: 'play.google.com',
          includeSubdomains: false,
        },
      ],
    };
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
      selector: '#continue',
      actionHint: 'Click continue',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
    });
    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'click',
      target: {
        profileId: existingTab.profileId,
        targetId: existingTab.targetId,
        tabId: 42,
        windowId: 7,
      },
      payload: {
        selector: '#continue',
      },
    }));
  });

  it('creates node-scoped grants when approving existing-tab actions on remote nodes', async () => {
    const sendCommand = vi.fn(async () => ({ clicked: true }));
    const existingTab = {
      profileId: 'existing-tab:n.node-1:7:42',
      targetId: 'existing-tab:n.node-1:7:42:target',
      tabId: 42,
      windowId: 7,
      nodeId: 'node-1',
      title: 'Play Console',
      url: 'https://play.google.com/console',
      origin: 'https://play.google.com',
      allowedOrigins: [
        {
          scheme: 'https' as const,
          hostPattern: 'play.google.com',
          includeSubdomains: false,
        },
      ],
    };
    const { service, approvalRequests, grants } = makeService({
      existingTab,
      extensionCommandStore: { sendCommand },
      grants: [],
    });

    const first = await service.click({
      instanceId: 'instance-1',
      provider: 'copilot',
      profileId: existingTab.profileId,
      targetId: existingTab.targetId,
      selector: '#save',
      actionHint: 'Save draft',
    });
    expect(first).toMatchObject({
      decision: 'requires_user',
      outcome: 'not_run',
    });
    expect(approvalRequests[0].proposedGrant).toMatchObject({
      nodeId: 'node-1',
    });

    await service.approveRequest({
      requestId: approvalRequests[0].requestId,
      grant: approvalRequests[0].proposedGrant,
      reason: 'Approve Play Console save',
    });

    expect(grants[0].nodeId).toBe('node-1');
    expect(grants[0].profileId).toBeUndefined();
    expect(grants[0].targetId).toBeUndefined();
  });

  it('reports timed_out_unknown for a timed-out existing-tab click without a read-back contract', async () => {
    // The extension command timed out: the click may already have applied in the
    // user's Chrome. Without an expected post-click state, the gateway must
    // report the ambiguity explicitly instead of returning a bare timeout.
    const sendCommand = vi.fn(async () => {
      throw new Error('browser_extension_command_timeout');
    });
    const existingTab = {
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
      tabId: 42,
      windowId: 7,
      title: 'Play Console',
      url: 'https://play.google.com/console',
      origin: 'https://play.google.com',
      allowedOrigins: [
        {
          scheme: 'https' as const,
          hostPattern: 'play.google.com',
          includeSubdomains: false,
        },
      ],
    };
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
      selector: '#continue',
      actionHint: 'Click continue',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'failed',
      reason: 'browser_extension_command_timeout_unknown',
    });
  });

  it('reports timed_out_applied when a timed-out existing-tab click is proven by explicit verify read-back', async () => {
    const sendCommand = vi.fn(async (request) => {
      if (request.command === 'read_control') {
        return { checked: true };
      }
      throw new Error('browser_extension_command_timeout');
    });
    const existingTab = {
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
      tabId: 42,
      windowId: 7,
      title: 'Play Console',
      url: 'https://play.google.com/console',
      origin: 'https://play.google.com',
      allowedOrigins: [
        {
          scheme: 'https' as const,
          hostPattern: 'play.google.com',
          includeSubdomains: false,
        },
      ],
    };
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
      selector: '#terms',
      actionHint: 'Accept terms',
      verify: { checked: true },
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'failed',
      reason: 'browser_extension_command_timeout_timed_out_applied',
    });
    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'click',
      payload: {
        selector: '#terms',
        verify: { checked: true },
      },
    }));
    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'read_control',
      payload: { selector: '#terms' },
    }));
  });

  it('reports timed_out_applied when a timed-out existing-tab type is proven by read-back', async () => {
    const sendCommand = vi.fn(async (request) => {
      if (request.command === 'read_control') {
        return { value: 'Release notes' };
      }
      throw new Error('browser_extension_command_timeout');
    });
    const existingTab = {
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
      tabId: 42,
      windowId: 7,
      title: 'Play Console',
      url: 'https://play.google.com/console',
      origin: 'https://play.google.com',
      allowedOrigins: [
        {
          scheme: 'https' as const,
          hostPattern: 'play.google.com',
          includeSubdomains: false,
        },
      ],
    };
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

    const result = await service.type({
      instanceId: 'instance-1',
      provider: 'copilot',
      profileId: existingTab.profileId,
      targetId: existingTab.targetId,
      selector: '#release-notes',
      value: 'Release notes',
      actionHint: 'Type release notes',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'failed',
      reason: 'browser_extension_command_timeout_timed_out_applied',
    });
    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'read_control',
      payload: { selector: '#release-notes' },
    }));
  });

  it('reports timed_out_not_applied when a timed-out existing-tab type mismatches read-back', async () => {
    const sendCommand = vi.fn(async (request) => {
      if (request.command === 'read_control') {
        return { value: '' };
      }
      throw new Error('browser_extension_command_timeout');
    });
    const existingTab = {
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
      tabId: 42,
      windowId: 7,
      title: 'Play Console',
      url: 'https://play.google.com/console',
      origin: 'https://play.google.com',
      allowedOrigins: [
        {
          scheme: 'https' as const,
          hostPattern: 'play.google.com',
          includeSubdomains: false,
        },
      ],
    };
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

    const result = await service.type({
      instanceId: 'instance-1',
      provider: 'copilot',
      profileId: existingTab.profileId,
      targetId: existingTab.targetId,
      selector: '#release-notes',
      value: 'Release notes',
      actionHint: 'Type release notes',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'failed',
      reason: 'browser_extension_command_timeout_timed_out_not_applied',
    });
  });

  it('reports timed_out_applied when a timed-out existing-tab select is proven by selected label read-back', async () => {
    const sendCommand = vi.fn(async (request) => {
      if (request.command === 'read_control') {
        return { value: 'prod', selectedLabel: 'Production' };
      }
      throw new Error('browser_extension_command_timeout');
    });
    const existingTab = {
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
      tabId: 42,
      windowId: 7,
      title: 'Play Console',
      url: 'https://play.google.com/console',
      origin: 'https://play.google.com',
      allowedOrigins: [
        {
          scheme: 'https' as const,
          hostPattern: 'play.google.com',
          includeSubdomains: false,
        },
      ],
    };
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

    const result = await service.select({
      instanceId: 'instance-1',
      provider: 'copilot',
      profileId: existingTab.profileId,
      targetId: existingTab.targetId,
      selector: '#track',
      value: 'Production',
      actionHint: 'Select production track',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'failed',
      reason: 'browser_extension_command_timeout_timed_out_applied',
    });
    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'read_control',
      payload: { selector: '#track' },
    }));
  });

  it('leaves a timed-out existing-tab read as a plain (retry-safe) timeout', async () => {
    const sendCommand = vi.fn(async () => {
      throw new Error('browser_extension_command_timeout');
    });
    const existingTab = {
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
      tabId: 42,
      windowId: 7,
      title: 'Play Console',
      url: 'https://play.google.com/console',
      origin: 'https://play.google.com',
      allowedOrigins: [
        {
          scheme: 'https' as const,
          hostPattern: 'play.google.com',
          includeSubdomains: false,
        },
      ],
    };
    const { service } = makeService({
      existingTab,
      extensionCommandStore: { sendCommand },
    });

    const result = await service.queryElements({
      instanceId: 'instance-1',
      provider: 'copilot',
      profileId: existingTab.profileId,
      targetId: existingTab.targetId,
    });

    expect(result).toMatchObject({
      outcome: 'failed',
      reason: 'browser_extension_command_timeout',
    });
  });

  it('uploads files in existing Chrome tabs through the extension command bridge after upload approval', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-browser-upload-'));
    const filePath = path.join(tempDir, 'app.ipa');
    fs.writeFileSync(filePath, 'fake app');
    const resolvedFilePath = fs.realpathSync(filePath);
    const sendCommand = vi.fn(async () => ({
      uploaded: true,
      selector: 'input[type=file]',
      fileCount: 1,
      files: [{ name: 'app.ipa', size: Buffer.byteLength('fake app') }],
    }));
    const existingTab = {
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
      tabId: 42,
      windowId: 7,
      title: 'App Store Connect',
      url: 'https://appstoreconnect.apple.com/apps',
      origin: 'https://appstoreconnect.apple.com',
      allowedOrigins: appStoreConnectTab.allowedOrigins,
    };
    const { driver, service } = makeService({
      profile: null,
      profiles: [],
      existingTab,
      extensionCommandStore: { sendCommand },
      grants: [
        makeGrant({
          profileId: existingTab.profileId,
          targetId: existingTab.targetId,
          provider: 'claude',
          allowedOrigins: existingTab.allowedOrigins,
          allowedActionClasses: ['file-upload'],
          uploadRoots: [tempDir],
        }),
      ],
    });

    const result = await service.uploadFile({
      instanceId: 'instance-1',
      provider: 'claude',
      profileId: existingTab.profileId,
      targetId: existingTab.targetId,
      selector: 'input[type=file]',
      filePath,
      actionHint: 'Upload app binary',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
    });
    expect(driver.uploadFile).not.toHaveBeenCalled();
    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'upload_file',
      payload: {
        selector: 'input[type=file]',
        filePath: resolvedFilePath,
      },
    }));
  });

  it('fails an existing-tab upload when the extension cannot prove a file was selected', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-browser-upload-empty-'));
    const filePath = path.join(tempDir, 'app.ipa');
    fs.writeFileSync(filePath, 'fake app');
    const sendCommand = vi.fn(async () => ({
      uploaded: true,
      selector: 'input[type=file]',
      fileCount: 0,
      files: [],
    }));
    const existingTab = {
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
      tabId: 42,
      windowId: 7,
      title: 'App Store Connect',
      url: 'https://appstoreconnect.apple.com/apps',
      origin: 'https://appstoreconnect.apple.com',
      allowedOrigins: appStoreConnectTab.allowedOrigins,
    };
    const { service } = makeService({
      profile: null,
      profiles: [],
      existingTab,
      extensionCommandStore: { sendCommand },
      grants: [
        makeGrant({
          profileId: existingTab.profileId,
          targetId: existingTab.targetId,
          provider: 'claude',
          allowedOrigins: existingTab.allowedOrigins,
          allowedActionClasses: ['file-upload'],
          uploadRoots: [tempDir],
        }),
      ],
    });

    const result = await service.uploadFile({
      instanceId: 'instance-1',
      provider: 'claude',
      profileId: existingTab.profileId,
      targetId: existingTab.targetId,
      selector: 'input[type=file]',
      filePath,
      actionHint: 'Upload app binary',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'failed',
    });
    expect(result.reason).toContain('browser_upload_verify_mismatch:file_count');
  });

  it('adds Play Console Add from library recovery hints to upload verification failures', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-browser-upload-hint-'));
    const filePath = path.join(tempDir, 'app.aab');
    fs.writeFileSync(filePath, 'fake bundle');
    const sendCommand = vi.fn(async () => ({
      uploaded: false,
      fileCount: 0,
      files: [],
    }));
    const existingTab = {
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
      tabId: 42,
      windowId: 7,
      title: 'Play Console',
      url: 'https://play.google.com/console/u/0/developers/app/releases',
      origin: 'https://play.google.com',
      allowedOrigins: [
        {
          scheme: 'https' as const,
          hostPattern: 'play.google.com',
          includeSubdomains: false,
        },
      ],
    };
    const { service } = makeService({
      profile: null,
      profiles: [],
      existingTab,
      extensionCommandStore: { sendCommand },
      grants: [
        makeGrant({
          profileId: existingTab.profileId,
          targetId: existingTab.targetId,
          provider: 'claude',
          allowedOrigins: existingTab.allowedOrigins,
          allowedActionClasses: ['file-upload'],
          uploadRoots: [tempDir],
        }),
      ],
    });

    const result = await service.uploadFile({
      instanceId: 'instance-1',
      provider: 'claude',
      profileId: existingTab.profileId,
      targetId: existingTab.targetId,
      selector: 'input[type=file]',
      filePath,
      actionHint: 'Use Add from library to select the uploaded AAB',
    });

    expect(result.reason).toContain('browser_upload_verify_mismatch:file_count,uploaded');
    expect(result.reason).toContain('Recovery hint: For Play Console Add from library');
  });

  it('stages the file onto the remote node before uploading into a remote-node existing tab', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-browser-upload-remote-'));
    const filePath = path.join(tempDir, 'app.aab');
    fs.writeFileSync(filePath, 'fake bundle');
    const resolvedFilePath = fs.realpathSync(filePath);
    const sendCommand = vi.fn(async () => ({
      uploaded: true,
      selector: 'input[type=file]',
      fileCount: 1,
      files: [{ name: 'staged-app.aab', size: Buffer.byteLength('fake bundle') }],
    }));
    // The Play Console tab lives in Chrome on the windows worker node: the
    // coordinator-local path is meaningless there, so the gateway must ship
    // the bytes first and hand the extension the NODE-local staged path.
    const stagedRemotePath = 'C:\\work\\_scratch\\aio-browser-uploads\\staged-app.aab';
    const stageUploadFileOnNode = vi.fn(async () => ({
      remotePath: stagedRemotePath,
      size: Buffer.byteLength('fake bundle'),
      sha256: 'a'.repeat(64),
      integrity: 'size-and-sha256' as const,
    }));
    const existingTab = {
      profileId: 'existing-tab:n.node-1:7:42',
      targetId: 'existing-tab:n.node-1:7:42:target',
      tabId: 42,
      windowId: 7,
      nodeId: 'node-1',
      nodeName: 'windows-pc',
      title: 'Play Console',
      url: 'https://play.google.com/console',
      origin: 'https://play.google.com',
      allowedOrigins: [
        {
          scheme: 'https' as const,
          hostPattern: 'play.google.com',
          includeSubdomains: false,
        },
      ],
    };
    const { driver, service } = makeService({
      profile: null,
      profiles: [],
      existingTab,
      extensionCommandStore: { sendCommand },
      stageUploadFileOnNode,
      grants: [
        makeGrant({
          profileId: existingTab.profileId,
          targetId: existingTab.targetId,
          provider: 'claude',
          allowedOrigins: existingTab.allowedOrigins,
          allowedActionClasses: ['file-upload'],
          uploadRoots: [tempDir],
        }),
      ],
    });

    const result = await service.uploadFile({
      instanceId: 'instance-1',
      provider: 'claude',
      profileId: existingTab.profileId,
      targetId: existingTab.targetId,
      selector: 'input[type=file]',
      filePath,
      actionHint: 'Upload app bundle',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
    });
    expect(stageUploadFileOnNode).toHaveBeenCalledWith('node-1', resolvedFilePath);
    expect(driver.uploadFile).not.toHaveBeenCalled();
    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'upload_file',
      payload: {
        selector: 'input[type=file]',
        filePath: stagedRemotePath,
      },
    }));
  });

  it('reports a failed upload when staging the file onto the remote node fails', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-browser-upload-remote-fail-'));
    const filePath = path.join(tempDir, 'app.aab');
    fs.writeFileSync(filePath, 'fake bundle');
    const sendCommand = vi.fn(async () => ({
      uploaded: true,
      fileCount: 1,
      files: [{ name: 'app.aab', size: Buffer.byteLength('fake bundle') }],
    }));
    const stageUploadFileOnNode = vi.fn(async () => {
      throw new Error('upload_file_remote_staging_unavailable: node offline');
    });
    const existingTab = {
      profileId: 'existing-tab:n.node-1:7:42',
      targetId: 'existing-tab:n.node-1:7:42:target',
      tabId: 42,
      windowId: 7,
      nodeId: 'node-1',
      title: 'Play Console',
      url: 'https://play.google.com/console',
      origin: 'https://play.google.com',
      allowedOrigins: [
        {
          scheme: 'https' as const,
          hostPattern: 'play.google.com',
          includeSubdomains: false,
        },
      ],
    };
    const { service } = makeService({
      profile: null,
      profiles: [],
      existingTab,
      extensionCommandStore: { sendCommand },
      stageUploadFileOnNode,
      grants: [
        makeGrant({
          profileId: existingTab.profileId,
          targetId: existingTab.targetId,
          provider: 'claude',
          allowedOrigins: existingTab.allowedOrigins,
          allowedActionClasses: ['file-upload'],
          uploadRoots: [tempDir],
        }),
      ],
    });

    const result = await service.uploadFile({
      instanceId: 'instance-1',
      provider: 'claude',
      profileId: existingTab.profileId,
      targetId: existingTab.targetId,
      selector: 'input[type=file]',
      filePath,
      actionHint: 'Upload app bundle',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'failed',
    });
    expect(result.reason).toContain('upload_file_remote_staging_unavailable');
    // The extension must never receive a coordinator-local path it cannot read.
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('records a stored approval request when an existing-tab upload is outside the granted roots', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-browser-upload-denied-'));
    const filePath = path.join(tempDir, 'app.ipa');
    fs.writeFileSync(filePath, 'fake app');
    const resolvedFilePath = fs.realpathSync(filePath);
    const sendCommand = vi.fn(async () => ({ uploaded: true, fileCount: 1, files: [] }));
    const existingTab = {
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
      tabId: 42,
      windowId: 7,
      title: 'App Store Connect',
      url: 'https://appstoreconnect.apple.com/apps',
      origin: 'https://appstoreconnect.apple.com',
      allowedOrigins: appStoreConnectTab.allowedOrigins,
    };
    const { service, approvalRequests } = makeService({
      profile: null,
      profiles: [],
      existingTab,
      extensionCommandStore: { sendCommand },
      grants: [
        makeGrant({
          profileId: existingTab.profileId,
          targetId: existingTab.targetId,
          provider: 'claude',
          allowedOrigins: existingTab.allowedOrigins,
          allowedActionClasses: ['file-upload'],
          uploadRoots: [path.join(tempDir, 'somewhere-else')],
        }),
      ],
    });

    const result = await service.uploadFile({
      instanceId: 'instance-1',
      provider: 'claude',
      profileId: existingTab.profileId,
      targetId: existingTab.targetId,
      selector: 'input[type=file]',
      filePath,
      actionHint: 'Upload app binary',
    });

    // A requires_user answer is only actionable when a request the user can
    // approve actually exists — a synthetic requestId with no stored row left
    // the agent waiting on a decision nobody could ever make.
    expect(approvalRequests).toHaveLength(1);
    expect(approvalRequests[0]).toMatchObject({
      instanceId: 'instance-1',
      toolName: 'browser.upload_file',
      actionClass: 'file-upload',
      status: 'pending',
      filePath: resolvedFilePath,
    });
    expect(approvalRequests[0].proposedGrant.uploadRoots).toContain(path.dirname(resolvedFilePath));
    expect(result).toMatchObject({
      decision: 'requires_user',
      outcome: 'not_run',
      reason: expect.stringContaining('root_not_allowed'),
      requestId: approvalRequests[0].requestId,
    });
    // The agent-visible reason must say where the human actually approves.
    expect(result.reason).toContain('approvals card');
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('denies an existing-tab upload of a nonexistent path with coordinator-local guidance instead of recording an approval', async () => {
    const sendCommand = vi.fn(async () => ({ uploaded: true, fileCount: 1, files: [] }));
    const existingTab = {
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
      tabId: 42,
      windowId: 7,
      title: 'App Store Connect',
      url: 'https://appstoreconnect.apple.com/apps',
      origin: 'https://appstoreconnect.apple.com',
      allowedOrigins: appStoreConnectTab.allowedOrigins,
    };
    const { service, approvalRequests } = makeService({
      profile: null,
      profiles: [],
      existingTab,
      extensionCommandStore: { sendCommand },
      grants: [
        makeGrant({
          profileId: existingTab.profileId,
          targetId: existingTab.targetId,
          provider: 'claude',
          allowedOrigins: existingTab.allowedOrigins,
          allowedActionClasses: ['file-upload'],
        }),
      ],
    });

    // The BinsOut failure mode: the agent pre-copied the file to the worker
    // node and passed the node-local path, which the coordinator cannot read.
    const result = await service.uploadFile({
      instanceId: 'instance-1',
      provider: 'claude',
      profileId: existingTab.profileId,
      targetId: existingTab.targetId,
      selector: 'input[type=file]',
      filePath: 'C:\\Users\\worker\\Documents\\Work\\_scratch\\staged.jpg',
      actionHint: 'Upload image',
    });

    expect(result).toMatchObject({
      decision: 'denied',
      outcome: 'not_run',
      reason: expect.stringContaining('file_not_found'),
    });
    // The agent-visible reason must explain the coordinator-local path model.
    expect(result.reason).toContain('coordinator');
    // Approving cannot make a nonexistent file readable — no request row.
    expect(approvalRequests).toHaveLength(0);
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('auto-approves a denied existing-tab upload and proceeds when the predicate allows it', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-browser-upload-auto-'));
    const filePath = path.join(tempDir, 'app.ipa');
    fs.writeFileSync(filePath, 'fake app');
    const resolvedFilePath = fs.realpathSync(filePath);
    const sendCommand = vi.fn(async () => ({
      uploaded: true,
      selector: 'input[type=file]',
      fileCount: 1,
      files: [{ name: 'app.ipa', size: Buffer.byteLength('fake app') }],
    }));
    const existingTab = {
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
      tabId: 42,
      windowId: 7,
      title: 'App Store Connect',
      url: 'https://appstoreconnect.apple.com/apps',
      origin: 'https://appstoreconnect.apple.com',
      allowedOrigins: appStoreConnectTab.allowedOrigins,
    };
    const { service, approvalRequests } = makeService({
      profile: null,
      profiles: [],
      existingTab,
      extensionCommandStore: { sendCommand },
      autoApproveRequests: () => true,
      grants: [
        makeGrant({
          profileId: existingTab.profileId,
          targetId: existingTab.targetId,
          provider: 'claude',
          allowedOrigins: existingTab.allowedOrigins,
          allowedActionClasses: ['file-upload'],
          uploadRoots: [path.join(tempDir, 'somewhere-else')],
        }),
      ],
    });

    const result = await service.uploadFile({
      instanceId: 'instance-1',
      provider: 'claude',
      profileId: existingTab.profileId,
      targetId: existingTab.targetId,
      selector: 'input[type=file]',
      filePath,
      actionHint: 'Upload app binary',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
    });
    expect(approvalRequests).toHaveLength(1);
    expect(approvalRequests[0].status).toBe('approved');
    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'upload_file',
      payload: {
        selector: 'input[type=file]',
        filePath: resolvedFilePath,
      },
    }));
  });

  it('downloads files in existing Chrome tabs through the extension and returns the completed file record', async () => {
    const sendCommand = vi.fn(async () => ({
      id: 14,
      url: 'https://appstoreconnect.apple.com/download/report.csv',
      finalUrl: 'https://appstoreconnect.apple.com/download/report.csv',
      filename: '/Users/james/Downloads/report.csv',
      mime: 'text/csv',
      bytesReceived: 128,
      totalBytes: 128,
      state: 'complete',
      startedAt: '2026-06-02T10:00:00.000Z',
      endedAt: '2026-06-02T10:00:01.000Z',
    }));
    const { service } = makeService({
      existingTab: appStoreConnectTab,
      extensionCommandStore: { sendCommand },
      grants: [
        makeGrant({
          profileId: appStoreConnectTab.profileId,
          targetId: appStoreConnectTab.targetId,
          provider: 'claude',
          allowedOrigins: appStoreConnectTab.allowedOrigins,
          allowedActionClasses: ['file-download'],
        }),
      ],
    });

    const result = await service.downloadFile({
      instanceId: 'instance-1',
      provider: 'claude',
      profileId: appStoreConnectTab.profileId,
      targetId: appStoreConnectTab.targetId,
      selector: 'a.download',
      actionHint: 'Download report',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: {
        filename: '/Users/james/Downloads/report.csv',
        state: 'complete',
        bytesReceived: 128,
      },
    });
    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'download_file',
      payload: {
        selector: 'a.download',
        timeoutMs: 60_000,
      },
    }));
  });

  it('finds an existing Chrome tab by URL before asking the extension to open a new tab', async () => {
    const sendCommand = vi.fn();
    const existingTab = {
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
      tabId: 42,
      windowId: 7,
      title: 'Play Console',
      url: 'https://play.google.com/console/u/0/developers',
      origin: 'https://play.google.com',
      allowedOrigins: [
        {
          scheme: 'https' as const,
          hostPattern: 'play.google.com',
          includeSubdomains: false,
        },
      ],
    };
    const { service } = makeService({
      existingTab,
      extensionCommandStore: { sendCommand },
    });

    const result = await service.findOrOpen({
      instanceId: 'instance-1',
      provider: 'copilot',
      url: 'https://play.google.com/console',
      titleHint: 'Play Console',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: {
        profileId: existingTab.profileId,
        id: existingTab.targetId,
        driver: 'extension',
      },
    });
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('filters existing-tab matches by requested remote node before opening', async () => {
    const sendCommand = vi.fn(async () => ({
      tab: {
        tabId: 44,
        windowId: 8,
        title: 'Remote Example',
        url: 'https://example.com/new',
      },
    }));
    const existingTab = {
      profileId: 'existing-tab:n.node-2:7:42',
      targetId: 'existing-tab:n.node-2:7:42:target',
      nodeId: 'node-2',
      nodeName: 'Other PC',
      tabId: 42,
      windowId: 7,
      title: 'Example',
      url: 'https://example.com/page',
      origin: 'https://example.com',
      allowedOrigins: [
        {
          scheme: 'https' as const,
          hostPattern: 'example.com',
          includeSubdomains: false,
        },
      ],
    };
    const { service } = makeService({
      existingTab,
      extensionCommandStore: { sendCommand },
    });

    const result = await service.findOrOpen({
      instanceId: 'instance-1',
      provider: 'copilot',
      url: 'https://example.com',
      nodeId: 'node-1',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
    });
    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      queueKey: 'node:node-1',
      command: 'open_tab',
      payload: { url: 'https://example.com' },
    }));
  });

  it('uses the requested computer name to choose a remote tab over a same-origin local tab', async () => {
    const sendCommand = vi.fn();
    const localTab = {
      profileId: 'existing-tab:1:10',
      targetId: 'existing-tab:1:10:target',
      tabId: 10,
      windowId: 1,
      title: 'Emergent on Mac',
      url: 'https://app.emergent.sh/home',
      origin: 'https://app.emergent.sh',
      allowedOrigins: [{
        scheme: 'https' as const,
        hostPattern: 'app.emergent.sh',
        includeSubdomains: false,
      }],
      attachedAt: 1,
      updatedAt: 10,
    };
    const windowsTab = {
      profileId: 'existing-tab:n.node-1:2:20',
      targetId: 'existing-tab:n.node-1:2:20:target',
      nodeId: 'node-1',
      nodeName: 'Windows PC',
      tabId: 20,
      windowId: 2,
      title: 'Emergent on Windows',
      url: 'https://app.emergent.sh/home',
      origin: 'https://app.emergent.sh',
      allowedOrigins: localTab.allowedOrigins,
      attachedAt: 2,
      updatedAt: Date.now() + 1000,
    };
    const { extensionTabStore, service } = makeService({
      profile: null,
      profiles: [],
      extensionCommandStore: { sendCommand },
    });
    extensionTabStore.listTabs.mockReturnValue([localTab, windowsTab]);

    const result = await service.findOrOpen({
      instanceId: 'instance-1',
      provider: 'copilot',
      url: 'https://app.emergent.sh/home',
      computer: 'Windows PC',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: {
        id: windowsTab.targetId,
        profileId: windowsTab.profileId,
        nodeId: 'node-1',
        nodeName: 'Windows PC',
      },
    });
  });

  it('refreshes a requested remote computer before returning a matching cached tab id', async () => {
    const staleTab = {
      profileId: 'existing-tab:n.node-1:2:20',
      targetId: 'existing-tab:n.node-1:2:20:target',
      nodeId: 'node-1',
      nodeName: 'Windows PC',
      tabId: 20,
      windowId: 2,
      title: 'Emergent stale',
      url: 'https://app.emergent.sh/home',
      origin: 'https://app.emergent.sh',
      allowedOrigins: [{
        scheme: 'https' as const,
        hostPattern: 'app.emergent.sh',
        includeSubdomains: false,
      }],
      attachedAt: 1,
      updatedAt: 100,
    };
    const freshTab = {
      ...staleTab,
      profileId: 'existing-tab:n.node-1:2:21',
      targetId: 'existing-tab:n.node-1:2:21:target',
      tabId: 21,
      title: 'Emergent fresh',
      updatedAt: Date.now() + 1000,
    };
    const sendCommand = vi.fn(async () => ({ ok: true }));
    const { extensionTabStore, service } = makeService({
      profile: null,
      profiles: [],
      extensionCommandStore: { sendCommand },
    });
    extensionTabStore.listTabs
      .mockReturnValueOnce([staleTab])
      .mockReturnValueOnce([staleTab, freshTab]);

    const result = await service.findOrOpen({
      instanceId: 'instance-1',
      provider: 'copilot',
      url: 'https://app.emergent.sh/home',
      computer: 'Windows PC',
    });

    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      queueKey: 'node:node-1',
      command: 'report_inventory',
    }));
    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: {
        id: freshTab.targetId,
        profileId: freshTab.profileId,
      },
    });
  });

  it('fails find_or_open fast when the requested remote extension node is silent', async () => {
    const sendCommand = vi.fn();
    const { service } = makeService({
      profile: null,
      profiles: [],
      extensionCommandStore: { sendCommand },
      extensionContactState: {
        getLastExtensionContactAt: () => 1_000,
        isExtensionContactFresh: () => false,
        describeExtensionContact: (nodeId) => ({
          nodeId,
          lastContactAt: 1_000,
          silent: true,
          staleForMs: 120_000,
        }),
        getContactGapStats: () => ({ gapCount: 0, longestGapMs: 0 }),
      },
    });

    const result = await service.findOrOpen({
      instanceId: 'instance-1',
      provider: 'copilot',
      url: 'https://example.com',
      nodeId: 'node-1',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'failed',
      reason: 'browser_extension_unreachable',
    });
    expect(result.data).toBeNull();
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('does not select a stale cached remote tab as a live find_or_open result', async () => {
    const sendCommand = vi.fn();
    const existingTab = {
      profileId: 'existing-tab:n.node-1:7:42',
      targetId: 'existing-tab:n.node-1:7:42:target',
      nodeId: 'node-1',
      nodeName: 'Windows PC',
      tabId: 42,
      windowId: 7,
      title: 'Remote Example',
      url: 'https://example.com/page',
      origin: 'https://example.com',
      allowedOrigins: [
        {
          scheme: 'https' as const,
          hostPattern: 'example.com',
          includeSubdomains: false,
        },
      ],
    };
    const { service } = makeService({
      profile: null,
      profiles: [],
      existingTab,
      extensionCommandStore: { sendCommand },
      extensionContactState: {
        getLastExtensionContactAt: () => 1_000,
        isExtensionContactFresh: () => false,
        describeExtensionContact: (nodeId) => ({
          nodeId,
          lastContactAt: 1_000,
          silent: true,
          staleForMs: 120_000,
        }),
        getContactGapStats: () => ({ gapCount: 0, longestGapMs: 0 }),
      },
    });

    const result = await service.findOrOpen({
      instanceId: 'instance-1',
      provider: 'copilot',
      url: 'https://example.com',
      nodeId: 'node-1',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'failed',
      // Enriched with channel state so the caller learns WHY it is unreachable.
      reason: expect.stringContaining('browser_extension_unreachable') as string,
    });
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('routes commands for an attached remote existing tab to its node queue', async () => {
    const sendCommand = vi.fn(async () => ({
      tab: {
        tabId: 42,
        windowId: 7,
        title: 'Remote Example',
        url: 'https://example.com/page',
        text: 'hello',
      },
    }));
    const existingTab = {
      profileId: 'existing-tab:n.node-1:7:42',
      targetId: 'existing-tab:n.node-1:7:42:target',
      nodeId: 'node-1',
      nodeName: 'Windows PC',
      tabId: 42,
      windowId: 7,
      title: 'Remote Example',
      url: 'https://example.com/page',
      origin: 'https://example.com',
      allowedOrigins: [
        {
          scheme: 'https' as const,
          hostPattern: 'example.com',
          includeSubdomains: false,
        },
      ],
    };
    const { service } = makeService({
      existingTab,
      extensionCommandStore: { sendCommand },
    });

    const result = await service.snapshot({
      instanceId: 'instance-1',
      provider: 'copilot',
      profileId: existingTab.profileId,
      targetId: existingTab.targetId,
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
    });
    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      queueKey: 'node:node-1',
      command: 'snapshot',
    }));
  });

  it('detaches a stale existing-tab handle when the extension no longer has that tab id', async () => {
    const sendCommand = vi.fn(async () => {
      throw new Error('No tab with id: 42');
    });
    const existingTab = {
      profileId: 'existing-tab:n.node-1:7:42',
      targetId: 'existing-tab:n.node-1:7:42:target',
      nodeId: 'node-1',
      nodeName: 'Windows PC',
      tabId: 42,
      windowId: 7,
      title: 'Remote Example',
      url: 'https://example.com/page',
      origin: 'https://example.com',
      allowedOrigins: [
        {
          scheme: 'https' as const,
          hostPattern: 'example.com',
          includeSubdomains: false,
        },
      ],
    };
    const { extensionTabStore, service } = makeService({
      existingTab,
      extensionCommandStore: { sendCommand },
    });

    const result = await service.snapshot({
      instanceId: 'instance-1',
      provider: 'copilot',
      profileId: existingTab.profileId,
      targetId: existingTab.targetId,
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'failed',
      reason: 'No tab with id: 42',
    });
    expect(extensionTabStore.detachTab).toHaveBeenCalledWith(
      existingTab.profileId,
      existingTab.targetId,
    );
  });

  it('preserves remote node metadata when refreshing a remote existing-tab snapshot', async () => {
    const sendCommand = vi.fn(async () => ({
      tabId: 42,
      windowId: 7,
      title: 'Remote Example Fresh',
      url: 'https://example.com/fresh',
      text: 'fresh remote text',
    }));
    const existingTab = {
      profileId: 'existing-tab:n.node-1:7:42',
      targetId: 'existing-tab:n.node-1:7:42:target',
      nodeId: 'node-1',
      nodeName: 'Windows PC',
      tabId: 42,
      windowId: 7,
      title: 'Remote Example',
      url: 'https://example.com/page',
      origin: 'https://example.com',
      allowedOrigins: [
        {
          scheme: 'https' as const,
          hostPattern: 'example.com',
          includeSubdomains: false,
        },
      ],
    };
    const { extensionTabStore, service } = makeService({
      existingTab,
      extensionCommandStore: { sendCommand },
    });

    const result = await service.snapshot({
      instanceId: 'instance-1',
      provider: 'copilot',
      profileId: existingTab.profileId,
      targetId: existingTab.targetId,
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
    });
    expect(extensionTabStore.attachTab).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Remote Example Fresh',
        text: 'fresh remote text',
      }),
      {
        nodeId: 'node-1',
        nodeName: 'Windows PC',
      },
    );
  });

  it('preserves remote node metadata when navigation refreshes a remote existing tab', async () => {
    const sendCommand = vi.fn(async () => ({
      tabId: 42,
      windowId: 7,
      title: 'Remote Example After Navigate',
      url: 'https://example.com/after',
      text: 'after navigation',
    }));
    const existingTab = {
      profileId: 'existing-tab:n.node-1:7:42',
      targetId: 'existing-tab:n.node-1:7:42:target',
      nodeId: 'node-1',
      nodeName: 'Windows PC',
      tabId: 42,
      windowId: 7,
      title: 'Remote Example',
      url: 'https://example.com/page',
      origin: 'https://example.com',
      allowedOrigins: [
        {
          scheme: 'https' as const,
          hostPattern: 'example.com',
          includeSubdomains: false,
        },
      ],
    };
    const { extensionTabStore, service } = makeService({
      existingTab,
      extensionCommandStore: { sendCommand },
    });

    const result = await service.navigate({
      instanceId: 'instance-1',
      provider: 'copilot',
      profileId: existingTab.profileId,
      targetId: existingTab.targetId,
      url: 'https://example.com/after',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
    });
    expect(extensionTabStore.attachTab).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Remote Example After Navigate',
        text: 'after navigation',
      }),
      {
        nodeId: 'node-1',
        nodeName: 'Windows PC',
      },
    );
  });

  it('fails remote existing-tab commands fast when extension contact is stale', async () => {
    const sendCommand = vi.fn();
    const existingTab = {
      profileId: 'existing-tab:n.node-1:7:42',
      targetId: 'existing-tab:n.node-1:7:42:target',
      nodeId: 'node-1',
      nodeName: 'Windows PC',
      tabId: 42,
      windowId: 7,
      title: 'Remote Example',
      url: 'https://example.com/page',
      origin: 'https://example.com',
      allowedOrigins: [
        {
          scheme: 'https' as const,
          hostPattern: 'example.com',
          includeSubdomains: false,
        },
      ],
    };
    const { service } = makeService({
      existingTab,
      extensionCommandStore: { sendCommand },
      extensionContactState: {
        getLastExtensionContactAt: () => 1_000,
        isExtensionContactFresh: () => false,
        describeExtensionContact: (nodeId) => ({
          nodeId,
          lastContactAt: 1_000,
          silent: true,
          staleForMs: 120_000,
        }),
        getContactGapStats: () => ({ gapCount: 0, longestGapMs: 0 }),
      },
    });

    const result = await service.snapshot({
      instanceId: 'instance-1',
      provider: 'copilot',
      profileId: existingTab.profileId,
      targetId: existingTab.targetId,
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'failed',
      // Enriched with channel state so the caller learns WHY it is unreachable.
      reason: expect.stringContaining('browser_extension_unreachable') as string,
    });
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('surfaces a browser approval request instead of denying cross-origin existing-tab navigation', async () => {
    const sendCommand = vi.fn();
    const { approvalRequests, service } = makeService({
      existingTab: appStoreConnectTab,
      extensionCommandStore: { sendCommand },
    });

    const result = await service.navigate({
      instanceId: 'instance-1',
      provider: 'claude',
      profileId: appStoreConnectTab.profileId,
      targetId: appStoreConnectTab.targetId,
      url: 'https://developer.apple.com/account/resources/identifiers/list',
    });

    expect(result).toMatchObject({
      decision: 'requires_user',
      outcome: 'not_run',
      requestId: 'request-1',
      reason: 'cross_origin_navigation_requires_user_approval',
    });
    expect(approvalRequests[0]).toMatchObject({
      instanceId: 'instance-1',
      provider: 'claude',
      profileId: appStoreConnectTab.profileId,
      targetId: appStoreConnectTab.targetId,
      toolName: 'browser.navigate',
      action: 'navigate',
      actionClass: 'navigate',
      origin: 'https://developer.apple.com',
      url: 'https://developer.apple.com/account/resources/identifiers/list',
      proposedGrant: {
        mode: 'per_action',
        allowedOrigins: [{
          scheme: 'https',
          hostPattern: 'developer.apple.com',
          includeSubdomains: false,
        }],
        allowedActionClasses: ['navigate'],
        allowExternalNavigation: true,
        autonomous: false,
      },
    });
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('navigates an existing Chrome tab across origins after an approved navigation grant', async () => {
    const sendCommand = vi.fn(async () => ({
      tab: {
        tabId: 42,
        windowId: 7,
        title: 'Certificates, Identifiers & Profiles',
        url: 'https://developer.apple.com/account/resources/identifiers/list',
      },
    }));
    const { audits, service } = makeService({
      existingTab: appStoreConnectTab,
      extensionCommandStore: { sendCommand },
      grants: [
        makeGrant({
          profileId: appStoreConnectTab.profileId,
          targetId: appStoreConnectTab.targetId,
          provider: 'claude',
          allowedOrigins: [{
            scheme: 'https',
            hostPattern: 'developer.apple.com',
            includeSubdomains: false,
          }],
          allowedActionClasses: ['navigate'],
          allowExternalNavigation: true,
        }),
      ],
    });

    const result = await service.navigate({
      instanceId: 'instance-1',
      provider: 'claude',
      profileId: appStoreConnectTab.profileId,
      targetId: appStoreConnectTab.targetId,
      url: 'https://developer.apple.com/account/resources/identifiers/list',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
    });
    expect(audits[0]).toMatchObject({
      grantId: 'grant-1',
      origin: 'https://developer.apple.com',
    });
    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'navigate',
      target: {
        profileId: appStoreConnectTab.profileId,
        targetId: appStoreConnectTab.targetId,
        tabId: 42,
        windowId: 7,
      },
      payload: {
        url: 'https://developer.apple.com/account/resources/identifiers/list',
      },
    }));
  });

  it('records existing-tab navigation against a live campaign lease', async () => {
    const sendCommand = vi.fn(async () => ({
      tab: {
        tabId: 42,
        windowId: 7,
        title: 'App Store Connect',
        url: 'https://appstoreconnect.apple.com/apps/next',
      },
    }));
    const campaigns = new BrowserCampaignService();
    const { grantStore, service } = makeService({
      existingTab: appStoreConnectTab,
      extensionCommandStore: { sendCommand },
    });
    const runtime = initializeBrowserCampaignRuntime({
      campaigns,
      grantStore,
      renewIntervalMs: 60 * 60 * 1000,
    });
    const campaign = campaigns.create({
      label: 'App Store Connect campaign',
      profileId: appStoreConnectTab.profileId,
      allowedOrigins: ['https://appstoreconnect.apple.com'],
      allowedActionClasses: ['navigate', 'input', 'submit'],
      budget: {
        maxActions: 10,
        maxSubmits: 5,
        maxNewAccounts: 1,
        maxUploads: 1,
        maxDurationMs: 8 * 60 * 60 * 1000,
      },
    });
    const lease = runtime.claimLease({
      campaignId: campaign.id,
      instanceId: 'instance-1',
      provider: 'claude',
    });
    expect(lease.granted).toBe(true);

    await service.navigate({
      instanceId: 'instance-1',
      provider: 'claude',
      profileId: appStoreConnectTab.profileId,
      targetId: appStoreConnectTab.targetId,
      url: 'https://appstoreconnect.apple.com/apps/next',
    });

    expect(campaigns.getCounters(campaign.id)).toMatchObject({
      actions: 1,
    });
  });

  it('allows agents to request grants for existing Chrome tabs', async () => {
    const { approvalRequests, service } = makeService({
      existingTab: appStoreConnectTab,
    });

    const result = await service.requestGrant({
      instanceId: 'instance-1',
      provider: 'claude',
      profileId: appStoreConnectTab.profileId,
      targetId: appStoreConnectTab.targetId,
      reason: 'Need to open Apple Developer identifiers from App Store Connect',
      proposedGrant: {
        mode: 'session',
        allowedOrigins: [{
          scheme: 'https',
          hostPattern: 'developer.apple.com',
          includeSubdomains: false,
        }],
        allowedActionClasses: ['navigate', 'read'],
        allowExternalNavigation: true,
        autonomous: false,
      },
    });

    expect(result).toMatchObject({
      decision: 'requires_user',
      outcome: 'not_run',
      requestId: 'request-1',
      reason: 'Need to open Apple Developer identifiers from App Store Connect',
    });
    expect(approvalRequests[0]).toMatchObject({
      profileId: appStoreConnectTab.profileId,
      targetId: appStoreConnectTab.targetId,
      toolName: 'browser.request_grant',
      action: 'request_grant',
      actionClass: 'navigate',
      origin: appStoreConnectTab.origin,
      url: appStoreConnectTab.url,
      proposedGrant: {
        allowedOrigins: [{
          scheme: 'https',
          hostPattern: 'developer.apple.com',
          includeSubdomains: false,
        }],
      },
    });
  });

  it('captures a fresh existing-tab snapshot through the extension command bridge', async () => {
    const sendCommand = vi.fn(async () => ({
      tabId: 42,
      windowId: 7,
      title: 'Certificates, Identifiers & Profiles',
      url: 'https://developer.apple.com/account/resources/identifiers/list',
      text: 'token=abc123 Identifiers App IDs',
    }));
    const { extensionTabStore, service } = makeService({
      existingTab: {
        ...appleDeveloperTab,
        title: 'Stale Developer Portal',
        text: 'stale cache',
      },
      extensionCommandStore: { sendCommand },
    });

    const result = await service.snapshot({
      instanceId: 'instance-1',
      provider: 'claude',
      profileId: appleDeveloperTab.profileId,
      targetId: appleDeveloperTab.targetId,
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: {
        title: 'Certificates, Identifiers & Profiles',
        url: 'https://developer.apple.com/account/resources/identifiers/list',
        text: 'token=[REDACTED] Identifiers App IDs',
      },
    });
    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'snapshot',
      target: {
        profileId: appleDeveloperTab.profileId,
        targetId: appleDeveloperTab.targetId,
        tabId: 42,
        windowId: 7,
      },
    }));
    expect(extensionTabStore.attachTab).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Certificates, Identifiers & Profiles',
      text: 'token=abc123 Identifiers App IDs',
    }));
  });

  it('captures a fresh existing-tab screenshot instead of requiring cached attachment data', async () => {
    const sendCommand = vi.fn(async () => ({
      screenshotBase64: 'ZnJlc2gtcG5n',
      capturedAt: 1_700_000_000_000,
    }));
    const { service } = makeService({
      existingTab: {
        ...appStoreConnectTab,
        screenshotBase64: undefined,
      },
      extensionCommandStore: { sendCommand },
    });

    const result = await service.screenshot({
      instanceId: 'instance-1',
      provider: 'claude',
      profileId: appStoreConnectTab.profileId,
      targetId: appStoreConnectTab.targetId,
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: 'ZnJlc2gtcG5n',
    });
    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'screenshot',
      target: {
        profileId: appStoreConnectTab.profileId,
        targetId: appStoreConnectTab.targetId,
        tabId: 42,
        windowId: 7,
      },
    }));
  });

  it('waits for selectors in existing Chrome tabs through the extension command bridge', async () => {
    const sendCommand = vi.fn(async () => ({
      tagName: 'BUTTON',
      text: 'New App',
    }));
    const { driver, service } = makeService({
      profile: null,
      profiles: [],
      existingTab: appStoreConnectTab,
      extensionCommandStore: { sendCommand },
    });

    const result = await service.waitFor({
      instanceId: 'instance-1',
      provider: 'claude',
      profileId: appStoreConnectTab.profileId,
      targetId: appStoreConnectTab.targetId,
      selector: 'button[aria-label="New App"]',
      timeoutMs: 5_000,
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
    });
    expect(driver.waitFor).not.toHaveBeenCalled();
    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'wait_for',
      target: {
        profileId: appStoreConnectTab.profileId,
        targetId: appStoreConnectTab.targetId,
        tabId: 42,
        windowId: 7,
      },
      payload: {
        selector: 'button[aria-label="New App"]',
        timeoutMs: 5_000,
      },
    }));
  });

  it('queries selector candidates in existing Chrome tabs through the extension command bridge', async () => {
    const sendCommand = vi.fn(async () => ({
      elements: [{
        selector: 'button[aria-label="New App"]',
        tagName: 'BUTTON',
        role: 'button',
        accessibleName: 'New App',
        text: '',
      }],
    }));
    const { driver, service } = makeService({
      profile: null,
      profiles: [],
      existingTab: appStoreConnectTab,
      extensionCommandStore: { sendCommand },
    });

    const result = await service.queryElements({
      instanceId: 'instance-1',
      provider: 'claude',
      profileId: appStoreConnectTab.profileId,
      targetId: appStoreConnectTab.targetId,
      query: 'New App',
      limit: 10,
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: [{
        selector: 'button[aria-label="New App"]',
        tagName: 'BUTTON',
        accessibleName: 'New App',
      }],
    });
    expect(driver.waitFor).not.toHaveBeenCalled();
    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'query_elements',
      timeoutMs: 65_000,
      executionTimeoutMs: 60_000,
      target: {
        profileId: appStoreConnectTab.profileId,
        targetId: appStoreConnectTab.targetId,
        tabId: 42,
        windowId: 7,
      },
      payload: {
        query: 'New App',
        limit: 10,
      },
    }));
  });

  it('reports <select>, checkbox, and input control state so dropdowns can be verified', async () => {
    const sendCommand = vi.fn(async () => ({
      elements: [
        {
          selector: '#environment-select',
          tagName: 'SELECT',
          role: 'select',
          value: 'sandbox_production',
          selectedOption: 'Sandbox & Production',
          disabled: false,
          options: [
            { value: 'sandbox', label: 'Sandbox', selected: false },
            { value: 'sandbox_production', label: 'Sandbox & Production', selected: true },
          ],
        },
        {
          selector: '#agree',
          tagName: 'INPUT',
          inputType: 'checkbox',
          checked: true,
        },
        {
          selector: '#secret',
          tagName: 'INPUT',
          inputType: 'password',
        },
      ],
    }));
    const { service } = makeService({
      profile: null,
      profiles: [],
      existingTab: appStoreConnectTab,
      extensionCommandStore: { sendCommand },
    });

    const result = await service.queryElements({
      instanceId: 'instance-1',
      provider: 'claude',
      profileId: appStoreConnectTab.profileId,
      targetId: appStoreConnectTab.targetId,
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: [
        {
          selector: '#environment-select',
          tagName: 'SELECT',
          value: 'sandbox_production',
          selectedOption: 'Sandbox & Production',
          options: [
            { value: 'sandbox', label: 'Sandbox', selected: false },
            { value: 'sandbox_production', label: 'Sandbox & Production', selected: true },
          ],
        },
        {
          selector: '#agree',
          tagName: 'INPUT',
          checked: true,
        },
        {
          selector: '#secret',
          tagName: 'INPUT',
        },
      ],
    });
    // Password inputs must never leak a value back to the agent.
    const passwordCandidate = (result.data as unknown as Record<string, unknown>[])[2];
    expect(passwordCandidate['value']).toBeUndefined();
  });

  describe('console/network capture on shared extension tabs', () => {
    const spaTab = {
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
      tabId: 42,
      windowId: 7,
      title: 'Prod App',
      url: 'https://app.example.com/dashboard',
      origin: 'https://app.example.com',
      allowedOrigins: [
        {
          scheme: 'https' as const,
          hostPattern: 'app.example.com',
          includeSubdomains: false,
        },
      ],
    };

    it('resolves console_messages through the same extension bridge that snapshot/click use', async () => {
      // Regression: this is the exact gap the console-read prompt fixes. These
      // ids drive snapshot/click fine, so console_messages must resolve them too
      // — never fall through to profile_target_or_url_not_found.
      const sendCommand = vi.fn(async (request) => {
        expect(request.command).toBe('console_messages');
        return {
          kind: 'console',
          installed: true,
          entries: [
            {
              type: 'error',
              text: 'TypeError: cannot read properties of undefined',
              location: { url: 'https://app.example.com/main.js', lineNumber: 12, columnNumber: 5 },
              stack: 'TypeError\n  at render (main.js:12:5)',
              seq: 1,
              timestamp: 100,
            },
          ],
        };
      });
      const { service } = makeService({
        existingTab: spaTab,
        extensionCommandStore: { sendCommand },
      });

      const result = await service.consoleMessages({
        instanceId: 'instance-1',
        provider: 'copilot',
        profileId: spaTab.profileId,
        targetId: spaTab.targetId,
      });

      expect(result).toMatchObject({ decision: 'allowed', outcome: 'succeeded' });
      expect(result.reason).not.toBe('profile_target_or_url_not_found');
      const entries = result.data as Array<Record<string, unknown>>;
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        type: 'error',
        text: 'TypeError: cannot read properties of undefined',
        location: { url: 'https://app.example.com/main.js', lineNumber: 12, columnNumber: 5 },
      });
    });

    it('returns failing network requests with method, url, and status', async () => {
      const sendCommand = vi.fn(async (request) => {
        expect(request.command).toBe('network_requests');
        return {
          kind: 'network',
          installed: true,
          entries: [
            {
              method: 'GET',
              url: 'https://api.example.com/orders',
              resourceType: 'fetch',
              status: 404,
              statusText: 'Not Found',
              ok: false,
              seq: 2,
              timestamp: 200,
            },
            {
              method: 'POST',
              url: 'https://api.example.com/auth',
              resourceType: 'xhr',
              status: 401,
              ok: false,
              seq: 3,
              timestamp: 210,
            },
          ],
        };
      });
      const { service } = makeService({
        existingTab: spaTab,
        extensionCommandStore: { sendCommand },
      });

      const result = await service.networkRequests({
        instanceId: 'instance-1',
        provider: 'copilot',
        profileId: spaTab.profileId,
        targetId: spaTab.targetId,
      });

      expect(result).toMatchObject({ decision: 'allowed', outcome: 'succeeded' });
      const entries = result.data as Array<Record<string, unknown>>;
      expect(entries.map((entry) => entry['status'])).toEqual([404, 401]);
      expect(entries[0]).toMatchObject({ method: 'GET', resourceType: 'fetch', ok: false });
    });

    it('returns a distinct capability error (not profile_target_or_url_not_found) for an old extension', async () => {
      // An extension too old to know the command must not read as "wrong ids".
      const sendCommand = vi.fn(async () => {
        throw new Error('Unsupported browser command: console_messages');
      });
      const { service } = makeService({
        existingTab: spaTab,
        extensionCommandStore: { sendCommand },
      });

      const result = await service.consoleMessages({
        instanceId: 'instance-1',
        provider: 'copilot',
        profileId: spaTab.profileId,
        targetId: spaTab.targetId,
      });

      expect(result).toMatchObject({
        decision: 'allowed',
        outcome: 'failed',
        reason: 'console_capture_unsupported_for_driver',
      });
      expect(result.reason).not.toBe('profile_target_or_url_not_found');
    });

    it('redacts secrets from captured console text before returning them', async () => {
      const sendCommand = vi.fn(async () => ({
        kind: 'console',
        installed: true,
        entries: [
          {
            type: 'warn',
            text: 'authorization: Bearer sk-should-not-leak',
            timestamp: 1,
          },
        ],
      }));
      const { service } = makeService({
        existingTab: spaTab,
        extensionCommandStore: { sendCommand },
      });

      const result = await service.consoleMessages({
        instanceId: 'instance-1',
        provider: 'copilot',
        profileId: spaTab.profileId,
        targetId: spaTab.targetId,
      });

      const entries = result.data as Array<Record<string, unknown>>;
      expect(entries[0]['text']).toContain('[REDACTED]');
      expect(entries[0]['text']).not.toContain('sk-should-not-leak');
    });

    it('denies capture reads when the tab origin is outside policy', async () => {
      const offPolicyTab = {
        ...spaTab,
        url: 'https://evil.example.net/x',
        origin: 'https://evil.example.net',
      };
      const sendCommand = vi.fn(async () => ({ kind: 'console', installed: true, entries: [] }));
      const { service } = makeService({
        existingTab: offPolicyTab,
        extensionCommandStore: { sendCommand },
      });

      const result = await service.consoleMessages({
        instanceId: 'instance-1',
        provider: 'copilot',
        profileId: offPolicyTab.profileId,
        targetId: offPolicyTab.targetId,
      });

      expect(result).toMatchObject({ decision: 'denied', outcome: 'not_run' });
      expect(sendCommand).not.toHaveBeenCalled();
    });
  });
});
