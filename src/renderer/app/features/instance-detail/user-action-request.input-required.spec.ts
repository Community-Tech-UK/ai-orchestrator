import { describe, expect, it } from 'vitest';
import { acpPermissionOptions } from './user-action-request.input-required';

describe('ACP options', () => {
  it('orders valid options by safe once choices and labels lasting choices', () => {
    const options = acpPermissionOptions({ permissionMetadata: { type: 'acp_permission_request', options: [
      { optionId: 'aa', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'rr', name: 'Reject forever', kind: 'reject_always' },
      { optionId: 'a', name: 'Allow', kind: 'allow_once' },
      { optionId: 'r', name: 'Reject', kind: 'reject_once' },
    ] } });
    expect(options?.map(o => [o.optionId, o.tone, o.lasting])).toEqual([
      ['a', 'allow', false], ['aa', 'allow', true], ['r', 'reject', false], ['rr', 'reject', true],
    ]);
  });
  it('rejects missing, empty, malformed and nonpermission options', () => {
    for (const options of [undefined, [], [{ optionId: 'a', name: 'Allow', kind: 'unknown' }], [{ name: 'Allow', kind: 'allow_once' }]]) {
      expect(acpPermissionOptions({ permissionMetadata: { type: 'acp_permission_request', options } })).toBeNull();
    }
  });
});
