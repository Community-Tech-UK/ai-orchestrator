import { describe, expect, it, vi } from 'vitest';
import {
  BundledDarwinHelperClient,
  resolveDesktopHelperPath,
  type DesktopHelperRunner,
} from './darwin-helper-client';
import {
  DESKTOP_HELPER_PROTOCOL_VERSION,
  DesktopHelperProtocolError,
  parseDesktopHelperResponse,
  serializeDesktopHelperRequest,
} from './desktop-helper-protocol';

function response(
  id: string,
  result: unknown,
  protocolVersion = DESKTOP_HELPER_PROTOCOL_VERSION,
): string {
  return JSON.stringify({
    protocolVersion,
    id,
    ok: true,
    result,
  });
}

describe('desktop helper protocol', () => {
  it('serializes one bounded JSON-lines request', () => {
    const line = serializeDesktopHelperRequest('request-1', 'click', {
      appId: 'darwin-app:com.example.Editor',
      x: 12,
      y: 34,
    });

    expect(line.endsWith('\n')).toBe(true);
    expect(line.split('\n')).toHaveLength(2);
    expect(JSON.parse(line)).toEqual({
      protocolVersion: DESKTOP_HELPER_PROTOCOL_VERSION,
      id: 'request-1',
      command: 'click',
      payload: {
        appId: 'darwin-app:com.example.Editor',
        x: 12,
        y: 34,
      },
    });
  });

  it('parses a matching success response', () => {
    expect(parseDesktopHelperResponse(response('request-1', { input: true }), 'request-1'))
      .toEqual({ input: true });
  });

  it('rejects malformed, mismatched, and wrong-version responses', () => {
    expect(() => parseDesktopHelperResponse('not-json', 'request-1'))
      .toThrowError(new DesktopHelperProtocolError('helper_protocol_invalid'));
    expect(() => parseDesktopHelperResponse(response('other', {}), 'request-1'))
      .toThrowError(new DesktopHelperProtocolError('helper_request_mismatch'));
    expect(() => parseDesktopHelperResponse(response('request-1', {}, '2.0.0'), 'request-1'))
      .toThrowError(new DesktopHelperProtocolError('helper_version_mismatch'));
  });
});

describe('resolveDesktopHelperPath', () => {
  it('uses the app resources directory in packaged mode', () => {
    expect(resolveDesktopHelperPath({
      isPackaged: true,
      resourcesPath: '/Applications/Harness.app/Contents/Resources',
      appPath: '/unused',
    })).toBe('/Applications/Harness.app/Contents/Resources/desktop-helper/desktop-helper');
  });

  it('uses the project dist directory in development mode', () => {
    expect(resolveDesktopHelperPath({
      isPackaged: false,
      resourcesPath: '/unused',
      appPath: '/work/harness',
    })).toBe('/work/harness/dist/desktop-helper/desktop-helper');
  });
});

