import { describe, expect, it, vi } from 'vitest';
import { createInitializedAgentHarness, TestAcpCliAdapter } from './acp-cli-adapter.test-helpers';
import { CompactionCoordinator } from '../../context/compaction-coordinator';
import { recordProviderThreadCompactionMarker, setCompactionMarkerRecorderForTesting } from '../../app/compaction-runtime';
import { recordCompactionMarker } from '../../persistence/rlm/rlm-compaction-markers';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import type { OutputMessage } from '../../../shared/types/instance.types';
function marker(shape: string, key = 'compact-1', status = 'completed') { return shape === 'standard' ? { sessionUpdate: 'compaction_update', compactionId: key, status } : { sessionUpdate: 'session_info_update', _meta: { 'opencode/compaction': { status, ...(shape === 'meta-unkeyed' ? {} : { compactionId: key }) } } }; }
async function run(shape: string, mode = 'success', repeat = false) {
    const db = defaultDriverFactory(':memory:');
    db.exec('CREATE TABLE session_compaction_markers(id TEXT PRIMARY KEY,instance_id TEXT,thread_id TEXT,project_key TEXT,method TEXT,created_at INTEGER,utilization_before REAL,utilization_after REAL,ledger_anchor INTEGER,metadata_json TEXT)');
    CompactionCoordinator._resetForTesting();
    setCompactionMarkerRecorderForTesting(params => recordCompactionMarker(db, params));
    const proc = createInitializedAgentHarness();
    const adapter = new TestAcpCliAdapter(proc, { command: 'acp-placeholder', workingDirectory: '/tmp', systemPrompt: 'fixture instructions', nativeCompaction: { command: '/compact', timeoutMs: 1000 }, promptTimeoutMs: 30 });
    adapter.configureOpenCodeV2(true);
    const output: OutputMessage[] = [];
    adapter.on('error', () => { });
    adapter.on('output', message => { output.push(message); if (message.metadata?.['threadCompacted'])
        recordProviderThreadCompactionMarker({ instanceId: 'fixture', provider: 'opencode', sessionId: adapter.getSessionId() ?? undefined, messageId: message.id, createdAt: message.timestamp, messageMetadata: message.metadata }); });
    try {
        proc.onRequest('session/prompt', request => proc.respond(request.id, { stopReason: 'end_turn' }));
        await adapter.spawn();
        await adapter.sendInput('ordinary first turn');
        const session = adapter.getSessionId();
        proc.notify('session/update', { sessionId: session, update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact' }] } });
        proc.onRequest('session/prompt', request => { expect(request.params).toMatchObject({ sessionId: session, prompt: [{ type: 'text', text: '/compact' }] }); setImmediate(() => { if (shape !== 'none') {
            proc.notify('session/update', { sessionId: session, update: marker(shape, 'compact-1', mode === 'provider-failed' ? 'failed' : 'completed') });
            if (repeat)
                proc.notify('session/update', { sessionId: session, update: marker(shape, 'compact-1', mode === 'provider-failed' ? 'failed' : 'completed') });
        } if (mode === 'rpc-error')
            proc.respondError(request.id, -32000, 'fixture failure');
        else if (mode === 'client-cancel')
            adapter.interrupt();
        else if (mode !== 'timeout')
            proc.respond(request.id, { stopReason: mode === 'cancelled' ? 'cancelled' : 'end_turn' }); }); });
        const fallback = vi.fn(async () => true);
        let native: boolean | undefined;
        const coordinator = CompactionCoordinator.getInstance();
        coordinator.configure({ nativeCompact: async () => native = await adapter.compactContext(), supportsNativeCompaction: () => true, restartCompact: fallback });
        const result = await coordinator.compactInstance('fixture');
        expect(native).toBe(mode === 'success');
        expect(result.method).toBe(mode === 'success' ? 'native' : 'restart-with-summary');
        expect(fallback).toHaveBeenCalledTimes(mode === 'success' ? 0 : 1);
        expect(adapter.getSessionId()).toBe(session);
        const completed = output.filter(message => message.metadata?.['threadCompacted']);
        expect.soft(completed).toHaveLength(mode === 'success' ? 1 : 0);
        expect(db.prepare('SELECT COUNT(*) AS count FROM session_compaction_markers').get()).toEqual({ count: mode === 'success' ? 1 : 0 });
        expect(adapter.listenerCount('output')).toBe(1);
        if (mode === 'provider-failed') {
            proc.onRequest('session/prompt', request => proc.respond(request.id, { stopReason: 'end_turn' }));
            expect(await adapter.compactContext()).toBe(true);
            expect(output.filter(message => message.metadata?.['threadCompacted'])).toHaveLength(1);
            expect(adapter.listenerCount('output')).toBe(1);
        }
    }
    finally {
        proc.exit();
        await adapter.terminate(false);
        setCompactionMarkerRecorderForTesting(null);
        CompactionCoordinator._resetForTesting();
        db.close();
    }
}
describe('native acknowledgement and provider marker share one production boundary', () => {
    it.each(['standard', 'meta'])('one supported %s marker produces one visible and durable boundary', shape => run(shape));
    it.each(['standard', 'meta'])('repeated keyed %s completion coalesces before the command acknowledgement', shape => run(shape, 'success', true));
    it.each(['standard', 'meta', 'meta-unkeyed'])('explicit %s provider failure must not be promoted by end_turn', shape => run(shape, 'provider-failed'));
    it('unkeyed meta completion still coalesces with the command acknowledgement', () => run('meta-unkeyed'));
    it('marker-free native success still records one boundary', () => run('none'));
    it.each(['rpc-error', 'timeout', 'cancelled', 'client-cancel'])('marker-free %s still uses summary fallback without native boundary', mode => run('none', mode));
});
describe('ordinary provider compaction identity stays independent of native acknowledgement', () => {
    it.each(['standard', 'meta'])('deduplicates keyed %s status per turn but preserves distinct compactions and later turns', async (shape) => {
        const proc = createInitializedAgentHarness();
        const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp' });
        adapter.configureOpenCodeV2(true);
        const output: OutputMessage[] = [];
        adapter.on('output', message => output.push(message));
        try {
            await adapter.spawn();
            proc.onRequest('session/prompt', request => { for (const key of ['first', 'second']) {
                proc.notify('session/update', { sessionId: adapter.getSessionId(), update: marker(shape, key) });
                proc.notify('session/update', { sessionId: adapter.getSessionId(), update: marker(shape, key) });
            } proc.respond(request.id, { stopReason: 'end_turn' }); });
            await adapter.sendMessage({ role: 'user', content: 'ordinary first' });
            expect(output.filter(message => message.metadata?.['threadCompacted'])).toHaveLength(2);
            await adapter.sendMessage({ role: 'user', content: 'ordinary second' });
            const completed = output.filter(message => message.metadata?.['threadCompacted']);
            expect(completed).toHaveLength(4);
            expect(new Set(completed.map(message => message.id)).size).toBe(4);
        }
        finally {
            proc.exit();
            await adapter.terminate(false);
        }
    });
});

it('ordinary unkeyed provider metadata emits a compaction notice without a protocol error',async()=>{
 const proc=createInitializedAgentHarness();const adapter=new TestAcpCliAdapter(proc,{workingDirectory:'/tmp'});adapter.configureOpenCodeV2(true);const output:OutputMessage[]=[];adapter.on('output',m=>output.push(m));
 try{await adapter.spawn();proc.notify('session/update',{sessionId:adapter.getSessionId(),update:marker('meta-unkeyed')});expect(output.filter(m=>m.metadata?.['threadCompacted'])).toHaveLength(1);expect(output.filter(m=>m.metadata?.['source']==='acp-protocol-error')).toHaveLength(0);}finally{proc.exit();await adapter.terminate(false);}
});
