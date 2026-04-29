import { describe, expect, it } from 'vitest';

import {
  canResolveInputRequiredWithYolo,
  defaultInputRequiredScope,
  isPermissionDenialRequest,
  shouldClearInputRequiredForYolo,
  shouldClearRequestAfterYoloEnabled
} from './user-action-request.rules';

describe('user action request rules', () => {
  it('keeps Claude permission-denial prompts visible while YOLO is enabled', () => {
    const request = {
      instanceId: 'inst-1',
      requestType: 'input_required',
      permissionMetadata: { type: 'permission_denial' },
    };

    expect(isPermissionDenialRequest(request)).toBe(true);
    expect(shouldClearInputRequiredForYolo(request)).toBe(false);
    expect(shouldClearRequestAfterYoloEnabled(request, 'inst-1')).toBe(false);
    expect(canResolveInputRequiredWithYolo(request)).toBe(false);
  });

  it('clears normal input_required prompts after YOLO is enabled for the same instance', () => {
    const request = {
      instanceId: 'inst-1',
      requestType: 'input_required',
      permissionMetadata: { type: 'deferred_permission' },
    };

    expect(shouldClearInputRequiredForYolo(request)).toBe(true);
    expect(shouldClearRequestAfterYoloEnabled(request, 'inst-1')).toBe(true);
    expect(shouldClearRequestAfterYoloEnabled(request, 'inst-2')).toBe(false);
    expect(canResolveInputRequiredWithYolo(request)).toBe(true);
  });

  it('defaults permission-denial prompts to Always so the allow rule is written', () => {
    expect(defaultInputRequiredScope({ type: 'permission_denial' })).toBe('always');
    expect(defaultInputRequiredScope({ type: 'deferred_permission' })).toBe('once');
    expect(defaultInputRequiredScope(undefined)).toBe('once');
  });
});
