/**
 * Linear's teams and the projects in each, for the folder-link editor's pickers. Names and ids only: no ticket is
 * read. A read, through the one Linear call function, on the connection James confirmed; every page is read or the
 * whole list fails (`readAllLinearPages`), so the editor never offers a partial list as if it were whole.
 */
import type { PlanQueueLinearProjectChoices, PlanQueueLinearTeamProjects } from '@contracts/schemas/plan-queue';
import { callLinearTool, type LinearCallDependencies } from './linear-call';
import { readAllLinearPages, toLinearPage } from './linear-paging';
import { LinearProjectsPageSchema, type LinearProject } from './linear-result-schemas';

/** Linear's most results per page for this tool. */
const PAGE_SIZE = 50;

export async function listLinearProjectChoices(dependencies?: LinearCallDependencies): Promise<PlanQueueLinearProjectChoices> {
  const projects = await readAllLinearPages<LinearProject>(async (cursor) => {
    const page = await callLinearTool(
      'list_projects',
      { fields: ['teams'], limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) },
      LinearProjectsPageSchema,
      dependencies,
    );
    return toLinearPage(page.projects, page);
  });
  return { teams: groupByTeam(projects) };
}

/** A project that belongs to two teams is offered under each, so the saved link names the team it was picked from. */
function groupByTeam(projects: readonly LinearProject[]): PlanQueueLinearTeamProjects[] {
  const teams = new Map<string, PlanQueueLinearTeamProjects>();
  for (const project of projects) {
    for (const team of project.teams) {
      const entry = teams.get(team.id) ?? { teamId: team.id, teamKey: team.key, teamName: team.name, projects: [] };
      if (!entry.projects.some((listed) => listed.id === project.id)) entry.projects.push({ id: project.id, name: project.name });
      teams.set(team.id, entry);
    }
  }
  return [...teams.values()]
    .map((team) => ({ ...team, projects: team.projects.sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => a.teamKey.localeCompare(b.teamKey));
}
