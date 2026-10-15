import { describe, expect, it, vi } from 'vitest';
import { startCodexThread, resumeCodexThread } from './codex-thread-requests';
const policy={level:'off' as const,config:{'agents.enabled':false},outputLimit:4000,postTurnCompactPercent:60};
describe('Codex thread request policy transport',()=>{
  it('applies to starts/resumes and only drops config on an unsupported policy rejection',async()=>{
    const request=vi.fn().mockRejectedValueOnce(new Error('unknown field config')).mockResolvedValue({threadId:'thread'});
    await startCodexThread({request}, {cwd:'/repo'}, policy);
    expect(request.mock.calls[0][1]).toMatchObject({config:{'agents.enabled':false}});expect(request.mock.calls[1][1]).not.toHaveProperty('config');
    request.mockClear();await resumeCodexThread({request},{threadId:'thread'},policy);expect(request.mock.calls[0][1]).toMatchObject({config:{'agents.enabled':false},excludeTurns:true});
    const rejected=vi.fn().mockRejectedValue(new Error('connection closed'));
    await expect(startCodexThread({request:rejected},{cwd:'/repo'},policy)).rejects.toThrow('connection closed');expect(rejected).toHaveBeenCalledTimes(1);
  });
});
