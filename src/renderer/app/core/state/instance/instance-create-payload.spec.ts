import { describe, expect, it } from 'vitest';
import { buildCreateWithMessagePayload } from './instance-create-payload';

describe('buildCreateWithMessagePayload', () => {
  it('marks the first message as typed by a person only when the composer says so', () => {
    const typed = buildCreateWithMessagePayload({ message: 'hello', workingDirectory: '/repo', typedByPerson: true }, undefined, undefined);
    expect(typed.origin).toEqual({ kind: 'person', typedAt: expect.any(Number) });

    const untyped = buildCreateWithMessagePayload({ message: 'hello', workingDirectory: '/repo' }, undefined, undefined);
    expect(untyped).not.toHaveProperty('origin');
    expect(untyped).not.toHaveProperty('typedByPerson');
  });
});
