import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http = require('node:http');
import https = require('node:https');
import { AllowedHostMatcher } from './allowed-hosts';
import { installNetworkPauseGate } from './install-network-pause-gate';
import { OrchestratorPausedError } from '../pause/orchestrator-paused-error';

let uninstall: (() => void) | null = null;

function swallowClientRequestErrors(request: http.ClientRequest): void {
  request.on('error', () => undefined);
}

describe('installNetworkPauseGate', () => {
  let realHttpRequest: typeof http.request;
  let realHttpGet: typeof http.get;
  let realHttpsRequest: typeof https.request;
  let realHttpsGet: typeof https.get;
  let realFetch: typeof globalThis.fetch;

  beforeEach(() => {
    realHttpRequest = http.request;
    realHttpGet = http.get;
    realHttpsRequest = https.request;
    realHttpsGet = https.get;
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    uninstall?.();
    uninstall = null;
  });

  it('replaces all five primitives on install', () => {
    uninstall = installNetworkPauseGate({
      coordinator: { isPaused: () => false },
      allowedHosts: new AllowedHostMatcher({ allowPrivateRanges: false }),
    });

    expect(http.request).not.toBe(realHttpRequest);
    expect(http.get).not.toBe(realHttpGet);
    expect(https.request).not.toBe(realHttpsRequest);
    expect(https.get).not.toBe(realHttpsGet);
    expect(globalThis.fetch).not.toBe(realFetch);
  });

  it('restores identity on uninstall', () => {
    uninstall = installNetworkPauseGate({
      coordinator: { isPaused: () => false },
      allowedHosts: new AllowedHostMatcher({ allowPrivateRanges: false }),
    });

    uninstall();
    uninstall = null;

    expect(http.request).toBe(realHttpRequest);
    expect(http.get).toBe(realHttpGet);
    expect(https.request).toBe(realHttpsRequest);
    expect(https.get).toBe(realHttpsGet);
    expect(globalThis.fetch).toBe(realFetch);
  });

  it('throws for http and https calls to non-local hosts while paused', () => {
    uninstall = installNetworkPauseGate({
      coordinator: { isPaused: () => true },
      allowedHosts: new AllowedHostMatcher({ allowPrivateRanges: false }),
    });

    expect(() => http.request({ hostname: 'api.openai.com', path: '/' })).toThrow(
      OrchestratorPausedError
    );
    expect(() => http.get('http://api.openai.com/')).toThrow(OrchestratorPausedError);
    expect(() => https.request({ hostname: 'api.anthropic.com', path: '/' })).toThrow(
      OrchestratorPausedError
    );
    expect(() => https.get('https://api.anthropic.com/')).toThrow(OrchestratorPausedError);
  });

  it('rejects fetch to non-local hosts while paused', async () => {
    uninstall = installNetworkPauseGate({
      coordinator: { isPaused: () => true },
      allowedHosts: new AllowedHostMatcher({ allowPrivateRanges: false }),
    });

    await expect(globalThis.fetch('https://api.anthropic.com/')).rejects.toBeInstanceOf(
      OrchestratorPausedError
    );
  });

  it('allows localhost, host alias, and bracketed IPv6 loopback while paused', async () => {
    uninstall = installNetworkPauseGate({
      coordinator: { isPaused: () => true },
      allowedHosts: new AllowedHostMatcher({ allowPrivateRanges: false }),
    });

    expect(() => {
      const request = http.request({ hostname: 'localhost', port: 1, path: '/', timeout: 1 });
      swallowClientRequestErrors(request);
      request.destroy();
    }).not.toThrow(OrchestratorPausedError);

    expect(() => {
      const request = http.request({ host: '127.0.0.1', port: 1, path: '/', timeout: 1 });
      swallowClientRequestErrors(request);
      request.destroy();
    }).not.toThrow(OrchestratorPausedError);

    expect(() => {
      const request = http.request({ host: '127.0.0.1:8080', path: '/', timeout: 1 });
      swallowClientRequestErrors(request);
      request.destroy();
    }).not.toThrow(OrchestratorPausedError);

    let blocked = false;
    try {
      await globalThis.fetch('http://[::1]:65535/').catch(() => null);
    } catch (error) {
      blocked = error instanceof OrchestratorPausedError;
    }
    expect(blocked).toBe(false);
  });

  it('still gates public hosts passed through the host alias', () => {
    uninstall = installNetworkPauseGate({
      coordinator: { isPaused: () => true },
      allowedHosts: new AllowedHostMatcher({ allowPrivateRanges: false }),
    });

    expect(() => http.request({ host: 'api.example.com', path: '/' })).toThrow(
      OrchestratorPausedError
    );
  });
});
