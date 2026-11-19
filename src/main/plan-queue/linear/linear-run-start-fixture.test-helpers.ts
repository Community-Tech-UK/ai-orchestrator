/**
 * A Linear for the specs that start a Linear run: a real Start preview service, whose ticket text and whose later live reads
 * both go through the fake connector (a real MCP server on this machine), so the same words give the same hash at Start and at
 * the check before a session. The list itself (rows, projects, teams) is stood in for, because Step 3's reading is proved
 * elsewhere; what these specs prove is what Start does with a preview.
 */
import type { PlanQueueLinearPreviewRow, PlanQueueLinearTeam } from '@contracts/schemas/plan-queue';
import type { OrchestratorMcpServer } from '../../../shared/types/mcp-orchestrator.types';
import type { LinearCallDependencies } from './linear-call';
import type { DiscoveryRow, DiscoveryTeam } from './linear-discovery';
import {
  acceptingFakeAddress, startFakeLinearConnector, structured, type FakeLinearConnector,
} from './linear-fake-connector.test-helpers';
import { LinearPreviewService } from './linear-preview';
import { readLiveTicket } from './linear-ticket-live-read';
import type { FolderDiscovery } from './linear-ticket-reader';
import { readTicketText } from './linear-ticket-text';
import type { LiveTicketRead } from '../plan-queue-ticket-guard';
import type { LinearStartSources } from '../plan-queue-linear-run-create';

export interface FixtureTicket {
  identifier: string;
  /** Linear's long id: the preview row's id and the item's `linear:<id>`. */
  uuid: string;
  title: string;
  description: string;
  comments: { id: string; body: string }[];
  priority: number;
  teamId: string;
  projectId: string;
}

export const ORC12: FixtureTicket = { identifier: 'ORC-12', uuid: 'uuid-12', title: 'Make the sign in button work', description: 'The button does nothing.', comments: [], priority: 2, teamId: 'team-orc', projectId: 'project-1' };
export const ORC13: FixtureTicket = { identifier: 'ORC-13', uuid: 'uuid-13', title: 'Tidy the footer', description: 'The footer links are out of order.', comments: [], priority: 3, teamId: 'team-orc', projectId: 'project-1' };
export const ORC14: FixtureTicket = { identifier: 'ORC-14', uuid: 'uuid-14', title: 'Fix the crash on launch', description: 'It closes straight away.', comments: [], priority: 1, teamId: 'team-orc', projectId: 'project-1' };

/** James's saved rules for one team of his own, allowing the providers named. */
export const ownTeam = (teamId: string, providers: string[] = ['claude', 'codex']): PlanQueueLinearTeam => ({
  teamId, teamKey: teamId === 'team-orc' ? 'ORC' : 'COM', teamName: 'Team', ownership: 'own',
  startedStatus: { id: 's', name: 'In Progress', kind: 'started' }, handBackStatus: { id: 'h', name: 'Todo', kind: 'unstarted' },
  landedStatus: { id: 'l', name: 'In Review', kind: 'started' }, doneStatus: { id: 'd', name: 'Done', kind: 'completed' }, providers,
});

export class LinearFixture {
  /** Rows the list shows that a test changes: a row that cannot be ticked, a team that is not ready. */
  readonly rowOverrides = new Map<string, Partial<DiscoveryRow>>();
  readonly teamOverrides = new Map<string, Partial<DiscoveryTeam>>();
  rules: PlanQueueLinearTeam[] = [ownTeam('team-orc')];
  readonly service: LinearPreviewService;
  discoveries = 0;

  private constructor(readonly connector: FakeLinearConnector, readonly deps: LinearCallDependencies, readonly tickets: Map<string, FixtureTicket>, folder: string, now: () => number) {
    this.service = new LinearPreviewService({
      discover: async () => this.discover(folder),
      readText: (identifier, counter) => readTicketText(identifier, counter, this.deps),
      readTeams: () => this.rules,
      providerLabel: (id) => id,
      now,
    });
  }

