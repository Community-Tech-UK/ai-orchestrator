import type { SqliteDriver } from '../db/sqlite-driver';
import { getContentStore, type ContentRef } from '../session/content-store';
import type { FileAttachment } from '../../shared/types/instance.types';
import { generateId } from '../../shared/utils/id-generator';

interface AutomationAttachmentRow {
  id: string;
  automation_id: string;
  position: number;
  name: string;
  type: string;
  size: number;
  content_ref_json: string;
  created_at: number;
}

export interface PreparedAutomationAttachment {
  id: string;
  automationId: string;
  position: number;
  name: string;
  type: string;
  size: number;
  contentRef: ContentRef;
  createdAt: number;
}

export class AutomationAttachmentService {
  constructor(
    private readonly db: SqliteDriver,
    private readonly contentStore = getContentStore(),
  ) {}

  async prepare(
    automationId: string,
    attachments: FileAttachment[] | undefined,
    now = Date.now(),
  ): Promise<PreparedAutomationAttachment[]> {
    if (!attachments || attachments.length === 0) {
      return [];
    }

    const prepared: PreparedAutomationAttachment[] = [];
    for (const [position, attachment] of attachments.entries()) {
      if (!attachment.data) {
        throw new Error(`Attachment "${attachment.name}" has no data to persist`);
      }
      prepared.push({
        id: generateId(),
        automationId,
        position,
        name: attachment.name,
        type: attachment.type,
        size: attachment.size,
        contentRef: await this.contentStore.storeDurable(attachment.data),
        createdAt: now,
      });
    }
    return prepared;
  }

  replacePrepared(
    automationId: string,
    prepared: PreparedAutomationAttachment[],
  ): void {
    this.db.prepare(`DELETE FROM automation_attachments WHERE automation_id = ?`).run(automationId);
    const insert = this.db.prepare(`
      INSERT INTO automation_attachments
        (id, automation_id, position, name, type, size, content_ref_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const attachment of prepared) {
      insert.run(
        attachment.id,
        automationId,
        attachment.position,
        attachment.name,
        attachment.type,
        attachment.size,
        JSON.stringify(attachment.contentRef),
        attachment.createdAt,
      );
    }
  }

  async listForAutomation(automationId: string): Promise<FileAttachment[]> {
    const rows = this.db.prepare(`
      SELECT *
      FROM automation_attachments
      WHERE automation_id = ?
      ORDER BY position ASC
    `).all<AutomationAttachmentRow>(automationId);

    const attachments: FileAttachment[] = [];
    for (const row of rows) {
      const ref = JSON.parse(row.content_ref_json) as ContentRef;
      attachments.push({
        name: row.name,
        type: row.type,
        size: row.size,
        data: await this.contentStore.resolve(ref),
      });
    }
    return attachments;
  }
}
