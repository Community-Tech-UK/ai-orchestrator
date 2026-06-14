import { SlicePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  inject,
  OnInit,
} from '@angular/core';
import type { CampaignNodeRunDto, CampaignRunDto } from '../../../../shared/types/campaign.types';
import { CampaignStore } from '../../core/state/campaign.store';

function statusLabel(status: string): string {
  switch (status) {
    case 'pending': return 'Pending';
    case 'running': return 'Running';
    case 'paused': return 'Paused — Needs Review';
    case 'completed': return 'Completed';
    case 'failed': return 'Failed';
    case 'halted': return 'Halted';
    default: return status;
  }
}

function nodeStatusLabel(status: string): string {
  switch (status) {
    case 'pending': return 'Waiting';
    case 'running': return 'Running';
    case 'skipped': return 'Skipped';
    case 'completed': return 'Done';
    case 'completed-needs-review': return 'Needs Review';
    case 'failed': return 'Failed';
    case 'provider-limit': return 'Rate-limited';
    case 'operator-halted': return 'Halted';
    default: return status;
  }
}

function formatDuration(startedAt?: number, endedAt?: number): string {
  if (!startedAt) return '—';
  const end = endedAt ?? Date.now();
  const ms = end - startedAt;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

@Component({
  selector: 'app-campaign-page',
  standalone: true,
  imports: [SlicePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="campaign-page">
      <header class="cp-header">
        <h1>Campaigns</h1>
        <span class="cp-subtitle">Multi-loop DAG orchestration — each node is a standard loop run.</span>
      </header>

      @if (store.isLoading()) {
        <div class="cp-loading">Loading campaigns…</div>
      } @else if (store.lastError()) {
        <div class="cp-error">{{ store.lastError() }}</div>
      } @else if (store.allCampaigns().length === 0) {
        <div class="cp-empty">
          <p>No campaigns yet.</p>
          <p class="cp-empty-hint">Use the campaign API to start a multi-loop sequence. A campaign defines a directed acyclic graph of loop specs — nodes run in order, respecting edge predicates and the policy's review/parallel settings.</p>
        </div>
      } @else {
        <div class="cp-list">
          @for (campaign of store.allCampaigns(); track campaign.id) {
            <div class="cp-card" [attr.data-status]="campaign.status">
              <div class="cp-card-head">
                <span class="cp-title">{{ campaign.spec.title }}</span>
                <span class="cp-status-pill" [attr.data-status]="campaign.status">{{ statusLabel(campaign.status) }}</span>
                <span class="cp-duration">{{ formatDuration(campaign.startedAt, campaign.endedAt) }}</span>
                <span class="cp-actions">
                  @if (campaign.status === 'running') {
                    <button type="button" (click)="onHalt(campaign.id)">Halt</button>
                  }
                  @if (campaign.status === 'paused') {
                    <button type="button" class="cp-resume" (click)="onResume(campaign.id)">Resume</button>
                    <button type="button" (click)="onHalt(campaign.id)">Halt</button>
                  }
                </span>
              </div>

              @if (campaign.pausedReason) {
                <div class="cp-paused-reason">Paused: {{ campaign.pausedReason }}</div>
              }

              <div class="cp-nodes">
                @for (node of campaign.spec.nodes; track node.id) {
                  <div class="cp-node" [attr.data-status]="nodeStatus(campaign, node.id)">
                    <span class="cpn-label">{{ node.label ?? node.id }}</span>
                    <span class="cpn-status">{{ nodeStatusLabel(nodeStatus(campaign, node.id)) }}</span>
                    @if (nodeRunDuration(campaign, node.id); as dur) {
                      <span class="cpn-duration">{{ dur }}</span>
                    }
                    @if (nodeSkipReason(campaign, node.id); as reason) {
                      <span class="cpn-skip" title="{{ reason }}">Skipped: {{ reason | slice:0:60 }}</span>
                    }
                    @if (node.dependsOn.length > 0) {
                      <span class="cpn-deps" title="Depends on: {{ node.dependsOn.join(', ') }}">after {{ node.dependsOn.join(', ') }}</span>
                    }
                  </div>
                }
              </div>

              <div class="cp-policy">
                Policy: max {{ campaign.spec.policy.maxParallel }} parallel · on-needs-review: {{ campaign.spec.policy.onNodeNeedsReview }}
                @if (campaign.spec.policy.isolation) {
                  · isolation: {{ campaign.spec.policy.isolation }}
                }
              </div>
            </div>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .campaign-page { padding: 24px; max-width: 900px; }
    .cp-header { margin-bottom: 20px; }
    .cp-header h1 { margin: 0 0 4px; font-size: 20px; }
    .cp-subtitle { font-size: 13px; opacity: 0.6; }
    .cp-loading, .cp-error, .cp-empty { padding: 24px; text-align: center; opacity: 0.7; }
    .cp-error { color: var(--color-error, #e53e3e); }
    .cp-empty-hint { font-size: 12px; opacity: 0.6; max-width: 480px; margin: 8px auto; }
    .cp-list { display: flex; flex-direction: column; gap: 12px; }
    .cp-card { border: 1px solid var(--border, #333); border-radius: 6px; padding: 12px 16px; }
    .cp-card[data-status="running"] { border-left: 3px solid var(--color-running, #38a169); }
    .cp-card[data-status="paused"] { border-left: 3px solid var(--color-warn, #d69e2e); }
    .cp-card[data-status="failed"] { border-left: 3px solid var(--color-error, #e53e3e); }
    .cp-card[data-status="completed"] { border-left: 3px solid var(--color-ok, #48bb78); opacity: 0.8; }
    .cp-card-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
    .cp-title { font-weight: 600; font-size: 14px; flex: 1; }
    .cp-status-pill { font-size: 11px; padding: 2px 8px; border-radius: 10px; background: var(--pill-bg, #2d3748); }
    .cp-status-pill[data-status="running"] { background: var(--color-running, #276749); }
    .cp-status-pill[data-status="paused"] { background: var(--color-warn-bg, #744210); }
    .cp-status-pill[data-status="failed"] { background: var(--color-error-bg, #742a2a); }
    .cp-duration { font-size: 12px; opacity: 0.6; }
    .cp-actions { margin-left: auto; display: flex; gap: 6px; }
    .cp-actions button { font-size: 12px; padding: 3px 10px; border-radius: 4px; cursor: pointer; border: 1px solid var(--border, #555); background: transparent; color: inherit; }
    .cp-actions .cp-resume { border-color: var(--color-ok, #48bb78); color: var(--color-ok, #48bb78); }
    .cp-paused-reason { font-size: 12px; color: var(--color-warn, #d69e2e); margin-bottom: 8px; }
    .cp-nodes { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
    .cp-node { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 4px 8px; border-radius: 4px; background: var(--node-bg, rgba(255,255,255,0.04)); }
    .cp-node[data-status="running"] { background: rgba(56,161,105,0.15); }
    .cp-node[data-status="failed"] { background: rgba(229,62,62,0.12); }
    .cp-node[data-status="skipped"] { opacity: 0.5; }
    .cpn-label { font-weight: 500; }
    .cpn-status { font-size: 11px; opacity: 0.7; }
    .cpn-duration { font-size: 11px; opacity: 0.6; }
    .cpn-deps { font-size: 10px; opacity: 0.5; }
    .cpn-skip { font-size: 11px; color: var(--color-warn, #d69e2e); }
    .cp-policy { font-size: 11px; opacity: 0.5; margin-top: 4px; }
  `],
})
export class CampaignPageComponent implements OnInit {
  store = inject(CampaignStore);

  ngOnInit(): void {
    this.store.ensureWired();
    void this.store.load();
  }

  onHalt(campaignId: string): void {
    void this.store.halt(campaignId);
  }

  onResume(campaignId: string): void {
    void this.store.resume(campaignId);
  }

  statusLabel(status: string): string { return statusLabel(status); }
  nodeStatusLabel(status: string): string { return nodeStatusLabel(status); }
  formatDuration(startedAt?: number, endedAt?: number): string { return formatDuration(startedAt, endedAt); }

  nodeStatus(campaign: CampaignRunDto, nodeId: string): string {
    const run = campaign.nodeRuns.find((n: CampaignNodeRunDto) => n.nodeId === nodeId);
    return run?.status ?? 'pending';
  }

  nodeRunDuration(campaign: CampaignRunDto, nodeId: string): string | null {
    const run = campaign.nodeRuns.find((n: CampaignNodeRunDto) => n.nodeId === nodeId);
    if (!run?.startedAt) return null;
    return formatDuration(run.startedAt, run.endedAt);
  }

  nodeSkipReason(campaign: CampaignRunDto, nodeId: string): string | null {
    const run = campaign.nodeRuns.find((n: CampaignNodeRunDto) => n.nodeId === nodeId);
    return run?.skippedReason ?? null;
  }
}
