import { describe, expect, it } from 'vitest';

import { getDefaultAgent } from '../agent.types';

describe('agent.types', () => {
  it('gives Build mode a quality contract for normal coding sessions', () => {
    const build = getDefaultAgent();

    expect(build.id).toBe('build');
    expect(build.systemPrompt).toEqual(expect.stringContaining('Use the existing architecture and idioms.'));
    expect(build.systemPrompt).toEqual(expect.stringContaining('Before claiming completion, run appropriate verification'));
    expect(build.systemPrompt).toEqual(expect.stringContaining('fresh review pass of your own changes'));
    expect(build.systemPrompt).toEqual(expect.stringContaining('Loop Mode / fresh-eyes review'));
  });
});
