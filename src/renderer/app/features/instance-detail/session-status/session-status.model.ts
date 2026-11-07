import type { Instance } from '../../../core/state/instance/instance.types';
import type { ProviderQuotaSnapshot } from '../../../../../shared/types/provider-quota.types';
import type { SessionSpendBreakdown } from '../../../../../shared/types/cost-session.types';
import { getModelShortName } from '../../../../../shared/types/provider.types';
import { resolveBillingMode } from '../../../../../shared/utils/billing-mode';
import { resolveCacheTtlMs } from '../../../../../shared/utils/cache-ttl';
import { isOccupancyPressureReading } from '../../../../../shared/utils/context-occupancy';
import { formatQuotaWindow, quotaWindowsForSession } from '../composer-quota-notice';

export interface SessionStatusView { title: string; rows: { label: string; lines: string[] }[]; text: string; cacheIsClaudePlan?: boolean }
export const formatSessionTokens = (tokens: number): string => tokens >= 1e6 ? `${Number((tokens / 1e6).toFixed(1))}M`
  : tokens >= 1000 ? `${Number((tokens / 1000).toFixed(1))}K` : String(tokens);
export function buildSessionStatus(input: { instance: Instance; quotaSnapshot?: ProviderQuotaSnapshot | null;
  breakdown?: SessionSpendBreakdown | null; accountLabel?: string; accountPlan?: string;
  permissionSentence?: string; showCost: boolean; now: number }): SessionStatusView {
  const { instance, breakdown, quotaSnapshot: quota, now } = input;
  const billing = resolveBillingMode(instance.provider, quota, { planLabel: input.accountPlan });
  const rows: SessionStatusView['rows'] = [];
  const add = (label: string, ...lines: string[]) => rows.push({ label, lines });
  add('Model', (instance.runtimeSummary?.label ?? (instance.currentModel ? getModelShortName(instance.currentModel, instance.provider) : 'Not reported yet'))
    + (instance.reasoningEffort ? ` · effort ${instance.reasoningEffort}` : ''));
  add('Allowed to', input.permissionSentence ?? 'Not available yet');
  add('Account', [input.accountLabel, input.accountPlan ?? quota?.plan].filter(Boolean).join(' · ') || 'Not available yet');
  if (billing === 'plan' || billing === 'credits' || quota) {
    const lines = quota ? quotaWindowsForSession(quota, instance.currentModel).map(window => {
      const { label, remaining, reset } = formatQuotaWindow(window);
      return `${label}: ${remaining} left${reset ? ` · resets ${reset}` : ''}`;
    }) : [];
    if (instance.provider === 'copilot') lines.push(breakdown?.aiCreditsNano !== undefined
      ? `AI credits this session: ${(breakdown.aiCreditsNano / 1e9).toLocaleString('en-GB', { maximumFractionDigits: 2 })}`
      : instance.executionLocation?.type === 'remote' ? 'AI credits are not available for sessions on another machine.' : 'AI credits: Not available yet');
    if (quota && (!quota.ok || now - quota.takenAt > 30 * 60000)) lines.push('May be out of date');
    add('Plan usage', ...(lines.length ? lines : ['Not available yet']));
  }
  const usage = instance.contextUsage;
  add('Context', isOccupancyPressureReading(usage) && usage.total > 0
    ? `${usage.isEstimated ? 'About ' : ''}${formatSessionTokens(usage.used)} of ${formatSessionTokens(usage.total)} (${Math.round(usage.used / usage.total * 100)}%)`
    : usage.occupancyReported && usage.occupancyIsAggregate ? `${formatSessionTokens(usage.cumulativeTokens ?? usage.used)} tokens used (no window figure)` : 'Not reported yet');
  if (!breakdown || breakdown.turns === 0) add('Used in this session', 'Not available yet');
  else {
    const total = breakdown.byModel.reduce((sum, model) => ({ input: sum.input + model.inputTokens, read: sum.read + model.cacheReadTokens,
      write: sum.write + model.cacheWriteTokens, output: sum.output + model.outputTokens }), { input: 0, read: 0, write: 0, output: 0 });
    const lines = [`${breakdown.turns} turns · ${formatSessionTokens(total.input)} uncached input · ${formatSessionTokens(total.read)} cache read · ${formatSessionTokens(total.write)} cache write · ${formatSessionTokens(total.output)} output`];
    if (input.showCost && instance.provider !== 'copilot') {
      lines.push(`≈$${breakdown.totalCostUsd.toFixed(2)} at API prices${breakdown.splitAvailable === false ? ' · main/helper split not available yet' : ` · main conversation about $${breakdown.mainCostUsd.toFixed(2)} · helper agents and side models about $${breakdown.helperCostUsd.toFixed(2)}`}`);
      if (billing === 'plan') lines.push('API-price equivalent, not billed to you');
      if (breakdown.estimatedShare > 0) lines.push(`${Math.round(breakdown.estimatedShare * 100)}% of the cost is estimated`);
    }
    for (const model of breakdown.byModel) {
      const cost = model.costKnown === false && model.costUsd === 0 ? ' · cost not available yet'
        : ` · ≈$${model.costUsd.toFixed(2)} at API prices${model.costKnown === false ? ' · some cost not available yet' : ''}`;
      lines.push(`${getModelShortName(model.model, instance.provider)}${model.isMainModel ? ' · main model' : ' · helper or side model'}: ${formatSessionTokens(model.inputTokens + model.cacheReadTokens + model.cacheWriteTokens + model.outputTokens)} tokens${input.showCost && instance.provider !== 'copilot' ? cost : ''}`);
    }
    add('Used in this session', ...lines);
  }
  if (!input.showCost) add('Cost', 'Cost figures are hidden (Settings › Display › Show cost estimates).');
  const ttl = resolveCacheTtlMs(instance, billing, breakdown?.copilotCache);
  if (ttl) {
    const cache = breakdown?.copilotCache.find(c => c.modelId === instance.currentModel);
    const expires = instance.provider === 'copilot' ? cache?.expiresAt : instance.lastActivity > 0 ? instance.lastActivity + ttl : undefined;
    add('Cache', expires === undefined ? 'Not available yet' : expires > now ? `Cache warm, cools in about ${Math.ceil((expires - now) / 60000)} min`
      : isOccupancyPressureReading(usage) ? `Cache has cooled; your next message re-sends about ${formatSessionTokens(usage.used)} tokens at full price`
        : 'Cache has cooled; the size of the next re-send is not reported.');
  }
  const title = `Session status · ${instance.displayName}`;
  return { title, rows, cacheIsClaudePlan: instance.provider === 'claude' && billing === 'plan',
    text: [title, ...rows.map(row => `${row.label}: ${row.lines.join('\n')}`)].join('\n\n') };
}
