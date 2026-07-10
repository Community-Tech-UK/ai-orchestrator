import { describe, expect, it } from 'vitest';

import { BUILTIN_AGENTS, getAgentById, getDefaultAgent } from '../agent.types';

describe('agent.types', () => {
  it('gives Build mode a quality contract for normal coding sessions', () => {
    const build = getDefaultAgent();

    expect(build.id).toBe('build');
    expect(build.systemPrompt).toEqual(expect.stringContaining('Use the existing architecture and idioms.'));
    expect(build.systemPrompt).toEqual(expect.stringContaining('Before claiming completion, run appropriate verification'));
    expect(build.systemPrompt).toEqual(expect.stringContaining('fresh review pass of your own changes'));
    expect(build.systemPrompt).not.toEqual(expect.stringContaining('Loop Mode / fresh-eyes review'));
  });

  it('defines an exact fence-free mode-switch marker protocol for Plan mode', () => {
    const plan = getAgentById('plan')!;
    expect(plan.systemPrompt).toContain('on their own lines');
    expect(plan.systemPrompt).toContain('no code fence');
    expect(plan.systemPrompt).toContain('never mention or quote these markers');
  });

  describe('observer profile (E12)', () => {
    it('is present in BUILTIN_AGENTS', () => {
      const observer = BUILTIN_AGENTS.find((a) => a.id === 'observer');
      expect(observer).toBeDefined();
    });

    it('is retrievable via getAgentById', () => {
      const observer = getAgentById('observer');
      expect(observer).toBeDefined();
      expect(observer!.id).toBe('observer');
    });

    it('has mode "observer"', () => {
      const observer = getAgentById('observer')!;
      expect(observer.mode).toBe('observer');
    });

    it('is read-only: write, bash, web, and task are denied', () => {
      const observer = getAgentById('observer')!;
      expect(observer.permissions.read).toBe('allow');
      expect(observer.permissions.write).toBe('deny');
      expect(observer.permissions.bash).toBe('deny');
      expect(observer.permissions.web).toBe('deny');
      expect(observer.permissions.task).toBe('deny');
    });

    it('system prompt restricts observer to visual/attachment summarisation only', () => {
      const observer = getAgentById('observer')!;
      expect(observer.systemPrompt).toEqual(expect.stringContaining('OBSERVER MODE'));
      expect(observer.systemPrompt).toEqual(expect.stringContaining('images'));
      expect(observer.systemPrompt).toEqual(expect.stringContaining('PDFs'));
      expect(observer.systemPrompt).toEqual(expect.stringContaining('Do NOT write or edit any files'));
    });

    it('is marked builtin', () => {
      const observer = getAgentById('observer')!;
      expect(observer.builtin).toBe(true);
    });
  });
});
