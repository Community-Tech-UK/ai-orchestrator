import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlobalPauseService } from '../global-pause/global-pause-service';
import { SessionAdmissionService } from './session-admission-service';

vi.mock('../persistence/rlm-database', () => ({ getRLMDatabase: () => { throw new Error('No audit database in this focused runtime test'); } }));

describe('session admission during a global pause', () => {
  afterEach(() => { vi.restoreAllMocks(); SessionAdmissionService._resetForTesting(); });
  it('keeps direct orchestration writes held through idle edges and replays them on release', () => {
    let held = true;
    vi.spyOn(GlobalPauseService, 'peek').mockReturnValue({ holdsAutomaticInput: () => held } as unknown as GlobalPauseService);
    const host = Object.assign(new EventEmitter(), { getInstance: () => ({ status: 'idle' as const }) });
    const service = SessionAdmissionService.getInstance(); service.setInstanceManager(host);
    const delivered = vi.fn(); service.registerRedeliveryHandler('orchestration', delivered);
    expect(service.admitAutomatedWrite({ instanceId: 'chat', origin: 'orchestration', message: 'Child report' }).kind).toBe('suppressed');
    host.emit('instance:state-update', { instanceId: 'chat', status: 'idle' });
    expect(delivered).not.toHaveBeenCalled();
    held = false; service.refireHeldWrites();
    expect(delivered).toHaveBeenCalledTimes(1);
    service.refireHeldWrites(); expect(delivered).toHaveBeenCalledTimes(1);
  });
});
