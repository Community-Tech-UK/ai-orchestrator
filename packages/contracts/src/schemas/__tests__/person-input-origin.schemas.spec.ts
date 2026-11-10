import { describe, expect, it } from 'vitest';
import { InstanceSendInputPayloadSchema } from '../instance.schemas';
import { LoopInterveneePayloadSchema, LoopStartPayloadSchema } from '../loop.schemas';
import { SessionForkPayloadSchema } from '../session.schemas';

// Zod drops keys it does not know, so a payload whose schema lacks the field
// would silently lose the marker and the message would no longer count as typed.
describe('typed-by-a-person marker on IPC payloads', () => {
  const origin = { kind: 'person' as const, typedAt: 42 };
  const loopConfig = LoopStartPayloadSchema.shape.config.parse({ initialPrompt: 'goal', workspaceCwd: '/repo' });

  it.each([
    ['send input', InstanceSendInputPayloadSchema, { instanceId: 'inst-1', message: 'hi', origin }, 'origin'],
    ['edit and resend', SessionForkPayloadSchema, { instanceId: 'inst-1', initialPrompt: 'edited', initialPromptOrigin: origin }, 'initialPromptOrigin'],
    ['loop start', LoopStartPayloadSchema, { chatId: 'inst-1', config: loopConfig, origin }, 'origin'],
    ['loop hint', LoopInterveneePayloadSchema, { loopRunId: 'loop-1', message: 'hint', origin }, 'origin'],
  ] as const)('keeps the marker on %s', (_label, schema, payload, key) => {
    expect((schema.parse(payload) as Record<string, unknown>)[key]).toEqual(origin);
  });

  it.each([
    { kind: 'harness', typedAt: 42 },
    { kind: 'person', typedAt: 0 },
    { kind: 'person', typedAt: 42, extra: true },
  ])('refuses a malformed marker %j', (bad) => {
    expect(LoopInterveneePayloadSchema.safeParse({ loopRunId: 'loop-1', message: 'hint', origin: bad }).success).toBe(false);
    expect(SessionForkPayloadSchema.safeParse({ instanceId: 'inst-1', initialPromptOrigin: bad }).success).toBe(false);
  });
});
