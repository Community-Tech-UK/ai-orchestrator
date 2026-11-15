import { describe, expect, it } from 'vitest';
import {
  LinearProjectsPageSchema,
  LinearStatusListSchema,
  LinearTeamsPageSchema,
  LinearUsersPageSchema,
  LinearWhoAmISchema,
} from './linear-result-schemas';

// Shapes copied (field names only, placeholder values) from what the connector returned on 15 November 2026.
describe('Linear result schemas', () => {
  it('reads the connector\'s who-am-I answer and ignores fields it adds', () => {
    const parsed = LinearWhoAmISchema.parse({
      user: { id: 'u1', name: 'A Person', email: 'a@example.test', displayName: 'a', isAdmin: true },
      workspace: { id: 'w1', name: 'Workspace', url: 'https://example.test' },
      connection: { client: 'Harness', access: 'all' },
    });
    expect(parsed.user.id).toBe('u1');
    expect(parsed.workspace.name).toBe('Workspace');
  });

  it('requires the fields Harness reads', () => {
    expect(LinearWhoAmISchema.safeParse({ user: { id: 'u1', name: 'A' }, workspace: { id: 'w', name: 'W' } }).success).toBe(false);
    expect(LinearWhoAmISchema.safeParse({ user: { id: '', name: 'A', email: 'e' }, workspace: { id: 'w', name: 'W' } }).success).toBe(false);
  });

  it('caps every name at 200 characters', () => {
    const long = 'x'.repeat(201);
    expect(LinearWhoAmISchema.safeParse({ user: { id: 'u', name: long, email: 'e' }, workspace: { id: 'w', name: 'W' } }).success).toBe(false);
    expect(LinearStatusListSchema.safeParse([{ id: 's', name: long, type: 'started' }]).success).toBe(false);
    expect(LinearTeamsPageSchema.safeParse({ teams: [{ id: 't', key: 'K', name: long }], hasNextPage: false }).success).toBe(false);
    expect(LinearProjectsPageSchema.safeParse({ projects: [{ id: 'p', name: long, teams: [] }], hasNextPage: false }).success).toBe(false);
    expect(LinearUsersPageSchema.safeParse({ users: [{ id: 'u', name: long }], hasNextPage: false }).success).toBe(false);
  });

  it('reads teams with and without a reported visibility, and pages without a cursor on the last page', () => {
    const parsed = LinearTeamsPageSchema.parse({
      teams: [
        { id: 't1', key: 'AAA', name: 'One', visibility: 'private', parentId: null },
        { id: 't2', key: 'BBB', name: 'Two', parentId: 't1' },
      ],
      hasNextPage: false,
    });
    expect(parsed.teams[0].visibility).toBe('private');
    expect(parsed.teams[1].visibility).toBeUndefined();
    expect(LinearTeamsPageSchema.safeParse({ teams: [] }).success).toBe(false);
  });

  it('reads the bare status list and a project with its teams', () => {
    expect(LinearStatusListSchema.parse([{ id: 's1', type: 'started', name: 'In Progress' }])).toHaveLength(1);
    expect(LinearStatusListSchema.safeParse({ statuses: [] }).success).toBe(false);
    expect(LinearProjectsPageSchema.parse({
      projects: [{ id: 'P-1', name: 'Project', teams: [{ id: 't', key: 'K', name: 'T' }] }],
      hasNextPage: true,
      cursor: 'next',
    }).projects[0].teams[0].key).toBe('K');
    expect(LinearProjectsPageSchema.safeParse({ projects: [{ id: 'P-1', name: 'Project' }], hasNextPage: false }).success).toBe(false);
  });
});
