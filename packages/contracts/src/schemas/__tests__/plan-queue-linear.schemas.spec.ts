import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PLAN_QUEUE_LINEAR_CONNECTION, DEFAULT_PLAN_QUEUE_LINEAR_FOLDER_LINKS, DEFAULT_PLAN_QUEUE_LINEAR_TEAMS,
  PlanQueueLinearConnectionSchema, PlanQueueLinearFolderLinksSchema, PlanQueueLinearTeamsSchema,
} from '../plan-queue.schemas';

const connection = { connectorId: 'conn-1', userId: 'user-1', userName: 'Test User', workspaceName: 'Test Workspace', confirmedAt: 1794703053785 };

const project = (id: string, teamId = 'team-a', teamKey = 'AAA') => ({ id, name: `Project ${id}`, teamId, teamKey });
const link = (folder: string, projects: { priv?: string; clients?: string[] }) => ({
  folder,
  privateProject: projects.priv ? project(projects.priv) : null,
  clientProjects: (projects.clients ?? []).map((id) => project(id, 'team-c', 'CCC')),
});

const status = (id: string, kind: string) => ({ id, name: `Status ${id}`, kind });
const team = (overrides: Record<string, unknown> = {}) => ({
  teamId: 'team-a', teamKey: 'AAA', teamName: 'Team A', ownership: 'own',
  startedStatus: status('s1', 'started'), handBackStatus: status('s2', 'unstarted'),
  landedStatus: status('s3', 'started'), doneStatus: status('s4', 'completed'),
  providers: ['claude'],
  ...overrides,
});
const clientTeam = (overrides: Record<string, unknown> = {}) => team({ teamId: 'team-c', teamKey: 'CCC', ownership: 'client', doneStatus: null, ...overrides });

describe('Plan Queue Linear connection', () => {
  it('defaults to not set up and accepts null or one complete record', () => {
    expect(DEFAULT_PLAN_QUEUE_LINEAR_CONNECTION).toBeNull();
    expect(PlanQueueLinearConnectionSchema.safeParse(null).success).toBe(true);
    expect(PlanQueueLinearConnectionSchema.safeParse(connection).success).toBe(true);
  });

  it('refuses a record missing the connector or the user, so the two are never saved apart', () => {
    for (const field of ['connectorId', 'userId', 'userName', 'workspaceName', 'confirmedAt']) {
      const { [field]: _removed, ...rest } = connection as Record<string, unknown>;
      expect(PlanQueueLinearConnectionSchema.safeParse(rest).success, field).toBe(false);
    }
    expect(PlanQueueLinearConnectionSchema.safeParse({ ...connection, extra: 1 }).success).toBe(false);
    expect(PlanQueueLinearConnectionSchema.safeParse({ ...connection, confirmedAt: 0 }).success).toBe(false);
    expect(PlanQueueLinearConnectionSchema.safeParse({ ...connection, userName: 'x'.repeat(201) }).success).toBe(false);
  });
});

