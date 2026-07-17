import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserGatewayRpcServer } from './browser-gateway-rpc-server';
import type { BrowserGatewayNavigateRequest } from './browser-gateway-service-types';
import type { BrowserGatewayResult } from '@contracts/types/browser';
import { createBrowserMcpTools } from './browser-mcp-tools';
import { BrowserReliabilityEvents, getBrowserReliabilityEvents } from './browser-reliability-events';
import {
  BROWSER_GATEWAY_RPC_PROTOCOL_VERSION,
  computeBrowserToolSurfaceHash,
} from './browser-rpc-contract';
import { BrowserToolRevealStore } from './browser-tool-reveal-store';

describe('BrowserGatewayRpcServer', () => {
  it('rejects unknown instance ids before reaching the gateway', async () => {
    const navigate = vi.fn();
    const server = new BrowserGatewayRpcServer({
      service: { navigate },
      userDataPath: '/tmp',
      isKnownLocalInstance: () => false,
      registerCleanup: vi.fn(),
    });

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'browser.navigate',
        params: {
          instanceId: 'unknown',
          payload: {
            profileId: 'profile-1',
            targetId: 'target-1',
            url: 'http://localhost:4567',
          },
        },
      }),
    ).rejects.toThrow(/unknown browser gateway instance/);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('rejects instance ids by default unless the app supplies a known-instance validator', async () => {
    const navigate = vi.fn();
    const server = new BrowserGatewayRpcServer({
      service: { navigate },
      userDataPath: '/tmp',
      registerCleanup: vi.fn(),
    });

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'browser.navigate',
        params: {
          instanceId: 'instance-1',
          provider: 'copilot',
          payload: {
            profileId: 'profile-1',
            targetId: 'target-1',
            url: 'http://localhost:4567',
          },
        },
      }),
    ).rejects.toThrow(/unknown browser gateway instance/);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('rejects oversized payloads', async () => {
    const server = new BrowserGatewayRpcServer({
      service: { navigate: vi.fn() },
      userDataPath: '/tmp',
      isKnownLocalInstance: () => true,
      registerCleanup: vi.fn(),
      maxPayloadBytes: 10,
    });

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'browser.navigate',
        params: {
          instanceId: 'instance-1',
          provider: 'copilot',
          payload: {
            profileId: 'profile-1',
            targetId: 'target-1',
            url: 'http://localhost:4567/too-large',
          },
        },
      }),
    ).rejects.toThrow(/payload too large/);
  });

  it('limits cumulative payload bytes per instance within the rate window', async () => {
    const navigate = vi.fn(async () => ({ decision: 'allowed', outcome: 'ok' })) as unknown as (
      request: BrowserGatewayNavigateRequest,
    ) => Promise<BrowserGatewayResult<null>>;
    const server = new BrowserGatewayRpcServer({
      service: { navigate },
      userDataPath: '/tmp',
      isKnownLocalInstance: () => true,
      registerCleanup: vi.fn(),
      maxPayloadBytes: 512,
      rateLimit: { maxRequests: 10, maxBytes: 300, windowMs: 10_000 },
    });
    const request = {
      jsonrpc: '2.0' as const,
      method: 'browser.navigate',
      params: {
        instanceId: 'instance-1',
        provider: 'copilot',
        payload: {
          profileId: 'profile-1',
          targetId: 'target-1',
          url: `https://example.com/${'x'.repeat(80)}`,
        },
      },
    };

    await server.handleRequest({ ...request, id: 1 });
    await expect(server.handleRequest({ ...request, id: 2 })).rejects.toThrow(
      'Browser Gateway RPC byte rate limit exceeded',
    );
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid schemas and forwards valid calls', async () => {
    const navigate = vi.fn().mockResolvedValue({ decision: 'allowed' });
    const server = new BrowserGatewayRpcServer({
      service: { navigate },
      userDataPath: '/tmp',
      isKnownLocalInstance: () => true,
      registerCleanup: vi.fn(),
    });

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'browser.navigate',
        params: {
          instanceId: 'instance-1',
          payload: {
            profileId: 'profile-1',
          },
        },
      }),
    ).rejects.toThrow(/Invalid browser gateway RPC payload/);

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'browser.navigate',
        params: {
          instanceId: 'instance-1',
          provider: 'copilot',
          payload: {
            profileId: 'profile-1',
            targetId: 'target-1',
            url: 'http://localhost:4567',
          },
        },
      }),
    ).resolves.toEqual({ decision: 'allowed' });
    expect(navigate).toHaveBeenCalledWith({
      instanceId: 'instance-1',
      provider: 'copilot',
      profileId: 'profile-1',
      targetId: 'target-1',
      url: 'http://localhost:4567',
    });
  });

  it('handles durable browser workflow checkpoint save and resume RPC calls', async () => {
    const checkpointStore = {
      saveStep: vi.fn(async (input: {
        ownerId: string;
        workflowId: string;
        stepId: string;
        pageFingerprint: string;
        resultSummary?: string;
        completedAt?: number;
      }) => ({
        ownerId: input.ownerId,
        workflowId: input.workflowId,
        updatedAt: input.completedAt ?? 123,
        steps: [{
          stepId: input.stepId,
          completedAt: input.completedAt ?? 123,
          pageFingerprint: input.pageFingerprint,
          resultSummary: input.resultSummary,
        }],
      })),
      get: vi.fn(async (ownerId: string, workflowId: string) => ({
        ownerId,
        workflowId,
        updatedAt: 123,
        steps: [{
          stepId: 'create-app',
          completedAt: 123,
          pageFingerprint: 'url:/console/app|saved:true',
        }],
      })),
    };
    const server = new BrowserGatewayRpcServer({
      service: {},
      userDataPath: '/tmp',
      isKnownLocalInstance: () => true,
      registerCleanup: vi.fn(),
      checkpointStore,
    });

    await expect(server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'browser.checkpoint_save',
      params: {
        instanceId: 'instance-1',
        payload: {
          workflowId: 'new-app/com.example.app',
          stepId: 'create-app',
          pageFingerprint: 'url:/console/app|saved:true',
          resultSummary: 'App record saved',
          completedAt: 123,
        },
      },
    })).resolves.toMatchObject({
      workflowId: 'new-app/com.example.app',
      steps: [{ stepId: 'create-app' }],
    });
    await expect(server.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'browser.checkpoint_resume',
      params: {
        instanceId: 'instance-1',
        payload: {
          workflowId: 'new-app/com.example.app',
        },
      },
    })).resolves.toMatchObject({
      workflowId: 'new-app/com.example.app',
      steps: [{ pageFingerprint: 'url:/console/app|saved:true' }],
    });
    expect(checkpointStore.saveStep).toHaveBeenCalledWith({
      ownerId: 'instance-1',
      workflowId: 'new-app/com.example.app',
      stepId: 'create-app',
      pageFingerprint: 'url:/console/app|saved:true',
      resultSummary: 'App record saved',
      completedAt: 123,
    });
    expect(checkpointStore.get).toHaveBeenCalledWith(
      'instance-1',
      'new-app/com.example.app',
    );
  });

  it('rejects arbitrary checkpoint result objects that could persist secrets', async () => {
    const server = new BrowserGatewayRpcServer({
      service: {},
      userDataPath: '/tmp',
      isKnownLocalInstance: () => true,
      registerCleanup: vi.fn(),
      checkpointStore: {
        saveStep: vi.fn(),
        get: vi.fn(),
      },
    });

    await expect(server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'browser.checkpoint_save',
      params: {
        instanceId: 'instance-1',
        payload: {
          workflowId: 'new-app/com.example.app',
          stepId: 'create-app',
          pageFingerprint: 'saved',
          result: { password: 'must-not-persist' },
        },
      },
    })).rejects.toThrow('Invalid browser gateway RPC payload');
  });

  it('validates and forwards managed profile creation calls', async () => {
    const createProfile = vi.fn().mockResolvedValue({ decision: 'allowed' });
    const server = new BrowserGatewayRpcServer({
      service: { createProfile },
      userDataPath: '/tmp',
      isKnownLocalInstance: () => true,
      registerCleanup: vi.fn(),
    });

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'browser.create_profile',
        params: {
          instanceId: 'instance-1',
          provider: 'claude',
          payload: {
            label: 'Google Play',
            mode: 'session',
            browser: 'chrome',
            allowedOrigins: [
              {
                scheme: 'https',
                hostPattern: 'play.google.com',
                includeSubdomains: true,
              },
            ],
            defaultUrl: 'https://play.google.com/console',
          },
        },
      }),
    ).resolves.toEqual({ decision: 'allowed' });
    expect(createProfile).toHaveBeenCalledWith({
      instanceId: 'instance-1',
      provider: 'claude',
      label: 'Google Play',
      mode: 'session',
      browser: 'chrome',
      allowedOrigins: [
        {
          scheme: 'https',
          hostPattern: 'play.google.com',
          includeSubdomains: true,
        },
      ],
      defaultUrl: 'https://play.google.com/console',
    });
  });

  it('validates and forwards find-or-open calls for provider browser tasks', async () => {
    const findOrOpen = vi.fn().mockResolvedValue({ decision: 'allowed' });
    const server = new BrowserGatewayRpcServer({
      service: { findOrOpen },
      userDataPath: '/tmp',
      isKnownLocalInstance: () => true,
      registerCleanup: vi.fn(),
    });

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'browser.find_or_open',
        params: {
          instanceId: 'instance-1',
          provider: 'claude',
          payload: {
            url: 'https://play.google.com/console',
            titleHint: 'Google Play Console',
            computer: 'Windows PC',
          },
        },
      }),
    ).resolves.toEqual({ decision: 'allowed' });
    expect(findOrOpen).toHaveBeenCalledWith({
      instanceId: 'instance-1',
      provider: 'claude',
      url: 'https://play.google.com/console',
      titleHint: 'Google Play Console',
      computer: 'Windows PC',
    });

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'browser.find_or_open',
        params: {
          instanceId: 'instance-1',
          payload: {
            url: 'file:///etc/passwd',
          },
        },
      }),
    ).rejects.toThrow(/Invalid browser gateway RPC payload/);
  });

  it('validates native-host token and forwards existing-tab attachment calls without a provider instance id', async () => {
    const attachExistingTab = vi.fn().mockResolvedValue({ decision: 'allowed' });
    const server = new BrowserGatewayRpcServer({
      service: { attachExistingTab },
      userDataPath: '/tmp',
      extensionToken: 'native-token',
      registerCleanup: vi.fn(),
    });

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'browser.extension_attach_tab',
        params: {
          extensionToken: 'native-token',
          extensionOrigin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/',
          payload: {
            tabId: 42,
            windowId: 7,
            url: 'https://play.google.com/console',
            title: 'Google Play Console',
            text: 'Release dashboard',
            screenshotBase64: 'cG5n',
            capturedAt: 1000,
          },
        },
      }),
    ).resolves.toEqual({ decision: 'allowed' });
    expect(attachExistingTab).toHaveBeenCalledWith({
      provider: 'orchestrator',
      extensionOrigin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/',
      tabId: 42,
      windowId: 7,
      url: 'https://play.google.com/console',
      title: 'Google Play Console',
      text: 'Release dashboard',
      screenshotBase64: 'cG5n',
      capturedAt: 1000,
    });
  });

  it('lets an authorized extension native host poll queued commands and report results', async () => {
    const extensionCommandStore = {
      pollCommand: vi.fn().mockResolvedValue({
        id: 'command-1',
        command: 'click',
        target: {
          tabId: 42,
          windowId: 7,
          profileId: 'existing-profile-42',
          targetId: 'existing-tab-42',
        },
        payload: { selector: '#continue' },
        createdAt: 1234,
      }),
      resolveCommand: vi.fn(),
    };
    const server = new BrowserGatewayRpcServer({
      service: {},
      userDataPath: '/tmp',
      extensionToken: 'native-token',
      extensionCommandStore,
      registerCleanup: vi.fn(),
    } as unknown as ConstructorParameters<typeof BrowserGatewayRpcServer>[0] & {
      extensionCommandStore: typeof extensionCommandStore;
    });

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'browser.extension_poll_command',
        params: {
          extensionToken: 'native-token',
          payload: {
            timeoutMs: 25,
          },
        },
      }),
    ).resolves.toMatchObject({
      id: 'command-1',
      command: 'click',
      target: {
        tabId: 42,
        windowId: 7,
      },
      payload: { selector: '#continue' },
    });
    expect(extensionCommandStore.pollCommand).toHaveBeenCalledWith({ timeoutMs: 25 });

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'browser.extension_command_result',
        params: {
          extensionToken: 'native-token',
          payload: {
            commandId: 'command-1',
            ok: true,
            result: {
              text: 'Continue',
            },
          },
        },
      }),
    ).resolves.toEqual({ ok: true });
    expect(extensionCommandStore.resolveCommand).toHaveBeenCalledWith({
      commandId: 'command-1',
      ok: true,
      result: {
        text: 'Continue',
      },
    });
  });

  it('marks local commands received and records local extension disconnects', async () => {
    const extensionCommandStore = {
      pollCommand: vi.fn(),
      resolveCommand: vi.fn(),
      markReceived: vi.fn(),
    };
    const onExtensionDisconnected = vi.fn();
    const server = new BrowserGatewayRpcServer({
      service: {},
      userDataPath: '/tmp',
      extensionToken: 'native-token',
      extensionCommandStore,
      onExtensionDisconnected,
      registerCleanup: vi.fn(),
    } as ConstructorParameters<typeof BrowserGatewayRpcServer>[0] & {
      extensionCommandStore: typeof extensionCommandStore;
    });

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'browser.extension_command_received',
        params: {
          extensionToken: 'native-token',
          payload: { commandId: 'command-1' },
        },
      }),
    ).resolves.toEqual({ ok: true });
    expect(extensionCommandStore.markReceived).toHaveBeenCalledWith('local', 'command-1');

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'browser.extension_command_received',
        params: {
          extensionToken: 'native-token',
          payload: {},
        },
      }),
    ).rejects.toThrow(/Invalid browser gateway RPC payload/);

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 3,
        method: 'browser.extension_disconnected',
        params: {
          extensionToken: 'native-token',
          payload: { reason: 'native_host_stdin_eof' },
        },
      }),
    ).resolves.toEqual({ ok: true });
    expect(onExtensionDisconnected).toHaveBeenCalledWith('native_host_stdin_eof');
  });

  it('rejects extension RPC calls with an invalid native-host token', async () => {
    const attachExistingTab = vi.fn();
    const server = new BrowserGatewayRpcServer({
      service: { attachExistingTab },
      userDataPath: '/tmp',
      extensionToken: 'native-token',
      registerCleanup: vi.fn(),
    });

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'browser.extension_attach_tab',
        params: {
          extensionToken: 'wrong-token',
          payload: {
            tabId: 42,
            windowId: 7,
            url: 'https://play.google.com/console',
          },
        },
      }),
    ).rejects.toThrow(/invalid browser extension host token/);
    expect(attachExistingTab).not.toHaveBeenCalled();
  });

  it('validates and forwards mutating browser gateway calls', async () => {
    const click = vi.fn().mockResolvedValue({ decision: 'requires_user', requestId: 'request-1' });
    const server = new BrowserGatewayRpcServer({
      service: { click },
      userDataPath: '/tmp',
      isKnownLocalInstance: () => true,
      registerCleanup: vi.fn(),
    });

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'browser.click',
        params: {
          instanceId: 'instance-1',
          payload: {
            profileId: 'profile-1',
            targetId: 'target-1',
            selector: 'button.publish',
          },
        },
      }),
    ).resolves.toEqual({ decision: 'requires_user', requestId: 'request-1' });
    expect(click).toHaveBeenCalledWith({
      instanceId: 'instance-1',
      profileId: 'profile-1',
      targetId: 'target-1',
      selector: 'button.publish',
    });
  });

  it('validates and forwards human handoff browser gateway calls', async () => {
    const requestUserLogin = vi.fn().mockResolvedValue({
      decision: 'requires_user',
      requestId: 'request-login',
    });
    const pauseForManualStep = vi.fn().mockResolvedValue({
      decision: 'requires_user',
      requestId: 'request-manual',
    });
    const server = new BrowserGatewayRpcServer({
      service: { requestUserLogin, pauseForManualStep },
      userDataPath: '/tmp',
      isKnownLocalInstance: () => true,
      registerCleanup: vi.fn(),
    });

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'browser.request_user_login',
        params: {
          instanceId: 'instance-1',
          provider: 'claude',
          payload: {
            profileId: 'profile-1',
            targetId: 'target-1',
            reason: 'Please sign in to Google Play Console.',
          },
        },
      }),
    ).resolves.toEqual({ decision: 'requires_user', requestId: 'request-login' });
    expect(requestUserLogin).toHaveBeenCalledWith({
      instanceId: 'instance-1',
      provider: 'claude',
      profileId: 'profile-1',
      targetId: 'target-1',
      reason: 'Please sign in to Google Play Console.',
    });

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'browser.pause_for_manual_step',
        params: {
          instanceId: 'instance-1',
          payload: {
            profileId: 'profile-1',
            targetId: 'target-1',
            kind: 'unsupported',
          },
        },
      }),
    ).rejects.toThrow(/Invalid browser gateway RPC payload/);

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 3,
        method: 'browser.pause_for_manual_step',
        params: {
          instanceId: 'instance-1',
          provider: 'copilot',
          payload: {
            profileId: 'profile-1',
            targetId: 'target-1',
            kind: 'two_factor',
            reason: 'Enter the authenticator code.',
          },
        },
      }),
    ).resolves.toEqual({ decision: 'requires_user', requestId: 'request-manual' });
    expect(pauseForManualStep).toHaveBeenCalledWith({
      instanceId: 'instance-1',
      provider: 'copilot',
      profileId: 'profile-1',
      targetId: 'target-1',
      kind: 'two_factor',
      reason: 'Enter the authenticator code.',
    });
  });

  it('falls back to a short temp socket path when userData is too long for Unix sockets', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const longUserDataPath = path.join(
      os.tmpdir(),
      'browser-gateway-rpc-server-spec',
      'a'.repeat(140),
    );
    fs.mkdirSync(longUserDataPath, { recursive: true });
    const server = new BrowserGatewayRpcServer({
      service: {},
      userDataPath: longUserDataPath,
      isKnownLocalInstance: () => true,
      registerCleanup: vi.fn(),
    });

    await server.start();
    const socketPath = server.getSocketPath();

    expect(socketPath).toBeTruthy();
    expect(socketPath).not.toContain(longUserDataPath);
    expect(Buffer.byteLength(socketPath!, 'utf-8')).toBeLessThanOrEqual(100);

    await server.stop();
  });

  it('returns a JSON-RPC error for malformed socket input', async () => {
    const server = new BrowserGatewayRpcServer({
      service: {},
      userDataPath: os.tmpdir(),
      isKnownLocalInstance: () => true,
      registerCleanup: vi.fn(),
    });

    await server.start();
    try {
      const response = await sendRaw(server.getSocketPath()!, '{not-json}\n');

      expect(response).toMatchObject({
        jsonrpc: '2.0',
        id: null,
        error: {
          message: 'Invalid Browser Gateway RPC request JSON',
        },
      });
    } finally {
      await server.stop();
    }
  });

  it('rejects raw socket requests that exceed the configured envelope limit', async () => {
    const server = new BrowserGatewayRpcServer({
      service: {},
      userDataPath: os.tmpdir(),
      isKnownLocalInstance: () => true,
      registerCleanup: vi.fn(),
      maxPayloadBytes: 1,
    });

    await server.start();
    try {
      const response = await sendRaw(
        server.getSocketPath()!,
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'browser.health',
          params: {
            instanceId: 'instance-1',
            payload: {
              value: 'x'.repeat(20_000),
            },
          },
        })}\n`,
      );

      expect(response).toMatchObject({
        jsonrpc: '2.0',
        id: null,
        error: {
          message: 'Browser Gateway RPC request too large',
        },
      });
    } finally {
      await server.stop();
    }
  });
});

describe('BrowserGatewayRpcServer forward-compatible validation', () => {
  beforeEach(() => {
    BrowserReliabilityEvents._resetForTesting();
  });

  function makeServer(service: Record<string, unknown>): BrowserGatewayRpcServer {
    return new BrowserGatewayRpcServer({
      service,
      userDataPath: '/tmp',
      isKnownLocalInstance: () => true,
      registerCleanup: vi.fn(),
    });
  }

  it('accepts the advertised optional extractionHint on browser.snapshot', async () => {
    const snapshot = vi.fn().mockResolvedValue({ decision: 'allowed' });
    const server = makeServer({ snapshot });

    await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'browser.snapshot',
      params: {
        instanceId: 'instance-1',
        payload: {
          profileId: 'profile-1',
          targetId: 'target-1',
          extractionHint: 'campaign budget field state',
        },
      },
    });

    expect(snapshot).toHaveBeenCalledWith(
      expect.objectContaining({ extractionHint: 'campaign budget field state' }),
    );
  });

  it('strips unknown additive optional fields instead of hard-failing, and records the skew', async () => {
    const snapshot = vi.fn().mockResolvedValue({ decision: 'allowed' });
    const server = makeServer({ snapshot });

    await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'browser.snapshot',
      params: {
        instanceId: 'instance-1',
        payload: {
          profileId: 'profile-1',
          targetId: 'target-1',
          futureOptionalField: 'from a newer bridge',
        },
      },
    });

    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(snapshot.mock.calls[0][0]).not.toHaveProperty('futureOptionalField');
    const events = getBrowserReliabilityEvents().recent();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'schema_skew_stripped',
      detail: { method: 'browser.snapshot', droppedKeys: ['futureOptionalField'] },
    });
  });

  it('still rejects type errors on known fields', async () => {
    const snapshot = vi.fn();
    const server = makeServer({ snapshot });

    await expect(server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'browser.snapshot',
      params: {
        instanceId: 'instance-1',
        payload: { profileId: 'profile-1', targetId: 42 },
      },
    })).rejects.toThrow('Invalid browser gateway RPC payload');
    expect(snapshot).not.toHaveBeenCalled();
  });

  it('never strips unknown keys from security-critical methods', async () => {
    const requestGrant = vi.fn();
    const server = makeServer({ requestGrant });

    await expect(server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'browser.request_grant',
      params: {
        instanceId: 'instance-1',
        payload: {
          profileId: 'profile-1',
          targetId: 'target-1',
          proposedGrant: {
            mode: 'per_action',
            allowedOrigins: [],
            allowedActionClasses: ['read'],
            allowExternalNavigation: false,
            autonomous: false,
          },
          restrictToSafeOrigins: true,
        },
      },
    })).rejects.toThrow('Invalid browser gateway RPC payload');
    expect(requestGrant).not.toHaveBeenCalled();
    expect(getBrowserReliabilityEvents().recent()).toHaveLength(0);
  });

  it('tolerates an advisory contract field in the params envelope', async () => {
    const snapshot = vi.fn().mockResolvedValue({ decision: 'allowed' });
    const server = makeServer({ snapshot });

    await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'browser.snapshot',
      params: {
        instanceId: 'instance-1',
        contract: { protocolVersion: 99 },
        payload: { profileId: 'profile-1', targetId: 'target-1' },
      } as never,
    });

    expect(snapshot).toHaveBeenCalledTimes(1);
  });
});

describe('BrowserGatewayRpcServer tool-surface continuity', () => {
  beforeEach(() => {
    BrowserReliabilityEvents._resetForTesting();
    BrowserToolRevealStore._resetForTesting();
  });

  function makeServer(): BrowserGatewayRpcServer {
    return new BrowserGatewayRpcServer({
      service: {},
      userDataPath: '/tmp',
      isKnownLocalInstance: () => true,
      registerCleanup: vi.fn(),
    });
  }

  it('round-trips revealed tool names per instance', async () => {
    const server = makeServer();
    await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'browser.tool_reveal_record',
      params: {
        instanceId: 'instance-1',
        payload: { names: ['browser.evaluate', 'browser.wait_for'] },
      },
    });

    const mine = await server.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'browser.tool_reveal_get',
      params: { instanceId: 'instance-1', payload: {} },
    });
    const other = await server.handleRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'browser.tool_reveal_get',
      params: { instanceId: 'instance-2', payload: {} },
    });

    expect(mine).toEqual({
      revealedNames: ['browser.evaluate', 'browser.wait_for'],
    });
    expect(other).toEqual({ revealedNames: [] });
  });

  it('reports full parity when the forwarder surface matches this build', async () => {
    const server = makeServer();
    const tools = createBrowserMcpTools({ call: async () => null });

    const result = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'browser.report_tool_surface',
      params: {
        instanceId: 'instance-1',
        payload: {
          names: tools.map((tool) => tool.name),
          revealedNames: [],
          protocolVersion: BROWSER_GATEWAY_RPC_PROTOCOL_VERSION,
          surfaceHash: computeBrowserToolSurfaceHash(tools),
        },
      },
    }) as { parity: Record<string, unknown> };

    expect(result.parity).toMatchObject({
      missing: [],
      extra: [],
      surfaceHashMatch: true,
      protocolVersionMatch: true,
    });
    expect(getBrowserReliabilityEvents().recent()).toHaveLength(0);
  });

  it('flags missing tools and contract skew with reliability events', async () => {
    const server = makeServer();
    const tools = createBrowserMcpTools({ call: async () => null });
    const names = tools
      .map((tool) => tool.name)
      .filter((name) => name !== 'browser.evaluate');

    const result = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'browser.report_tool_surface',
      params: {
        instanceId: 'instance-1',
        payload: {
          names,
          revealedNames: [],
          protocolVersion: BROWSER_GATEWAY_RPC_PROTOCOL_VERSION + 1,
          surfaceHash: 'stale-bridge-hash',
        },
      },
    }) as { parity: { missing: string[]; surfaceHashMatch: boolean } };

    expect(result.parity.missing).toEqual(['browser.evaluate']);
    expect(result.parity.surfaceHashMatch).toBe(false);
    const kinds = getBrowserReliabilityEvents().recent().map((event) => event.kind);
    expect(kinds).toContain('contract_mismatch');
    expect(kinds).toContain('tool_surface_diff');
  });
});

function sendRaw(socketPath: string, raw: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let buffer = '';
    socket.on('connect', () => {
      socket.write(raw);
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
    });
    socket.on('end', () => {
      try {
        resolve(JSON.parse(buffer.trim()) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    socket.on('error', reject);
  });
}
