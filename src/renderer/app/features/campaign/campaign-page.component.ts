import { SlicePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type {
  CampaignEdge,
  CampaignNodeRunDto,
  CampaignRunDto,
  CampaignSpec,
  LoopTerminalStatus,
  TerminalStatusPredicate,
} from '../../../../shared/types/campaign.types';
import { CampaignStore } from '../../core/state/campaign.store';

type Provider = 'claude' | 'codex' | 'gemini' | 'copilot' | 'cursor';
type Stage = 'PLAN' | 'REVIEW' | 'IMPLEMENT';
type EditorMode = 'select' | 'add-node' | 'connect';
type EdgeMode = 'any' | 'is' | 'in' | 'not';

interface EditorNode {
  id: string;
  label: string;
  initialPrompt: string;
  workspaceCwd: string;
  verifyCommand: string;
  provider: Provider;
  initialStage: Stage;
  x: number;
  y: number;
}

interface EditorEdge {
  from: string;
  to: string;
  mode: EdgeMode;
  status: LoopTerminalStatus;
  statuses: LoopTerminalStatus[];
}

interface DragState {
  nodeId: string;
  offsetX: number;
  offsetY: number;
}

const TERMINAL_STATUSES: LoopTerminalStatus[] = [
  'completed',
  'completed-needs-review',
  'failed',
  'provider-limit',
  'operator-halted',
];
const PROVIDERS: Provider[] = ['claude', 'codex', 'gemini', 'copilot', 'cursor'];
const STAGES: Stage[] = ['IMPLEMENT', 'PLAN', 'REVIEW'];
const NODE_W = 156;
const NODE_H = 76;

function statusLabel(status: string): string {
  switch (status) {
    case 'pending': return 'Pending';
    case 'running': return 'Running';
    case 'paused': return 'Paused';
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
    case 'completed-needs-review': return 'Needs review';
    case 'failed': return 'Failed';
    case 'provider-limit': return 'Rate-limited';
    case 'operator-halted': return 'Halted';
    default: return status;
  }
}

function formatDuration(startedAt?: number, endedAt?: number): string {
  if (!startedAt) return '-';
  const end = endedAt ?? Date.now();
  const ms = end - startedAt;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function newCampaignId(): string {
  return `campaign-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

@Component({
  selector: 'app-campaign-page',
  standalone: true,
  imports: [FormsModule, SlicePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './campaign-page.component.html',
  styleUrl: './campaign-page.component.scss',
})
export class CampaignPageComponent implements OnInit {
  protected readonly NODE_W = NODE_W;
  protected readonly NODE_H = NODE_H;
  protected readonly terminalStatuses = TERMINAL_STATUSES;
  protected readonly providers = PROVIDERS;
  protected readonly stages = STAGES;
  store = inject(CampaignStore);

  title = signal('New campaign');
  nodes = signal<EditorNode[]>([this.createNode(1, 80, 120)]);
  edges = signal<EditorEdge[]>([]);
  selectedNodeId = signal('node-1');
  mode = signal<EditorMode>('select');
  edgeFrom = signal('node-1');
  edgeTo = signal('node-1');
  edgeMode = signal<EdgeMode>('any');
  edgeStatus = signal<LoopTerminalStatus>('completed');
  edgeStatuses = signal<LoopTerminalStatus[]>(['completed']);
  connectSourceId = signal<string | null>(null);
  maxParallel = signal(3);
  onNodeNeedsReview = signal<'pause-campaign' | 'continue' | 'halt'>('pause-campaign');
  isolationEnabled = signal(false);
  editorError = signal<string | null>(null);
  editorNotice = signal<string | null>(null);
  private nextNodeNumber = 2;
  private drag = signal<DragState | null>(null);

  selectedNode = computed(() => this.nodeFor(this.selectedNodeId()) ?? this.nodes()[0]);
  canRun = computed(() => this.localValidationErrors().length === 0);

  ngOnInit(): void {
    this.store.ensureWired();
    void this.store.load();
  }

  resetEditor(): void {
    this.title.set('New campaign');
    this.nodes.set([this.createNode(1, 80, 120)]);
    this.edges.set([]);
    this.selectedNodeId.set('node-1');
    this.edgeFrom.set('node-1');
    this.edgeTo.set('node-1');
    this.connectSourceId.set(null);
    this.isolationEnabled.set(false);
    this.nextNodeNumber = 2;
    this.clearMessages();
  }

  addNodeAt(x: number, y: number): void {
    const node = this.createNode(this.nextNodeNumber, Math.max(12, Math.min(540, x)), Math.max(12, Math.min(270, y)));
    this.nextNodeNumber += 1;
    this.nodes.update((nodes) => [...nodes, node]);
    this.selectedNodeId.set(node.id);
    this.edgeTo.set(node.id);
    this.clearMessages();
  }

  updateNode(id: string, patch: Partial<EditorNode>): void {
    this.nodes.update((nodes) => nodes.map((node) => node.id === id ? { ...node, ...patch } : node));
    this.clearMessages();
  }

  removeNode(id: string): void {
    if (this.nodes().length <= 1) return;
    const remaining = this.nodes().filter((node) => node.id !== id);
    this.nodes.set(remaining);
    this.edges.update((edges) => edges.filter((edge) => edge.from !== id && edge.to !== id));
    this.selectedNodeId.set(remaining[0]?.id ?? '');
    this.edgeFrom.set(remaining[0]?.id ?? '');
    this.edgeTo.set(remaining[0]?.id ?? '');
    this.clearMessages();
  }

  addEdge(): void {
    const from = this.edgeFrom();
    const to = this.edgeTo();
    const error = this.validateCandidateEdge(from, to);
    if (error) {
      this.editorError.set(error);
      this.editorNotice.set(null);
      return;
    }
    const statuses = this.edgeMode() === 'in' ? this.edgeStatuses() : [this.edgeStatus()];
    const edge: EditorEdge = { from, to, mode: this.edgeMode(), status: statuses[0] ?? this.edgeStatus(), statuses };
    this.edges.update((edges) => [...edges.filter((e) => !(e.from === from && e.to === to)), edge]);
    this.editorError.set(null);
    this.editorNotice.set('Edge added');
  }

  removeEdge(edge: EditorEdge): void {
    this.edges.update((edges) => edges.filter((e) => e !== edge));
    this.clearMessages();
  }

  async onValidateSpec(): Promise<void> {
    const localErrors = this.localValidationErrors();
    if (localErrors.length > 0) {
      this.editorError.set(localErrors.join('; '));
      this.editorNotice.set(null);
      return;
    }
    const res = await this.store.validate(this.buildSpec());
    if (res.success && res.data?.valid) {
      this.editorError.set(null);
      this.editorNotice.set('Campaign spec is valid');
      return;
    }
    this.editorNotice.set(null);
    this.editorError.set(res.success ? (res.data?.errors.join('; ') || 'Invalid campaign spec') : (res.error?.message ?? 'Validation failed'));
  }

  async onRunCampaign(): Promise<void> {
    const localErrors = this.localValidationErrors();
    if (localErrors.length > 0) {
      this.editorError.set(localErrors.join('; '));
      this.editorNotice.set(null);
      return;
    }
    const spec = this.buildSpec();
    const validation = await this.store.validate(spec);
    if (!validation.success || !validation.data?.valid) {
      this.editorNotice.set(null);
      this.editorError.set(validation.success ? (validation.data?.errors.join('; ') || 'Invalid campaign spec') : (validation.error?.message ?? 'Validation failed'));
      return;
    }
    const started = await this.store.start(spec);
    if (started.success) {
      this.editorError.set(null);
      this.editorNotice.set('Campaign started');
      return;
    }
    this.editorNotice.set(null);
    this.editorError.set(started.error?.message ?? 'Failed to start campaign');
  }

  loadSpec(campaign: CampaignRunDto): void {
    const loadedNodes = campaign.spec.nodes.map((node, index) => ({
      id: node.id,
      label: node.label ?? node.id,
      initialPrompt: node.loopConfig.initialPrompt,
      workspaceCwd: node.loopConfig.workspaceCwd,
      verifyCommand: node.loopConfig.completion?.verifyCommand ?? '',
      provider: this.asProvider(node.loopConfig.provider),
      initialStage: this.asStage(node.loopConfig.initialStage),
      x: 60 + (index % 4) * 180,
      y: 70 + Math.floor(index / 4) * 110,
    }));
    this.title.set(campaign.spec.title);
    this.nodes.set(loadedNodes.length ? loadedNodes : [this.createNode(1, 80, 120)]);
    this.edges.set(campaign.spec.edges.map((edge) => this.fromCampaignEdge(edge)));
    this.maxParallel.set(campaign.spec.policy.maxParallel);
    this.onNodeNeedsReview.set(campaign.spec.policy.onNodeNeedsReview);
    this.isolationEnabled.set(campaign.spec.policy.isolation === 'worktree');
    this.selectedNodeId.set(this.nodes()[0].id);
    this.edgeFrom.set(this.nodes()[0].id);
    this.edgeTo.set(this.nodes()[0].id);
    this.nextNodeNumber = this.nextAvailableNodeNumber(this.nodes());
    this.clearMessages();
  }

  rerunCampaign(campaign: CampaignRunDto): void {
    this.loadSpec({ ...campaign, spec: { ...campaign.spec, id: newCampaignId(), title: `${campaign.spec.title} copy` } });
    this.title.set(`${campaign.spec.title} copy`);
  }

  onCanvasClick(event: MouseEvent): void {
    if (this.mode() !== 'add-node') return;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.addNodeAt(event.clientX - rect.left - NODE_W / 2, event.clientY - rect.top - NODE_H / 2);
  }

  onCanvasKeyAdd(event: KeyboardEvent): void {
    if (this.mode() !== 'add-node') return;
    event.preventDefault();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.addNodeAt(rect.width / 2 - NODE_W / 2, rect.height / 2 - NODE_H / 2);
  }

  onNodeClick(id: string, event: MouseEvent): void {
    event.stopPropagation();
    if (this.mode() === 'connect') {
      const source = this.connectSourceId();
      if (!source) {
        this.connectSourceId.set(id);
        this.edgeFrom.set(id);
        return;
      }
      this.edgeTo.set(id);
      this.addEdge();
      this.connectSourceId.set(null);
      return;
    }
    this.selectedNodeId.set(id);
  }

  onNodePointerDown(id: string, event: PointerEvent): void {
    if (this.mode() !== 'select') return;
    const node = this.nodeFor(id);
    if (!node) return;
    event.stopPropagation();
    this.selectedNodeId.set(id);
    const rect = (event.currentTarget as HTMLElement).offsetParent?.getBoundingClientRect();
    if (!rect) return;
    this.drag.set({ nodeId: id, offsetX: event.clientX - rect.left - node.x, offsetY: event.clientY - rect.top - node.y });
  }

  onCanvasPointerMove(event: PointerEvent): void {
    const drag = this.drag();
    if (!drag) return;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.updateNode(drag.nodeId, {
      x: Math.max(8, Math.min(556, event.clientX - rect.left - drag.offsetX)),
      y: Math.max(8, Math.min(276, event.clientY - rect.top - drag.offsetY)),
    });
  }

  onCanvasPointerUp(): void {
    this.drag.set(null);
  }

  onMaxParallelChange(value: number | string): void {
    const n = Number(value);
    this.maxParallel.set(Number.isFinite(n) ? Math.max(1, Math.min(16, Math.floor(n))) : 1);
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

  nodeFor(id: string): EditorNode | undefined {
    return this.nodes().find((node) => node.id === id);
  }

  labelFor(id: string): string {
    const node = this.nodeFor(id);
    return node?.label || id;
  }

  outgoingCount(id: string): number {
    return this.edges().filter((edge) => edge.from === id).length;
  }

  incomingCount(id: string): number {
    return this.edges().filter((edge) => edge.to === id).length;
  }

  edgeStatusSelected(status: LoopTerminalStatus): boolean {
    return this.edgeStatuses().includes(status);
  }

  toggleEdgeStatus(status: LoopTerminalStatus, selected: boolean): void {
    const current = this.edgeStatuses();
    if (selected) {
      this.edgeStatuses.set([...new Set([...current, status])]);
      this.edgeStatus.set(status);
      return;
    }
    if (current.length <= 1 && current.includes(status)) return;
    this.edgeStatuses.set(current.filter((item) => item !== status));
  }

  edgeGateLabel(edge: EditorEdge): string {
    if (edge.mode === 'any') return '';
    if (edge.mode === 'in') return ` / in ${edge.statuses.join(', ')}`;
    return ` / ${edge.mode} ${edge.status}`;
  }

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

  private buildSpec(): CampaignSpec {
    const edges = this.edges().map<CampaignEdge>((edge) => ({
      from: edge.from,
      to: edge.to,
      ...(this.edgePredicate(edge) ? { when: this.edgePredicate(edge) } : {}),
    }));
    return {
      id: newCampaignId(),
      title: this.title().trim() || 'Campaign',
      nodes: this.nodes().map((node) => ({
        id: node.id,
        label: node.label.trim() || node.id,
        dependsOn: edges.filter((edge) => edge.to === node.id).map((edge) => edge.from),
        loopConfig: {
          initialPrompt: node.initialPrompt.trim(),
          workspaceCwd: node.workspaceCwd.trim(),
          provider: node.provider,
          initialStage: node.initialStage,
          ...(node.verifyCommand.trim() ? { completion: { verifyCommand: node.verifyCommand.trim() } } : {}),
        },
      })),
      edges,
      policy: {
        onNodeNeedsReview: this.onNodeNeedsReview(),
        maxParallel: this.maxParallel(),
        ...(this.isolationEnabled() ? { isolation: 'worktree' as const } : {}),
      },
      createdAt: Date.now(),
    };
  }

  private edgePredicate(edge: EditorEdge): TerminalStatusPredicate | undefined {
    if (edge.mode === 'any') return undefined;
    if (edge.mode === 'in') return { type: 'in', statuses: edge.statuses.length ? edge.statuses : [edge.status] };
    return { type: edge.mode, status: edge.status };
  }

  private localValidationErrors(): string[] {
    const errors: string[] = [];
    if (!this.title().trim()) errors.push('Campaign title is required');
    for (const node of this.nodes()) {
      if (!node.initialPrompt.trim()) errors.push(`${node.id} goal is required`);
      if (!node.workspaceCwd.trim()) errors.push(`${node.id} workspace is required`);
    }
    if (this.hasCycle(this.edges())) errors.push('Campaign DAG contains a cycle');
    return errors;
  }

  private validateCandidateEdge(from: string, to: string): string | null {
    if (!from || !to) return 'Choose both edge endpoints';
    if (from === to) return 'A node cannot depend on itself';
    if (this.edges().some((edge) => edge.from === from && edge.to === to)) return 'That edge already exists';
    if (this.hasCycle([...this.edges(), { from, to, mode: this.edgeMode(), status: this.edgeStatus(), statuses: this.edgeStatuses() }])) {
      return 'Adding that edge would create a cycle';
    }
    return null;
  }

  private hasCycle(edges: EditorEdge[]): boolean {
    const ids = this.nodes().map((node) => node.id);
    const graph = new Map(ids.map((id) => [id, [] as string[]]));
    for (const edge of edges) graph.get(edge.from)?.push(edge.to);
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): boolean => {
      if (visiting.has(id)) return true;
      if (visited.has(id)) return false;
      visiting.add(id);
      for (const next of graph.get(id) ?? []) {
        if (visit(next)) return true;
      }
      visiting.delete(id);
      visited.add(id);
      return false;
    };
    return ids.some((id) => visit(id));
  }

  private createNode(index: number, x: number, y: number): EditorNode {
    return {
      id: `node-${index}`,
      label: `Loop ${index}`,
      initialPrompt: index === 1 ? 'Implement the first objective' : 'Review or continue the prior loop output',
      workspaceCwd: '',
      verifyCommand: '',
      provider: 'claude',
      initialStage: 'IMPLEMENT',
      x,
      y,
    };
  }

  private nextAvailableNodeNumber(nodes: EditorNode[]): number {
    const highestGeneratedId = nodes.reduce((highest, node) => {
      const match = /^node-(\d+)$/.exec(node.id);
      if (!match) return highest;
      return Math.max(highest, Number(match[1]));
    }, 0);
    return Math.max(highestGeneratedId, nodes.length) + 1;
  }

  private fromCampaignEdge(edge: CampaignEdge): EditorEdge {
    if (!edge.when) return { from: edge.from, to: edge.to, mode: 'any', status: 'completed', statuses: ['completed'] };
    if (edge.when.type === 'is' || edge.when.type === 'not') {
      return { from: edge.from, to: edge.to, mode: edge.when.type, status: edge.when.status, statuses: [edge.when.status] };
    }
    const statuses: LoopTerminalStatus[] = edge.when.statuses.length ? [...edge.when.statuses] : ['completed'];
    return { from: edge.from, to: edge.to, mode: 'in', status: statuses[0], statuses };
  }

  private asProvider(value: unknown): Provider {
    return PROVIDERS.includes(value as Provider) ? value as Provider : 'claude';
  }

  private asStage(value: unknown): Stage {
    return STAGES.includes(value as Stage) ? value as Stage : 'IMPLEMENT';
  }

  private clearMessages(): void {
    this.editorError.set(null);
    this.editorNotice.set(null);
  }
}
