import * as os from 'os';
import * as path from 'path';
import type { OperatorNodeType } from '../../shared/types/operator.types';

export type OperatorIntent =
  | 'global_question'
  | 'project_feature'
  | 'project_audit'
  | 'workspace_git_batch'
  | 'cross_project_research'
  | 'ambiguous';

export interface OperatorRequestPlan {
  intent: OperatorIntent;
  executor: OperatorNodeType;
  needsRun: boolean;
  title: string;
  confidence: number;
  risk: 'low' | 'medium' | 'high';
  successCriteria: string[];
  rootPath?: string;
  projectQuery?: string;
  projectGoal?: string;
  maxConcurrentNodes: number;
}

export interface OperatorPlannerOptions {
  resolveWorkRoot?: (text: string) => string;
}

export function planOperatorRequest(
  text: string,
  options: OperatorPlannerOptions = {},
): OperatorRequestPlan {
  const trimmed = text.trim();
  const resolveWorkRoot = options.resolveWorkRoot ?? defaultOperatorWorkRoot;

  if (isPullAllReposRequest(trimmed)) {
    return {
      intent: 'workspace_git_batch',
      executor: 'git-batch',
      needsRun: true,
      title: 'Pull repositories',
      confidence: 0.95,
      risk: 'medium',
      rootPath: resolveWorkRoot(trimmed),
      maxConcurrentNodes: 6,
      successCriteria: [
        'Fetch and fast-forward clean tracking repositories',
        'Skip dirty, divergent, detached, no-remote, and no-upstream repositories with reasons',
        'Summarize per-repository outcomes',
      ],
    };
  }

  if (isCrossProjectResearchRequest(trimmed)) {
    return {
      intent: 'cross_project_research',
      executor: 'project-agent',
      needsRun: true,
      title: 'Research projects',
      confidence: 0.78,
      risk: 'medium',
      rootPath: resolveWorkRoot(trimmed),
      maxConcurrentNodes: 3,
      projectGoal: trimmed,
      successCriteria: [
        'Inspect each resolved project with bounded workers',
        'Collect project-level findings',
        'Synthesize common themes and per-project outcomes',
      ],
    };
  }

  const projectTask = parseProjectTaskRequest(trimmed);
  if (projectTask) {
    const audit = projectTask.intent === 'project_audit';
    return {
      intent: projectTask.intent,
      executor: audit ? 'repo-job' : 'project-agent',
      needsRun: true,
      title: audit ? `Audit ${projectTask.projectQuery}` : `Implement in ${projectTask.projectQuery}`,
      confidence: projectTask.confidence,
      risk: audit ? 'low' : 'high',
      projectQuery: projectTask.projectQuery,
      projectGoal: projectTask.goal,
      maxConcurrentNodes: 1,
      successCriteria: audit
        ? ['Resolve the target project', 'Run a repository health audit', 'Return prioritized findings']
        : ['Resolve the target project', 'Delegate implementation', 'Run verification', 'Repair failed verification within budget'],
    };
  }

  return {
    intent: 'global_question',
    executor: 'synthesis',
    needsRun: false,
    title: 'Conversation',
    confidence: 0.5,
    risk: 'low',
    maxConcurrentNodes: 0,
    successCriteria: ['Respond in the existing global conversation without launching work'],
  };
}

function isPullAllReposRequest(text: string): boolean {
  const normalized = text.toLowerCase();
  return /\bpull\b/.test(normalized)
    && /\brepos?\b|\brepositories\b/.test(normalized);
}

function isCrossProjectResearchRequest(text: string): boolean {
  const normalized = text.toLowerCase();
  return /\b(all|multiple|each|every)\b/.test(normalized)
    && /\b(repos?|repositories|projects)\b/.test(normalized)
    && /\b(review|audit|research|inspect|improve|improvements|synth(?:esize|esise)|summarize|summarise)\b/.test(normalized)
    && !/\bpull\b/.test(normalized);
}

function parseProjectTaskRequest(
  text: string,
): { projectQuery: string; goal: string; intent: 'project_feature' | 'project_audit'; confidence: number } | null {
  const explicitPrefix = text.match(/^\s*in\s+([^,]+),\s*(.+)$/i);
  if (explicitPrefix) {
    const projectQuery = explicitPrefix[1].trim();
    const goal = explicitPrefix[2].trim();
    if (
      projectQuery
      && goal
      && /\b(implement|build|add|allow|create|fix|change|update)\b/i.test(goal)
    ) {
      return { projectQuery, goal, intent: 'project_feature', confidence: 0.9 };
    }
  }

  const suffixFeature = text.match(/^\s*((?:implement|build|add|allow|create|fix|change|update)\b.+?)\s+in\s+(.+?)\s*$/i);
  if (suffixFeature) {
    const goal = suffixFeature[1].trim();
    const projectQuery = cleanProjectQuery(suffixFeature[2]);
    if (projectQuery && !/^(?:the\s+)?projects?$/i.test(projectQuery)) {
      return { projectQuery, goal, intent: 'project_feature', confidence: 0.82 };
    }
  }

  const directAudit = text.match(/\b(?:audit|review|inspect)\s+(?:the\s+)?(.+?)\s+p(?:roject|lroject)s?\b/i);
  if (directAudit) {
    const projectQuery = cleanProjectQuery(directAudit[1]);
    if (projectQuery) {
      return { projectQuery, goal: text.trim(), intent: 'project_audit', confidence: 0.8 };
    }
  }

  const projectMention = text.match(/\b(?:in|for)\s+(?:the\s+)?(.+?)\s+p(?:roject|lroject)s?\b/i);
  if (!projectMention) {
    return null;
  }
  const projectQuery = cleanProjectQuery(projectMention[1]);
  if (!projectQuery) {
    return null;
  }

  if (/\b(audit|improve|improvements|go through|review|list|do some work)\b/i.test(text)) {
    return { projectQuery, goal: text.trim(), intent: 'project_audit', confidence: 0.76 };
  }

  if (/\b(implement|build|add|allow|create|fix|change|update)\b/i.test(text)) {
    return { projectQuery, goal: text.trim(), intent: 'project_feature', confidence: 0.74 };
  }

  return null;
}

function cleanProjectQuery(value: string): string {
  return value.trim()
    .replace(/^(?:the\s+)/i, '')
    .replace(/\s+p(?:roject|lroject)s?$/i, '')
    .trim();
}

export function defaultOperatorWorkRoot(text: string): string {
  if (/\bwork folder\b|\bwork directory\b|\bwork dir\b/.test(text.toLowerCase())) {
    return path.join(os.homedir(), 'work');
  }
  return process.cwd();
}