describe('BundledDarwinHelperClient', () => {
  it('reports an absent helper without attempting to execute it', async () => {
    const run = vi.fn<DesktopHelperRunner>();
    const client = new BundledDarwinHelperClient({
      helperPath: '/missing/desktop-helper',
      pathExists: () => false,
      run,
    });

    await expect(client.health()).resolves.toMatchObject({
      mode: 'unavailable',
      degraded: true,
      issue: 'helper_missing',
      screenRecording: false,
      accessibility: false,
      input: false,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('reports a protocol version mismatch as degraded health', async () => {
    const run = vi.fn<DesktopHelperRunner>(async (_path, input) => {
      const request = JSON.parse(input) as { id: string };
      return {
        stdout: response(request.id, {}, '9.0.0'),
        stderr: '',
      };
    });
    const client = new BundledDarwinHelperClient({
      helperPath: '/present/desktop-helper',
      pathExists: () => true,
      run,
    });

    await expect(client.health()).resolves.toMatchObject({
      mode: 'unavailable',
      degraded: true,
      issue: 'version_mismatch',
      input: false,
    });
  });

  it('serializes requestAccessibility with an empty payload and returns the trust state', async () => {
    const run = vi.fn<DesktopHelperRunner>(async (_path, input) => {
      const request = JSON.parse(input) as {
        id: string;
        command: string;
        payload: Record<string, unknown>;
      };
      expect(request.command).toBe('requestAccessibility');
      expect(request.payload).toEqual({});
      return {
        stdout: response(request.id, { trusted: false }),
        stderr: '',
      };
    });
    const client = new BundledDarwinHelperClient({
      helperPath: '/present/desktop-helper',
      pathExists: () => true,
      run,
    });

    await expect(client.requestAccessibility()).resolves.toBe(false);
    expect(run).toHaveBeenCalledOnce();
  });

  it('rejects a malformed requestAccessibility result', async () => {
    const run = vi.fn<DesktopHelperRunner>(async (_path, input) => {
      const request = JSON.parse(input) as { id: string };
      return {
        stdout: response(request.id, { trusted: 'yes' }),
        stderr: '',
      };
    });
    const client = new BundledDarwinHelperClient({
      helperPath: '/present/desktop-helper',
      pathExists: () => true,
      run,
    });

    await expect(client.requestAccessibility()).rejects.toThrow('computer_use_driver_failed');
  });

  it('fails requestAccessibility safely when the helper is missing', async () => {
    const run = vi.fn<DesktopHelperRunner>();
    const client = new BundledDarwinHelperClient({
      helperPath: '/missing/desktop-helper',
      pathExists: () => false,
      run,
    });

    await expect(client.requestAccessibility()).rejects.toThrow('computer_use_helper_missing');
    expect(run).not.toHaveBeenCalled();
  });

  it('maps a requestAccessibility protocol version mismatch to the stable error', async () => {
    const run = vi.fn<DesktopHelperRunner>(async (_path, input) => {
      const request = JSON.parse(input) as { id: string };
      return {
        stdout: response(request.id, { trusted: true }, '9.0.0'),
        stderr: '',
      };
    });
    const client = new BundledDarwinHelperClient({
      helperPath: '/present/desktop-helper',
      pathExists: () => true,
      run,
    });

    await expect(client.requestAccessibility())
      .rejects.toThrow('computer_use_helper_version_mismatch');
  });

  it('maps helper app records into desktop descriptors', async () => {
    const run = vi.fn<DesktopHelperRunner>(async (_path, input) => {
      const request = JSON.parse(input) as { id: string };
      return {
        stdout: response(request.id, {
          apps: [{
            name: 'Preview',
            bundleId: 'com.apple.Preview',
            pid: 42,
            windows: [{ id: 99, title: 'Document' }],
          }],
        }),
        stderr: '',
      };
    });
    const client = new BundledDarwinHelperClient({
      helperPath: '/present/desktop-helper',
      pathExists: () => true,
      run,
    });

    await expect(client.listApps()).resolves.toEqual([{
      appId: 'darwin-app:com.apple.Preview',
      displayName: 'Preview',
      platform: 'darwin',
      bundleId: 'com.apple.Preview',
      pid: 42,
      windowId: '99',
      visibleWindowCount: 1,
    }]);
  });

  it('maps helper accessibility errors to stable gateway errors', async () => {
    const run = vi.fn<DesktopHelperRunner>(async (_path, input) => {
      const request = JSON.parse(input) as { id: string };
      return {
        stdout: JSON.stringify({
          protocolVersion: DESKTOP_HELPER_PROTOCOL_VERSION,
          id: request.id,
          ok: false,
          error: {
            code: 'accessibility_denied',
            message: 'Accessibility permission is required.',
          },
        }),
        stderr: '',
      };
    });
    const client = new BundledDarwinHelperClient({
      helperPath: '/present/desktop-helper',
      pathExists: () => true,
      run,
    });

    await expect(client.click({
      appId: 'darwin-app:com.apple.Preview',
      observationToken: 'obs',
      x: 1,
      y: 2,
    })).rejects.toThrow('computer_use_missing_accessibility');
  });

  it('maps helper sensitive-target refusals to the stable policy error', async () => {
    const run = vi.fn<DesktopHelperRunner>(async (_path, input) => {
      const request = JSON.parse(input) as { id: string };
      return {
        stdout: JSON.stringify({
          protocolVersion: DESKTOP_HELPER_PROTOCOL_VERSION,
          id: request.id,
          ok: false,
          error: {
            code: 'sensitive_target',
            message: 'The focused target is sensitive.',
          },
        }),
        stderr: '',
      };
    });
    const client = new BundledDarwinHelperClient({
      helperPath: '/present/desktop-helper',
      pathExists: () => true,
      run,
    });

    await expect(client.typeText({
      appId: 'darwin-app:com.example.Editor',
      observationToken: 'obs',
      text: 'ordinary-password',
    })).rejects.toThrow('computer_use_sensitive_action_blocked');
  });

  it('does not include typed text in process errors', async () => {
    const run = vi.fn<DesktopHelperRunner>(async () => {
      throw new Error('helper exited with status 1');
    });
    const client = new BundledDarwinHelperClient({
      helperPath: '/present/desktop-helper',
      pathExists: () => true,
      run,
    });

    await expect(client.typeText({
      appId: 'darwin-app:com.example.Editor',
      observationToken: 'obs',
      text: 'PRIVATE_TYPED_VALUE',
    })).rejects.toThrow('computer_use_driver_failed');
    await expect(client.typeText({
      appId: 'darwin-app:com.example.Editor',
      observationToken: 'obs',
      text: 'PRIVATE_TYPED_VALUE',
    })).rejects.not.toThrow('PRIVATE_TYPED_VALUE');
  });
});
