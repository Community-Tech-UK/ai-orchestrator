import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expectTypeOf } from 'vitest';
import type {
  MobileCreateInstanceRequest as CanonicalCreateRequest,
  MobileInstanceDto as CanonicalInstance,
  MobileMessagesResumeDto as CanonicalResume,
  MobileProjectDto as CanonicalProject,
  MobileReasoningEffort as CanonicalReasoningEffort,
} from './mobile-gateway.types';
import type {
  MobileCreateInstanceRequest as GatewayCreateRequest,
  MobileInstanceDto as GatewayInstance,
  MobileMessagesResumeDto as GatewayResume,
  MobileProjectDto as GatewayProject,
} from '../../../../src/shared/types/mobile-gateway.types';
import type {
  MobileCreateInstanceRequest as PhoneCreateRequest,
  MobileInstanceDto as PhoneInstance,
  MobileMessagesResumeDto as PhoneResume,
  MobileProjectDto as PhoneProject,
  MobileReasoningEffort as PhoneReasoningEffort,
} from '../../../../apps/mobile/src/app/core/models';

const root = resolve(import.meta.dirname, '../../../..');

describe('mobile gateway DTO ownership', () => {
  it('exposes identical DTOs through the desktop and phone entry points', () => {
    expectTypeOf<GatewayInstance>().toEqualTypeOf<CanonicalInstance>();
    expectTypeOf<PhoneInstance>().toEqualTypeOf<CanonicalInstance>();
    expectTypeOf<GatewayProject>().toEqualTypeOf<CanonicalProject>();
    expectTypeOf<PhoneProject>().toEqualTypeOf<CanonicalProject>();
    expectTypeOf<GatewayResume>().toEqualTypeOf<CanonicalResume>();
    expectTypeOf<PhoneResume>().toEqualTypeOf<CanonicalResume>();
    expectTypeOf<GatewayCreateRequest>().toEqualTypeOf<CanonicalCreateRequest>();
    expectTypeOf<PhoneCreateRequest>().toEqualTypeOf<CanonicalCreateRequest>();
    expectTypeOf<PhoneReasoningEffort>().toEqualTypeOf<CanonicalReasoningEffort>();
  });

  it('uses the dependency-free contracts module as the one DTO source', () => {
    const canonical = readFileSync(
      resolve(root, 'packages/contracts/src/types/mobile-gateway.types.ts'),
      'utf8',
    );
    const gatewayBridge = readFileSync(
      resolve(root, 'src/shared/types/mobile-gateway.types.ts'),
      'utf8',
    );
    const phoneBridge = readFileSync(
      resolve(root, 'apps/mobile/src/app/core/models.ts'),
      'utf8',
    );

    expect(canonical).not.toMatch(/^import\s/m);
    expect(gatewayBridge).toContain("from '@contracts/types/mobile-gateway'");
    expect(phoneBridge).toContain("from '@contracts/types/mobile-gateway'");
  });

  it('owns the replay cursor and current cross-surface fields centrally', () => {
    const canonical = readFileSync(
      resolve(root, 'packages/contracts/src/types/mobile-gateway.types.ts'),
      'utf8',
    );

    expect(canonical).toContain('seq?: number;');
    expect(canonical).toContain('export interface MobileMessagesResumeDto');
    expect(canonical).toContain('attentionLevel: MobileAttentionLevel;');
    expect(canonical).toContain('needsAttentionCount: number;');
    expect(canonical).toContain("| 'ultra'");
  });
});
