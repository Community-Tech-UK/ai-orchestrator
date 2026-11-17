/**
 * Plan Queue IPC handlers for the Linear connection: list the connectors at Linear's address, identify who one signs
 * in as, confirm and save the connection, forget it, and check it now. IPC callers are the operator on the Plan Queue
 * page; agents have no route here. A failure message is fixed words written by Harness, never Linear's own text.
 *
 * The Start preview's two channels (load a folder's list, load one ticket's text) are here too. They answer the page
 * only: the preview service holds ticket text in memory, and no tool, command or session method reaches it.
 *
 * It also holds the folder-link channels: Linear's teams and projects for the editor, the saved links with their live
 * state, and the one checked save. The links' settings key is written only by that save.
 */
import { IPC_CHANNELS } from '@contracts/channels';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  PlanQueueLinearConfirmPayloadSchema,
  PlanQueueLinearIdentifyPayloadSchema,
  PlanQueueLinearLinksSavePayloadSchema,
  PlanQueueLinearNoPayloadSchema,
  PlanQueueLinearPreviewLoadPayloadSchema,
  PlanQueueLinearPreviewTextPayloadSchema,
  PlanQueueLinearTeamsSavePayloadSchema,
} from '@contracts/schemas/plan-queue';
import { getSettingsManager } from '../../core/config/settings-manager';
import { getLinearConnectionService } from '../../plan-queue/linear/linear-connection-singleton';
import { isLinearCallError } from '../../plan-queue/linear/linear-errors';
import { getLinearFolderLinkService } from '../../plan-queue/linear/linear-folder-links-singleton';
import { listLinearProjectChoices } from '../../plan-queue/linear/linear-project-list';
import { getLinearPreviewService } from '../../plan-queue/linear/linear-preview-singleton';
import { isLinearDiscoveryFailure } from '../../plan-queue/linear/linear-ticket-reader';
import { getLinearTeamRuleService } from '../../plan-queue/linear/linear-team-rules-singleton';
import type { WindowManager } from '../../window-manager';
import { broadcastSettingsChanged } from './settings-broadcast';
import { handle } from './plan-queue-ipc-helpers';