  static async start(tickets: readonly FixtureTicket[], folder: string, now: () => number = Date.now): Promise<LinearFixture> {
    const store = new Map(tickets.map((ticket) => [ticket.identifier, { ...ticket, comments: [...ticket.comments] }]));
    const detail = (ticket: FixtureTicket) => ({
      id: ticket.identifier, uuid: ticket.uuid, title: ticket.title, url: `https://linear.example.test/issue/${ticket.identifier}`,
      priority: { value: ticket.priority, name: 'High' }, status: 'Todo', statusType: 'unstarted', labels: ['Harness'], assignee: null, assigneeId: null,
      project: 'Website', projectId: ticket.projectId, team: 'Team', teamId: ticket.teamId, parentId: null, description: ticket.description,
      relations: { blocks: [], blockedBy: [], relatedTo: [], duplicateOf: null }, attachments: [],
    });
    const connector = await startFakeLinearConnector({
      acceptedToken: 'PLACEHOLDER_TOKEN',
      tools: {
        get_issue: (args) => structured(detail(store.get(String(args['id']))!)),
        list_comments: (args) => structured({
          comments: store.get(String(args['issueId']))!.comments.map((comment) => ({
            id: comment.id, body: comment.body, author: { id: 'user-1', name: 'Alex Kim' }, onBehalfOf: null, parentId: null,
            createdAt: '2026-11-16T09:00:00.000Z', updatedAt: '2026-11-16T09:00:00.000Z',
          })),
          hasNextPage: false,
        }),
      },
    });
    const record = { id: 'c1', name: 'linear-test', kind: 'remote', transport: 'http', url: connector.url, autoConnect: true } as unknown as OrchestratorMcpServer;
    const deps: LinearCallDependencies = {
      readConnection: () => ({ connectorId: 'c1', userId: 'u1', userName: 'Test User', workspaceName: 'Test', confirmedAt: 1 }),
      getConnector: () => record,
      auth: { getAccessToken: async () => 'PLACEHOLDER_TOKEN', status: () => ({ state: 'signed-in' }) } as unknown as LinearCallDependencies['auth'],
      checkRecord: acceptingFakeAddress(connector),
      timeoutMs: 5000,
    };
    // The connector reads the fixture's own map, so an edit shows at once in the next read.
    return new LinearFixture(connector, deps, store, folder, now);
  }

  /** Changes a ticket in "Linear": the next read sees it. */
  edit(identifier: string, patch: Partial<FixtureTicket>): void { Object.assign(this.tickets.get(identifier)!, patch); }
  addComment(identifier: string, body: string): void {
    const ticket = this.tickets.get(identifier)!;
    ticket.comments.push({ id: `c${ticket.comments.length + 1}`, body });
  }

  /** The check before a session, reading as Linear holds the ticket now (the real read, through the connector). */
  readonly liveRead = (identifier: string): Promise<LiveTicketRead> => readLiveTicket(identifier, this.deps);

  private discover(folder: string): FolderDiscovery {
    this.discoveries += 1;
    const tickets = [...this.tickets.values()].sort((a, b) => (a.priority || 9) - (b.priority || 9));
    const rows = tickets.map((ticket): DiscoveryRow => ({
      id: ticket.uuid, identifier: ticket.identifier, title: ticket.title, priority: ticket.priority, assigneeName: null, labels: ['Harness'],
      teamId: ticket.teamId, projectId: ticket.projectId, ticked: true, canTick: true, waitingFor: [], reason: null, notes: [],
      ...this.rowOverrides.get(ticket.identifier),
    }));
    const teamIds = [...new Set(tickets.map((ticket) => ticket.teamId))];
    const teams = teamIds.map((teamId): DiscoveryTeam => ({
      teamId, teamKey: teamId === 'team-orc' ? 'ORC' : 'COM', ownership: this.rules.find((rule) => rule.teamId === teamId)?.ownership ?? null, ready: true, reasons: [],
      ...this.teamOverrides.get(teamId),
    }));
    void folder;
    return {
      rows, labelNote: null, teams,
      projects: [...new Set(tickets.map((ticket) => `${ticket.projectId}|${ticket.teamId}`))].map((key) => {
        const [id, teamId] = key.split('|');
        return { id, name: 'Website', teamId, teamKey: teamId === 'team-orc' ? 'ORC' : 'COM' };
      }),
    };
  }

  /** What the page's handler hands the start function, with the parts a test changes. */
  sources(over: Partial<LinearStartSources> = {}): LinearStartSources {
    return {
      preview: this.service,
      readTeams: () => this.rules,
      isTeamReady: async (teamId) => {
        const override = this.teamOverrides.get(teamId);
        return override?.ready === false ? { ready: false, reasons: [...(override.reasons ?? ['Not ready.'])] } : { ready: true };
      },
      connectionReason: () => null,
      ...over,
    };
  }

  /** Loads the list for the folder and reads every row's text, as the page does when James ticks each one. */
  async previewAll(folder: string, identifiers?: readonly string[]): Promise<{ previewId: string; rows: PlanQueueLinearPreviewRow[] }> {
    const preview = await this.service.load(folder);
    for (const row of preview.rows) if (!identifiers || identifiers.includes(row.identifier)) await this.service.loadText(preview.previewId, row.id);
    return { previewId: preview.previewId, rows: preview.rows };
  }

  async close(): Promise<void> {
    this.service._resetForTesting();
    await this.connector.close();
  }
}
