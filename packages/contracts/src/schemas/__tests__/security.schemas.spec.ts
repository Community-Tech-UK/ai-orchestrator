import { describe, expect, it } from 'vitest';
import {
  SecurityDetectSecretsPayloadSchema,
  SecurityRedactContentPayloadSchema,
  SecurityCheckFilePayloadSchema,
  SecurityGetAuditLogPayloadSchema,
  SecurityCheckEnvVarPayloadSchema,
  SecuritySetPermissionPresetPayloadSchema,
  BashValidatePayloadSchema,
  BashCommandPayloadSchema,
} from '../security.schemas';

describe('security.schemas', () => {
  it('BashValidatePayloadSchema requires a command', () => {
    expect(() => BashValidatePayloadSchema.parse({})).toThrow();
  });

  it('exports all security-group schemas as Zod schemas', () => {
    const schemas = [
      SecurityDetectSecretsPayloadSchema, SecurityRedactContentPayloadSchema,
      SecurityCheckFilePayloadSchema, SecurityGetAuditLogPayloadSchema,
      SecurityCheckEnvVarPayloadSchema, SecuritySetPermissionPresetPayloadSchema,
      BashValidatePayloadSchema, BashCommandPayloadSchema,
    ];
    for (const schema of schemas) {
      expect(typeof schema.parse).toBe('function');
    }
  });
});
