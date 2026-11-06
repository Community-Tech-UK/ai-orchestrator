import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

/**
 * The daily Claude cost check only works if every link below is in place. Each module has its own
 * behavioural spec; this one fails if a registration point is removed, so the pieces cannot sit
 * unused. It reads source text on purpose: constructing the whole IPC handler needs ~100 modules.
 */
const read = (path: string): string => readFileSync(join(process.cwd(), path), 'utf8');

describe('Claude cost check wiring', () => {
  it('registers the handlers (which start the schedule and the shutdown cleanup) inside registerHandlers at startup', () => {
    const source = read('src/main/ipc/ipc-main-handler.ts');
    expect(source).toMatch(/registerClaudeCostReconcileHandlers,\n/);
    const body = source.slice(source.indexOf('registerHandlers(): void {'));
    expect(body).toContain('registerClaudeCostReconcileHandlers();');
    expect(read('src/main/ipc/handlers/index.ts')).toContain("export { registerClaudeCostReconcileHandlers } from './claude-cost-reconcile-handlers';");
    const startup = read('src/main/app/initialization-steps.ts');
    expect(startup).toContain('new IpcMainHandler(');
    expect(startup).toMatch(/\.registerHandlers\(\)/);
  });

  it('starts the schedule and registers shutdown cleanup from the handler registration itself', () => {
    const source = read('src/main/ipc/handlers/claude-cost-reconcile-handlers.ts');
    expect(source).toContain('service.start();');
    expect(source).toMatch(/registerCleanup\(\(\) => service\.shutdown\(\)\)/);
  });

  it('exposes the channels to the renderer and shows the panel on the Costs page', () => {
    expect(read('packages/contracts/src/channels/index.ts')).toContain('...CLAUDE_COST_RECONCILE_CHANNELS,');
    expect(read('src/preload/preload.ts')).toContain('...createClaudeCostReconcileDomain(ipcRenderer, IPC_CHANNELS),');
    expect(read('src/preload/generated/channels.ts')).toContain("CLAUDE_COST_RECONCILE_GET: 'claude-cost-reconcile:get'");
    expect(read('src/renderer/app/features/cost/cost-page.component.html')).toContain('<app-claude-cost-drift />');
    expect(read('src/renderer/app/features/cost/cost-page.component.ts')).toMatch(/imports: \[[^\]]*ClaudeCostDriftComponent/);
  });
});
