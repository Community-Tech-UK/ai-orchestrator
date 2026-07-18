import { describe, expect, it } from 'vitest';
import { CodexCliAdapter } from './codex-cli-adapter';
import { CodexBaseAdapter } from './codex-base-adapter';
import { CodexExecAdapter } from './codex-exec-adapter';
import { CodexAppServerAdapter } from './codex-app-server-adapter';

describe('CodexBaseAdapter', () => {
  it('is the shared base for the public Codex adapter facade', () => {
    expect(new CodexCliAdapter()).toBeInstanceOf(CodexBaseAdapter);
  });

  it('layers the public facade over the exec fallback implementation', () => {
    expect(new CodexCliAdapter()).toBeInstanceOf(CodexExecAdapter);
  });

  it('layers app-server behavior over the exec fallback', () => {
    expect(new CodexCliAdapter()).toBeInstanceOf(CodexAppServerAdapter);
  });
});
