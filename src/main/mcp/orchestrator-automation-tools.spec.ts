/**
 * MCP automation tool arg schemas.
 *
 * These exist for one reason (LT-031): the MCP write path does **not** validate
 * against `AutomationCreatePayloadSchema` the way the IPC path does
 * (`automation-handlers.ts`). It writes straight through. So any arg bound that
 * is looser than the entity/event bound produces a value that saves
 * successfully and then fails `AutomationChangedEventSchema`, at which point
 * `validateRendererEventPayload` drops the `automation:changed` event and the
 * Automations UI silently keeps showing the stale automation.
 *
 * That is not hypothetical — it happened live on 2026-08-01 with `description`
 * (2000 write cap vs 1000 event cap). These tests pin the bounds that must stay
 * in agreement.
 */

import { describe, expect, it } from 'vitest';
import {
  CreateAutomationArgsSchema,
  UpdateAutomationArgsSchema,
} from './orchestrator-automation-tools';
import { AutomationSchema } from '@contracts/schemas/automation';

const baseCreate = {
  name: 'Nightly check',
  prompt: 'Run the nightly check',
  cron: '0 2 * * *',
};

describe('MCP automation arg bounds agree with the entity/event bounds (LT-031)', () => {
  /**
   * `workingDirectory` allowed 10_000 here against a 1_000 entity bound
   * (`WorkingDirectorySchema`, reached via `AutomationSchema.action`). A path
   * that long exceeds PATH_MAX on every supported platform, so the arg schema
   * was tightened to the shared bound rather than the entity bound loosened.
   */
  it('rejects a workingDirectory the entity schema would reject', () => {
    const tooLong = `/${'d'.repeat(1_200)}`;

    expect(CreateAutomationArgsSchema.safeParse({
      ...baseCreate,
      workingDirectory: tooLong,
    }).success).toBe(false);

    expect(UpdateAutomationArgsSchema.safeParse({
      id: '11111111-2222-4333-8444-555555555555',
      workingDirectory: tooLong,
    }).success).toBe(false);
  });

  it('still accepts a realistic absolute working directory', () => {
    const real = '/Users/someone/work/orchestrat0r/ai-orchestrator';

    expect(CreateAutomationArgsSchema.safeParse({
      ...baseCreate,
      workingDirectory: real,
    }).success).toBe(true);
  });

  /**
   * The description case that actually fired. The arg cap is 2000; the shared
   * entity cap is now 8000, so anything the write path accepts can also be
   * broadcast. This asserts the *relationship*, not a magic number.
   */
  it('accepts every description the write path allows, at the entity schema too', () => {
    const atWriteCap = 'x'.repeat(2_000);

    expect(CreateAutomationArgsSchema.safeParse({
      ...baseCreate,
      description: atWriteCap,
    }).success).toBe(true);

    // The same value must survive the schema the renderer event is validated
    // against. Asserted on the field shape rather than a full entity fixture, so
    // this pins the BOUND RELATIONSHIP and cannot rot when unrelated required
    // fields are added to AutomationSchema.
    expect(AutomationSchema.shape.description.safeParse(atWriteCap).success).toBe(true);
  });
});
