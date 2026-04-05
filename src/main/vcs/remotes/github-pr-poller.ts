/**
 * GitHub PR Poller — Fetches CI status, review decisions, and merge state for PRs.
 *
 * Extends the existing GitHubConnector (which only fetches static metadata)
 * with the ability to poll for live CI/PR state. Used by the Reaction Engine.
 */

import { getLogger } from '../../logging/logger';
import type {
  PREnrichmentData,
  PRState,
  CIStatus,
  CICheck,
  ReviewDecision,
} from '../../../shared/types/reaction.types';

const logger = getLogger('GitHubPRPoller');

function getAuthHeaders(): Record<string, string> {
  const token = process.env['GITHUB_TOKEN']?.trim();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

async function fetchGitHubJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ai-orchestrator',
      ...getAuthHeaders(),
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API ${response.status}: ${url}`);
  }

  return response.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Individual fetchers
// ---------------------------------------------------------------------------

interface GitHubPRPayload {
  state: string;
  merged: boolean;
  draft: boolean;
  mergeable: boolean | null;
  mergeable_state: string;
  head: { ref: string; sha: string };
  base: { ref: string };
  updated_at: string;
}

function mapPRState(payload: GitHubPRPayload): PRState {
  if (payload.merged) return 'merged';
  if (payload.state === 'closed') return 'closed';
  if (payload.draft) return 'draft';
  return 'open';
}

interface GitHubCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  started_at: string | null;
  completed_at: string | null;
}

interface GitHubCheckSuiteResponse {
  total_count: number;
  check_runs: GitHubCheckRun[];
}

function mapCICheck(run: GitHubCheckRun): CICheck {
  let status: CIStatus = 'unknown';
  if (run.status === 'completed') {
    status = run.conclusion === 'success' ? 'passing' : 'failing';
  } else if (run.status === 'in_progress' || run.status === 'queued') {
    status = 'pending';
  }

  return {
    name: run.name,
    status,
    conclusion: run.conclusion ?? undefined,
    url: run.html_url,
    startedAt: run.started_at ? new Date(run.started_at).getTime() : undefined,
    completedAt: run.completed_at ? new Date(run.completed_at).getTime() : undefined,
  };
}

function summarizeCIStatus(checks: CICheck[]): CIStatus {
  if (checks.length === 0) return 'unknown';
  if (checks.some((c) => c.status === 'failing')) return 'failing';
  if (checks.some((c) => c.status === 'pending')) return 'pending';
  if (checks.every((c) => c.status === 'passing')) return 'passing';
  return 'unknown';
}

interface GitHubReviewPayload {
  state: string;
  user: { login: string };
  submitted_at: string;
}

function deriveReviewDecision(reviews: GitHubReviewPayload[]): ReviewDecision {
  if (reviews.length === 0) return 'none';

  // Group by reviewer, keep only latest review per person
  const latestByReviewer = new Map<string, string>();
  for (const review of reviews) {
    const login = review.user.login;
    // Reviews are returned chronologically — last one wins
    if (review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED') {
      latestByReviewer.set(login, review.state);
    }
  }

  if (latestByReviewer.size === 0) return 'review_required';

  const decisions = [...latestByReviewer.values()];
  if (decisions.some((d) => d === 'CHANGES_REQUESTED')) return 'changes_requested';
  if (decisions.every((d) => d === 'APPROVED')) return 'approved';
  return 'review_required';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch enriched PR data for a single PR.
 * Makes 3 API calls: PR details, check runs, reviews.
 */
export async function fetchPREnrichment(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<PREnrichmentData> {
  const baseUrl = `https://api.github.com/repos/${owner}/${repo}`;
  const prUrl = `${baseUrl}/pulls/${prNumber}`;

  // Fetch PR details and reviews in parallel first
  const [prPayload, reviewsPayload] = await Promise.all([
    fetchGitHubJson<GitHubPRPayload>(prUrl),
    fetchGitHubJson<GitHubReviewPayload[]>(`${prUrl}/reviews`),
  ]);

  // Fetch check-runs using the head SHA from the PR payload
  let ciChecks: CICheck[] = [];
  try {
    const sha = prPayload.head.sha;
    const checksPayload = await fetchGitHubJson<GitHubCheckSuiteResponse>(
      `${baseUrl}/commits/${sha}/check-runs`,
    );
    ciChecks = checksPayload.check_runs.map(mapCICheck);
  } catch (err) {
    logger.warn('Failed to fetch CI checks', { owner, repo, prNumber, error: String(err) });
  }

  const state = mapPRState(prPayload);
  const ciStatus = summarizeCIStatus(ciChecks);
  const reviewDecision = deriveReviewDecision(reviewsPayload);
  const mergeable = prPayload.mergeable ?? false;
  const hasConflicts = prPayload.mergeable_state === 'dirty';

  return {
    owner,
    repo,
    number: prNumber,
    url: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
    state,
    ciStatus,
    ciChecks,
    reviewDecision,
    mergeable,
    hasConflicts,
    headBranch: prPayload.head.ref,
    baseBranch: prPayload.base.ref,
    updatedAt: new Date(prPayload.updated_at).getTime(),
    fetchedAt: Date.now(),
  };
}

/**
 * Batch-fetch enrichment data for multiple PRs.
 * Returns a Map keyed by "owner/repo#number".
 */
export async function fetchPREnrichmentBatch(
  prs: { owner: string; repo: string; number: number }[],
): Promise<Map<string, PREnrichmentData>> {
  const results = new Map<string, PREnrichmentData>();

  // Fetch all PRs in parallel with concurrency limit
  const CONCURRENCY = 5;
  const queue = [...prs];

  while (queue.length > 0) {
    const batch = queue.splice(0, CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(async (pr) => {
        const data = await fetchPREnrichment(pr.owner, pr.repo, pr.number);
        const key = `${pr.owner}/${pr.repo}#${pr.number}`;
        return { key, data };
      }),
    );

    for (const result of settled) {
      if (result.status === 'fulfilled') {
        results.set(result.value.key, result.value.data);
      } else {
        logger.warn('Failed to fetch PR enrichment', { error: String(result.reason) });
      }
    }
  }

  return results;
}

/**
 * Format CI failure details into a human-readable message
 * suitable for sending to an agent.
 */
export function formatCIFailureMessage(checks: CICheck[]): string {
  const failing = checks.filter((c) => c.status === 'failing');
  if (failing.length === 0) return 'CI is green.';

  const lines = ['CI has failing checks:', ''];
  for (const check of failing) {
    const conclusion = check.conclusion ? ` (${check.conclusion})` : '';
    const url = check.url ? ` — ${check.url}` : '';
    lines.push(`  - ${check.name}${conclusion}${url}`);
  }

  lines.push('', 'Please investigate and fix the failing checks.');
  return lines.join('\n');
}

/**
 * Format review comments into a message for the agent.
 */
export function formatReviewMessage(decision: ReviewDecision): string {
  switch (decision) {
    case 'changes_requested':
      return 'Changes have been requested on this PR. Please review the comments and address the feedback.';
    case 'approved':
      return 'This PR has been approved.';
    default:
      return 'Review is pending on this PR.';
  }
}
