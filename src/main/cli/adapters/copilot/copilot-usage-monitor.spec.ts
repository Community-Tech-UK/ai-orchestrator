import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CopilotUsageMonitor } from './copilot-usage-monitor';
import { copilotNeedsContextRecycle, type CopilotNumericUsage } from '../../../../shared/utils/copilot-usage';

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe('Copilot usage monitor', () => {
  it('uses the current session only, and stops publishing after teardown', async () => {
    const home = await mkdtemp(join(process.cwd(), '_scratch', 'step11-monitor-')); roots.push(home);
    for (const id of ['first', 'second']) await mkdir(join(home, 'session-state', id), { recursive: true });
    const file = (id: string) => join(home, 'session-state', id, 'events.jsonl');
    await writeFile(file('first'), JSON.stringify({ type: 'session.shutdown', data: { totalPremiumRequests: 15 } }) + '\n');
    await writeFile(file('second'), JSON.stringify({ type: 'session.shutdown', data: { totalPremiumRequests: 1 } }) + '\n');
    const published: (CopilotNumericUsage | undefined)[] = [];
    const monitor = new CopilotUsageMonitor(home, usage => published.push(usage));
    monitor.start('first'); await monitor.refresh();
    expect(monitor.snapshot()?.premiumRequests).toBe(15);
    monitor.start('second'); await monitor.refresh();
    expect(monitor.snapshot()?.premiumRequests).toBe(1);
    monitor.stop(); const count = published.length;
    await appendFile(file('second'), JSON.stringify({ type: 'session.shutdown', data: { totalPremiumRequests: 99 } }) + '\n');
    await monitor.refresh();
    expect(published).toHaveLength(count);
  });

  it.each([[900, false], [901, true], [0, false], [Infinity, false]])('recycles only proven root compaction above 90%%: %s', (tokens, expected) => {
    expect(copilotNeedsContextRecycle({ compactions: 1, postCompactionTokens: tokens, tokenLimit: 1000 })).toBe(expected);
    expect(copilotNeedsContextRecycle({ compactions: 0, postCompactionTokens: tokens, tokenLimit: 1000 })).toBe(false);
  });
});
