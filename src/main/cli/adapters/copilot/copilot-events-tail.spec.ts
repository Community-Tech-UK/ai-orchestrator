import { afterEach, describe, expect, it } from 'vitest';
import { appendFile, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CopilotEventsTail } from './copilot-events-tail';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const event = (type: string, data: unknown, agentId?: string) => JSON.stringify({ type, data, agentId }) + '\n';
async function fixture() {
  const home = await mkdtemp(join(process.cwd(), '_scratch', 'step11-numeric-')); roots.push(home);
  const dir = join(home, 'session-state', 'session-1'); await mkdir(dir, { recursive: true });
  const file = join(dir, 'events.jsonl');
  return { home, dir, file, tail: new CopilotEventsTail(home, 'session-1') };
}

describe('Copilot account-scoped numeric events tail', () => {
  it('projects only allowed numeric events and retries a partial line without retaining its body', async () => {
    const { file, tail } = await fixture();
    const usage = event('session.usage_record', { usage: { cost: 15, maxPromptTokens: 1000 }, content: 'SYNTHETIC_PRIVATE_BODY' });
    await writeFile(file, event('assistant.message', { cost: 999, content: 'SYNTHETIC_PRIVATE_BODY' }) + usage.slice(0, -2));
    expect(await tail.poll()).toEqual({ compactions: 0 });
    expect(JSON.stringify(tail)).not.toContain('SYNTHETIC_PRIVATE_BODY');
    await appendFile(file, usage.slice(-2));
    expect(await tail.poll()).toEqual({ premiumRequests: 15, tokenLimit: 1000, compactions: 0 });
    expect(await tail.poll()).toEqual({ premiumRequests: 15, tokenLimit: 1000, compactions: 0 });
    await appendFile(file, event('session.usage_checkpoint', { accountingSnapshot: { totalPremiumRequestCost: 17 } })
      + event('session.compaction_complete', { success: true, postCompactionTokens: 950, summaryContent: 'SYNTHETIC_PRIVATE_BODY' }));
    expect(await tail.poll()).toEqual({ premiumRequests: 17, tokenLimit: 1000, compactions: 1, postCompactionTokens: 950 });
    expect(JSON.stringify(tail)).not.toContain('SYNTHETIC_PRIVATE_BODY');
  });

  it('counts helper charges without letting helpers replace root occupancy or session totals', async () => {
    const { file, tail } = await fixture();
    await writeFile(file, event('session.usage_record', { usage: { cost: 1, maxPromptTokens: 1000 } })
      + event('session.usage_record', { usage: { cost: 2, maxPromptTokens: 10 } }, 'helper')
      + event('session.compaction_complete', { success: true, postCompactionTokens: 999 }, 'helper')
      + event('session.shutdown', { totalPremiumRequests: 100 }, 'helper'));
    expect(await tail.poll()).toEqual({ premiumRequests: 3, tokenLimit: 1000, compactions: 0 });
  });

  it('resets on truncation, replacement and same-size rewrites', async () => {
    const { file, tail } = await fixture();
    await writeFile(file, event('session.shutdown', { totalPremiumRequests: 2 }));
    expect((await tail.poll()).premiumRequests).toBe(2);
    await writeFile(file, event('session.shutdown', { totalPremiumRequests: 7 }));
    expect((await tail.poll()).premiumRequests).toBe(7);
    await rename(file, file + '.old');
    await writeFile(file, event('session.usage_checkpoint', { totalPremiumRequests: 1 }));
    expect(await tail.poll()).toEqual({ compactions: 0, premiumRequests: 1 });
  });

  it('bounds each poll and skips oversized lines without accepting a valid-looking suffix', async () => {
    const { file, tail } = await fixture();
    await writeFile(file, 'x'.repeat(1024 * 1024) + event('session.shutdown', { totalPremiumRequests: 999 })
      + event('session.shutdown', { totalPremiumRequests: 4 }));
    expect((await tail.poll()).premiumRequests).toBeUndefined();
    for (let i = 0; i < 20; i++) await tail.poll();
    expect((await tail.poll()).premiumRequests).toBe(4);
  });

  it('rejects traversal and symlinks escaping the exact account session', async () => {
    const { home, dir, file, tail } = await fixture();
    expect(() => new CopilotEventsTail(home, '../other')).toThrow();
    const elsewhere = await mkdtemp(join(process.cwd(), '_scratch', 'step11-other-')); roots.push(elsewhere);
    await writeFile(join(elsewhere, 'events.jsonl'), event('session.shutdown', { totalPremiumRequests: 99 }));
    await rm(dir, { recursive: true }); await symlink(elsewhere, dir);
    await expect(tail.poll()).rejects.toThrow('containment');
    await rm(dir); await mkdir(dir); await symlink(join(elsewhere, 'events.jsonl'), file);
    await expect(tail.poll()).rejects.toThrow('containment');
  });

  it('does not invent zero from malformed counters or unsuccessful compactions', async () => {
    const { file, tail } = await fixture();
    await writeFile(file, event('session.usage_record', { usage: { cost: '15', maxPromptTokens: -1 } })
      + event('session.compaction_complete', { success: false, postCompactionTokens: 950 }));
    expect(await tail.poll()).toEqual({ compactions: 0 });
    await appendFile(file, event('session.shutdown', { totalPremiumRequests: 0 }));
    expect((await tail.poll()).premiumRequests).toBe(0);
  });

  it('rejects an event explicitly bound to a different session', async () => {
    const { file, tail } = await fixture();
    await writeFile(file, JSON.stringify({ type: 'session.shutdown', sessionId: 'other-session', data: { totalPremiumRequests: 999 } }) + '\n');
    expect(await tail.poll()).toEqual({ compactions: 0 });
  });

  it('keeps overflow unavailable until an authoritative session total repairs it', async () => {
    const { file, tail } = await fixture();
    await writeFile(file, event('session.usage_record', { usage: { cost: Number.MAX_VALUE } }).repeat(2)
      + event('session.usage_record', { usage: { cost: 1 } }));
    expect((await tail.poll()).premiumRequests).toBeUndefined();
    await appendFile(file, event('session.usage_checkpoint', { totalPremiumRequests: 20 }));
    expect((await tail.poll()).premiumRequests).toBe(20);
  });
});
