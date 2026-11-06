import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { McpServerCostComponent } from './mcp-server-cost.component';
describe('MCP server cost', () => {
  it('shows connected schema cost, Claude hover, and a disconnected hint', () => {
    TestBed.configureTestingModule({ imports: [McpServerCostComponent] });
    const fixture = TestBed.createComponent(McpServerCostComponent);
    fixture.componentRef.setInput('serverId', 'server');
    fixture.componentRef.setInput('connected', true);
    fixture.componentRef.setInput('loaded', true);
    fixture.componentRef.setInput('tools', [{ name: 'read', serverId: 'server', inputSchema: {} }, { name: 'unrelated', serverId: 'other' }]);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('1 tool · up to about');
    expect(fixture.componentInstance.serverCostHint(2)).toContain('Claude');
    expect(fixture.componentInstance.serverCostHint(2)).toContain('about 2 tokens.');
    fixture.componentRef.setInput('loaded', false);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Tool cost not available yet');
    expect(fixture.nativeElement.textContent).not.toContain('0 tokens');
    fixture.componentRef.setInput('connected', false);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Connect to see the tool cost');
    fixture.destroy();
  });
});