describe('Plan Queue Linear folder links', () => {
  it('defaults to an empty list and accepts a private project, client projects, or both', () => {
    expect(DEFAULT_PLAN_QUEUE_LINEAR_FOLDER_LINKS).toEqual([]);
    expect(PlanQueueLinearFolderLinksSchema.safeParse([]).success).toBe(true);
    expect(PlanQueueLinearFolderLinksSchema.safeParse([
      link('/work/shop', { priv: 'p1' }),
      link('/work/blog', { clients: ['p2'] }),
      link('C:\\work\\both', { priv: 'p3', clients: ['p4', 'p5'] }),
    ]).success).toBe(true);
  });

  it('refuses a folder that is not a full path', () => {
    expect(PlanQueueLinearFolderLinksSchema.safeParse([link('shop', { priv: 'p1' })]).success).toBe(false);
    expect(PlanQueueLinearFolderLinksSchema.safeParse([link('\\shop', { priv: 'p1' })]).success).toBe(false);
  });

  it('refuses two entries for the same folder, however it is spelled', () => {
    expect(PlanQueueLinearFolderLinksSchema.safeParse([link('/work/shop', { priv: 'p1' }), link('/work/shop', { priv: 'p2' })]).success).toBe(false);
    expect(PlanQueueLinearFolderLinksSchema.safeParse([link('/work/shop', { priv: 'p1' }), link('/work/base/../shop/', { priv: 'p2' })]).success).toBe(false);
    expect(PlanQueueLinearFolderLinksSchema.safeParse([link('/work/shop', { priv: 'p1' }), link('/work/shop-two', { priv: 'p2' })]).success).toBe(true);
  });

  it('refuses a Linear project linked to two folders, or listed twice in one entry', () => {
    expect(PlanQueueLinearFolderLinksSchema.safeParse([link('/work/a', { priv: 'p1' }), link('/work/b', { priv: 'p1' })]).success).toBe(false);
    expect(PlanQueueLinearFolderLinksSchema.safeParse([link('/work/a', { clients: ['p1'] }), link('/work/b', { clients: ['p2', 'p1'] })]).success).toBe(false);
    expect(PlanQueueLinearFolderLinksSchema.safeParse([link('/work/a', { priv: 'p1', clients: ['p1'] })]).success).toBe(false);
    expect(PlanQueueLinearFolderLinksSchema.safeParse([link('/work/a', { clients: ['p1', 'p1'] })]).success).toBe(false);
  });

  it('refuses an entry with no project, and a list of more than 100 entries', () => {
    expect(PlanQueueLinearFolderLinksSchema.safeParse([link('/work/a', {})]).success).toBe(false);
    const many = (count: number) => Array.from({ length: count }, (_, index) => link(`/work/f${index}`, { priv: `p${index}` }));
    expect(PlanQueueLinearFolderLinksSchema.safeParse(many(100)).success).toBe(true);
    expect(PlanQueueLinearFolderLinksSchema.safeParse(many(101)).success).toBe(false);
  });
});

describe('Plan Queue Linear team rules', () => {
  it('defaults to an empty list and accepts an own team and a client team', () => {
    expect(DEFAULT_PLAN_QUEUE_LINEAR_TEAMS).toEqual([]);
    expect(PlanQueueLinearTeamsSchema.safeParse([team(), clientTeam()]).success).toBe(true);
  });

  it('accepts an empty provider list, which means no provider', () => {
    expect(PlanQueueLinearTeamsSchema.safeParse([clientTeam({ providers: [] })]).success).toBe(true);
  });

  it('refuses a team listed twice', () => {
    expect(PlanQueueLinearTeamsSchema.safeParse([team(), team({ teamKey: 'BBB' })]).success).toBe(false);
  });

  it('refuses started and landed statuses that are not of the started kind', () => {
    expect(PlanQueueLinearTeamsSchema.safeParse([team({ startedStatus: status('x', 'unstarted') })]).success).toBe(false);
    expect(PlanQueueLinearTeamsSchema.safeParse([team({ landedStatus: status('x', 'completed') })]).success).toBe(false);
    expect(PlanQueueLinearTeamsSchema.safeParse([clientTeam({ landedStatus: status('x', 'completed') })]).success).toBe(false);
  });

  it('refuses a hand-back status that is not of the unstarted kind', () => {
    expect(PlanQueueLinearTeamsSchema.safeParse([team({ handBackStatus: status('x', 'started') })]).success).toBe(false);
    expect(PlanQueueLinearTeamsSchema.safeParse([team({ handBackStatus: status('x', 'backlog') })]).success).toBe(false);
  });

  it('refuses a done status on a client team', () => {
    expect(PlanQueueLinearTeamsSchema.safeParse([clientTeam({ doneStatus: status('d', 'completed') })]).success).toBe(false);
  });

  it('needs a completed-kind done status on an own team', () => {
    expect(PlanQueueLinearTeamsSchema.safeParse([team({ doneStatus: null })]).success).toBe(false);
    expect(PlanQueueLinearTeamsSchema.safeParse([team({ doneStatus: status('d', 'started') })]).success).toBe(false);
  });

  it('refuses a provider listed twice and a blank provider', () => {
    expect(PlanQueueLinearTeamsSchema.safeParse([team({ providers: ['claude', 'claude'] })]).success).toBe(false);
    expect(PlanQueueLinearTeamsSchema.safeParse([team({ providers: [' '] })]).success).toBe(false);
  });

  it('checks shape only, so a status that no longer exists in Linear is still accepted', () => {
    expect(PlanQueueLinearTeamsSchema.safeParse([team({ startedStatus: status('deleted-in-linear', 'started') })]).success).toBe(true);
  });
});
