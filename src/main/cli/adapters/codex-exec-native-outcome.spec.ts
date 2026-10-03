import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { CodexCliAdapter } from './codex-cli-adapter';
import { getLogManager } from '../../logging/logger';
function nativeFixture(mode: 'answer' | 'provider-error' | 'silent', code = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-exec-control-'));
  const path = join(dir, 'fixture.cjs');
  writeFileSync(path, String.raw`let prompt = ''; process.stdin.on('data', chunk => prompt += chunk); process.stdin.on('end', () => {
    process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'LOCAL_ACCEPTED_THREAD'})+'\n');
    process.stderr.write('LOCAL_ACCEPTED_BYTES='+Buffer.byteLength(prompt)+'\n');
    const mode = ` + JSON.stringify(mode) + String.raw`;
    if (mode === 'silent') { setInterval(() => {}, 1000); return; }
    process.stdout.write(JSON.stringify(mode === 'answer' ? {type:'item.completed',item:{type:'agent_message',text:'LOCAL_NATIVE_ANSWER'}} : {type:'turn.failed',error:{message:'LOCAL_PROVIDER_FAILURE'}})+'\n');
    process.exitCode = ` + code + String.raw`; });`);
  const adapter = new CodexCliAdapter({ workingDir: dir, timeout: 500 });
  Object.assign(adapter, { useAppServer: false, isSpawned: true });
  const access = adapter as unknown as {
    config: {
      command: string;
      args: string[];
    };
    spawnProcess(args: string[]): ChildProcess;
    process: ChildProcess | null;
  };
  access.config.command = process.execPath;
  access.config.args = [path];
  const spawn = access.spawnProcess.bind(adapter);
  const children: ChildProcess[] = [];
  let stderr = '';
  access.spawnProcess = args => { const child = spawn(args); children.push(child); child.stderr!.on('data', chunk => { stderr += chunk.toString(); }); return child; };
  adapter.on('error', () => { /* Keep native EventEmitter errors observed during fixture cleanup. */ });
  return { adapter, access, children, stderr: () => stderr, cleanup: async () => { await adapter.terminate(false); rmSync(dir, { recursive: true, force: true }); } };
}
it.each([0, 7])('accepted real child retains exact answer/thread for native exit %s', async (code) => {
  getLogManager().updateConfig({ enableConsole: false, enableFile: false });
  const native = nativeFixture('answer', code);
  try {
    const response = await native.adapter.sendMessage({ role: 'user', content: 'LOCAL_PROMPT' });
    expect(native.stderr()).toContain('LOCAL_ACCEPTED_BYTES=12');
    expect(native.children).toHaveLength(1);
    expect(native.children[0].exitCode).toBe(code);
    expect(response.content).toBe('LOCAL_NATIVE_ANSWER');
    expect(native.adapter.getSessionId()).toBe('LOCAL_ACCEPTED_THREAD');
  }
  finally {
    await native.cleanup();
  }
});
it('accepted real native provider error retains existing retry count and original message', async () => {
  const native = nativeFixture('provider-error', 1);
  try {
    await expect(native.adapter.sendMessage({ role: 'user', content: 'LOCAL_PROMPT' })).rejects.toThrow('LOCAL_PROVIDER_FAILURE');
    expect(native.children).toHaveLength(2);
    expect(native.children.every(child => child.exitCode === 1)).toBe(true);
    expect(native.stderr().match(/LOCAL_ACCEPTED_BYTES=12/g)).toHaveLength(2);
    expect(native.adapter.getSessionId()).not.toBe('LOCAL_ACCEPTED_THREAD');
  }
  finally {
    await native.cleanup();
  }
});
it('accepted real ordinary Stop terminates native silence without a second prompt or late output/status', async () => {
  const native = nativeFixture('silent');
  const statuses: string[] = [];
  const complete = vi.fn();
  const errors = vi.fn();
  const outputs = vi.fn();
  native.adapter.on('status', status => statuses.push(status));
  native.adapter.on('complete', complete);
  native.adapter.on('turn_error', errors);
  native.adapter.on('output', outputs);
  try {
    const pending = native.adapter.sendInput('LOCAL_PROMPT').then(() => ({ status: 'fulfilled' as const }), error => ({ status: 'rejected' as const, error }));
    await vi.waitFor(() => expect(native.stderr()).toContain('LOCAL_ACCEPTED_BYTES=12'));
    expect(native.adapter.interrupt().status).toBe('accepted');
    const result = await pending;
    expect(native.children[0].signalCode).toBe('SIGINT');
    expect(native.children[0].exitCode).toBeNull();
    expect(native.children).toHaveLength(1);
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected')
      expect(result.error.name).toBe('AbortError');
    expect(complete).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    expect(outputs).not.toHaveBeenCalled();
    expect(statuses).toEqual(['busy']);
  }
  finally {
    await native.cleanup();
  }
});
it.each(['partial-timeout', 'meaningful-stop'] as const)('accepted actual child preserves native %s response', async (scenario) => {
  getLogManager().updateConfig({ enableConsole: false, enableFile: false });
  const dir = mkdtempSync(join(tmpdir(), 'codex-exec-positive-'));
  const file = join(dir, 'fixture.cjs');
  writeFileSync(file, String.raw`let prompt='';process.stdin.on('data',chunk=>prompt+=chunk);process.stdin.on('end',()=>{process.stderr.write('LOCAL_ACK='+Buffer.byteLength(prompt)+'\n');process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'LOCAL_POSITIVE_THREAD'})+'\n');const emit=()=>process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'LOCAL_POSITIVE_ANSWER'}})+'\n');` + (scenario === 'partial-timeout' ? `emit();setInterval(()=>{},1000);` : `const timer=setInterval(()=>{},1000);process.on('SIGINT',()=>{emit();clearInterval(timer);});`) + `});`);
  const adapter = new CodexCliAdapter({ workingDir: dir, timeout: scenario === 'partial-timeout' ? 200 : 1000 });
  Object.assign(adapter, { useAppServer: false, isSpawned: true });
  const access = adapter as unknown as {
    config: {
      command: string;
      args: string[];
    };
    spawnProcess(args: string[]): ChildProcess;
  };
  access.config.command = process.execPath;
  access.config.args = [file];
  const spawn = access.spawnProcess.bind(adapter);
  const children: ChildProcess[] = [];
  let stderr = '';
  access.spawnProcess = args => { const child = spawn(args); children.push(child); child.stderr!.on('data', chunk => stderr += chunk.toString()); return child; };
  adapter.on('error', () => { /* Keep native EventEmitter errors observed during fixture cleanup. */ });
  try {
    const pending = adapter.sendMessage({ role: 'user', content: 'LOCAL_PROMPT', metadata: { allowPartialOnTimeout: true } });
    await vi.waitFor(() => expect(stderr).toContain('LOCAL_ACK=12'));
    if (scenario === 'meaningful-stop')
      expect(adapter.interrupt().status).toBe('accepted');
    const response = await pending;
    expect(response.content).toBe('LOCAL_POSITIVE_ANSWER');
    expect(adapter.getSessionId()).toBe('LOCAL_POSITIVE_THREAD');
    expect(children).toHaveLength(1);
    if (scenario === 'partial-timeout')
      expect(response.metadata).toMatchObject({ partial: true, timedOut: true });
    else
      expect(children[0].exitCode).toBe(0);
  }
  finally {
    await adapter.terminate(false);
    rmSync(dir, { recursive: true, force: true });
  }
});
it('native old child close cannot disable or clear a live manual successor', async () => {
  getLogManager().updateConfig({ enableConsole: false, enableFile: false });
  const dir = mkdtempSync(join(tmpdir(), 'codex-exec-replacement-'));
  const oldFile = join(dir, 'old.cjs');
  const newFile = join(dir, 'new.cjs');
  writeFileSync(oldFile, String.raw`require('node:fs').closeSync(0);process.stderr.write('LOCAL_OLD_READY\n');setTimeout(()=>{},180);`);
  writeFileSync(newFile, String.raw`process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write('LOCAL_NEW_ACK\n');setTimeout(()=>{process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'LOCAL_REPLACEMENT_ANSWER'}})+'\n');},450);});`);
  const adapter = new CodexCliAdapter({ workingDir: dir, timeout: 1000 });
  Object.assign(adapter, { useAppServer: false, isSpawned: true });
  const access = adapter as unknown as {
    config: {
      command: string;
      args: string[];
    };
    spawnProcess(args: string[]): ChildProcess;
    process: ChildProcess | null;
    processAlive: boolean;
  };
  access.config.command = process.execPath;
  access.config.args = [oldFile];
  const spawn = access.spawnProcess.bind(adapter);
  const children: ChildProcess[] = [];
  let stderr = '';
  let failures = 0;
  access.spawnProcess = args => { const child = spawn(args); children.push(child); child.stderr!.on('data', chunk => stderr += chunk.toString()); child.stdin!.on('error', () => failures++); return child; };
  const statuses: string[] = [];
  const complete = vi.fn();
  const errors = vi.fn();
  adapter.on('status', s => statuses.push(s));
  adapter.on('complete', complete);
  adapter.on('turn_error', errors);
  adapter.on('error', () => { /* Keep native EventEmitter errors observed during fixture cleanup. */ });
  let current = true;
  const old = adapter.sendInput('X'.repeat(2 * 1024 * 1024), undefined, {
    dispatch: {
      assertCurrent: () => {
        if (!current)
          throw Object.assign(new Error('LOCAL_MANUAL_REPLACEMENT'), { name: 'AbortError' });
      }
    }
  }).then(() => ({ ok: true }), error => ({ ok: false, error }));
  try {
    await vi.waitFor(() => { expect(stderr).toContain('LOCAL_OLD_READY'); expect(failures).toBe(1); });
    current = false;
    access.config.args = [newFile];
    const next = adapter.sendInput('LOCAL_NEXT_PROMPT');
    await vi.waitFor(() => expect(stderr).toContain('LOCAL_NEW_ACK'));
    expect(access.process).toBe(children[1]);
    expect(access.processAlive).toBe(true);
    const prior = await old;
    expect(prior.ok).toBe(false);
    if ('error' in prior)
      expect(prior.error.name).toBe('AbortError');
    expect(children[0].exitCode).toBe(0);
    expect(children[1].exitCode).toBeNull();
    expect(access.process).toBe(children[1]);
    expect(access.processAlive).toBe(true);
    expect(statuses).toEqual(['busy', 'busy']);
    expect(complete).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    await next;
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0][0].content).toBe('LOCAL_REPLACEMENT_ANSWER');
    expect(children).toHaveLength(2);
  }
  finally {
    await adapter.terminate(false);
    rmSync(dir, { recursive: true, force: true });
  }
});
