import { ChangeDetectionStrategy, Component } from '@angular/core';
import { HOOK_EVENTS } from '../../../../shared/types/hook.types';
import type { HookEvent } from '../../../../shared/types/hook.types';

interface HookEventReference {
  event: HookEvent;
  when: string;
  fields: readonly string[];
  example: string;
}

const DETAIL_BY_EVENT: Record<HookEvent, Omit<HookEventReference, 'event'>> = {
  PreToolUse: {
    when: 'Before a tool operation is accepted.',
    fields: ['toolName', 'toolInput', 'filePath', 'command', 'workingDirectory'],
    example: 'Block destructive shell commands or writes outside the project.',
  },
  PostToolUse: {
    when: 'After tool output is streamed back.',
    fields: ['toolName', 'toolOutput', 'content', 'workingDirectory'],
    example: 'Warn when a command returns an error marker.',
  },
  PreSampling: {
    when: 'Before user content is sent to the model.',
    fields: ['userPrompt', 'content', 'messageCount', 'estimatedTokens'],
    example: 'Block prompts that include private tokens or forbidden paths.',
  },
  PostSampling: {
    when: 'After a model response is received.',
    fields: ['modelResponse', 'responseTokens', 'modelId'],
    example: 'Log large responses or flag unsafe suggested commands.',
  },
  Stop: {
    when: 'When an instance completes normally.',
    fields: ['stopReason', 'transcript', 'workingDirectory'],
    example: 'Archive final transcript metadata.',
  },
  StopFailure: {
    when: 'When an adapter error or failed process exit stops an instance.',
    fields: ['stopReason', 'errorMessage', 'errorProvider', 'workingDirectory'],
    example: 'Notify on provider outage or repeated CLI crash.',
  },
  PostCompact: {
    when: 'After context compaction succeeds.',
    fields: ['compactionMethod', 'compactionSuccess', 'previousContextUsage'],
    example: 'Persist a compaction metric or add a session note.',
  },
  CwdChanged: {
    when: 'When a chat or instance working directory changes.',
    fields: ['oldCwd', 'newCwd', 'workingDirectory'],
    example: 'Warn when switching into a production checkout.',
  },
  FileChanged: {
    when: 'When a watched file edit is detected.',
    fields: ['changedPath', 'changedRelativePath', 'changeType', 'filePath'],
    example: 'Run a targeted formatter for changed TypeScript files.',
  },
  SessionStart: {
    when: 'After a new instance starts successfully.',
    fields: ['sessionId', 'workingDirectory'],
    example: 'Seed per-session audit files.',
  },
  SessionEnd: {
    when: 'When an instance is terminated.',
    fields: ['sessionId', 'stopReason', 'workingDirectory'],
    example: 'Write a session-end summary with duration and exit reason.',
  },
  BeforeCommit: {
    when: 'Before the app invokes git commit from Source Control.',
    fields: ['command', 'userPrompt', 'content', 'workingDirectory'],
    example: 'Block the commit unless npm run lint or tests pass.',
  },
  UserPromptSubmit: {
    when: 'Before a user prompt is submitted to an instance.',
    fields: ['userPrompt', 'content', 'workingDirectory'],
    example: 'Require review for prompts that mention production credentials.',
  },
};

const EVENT_REFERENCES: readonly HookEventReference[] = HOOK_EVENTS.map((event) => ({
  event,
  ...DETAIL_BY_EVENT[event],
}));
const INTERPOLATION_TOKENS = ['${file}', '${tool}', '${command}', '${cwd}', '${instanceId}'] as const;

@Component({
  selector: 'app-hook-event-reference',
  standalone: true,
  template: `
    <div class="reference-card">
      <div class="panel-title">Event Reference</div>
      <div class="reference-note">
        Rules match payload fields. Command hooks inherit process env plus hook env, and external executables receive the full payload as JSON on stdin.
      </div>
      <div class="interpolation">
        Interpolation:
        @for (token of interpolationTokens; track token) {
          <code>{{ token }}</code>
        }
      </div>

      <div class="events-list">
        @for (item of events; track item.event) {
          <details class="event-row">
            <summary>
              <span class="event-name">{{ item.event }}</span>
              <span class="event-when">{{ item.when }}</span>
            </summary>
            <div class="field-list">
              @for (field of item.fields; track field) {
                <code>{{ field }}</code>
              }
            </div>
            <div class="example">{{ item.example }}</div>
          </details>
        }
      </div>
    </div>
  `,
  styles: [`
    :host {
      display: block;
    }

    .reference-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: var(--spacing-md);
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
    }

    .panel-title {
      font-size: 13px;
      font-weight: 700;
      color: var(--text-primary);
    }

    .reference-note,
    .interpolation,
    .example {
      font-size: 12px;
      line-height: 1.45;
      color: var(--text-secondary);
    }

    .interpolation {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
    }

    code {
      font-family: var(--font-mono);
      font-size: 11px;
      border: 1px solid var(--border-color);
      border-radius: 4px;
      padding: 2px 5px;
      background: var(--bg-primary);
      color: var(--text-primary);
    }

    .events-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      max-height: 360px;
      overflow: auto;
      padding-right: 2px;
    }

    .event-row {
      border: 1px solid var(--border-color);
      border-radius: 6px;
      background: var(--bg-primary);
      padding: 8px;
    }

    summary {
      cursor: pointer;
      display: grid;
      grid-template-columns: 130px 1fr;
      gap: 8px;
      align-items: start;
      list-style-position: outside;
    }

    .event-name {
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--accent-primary);
    }

    .event-when {
      font-size: 12px;
      color: var(--text-secondary);
    }

    .field-list {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      margin-top: 8px;
    }

    .example {
      margin-top: 8px;
    }

    @media (max-width: 980px) {
      summary {
        grid-template-columns: 1fr;
      }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HookEventReferenceComponent {
  readonly events = EVENT_REFERENCES;
  readonly interpolationTokens = INTERPOLATION_TOKENS;
}
