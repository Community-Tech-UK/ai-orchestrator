import { describe, it, expect } from 'vitest';
import { CursorCliAdapter } from '../cursor-cli-adapter';

describe('CursorCliAdapter — identity', () => {
  it('getName returns cursor-cli', () => {
    expect(new CursorCliAdapter({}).getName()).toBe('cursor-cli');
  });
  it('getCapabilities declares streaming + multiTurn + sandbox-appropriate caps', () => {
    const caps = new CursorCliAdapter({}).getCapabilities();
    expect(caps).toMatchObject({
      streaming: true, toolUse: true, multiTurn: true,
      codeExecution: true, vision: false,
      outputFormats: ['text', 'json', 'stream-json'],
    });
  });
  it('getRuntimeCapabilities declares supportsResume: true', () => {
    const caps = new CursorCliAdapter({}).getRuntimeCapabilities();
    expect(caps.supportsResume).toBe(true);
    expect(caps.supportsPermissionPrompts).toBe(false);
  });
});

describe('CursorCliAdapter — buildArgs baseline', () => {
  it('includes -p, --output-format stream-json, --force, --sandbox disabled', () => {
    const adapter = new CursorCliAdapter({});
    const args = (adapter as unknown as { buildArgs: (m: { content: string }) => string[] })
      .buildArgs({ content: 'hi' });
    expect(args).toEqual(expect.arrayContaining([
      '-p', '--output-format', 'stream-json',
      '--force', '--sandbox', 'disabled',
    ]));
  });

  it('positional prompt appears at the end', () => {
    const adapter = new CursorCliAdapter({});
    const args = (adapter as unknown as { buildArgs: (m: { content: string }) => string[] })
      .buildArgs({ content: 'hello' });
    expect(args[args.length - 1]).toBe('hello');
  });
});
