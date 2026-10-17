import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OutputMessage } from '../../../../shared/types/instance.types';
import { CodexCliAdapter } from '../codex-cli-adapter';
import { createMockProcess } from '../codex-cli-adapter.test-helpers';
import { runCodexExecProcess } from './exec-process-runner';
import { getLogManager } from '../../../logging/logger';

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.connected) child.disconnect();
    if (child.exitCode === null) child.kill();
  }
  vi.restoreAllMocks();
});

describe('Codex exec progress', () => {
  it('publishes native child progress before exit and keeps completion output exactly once', async () => {
    getLogManager().updateConfig({ enableConsole: false, enableFile: false });
    const child = spawn(process.execPath, ['-e', `
      const emit = event => process.stdout.write(JSON.stringify(event)+'\\n');
      process.stdin.resume();
      process.stdin.on('end', () => {
        emit({type:'thread.started',thread_id:'local-thread'});
        emit({type:'item.completed',item:{id:'progress',type:'agent_message',text:'Checking the layout.'}});
        emit({type:'item.started',item:{id:'command',type:'command_execution',command:'local-check'}});
        emit({type:'item.completed',item:{id:'command',type:'command_execution',command:'local-check',aggregated_output:'Check failed',exit_code:2,status:'completed'}});
        emit({type:'item.completed',item:{id:'edit',type:'file_change',status:'failed',changes:[{path:'example.css',kind:'update',diff:'local diff'}]}});
        emit({type:'item.started',item:{id:'mcp',type:'mcp_tool_call',server:'local',tool:'inspect',arguments:{page:1}}});
        emit({type:'item.completed',item:{id:'mcp',type:'mcp_tool_call',server:'local',tool:'inspect',status:'completed',result:{content:[{type:'text',text:'Page inspected'}]}}});
        process.send('ready');
      });
      process.on('message', () => {
        emit({type:'item.completed',item:{id:'answer',type:'agent_message',text:'Layout checked.'}});
        emit({type:'turn.completed',usage:{input_tokens:10,output_tokens:5}});
        process.disconnect();
      });
    `], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    children.push(child);
    const ready = once(child, 'message');
    const adapter = new CodexCliAdapter({ timeout: 5000 });
    Object.assign(adapter, { useAppServer: false, isSpawned: true });
    vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess').mockReturnValue(child);
    const outputs: OutputMessage[] = [];
    const complete = vi.fn();
    adapter.on('output', output => outputs.push(output));
    adapter.on('complete', complete);
    adapter.on('error', () => {});
    const pending = adapter.sendInput('Inspect layout');
    try {
      await ready;
      await vi.waitFor(() => expect(outputs.some(o => o.content.includes('Page inspected'))).toBe(true));
      expect(child.exitCode).toBeNull();
      expect(complete).not.toHaveBeenCalled();
      expect(outputs.filter(o => o.type === 'assistant').map(o => o.content)).toEqual(['Checking the layout.']);
      expect(outputs.filter(o => o.metadata?.['id'] === 'command').map(o => o.type)).toEqual(['tool_use', 'tool_result']);
      expect(outputs.find(o => o.type === 'tool_result' && o.metadata?.['id'] === 'command')?.metadata).toMatchObject({ is_error: true, exitCode: 2 });
      expect(outputs.find(o => o.type === 'tool_result' && o.metadata?.['id'] === 'edit')?.metadata).toMatchObject({ is_error: true });
      child.send('finish');
      await pending;
      expect(outputs.filter(o => o.type === 'assistant').map(o => o.content)).toEqual(['Checking the layout.', 'Layout checked.']);
      expect(outputs.filter(o => o.type === 'tool_use')).toHaveLength(3);
      expect(outputs.filter(o => o.type === 'tool_result')).toHaveLength(3);
      expect(complete).toHaveBeenCalledOnce();
      expect(complete.mock.calls[0][0]).toMatchObject({ content: 'Checking the layout.\nLayout checked.', usage: { totalTokens: 15 } });
    } finally {
      if (child.connected) child.send('finish');
      await pending.catch(() => {});
      await adapter.terminate(false);
    }
  });

  it('handles split lines, legacy starts, reasoning, duplicate completion and a final unterminated line', async () => {
    const child = createMockProcess();
    const outputs: OutputMessage[] = [];
    const pending = runCodexExecProcess({
      deadlineMs: 5000, timeoutMs: 5000, turnIdleTimeoutMs: 5000, phase: 'turn',
      emitExit: () => {}, emitHeartbeat: () => {}, emitOutput: o => outputs.push(o),
      generateResponseId: () => 'response', isActiveProcess: p => p === child,
      message: { role: 'user', content: 'Inspect layout' }, onThreadId: () => {},
      setProcess: () => {}, spawn: () => child,
    });
    // Let stdin acceptance settle before driving stdout.
    await new Promise<void>(resolve => setImmediate(resolve));
    const start = JSON.stringify({ type: 'item.created', item: { id: 'command', type: 'command_execution', command: 'local-check' } });
    child.stdout.write(start.slice(0, 20));
    expect(outputs).toHaveLength(0);
    child.stdout.write(start.slice(20) + '\n');
    child.stdout.write(JSON.stringify({ type: 'item.started', item: { id: 'command', type: 'command_execution', command: 'local-check' } }) + '\n');
    const completed = JSON.stringify({ type: 'item.completed', item: { id: 'command', type: 'command_execution', command: 'local-check', exit_code: 0 } });
    child.stdout.write(completed + '\n' + completed + '\n');
    child.stdout.write(JSON.stringify({ type: 'item.completed', item: { id: 'thought', type: 'reasoning', summary: ['Inspecting styles'] } }) + '\n');
    expect(outputs.filter(o => o.type === 'tool_use')).toHaveLength(1);
    expect(outputs.filter(o => o.type === 'tool_result')).toHaveLength(1);
    expect(outputs.find(o => o.thinking?.length)?.thinking?.[0].content).toBe('Inspecting styles');
    child.stdout.write(JSON.stringify({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'Ready.' } }));
    child.emitClose(0);
    const result = await pending;
    expect(outputs.filter(o => o.content === 'Ready.')).toHaveLength(1);
    expect(result.response.content).toBe('Ready.');
  });

  it.each([
    ['legacy tool', '[TOOL: custom]\nlocal input\n[/TOOL]\nReady.'],
    ['legacy thinking', '<thinking>\nCheck condition\n</thinking>\nReady.'],
    ['legacy result', JSON.stringify({ type: 'item.completed', item: { id: 'legacy', type: 'dynamicToolCall', toolName: 'local', text: 'Legacy result' } })],
  ])('preserves %s through the native child output path', async (kind, raw) => {
    const child = spawn(process.execPath, ['-e', `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(raw)}));`]);
    children.push(child);
    const outputs: OutputMessage[] = [];
    const result = await runCodexExecProcess({
      deadlineMs: 5000, timeoutMs: 5000, turnIdleTimeoutMs: 5000, phase: 'turn',
      emitExit: () => {}, emitHeartbeat: () => {}, emitOutput: o => outputs.push(o),
      generateResponseId: () => 'response', isActiveProcess: p => p === child,
      message: { role: 'user', content: 'Inspect layout' },
      onThreadId: () => {}, setProcess: () => {}, spawn: () => child,
    });
    if (kind === 'legacy tool') {
      expect(result.response.toolCalls?.[0].name).toBe('custom');
      expect(outputs.filter(o => o.type === 'tool_use')).toMatchObject([{ metadata: { name: 'custom', input: { raw: 'local input' } } }]);
    } else if (kind === 'legacy thinking') {
      expect(outputs.filter(o => o.type === 'assistant')).toMatchObject([{ content: 'Ready.', thinking: [{ content: 'Check condition', format: 'xml' }] }]);
    } else {
      expect(result.response.toolCalls?.[0].result).toBe('Legacy result');
      expect(outputs.filter(o => o.type === 'tool_result')).toMatchObject([{ content: 'Legacy result' }]);
    }
  });

  it.each(['json', 'legacy'])('publishes an unterminated %s last item when returning partial output on timeout', async format => {
    const child = createMockProcess();
    const outputs: OutputMessage[] = [];
    const pending = runCodexExecProcess({
      deadlineMs: 60, timeoutMs: 5000, turnIdleTimeoutMs: 5000, phase: 'turn',
      emitExit: () => {}, emitHeartbeat: () => {}, emitOutput: o => outputs.push(o),
      generateResponseId: () => 'response', isActiveProcess: p => p === child,
      message: { role: 'user', content: 'Inspect layout', metadata: { allowPartialOnTimeout: true } },
      onThreadId: () => {}, setProcess: () => {}, spawn: () => child,
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    child.stdout.write(format === 'json'
      ? JSON.stringify({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'Partial answer.' } })
      : 'Partial answer.');
    const result = await pending;
    expect(result.response.metadata).toMatchObject({ partial: true, timedOut: true });
    expect(outputs.filter(o => o.content === 'Partial answer.')).toHaveLength(1);
  });
});
