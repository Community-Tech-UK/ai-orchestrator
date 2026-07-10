import { describe, expect, it } from 'vitest';

import { buildToolPermissionPrompt } from './tool-permission-prompt';

describe('buildToolPermissionPrompt', () => {
  it('describes direct tool use without inventing approval failures in YOLO mode', () => {
    const prompt = buildToolPermissionPrompt(true);

    expect(prompt).toContain('[Tool Permissions]');
    expect(prompt).toContain('pre-approved');
    expect(prompt).toContain('use it directly');
    expect(prompt).toContain('Treat other tool failures as real errors');
    expect(prompt).not.toContain('request approval');
  });

  it('preserves explicit approval and denial semantics outside YOLO mode', () => {
    const prompt = buildToolPermissionPrompt(false);

    expect(prompt).toContain('[Tool Permissions]');
    expect(prompt).toContain('current tool policy');
    expect(prompt).toContain('approval is required');
    expect(prompt).toContain('denied');
    expect(prompt).toContain('Treat other tool failures as real errors');
    expect(prompt).not.toContain('pre-approved');
  });
});
