/**
 * Orchestrator doc-review MCP tools.
 *
 * Lets an agent hand a plan/spec/report to James for review without the manual
 * export/paste hop: `request_doc_review` registers an HTML artifact (already written
 * under the workspace's `.aio-review/` dir) as a pending review; James decides in-app and
 * the canonical feedback block arrives back as a user-role message. `get_doc_review_result`
 * is a poll variant for agents that prefer to pull.
 *
 * Both tools defer the work to injected functions (wired in `orchestrator-tools-step.ts`)
 * so this module never imports the DocReviewService or InstanceManager singletons.
 */

import {
  GetDocReviewResultToolPayloadSchema,
  RequestDocReviewToolPayloadSchema,
} from '@contracts/schemas/doc-review';
import type { DocReviewSession } from '@contracts/schemas/doc-review';
import type { McpServerToolDefinition } from './mcp-server-tools';

export interface RequestDocReviewArgs {
  instanceId: string;
  artifactPath: string;
  title: string;
  sourcePath?: string;
}

export type RequestDocReviewFn = (args: RequestDocReviewArgs) => Promise<{ reviewId: string }>;
export type GetDocReviewResultFn = (reviewId: string) => DocReviewSession | null;

export interface DocReviewToolContext {
  instanceId?: string | null;
  requestDocReview?: RequestDocReviewFn | null;
  getDocReviewResult?: GetDocReviewResultFn | null;
}

export function createDocReviewToolDefinitions(
  context: DocReviewToolContext,
): McpServerToolDefinition[] {
  return [
    {
      name: 'request_doc_review',
      description:
        'Ask James to review a plan, spec, audit, or decision doc. First write a self-contained HTML review artifact into the workspace\'s .aio-review/ directory (use the doc-review-artifact skill), then call this with its path. James reviews it in-app and his decisions arrive back here as a user message — the canonical "Document review feedback" block. Apply agreed changes to the Markdown source and re-render.',
      inputSchema: {
        type: 'object',
        properties: {
          artifact_path: {
            type: 'string',
            description:
              'Path to the review artifact HTML, inside the workspace .aio-review/ directory. Absolute or workspace-relative.',
          },
          title: {
            type: 'string',
            description: 'Short human title for the review (shown in the review pane).',
          },
          source_path: {
            type: 'string',
            description: 'Optional repo-relative path of the Markdown source the artifact renders.',
          },
        },
        required: ['artifact_path', 'title'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const parsed = RequestDocReviewToolPayloadSchema.parse(args);
        if (!context.instanceId) {
          throw new Error('request_doc_review requires a calling instance context');
        }
        if (!context.requestDocReview) {
          throw new Error('Doc-review is not available in this runtime');
        }
        const { reviewId } = await context.requestDocReview({
          instanceId: context.instanceId,
          artifactPath: parsed.artifact_path,
          title: parsed.title,
          sourcePath: parsed.source_path,
        });
        return {
          reviewId,
          status: 'pending',
          message:
            "Review requested. James will decide in-app; his decisions arrive here as a user message. You can also poll with get_doc_review_result.",
        };
      },
    },
    {
      name: 'get_doc_review_result',
      description:
        'Poll the status of a review created with request_doc_review. Returns pending until James decides, then the overall verdict and per-item decisions. Decisions also arrive automatically as a user message, so polling is optional.',
      inputSchema: {
        type: 'object',
        properties: {
          review_id: {
            type: 'string',
            description: 'The reviewId returned by request_doc_review.',
          },
        },
        required: ['review_id'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const parsed = GetDocReviewResultToolPayloadSchema.parse(args);
        if (!context.getDocReviewResult) {
          throw new Error('Doc-review is not available in this runtime');
        }
        const session = context.getDocReviewResult(parsed.review_id);
        if (!session) {
          return { found: false, reviewId: parsed.review_id };
        }
        return {
          found: true,
          reviewId: session.id,
          status: session.status,
          decided: session.status !== 'pending',
          overall: session.status === 'pending' ? null : session.status,
          decisions: session.decisions,
          generalComment: session.generalComment,
        };
      },
    },
  ];
}
