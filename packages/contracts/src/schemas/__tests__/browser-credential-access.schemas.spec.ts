import { describe, expect, it } from 'vitest';
import * as browserSchemas from '../browser.schemas';
import { MAX_REMEMBER_CREDENTIAL_ACCESS_MS } from '../browser-credential-access.schemas';
import type { ZodType } from 'zod';

const schemas = browserSchemas as unknown as Record<string, ZodType>;
const request = { profileId: 'profile-placeholder', targetId: 'target-placeholder', item: 'Saved test login', reason: 'Sign in for this task' };

describe('credential access contracts', () => {
  it('offers a strict task request without caller-authored identity or permission', () => {
    const schema = schemas['BrowserRequestCredentialAccessSchema'];
    expect(schema).toBeDefined();
    expect(schema.safeParse(request).success).toBe(true);
    for (const extra of [{ instanceId: 'someone-else' }, { taskScope: 'other-task' }, { permission: 'remember' }, { origin: 'https://different.example' }, { moveIntoFolder: true }]) {
      expect(schema.safeParse({ ...request, ...extra }).success).toBe(false);
    }
    expect(schema.safeParse({ ...request, purposes: ['secret_fill'] }).success).toBe(false);
  });

  it('requires an explicit bounded duration for remembered access', () => {
    const schema = schemas['BrowserCredentialAccessChoiceSchema'];
    expect(schema).toBeDefined();
    expect(schema.safeParse({ permission: 'task' }).success).toBe(true);
    expect(schema.safeParse({ permission: 'remember' }).success).toBe(false);
    expect(schema.safeParse({ permission: 'remember', rememberForMs: 86_400_000 }).success).toBe(true);
    expect(schema.safeParse({ permission: 'remember', rememberForMs: 8 * 86_400_000 }).success).toBe(true);
    expect(schema.safeParse({ permission: 'remember', rememberForMs: MAX_REMEMBER_CREDENTIAL_ACCESS_MS }).success).toBe(true);
    expect(schema.safeParse({ permission: 'remember', rememberForMs: MAX_REMEMBER_CREDENTIAL_ACCESS_MS + 1 }).success).toBe(false);
    expect(schema.safeParse({ permission: 'task', rememberForMs: 86_400_000 }).success).toBe(false);
  });
});
