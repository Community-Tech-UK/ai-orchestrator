import { describe, expect, it } from 'vitest';
import { InstanceCreatePayloadSchema, InstanceCreateWithMessagePayloadSchema } from '../instance.schemas';

const schemas = [InstanceCreatePayloadSchema, InstanceCreateWithMessagePayloadSchema];
describe.each(schemas)('OpenCode extra-folder creation schema', (schema) => {
  const base = { workingDirectory: '/repo', message: 'work', provider: 'opencode' };
  it('keeps bounded absolute POSIX, drive and UNC directories intact', () => {
    const additionalDirectories = ['/repo/other', 'C:\\work\\second', '\\\\server\\share\\folder'];
    expect(schema.parse({ ...base, additionalDirectories })).toMatchObject({ additionalDirectories });
    expect(schema.safeParse({ ...base, additionalDirectories: Array.from({ length: 64 }, (_, i) => `/repo/${i}`) }).success).toBe(true);
  });
  it.each(['relative', '~/repo', 'C:relative', '\\rooted-only', '/repo/*', '/repo/?', '/repo/\0', '', '/' + 'x'.repeat(4096)])('rejects invalid directory %j', (directory) => {
    expect(schema.safeParse({ ...base, additionalDirectories: [directory] }).success).toBe(false);
  });
  it('rejects over-cap, nonarray and nonstring values', () => {
    for (const additionalDirectories of [Array(65).fill('/repo'), '/repo', [42], null]) {
      expect(schema.safeParse({ ...base, additionalDirectories }).success).toBe(false);
    }
  });
  it.each(['claude', 'codex', 'gemini', 'auto', undefined])('refuses nonempty folders for provider %s', (provider) => {
    expect(schema.safeParse({ ...base, provider, additionalDirectories: ['/other'] }).success).toBe(false);
    expect(schema.safeParse({ ...base, provider, additionalDirectories: [] }).success).toBe(true);
  });
});
