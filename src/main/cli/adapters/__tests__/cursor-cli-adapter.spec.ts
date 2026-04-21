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

describe('CursorCliAdapter — buildArgs per-flag rules', () => {
  interface BuildArgsSpy {
    buildArgs: (m: { content: string }) => string[];
    cursorSessionId: string | null;
    partialOutputSupported: boolean;
  }

  it('omits --model when cliConfig.model is undefined', () => {
    const adapter = new CursorCliAdapter({});
    const args = (adapter as unknown as BuildArgsSpy).buildArgs({ content: 'x' });
    expect(args).not.toContain('--model');
  });
  it("omits --model when cliConfig.model === 'auto'", () => {
    const adapter = new CursorCliAdapter({ model: 'auto' });
    const args = (adapter as unknown as BuildArgsSpy).buildArgs({ content: 'x' });
    expect(args).not.toContain('--model');
  });
  it("omits --model when cliConfig.model === 'AUTO' (case-insensitive)", () => {
    const adapter = new CursorCliAdapter({ model: 'AUTO' });
    const args = (adapter as unknown as BuildArgsSpy).buildArgs({ content: 'x' });
    expect(args).not.toContain('--model');
  });
  it('includes --model when concrete value set', () => {
    const adapter = new CursorCliAdapter({ model: 'claude-sonnet-4-6' });
    const args = (adapter as unknown as BuildArgsSpy).buildArgs({ content: 'x' });
    expect(args).toContain('--model');
    expect(args).toContain('claude-sonnet-4-6');
  });
  it('prepends systemPrompt with blank-line separator', () => {
    const adapter = new CursorCliAdapter({ systemPrompt: 'SYS' });
    const args = (adapter as unknown as BuildArgsSpy).buildArgs({ content: 'user' });
    expect(args[args.length - 1]).toBe('SYS\n\nuser');
  });
  it('includes --resume <id> when cursorSessionId is set', () => {
    const adapter = new CursorCliAdapter({});
    (adapter as unknown as BuildArgsSpy).cursorSessionId = 'sess-123';
    const args = (adapter as unknown as BuildArgsSpy).buildArgs({ content: 'x' });
    const resumeIdx = args.indexOf('--resume');
    expect(resumeIdx).toBeGreaterThan(-1);
    expect(args[resumeIdx + 1]).toBe('sess-123');
  });
  it('omits --stream-partial-output when feature flag cleared', () => {
    const adapter = new CursorCliAdapter({});
    (adapter as unknown as BuildArgsSpy).partialOutputSupported = false;
    const args = (adapter as unknown as BuildArgsSpy).buildArgs({ content: 'x' });
    expect(args).not.toContain('--stream-partial-output');
  });
});
