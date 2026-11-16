import { describe, expect, it } from 'vitest';
import { validateBrowserRpcPayload } from './browser-rpc-server-support';
import {
  BrowserStartDeviceLoginRequestSchema,
  BrowserReadDeviceLoginRequestSchema,
  BrowserCancelDeviceLoginRequestSchema,
  BrowserFillDeviceLoginRequestSchema,
} from '../../../packages/contracts/src/schemas/browser-device-login.schemas';

const loginHandle = '00000000-0000-4000-8000-000000000001';
const cases = () => [
  [BrowserStartDeviceLoginRequestSchema, { nodeId: 'native-node', profileId: 'fresh-profile' }],
  [BrowserReadDeviceLoginRequestSchema, { loginHandle }],
  [BrowserCancelDeviceLoginRequestSchema, { loginHandle }],
  [BrowserFillDeviceLoginRequestSchema, { loginHandle, profileId: 'browser-profile', targetId: 'browser-target' }],
] as const;

describe('public device-login request boundaries', () => {
  it.each(['start', 'read', 'cancel', 'fill'])('rejects unknown fields at the %s RPC boundary', (action) => {
    const payload = action === 'start' ? { nodeId: 'native-node', profileId: 'fresh-profile' }
      : action === 'fill' ? { loginHandle, profileId: 'browser-profile', targetId: 'browser-target' } : { loginHandle };
    expect(() => validateBrowserRpcPayload(`browser.${action}_device_login`, { ...payload, code: 'NON_SECRET_PLACEHOLDER' }))
      .toThrow('Invalid browser gateway RPC payload');
  });
  it('accepts only opaque operation references and explicit destinations', () => {
    for (const [schema, input] of cases()) expect(schema.parse(input)).toEqual(input);
  });
  it.each(['code', 'owner', 'generation', 'expectedIdentity', 'command', 'approvalId'])('rejects caller-supplied %s', (field) => {
    for (const [schema, input] of cases()) {
      expect(schema.safeParse({ ...input, [field]: 'NON_SECRET_PLACEHOLDER' }).success).toBe(false);
    }
  });
  it.each(['legacy', '../profile', '', 'a'.repeat(65)])('rejects unsafe or legacy native profile %s', (profileId) => {
    expect(BrowserStartDeviceLoginRequestSchema.safeParse({ nodeId: 'native-node', profileId }).success).toBe(false);
  });
  it('rejects missing destinations and non-operation handles', () => {
    expect(BrowserFillDeviceLoginRequestSchema.safeParse({ loginHandle }).success).toBe(false);
    for (const schema of [BrowserReadDeviceLoginRequestSchema, BrowserCancelDeviceLoginRequestSchema]) {
      expect(schema.safeParse({ loginHandle: 'not-an-operation' }).success).toBe(false);
    }
  });
});
