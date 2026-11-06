import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { copyFor } from '../../shared/tooltip/tooltip-copy';
import { humanTokens } from '../loop/loop-formatters.util';
import { estimateServerCost, type EstimatedMcpTool } from './mcp-token-estimate';

@Component({
  selector: 'app-mcp-server-cost', standalone: true, changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AioTooltipDirective],
  template: `@if (!connected()) { <span>Connect to see the tool cost</span> }
  @else if (!loaded()) { <span>Tool cost not available yet</span> }
  @else {
    @let nameTokens = cost().nameTokens;
    <span class="server-cost" tabindex="0" [appTooltip]="serverCostHint(nameTokens)">{{ cost().toolCount }} {{ cost().toolCount === 1 ? 'tool' : 'tools' }} · up to about {{ tokens() }} tokens a message</span>
  }`,
  styles: [`:host { display: block; color: var(--text-secondary); font-size: 12px; margin-top: var(--spacing-xs); }`],
})
export class McpServerCostComponent {
  readonly serverId = input.required<string>();
  readonly connected = input(false);
  readonly loaded = input.required<boolean>();
  readonly tools = input<readonly (EstimatedMcpTool & { serverId: string })[]>([]);
  readonly cost = computed(() => estimateServerCost(this.tools().filter((tool) => tool.serverId === this.serverId())));
  readonly tokens = computed(() => humanTokens(this.cost().fullTokens).replace(/ tok$/, ''));

  /** The hint, with the names-only figure filled from a plain template value so the wording stays measurable. */
  serverCostHint(nameTokens: number): string {
    return copyFor('mcpServerCost') + ' about ' + nameTokens + ' tokens.';
  }
}