export function registerPlanQueueLinearHandlers(deps: { windowManager: Pick<WindowManager, 'sendToRenderer'> }): void {
  const service = getLinearConnectionService();
  // The page watches the setting, so a save from here is announced the way the settings handlers announce theirs.
  const announceSaved = (): void =>
    broadcastSettingsChanged(deps.windowManager, {
      key: 'planQueueLinearConnection',
      value: getSettingsManager().get('planQueueLinearConnection') ?? null,
    });

  handle(IPC_CHANNELS.PLAN_QUEUE_LINEAR_LIST, 'PLAN_QUEUE_LINEAR_LIST_FAILED', (payload) => {
    validateIpcPayload(PlanQueueLinearNoPayloadSchema, payload ?? {}, 'PLAN_QUEUE_LINEAR_LIST');
    return service.list();
  });

  handle(IPC_CHANNELS.PLAN_QUEUE_LINEAR_IDENTIFY, 'PLAN_QUEUE_LINEAR_IDENTIFY_FAILED', (payload) => {
    const validated = validateIpcPayload(PlanQueueLinearIdentifyPayloadSchema, payload, 'PLAN_QUEUE_LINEAR_IDENTIFY');
    return service.identify(validated.connectorId);
  });

  handle(IPC_CHANNELS.PLAN_QUEUE_LINEAR_CONFIRM, 'PLAN_QUEUE_LINEAR_CONFIRM_FAILED', async (payload) => {
    const validated = validateIpcPayload(PlanQueueLinearConfirmPayloadSchema, payload, 'PLAN_QUEUE_LINEAR_CONFIRM');
    const connection = await service.confirm(validated.connectorId, validated.userId);
    announceSaved();
    return connection;
  });

  handle(IPC_CHANNELS.PLAN_QUEUE_LINEAR_FORGET, 'PLAN_QUEUE_LINEAR_FORGET_FAILED', (payload) => {
    validateIpcPayload(PlanQueueLinearNoPayloadSchema, payload ?? {}, 'PLAN_QUEUE_LINEAR_FORGET');
    const connection = service.forget();
    announceSaved();
    return connection;
  });

  handle(IPC_CHANNELS.PLAN_QUEUE_LINEAR_CHECK, 'PLAN_QUEUE_LINEAR_CHECK_FAILED', (payload) => {
    validateIpcPayload(PlanQueueLinearNoPayloadSchema, payload ?? {}, 'PLAN_QUEUE_LINEAR_CHECK');
    return service.check();
  });

  const links = getLinearFolderLinkService();

  // A failed Linear read is checked again at once, as every Linear caller does, and only Harness's own words go back.
  const readLinear = async <T>(read: () => Promise<T>): Promise<T> => {
    try {
      return await read();
    } catch (error) {
      if (!isLinearCallError(error)) throw error;
      if (error.code !== 'not-set-up') service.noteCallFailure();
      throw new Error(error.message);
    }
  };

  handle(IPC_CHANNELS.PLAN_QUEUE_LINEAR_PROJECTS, 'PLAN_QUEUE_LINEAR_PROJECTS_FAILED', (payload) => {
    validateIpcPayload(PlanQueueLinearNoPayloadSchema, payload ?? {}, 'PLAN_QUEUE_LINEAR_PROJECTS');
    return readLinear(() => listLinearProjectChoices());
  });

  handle(IPC_CHANNELS.PLAN_QUEUE_LINEAR_LINKS, 'PLAN_QUEUE_LINEAR_LINKS_FAILED', (payload) => {
    validateIpcPayload(PlanQueueLinearNoPayloadSchema, payload ?? {}, 'PLAN_QUEUE_LINEAR_LINKS');
    return links.readAll().then((readings) => ({ links: readings }));
  });

  handle(IPC_CHANNELS.PLAN_QUEUE_LINEAR_LINKS_SAVE, 'PLAN_QUEUE_LINEAR_LINKS_SAVE_FAILED', async (payload) => {
    const validated = validateIpcPayload(PlanQueueLinearLinksSavePayloadSchema, payload, 'PLAN_QUEUE_LINEAR_LINKS_SAVE');
    const result = await links.save(validated.links);
    if (result.saved) {
      broadcastSettingsChanged(deps.windowManager, {
        key: 'planQueueLinearFolderLinks',
        value: getSettingsManager().get('planQueueLinearFolderLinks') ?? [],
      });
    }
    return result;
  });

  const teams = getLinearTeamRuleService();

  handle(IPC_CHANNELS.PLAN_QUEUE_LINEAR_TEAM_CHOICES, 'PLAN_QUEUE_LINEAR_TEAM_CHOICES_FAILED', (payload) => {
    validateIpcPayload(PlanQueueLinearNoPayloadSchema, payload ?? {}, 'PLAN_QUEUE_LINEAR_TEAM_CHOICES');
    return readLinear(() => teams.choices());
  });

  handle(IPC_CHANNELS.PLAN_QUEUE_LINEAR_TEAMS_CHECK, 'PLAN_QUEUE_LINEAR_TEAMS_CHECK_FAILED', (payload) => {
    validateIpcPayload(PlanQueueLinearNoPayloadSchema, payload ?? {}, 'PLAN_QUEUE_LINEAR_TEAMS_CHECK');
    return readLinear(() => teams.checkTeams());
  });

  handle(IPC_CHANNELS.PLAN_QUEUE_LINEAR_TEAMS_SAVE, 'PLAN_QUEUE_LINEAR_TEAMS_SAVE_FAILED', async (payload) => {
    const validated = validateIpcPayload(PlanQueueLinearTeamsSavePayloadSchema, payload, 'PLAN_QUEUE_LINEAR_TEAMS_SAVE');
    const result = await readLinear(() => teams.save(validated.teams));
    if (result.saved) {
      broadcastSettingsChanged(deps.windowManager, {
        key: 'planQueueLinearTeams',
        value: getSettingsManager().get('planQueueLinearTeams') ?? [],
      });
    }
    return result;
  });

  // A failed preview read is checked again at once like every Linear read, unless it was Harness's own refusal.
  const HARNESS_OWN_REFUSALS = new Set(['not-set-up', 'not-linked', 'broken-link', 'connection-paused', 'call-limit']);
  const readPreview = async <T>(read: () => Promise<T>): Promise<T> => {
    try {
      return await read();
    } catch (error) {
      // A text read fails with the call's own error; a list read, with the discovery's, which wraps it.
      if (isLinearCallError(error) && error.code !== 'not-set-up') service.noteCallFailure();
      if (isLinearDiscoveryFailure(error) && !HARNESS_OWN_REFUSALS.has(error.code)) service.noteCallFailure();
      throw error;
    }
  };

  const preview = getLinearPreviewService();

  handle(IPC_CHANNELS.PLAN_QUEUE_LINEAR_PREVIEW_LOAD, 'PLAN_QUEUE_LINEAR_PREVIEW_LOAD_FAILED', (payload) => {
    const validated = validateIpcPayload(PlanQueueLinearPreviewLoadPayloadSchema, payload, 'PLAN_QUEUE_LINEAR_PREVIEW_LOAD');
    return readPreview(() => preview.load(validated.folder));
  });

  handle(IPC_CHANNELS.PLAN_QUEUE_LINEAR_PREVIEW_TEXT, 'PLAN_QUEUE_LINEAR_PREVIEW_TEXT_FAILED', (payload) => {
    const validated = validateIpcPayload(PlanQueueLinearPreviewTextPayloadSchema, payload, 'PLAN_QUEUE_LINEAR_PREVIEW_TEXT');
    return readPreview(() => preview.loadText(validated.previewId, validated.linearId));
  });
}
