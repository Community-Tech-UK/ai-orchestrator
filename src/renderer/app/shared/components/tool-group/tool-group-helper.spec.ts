import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { ToolGroupComponent } from './tool-group.component';
import { SubagentUsageStore } from '../../../core/state/subagent-usage.store';
import type { OutputMessage } from '../../../core/state/instance.store';
describe('helper size on Task and Agent rows', () => {
  it('renders only matched helper samples on helper tools', () => {
    TestBed.configureTestingModule({ imports: [ToolGroupComponent], providers: [{ provide: SubagentUsageStore, useValue: {
      sample: (_instance: string, id: string) => id === 'task' ? { finalContextTokens: 82000, toolUses: 14, durationMs: 180000, final: true } : undefined,
    } }] });
    const fixture = TestBed.createComponent(ToolGroupComponent); const component = fixture.componentInstance;
    const task: OutputMessage = { id: 'row', type: 'tool_use', timestamp: 1, content: '', metadata: { id: 'task', name: 'Task' } };
    (component as unknown as { toolMessages: () => OutputMessage[] }).toolMessages = () => [task];
    (component as unknown as { instanceId: () => string }).instanceId = () => 'i';
    (component as unknown as { itemId: () => string }).itemId = () => 'group';
    component.toggle(); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Helper agent · 82K tokens at the end · 14 tool calls · 3 min');
    expect(component.helperText({ ...task, metadata: { id: 'missing', name: 'Task' } })).toBeNull();
    expect(component.helperText({ ...task, metadata: { id: 'task', name: 'Bash' } })).toBeNull();
  });
});
