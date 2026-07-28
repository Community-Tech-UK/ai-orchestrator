import {
  COMPOSER_SUBMISSION_DB_NAME,
  COMPOSER_SUBMISSION_DB_VERSION,
  COMPOSER_SUBMISSION_STORE_NAME,
  type ComposerSubmissionRecord,
  type ComposerSubmissionStorage,
} from './composer-submission.types';

/**
 * In-memory journal. Used when IndexedDB is unavailable (jsdom in tests, or a
 * renderer where storage is blocked) so the submission lifecycle still works —
 * it just does not survive a reload.
 */
export class MemoryComposerSubmissionStorage implements ComposerSubmissionStorage {
  private readonly records = new Map<string, ComposerSubmissionRecord>();

  async list(): Promise<ComposerSubmissionRecord[]> {
    return [...this.records.values()];
  }

  async put(record: ComposerSubmissionRecord): Promise<void> {
    this.records.set(record.id, record);
  }

  async delete(id: string): Promise<void> {
    this.records.delete(id);
  }
}

/**
 * IndexedDB journal. `File` values are structured-cloned by IndexedDB, so
 * attachments survive a renderer reload and an application restart intact.
 */
export class IndexedDbComposerSubmissionStorage implements ComposerSubmissionStorage {
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(private readonly factory: IDBFactory) {}

  async list(): Promise<ComposerSubmissionRecord[]> {
    const db = await this.open();
    return this.request<ComposerSubmissionRecord[]>(
      db.transaction(COMPOSER_SUBMISSION_STORE_NAME, 'readonly')
        .objectStore(COMPOSER_SUBMISSION_STORE_NAME)
        .getAll(),
    );
  }

  async put(record: ComposerSubmissionRecord): Promise<void> {
    const db = await this.open();
    await this.request(
      db.transaction(COMPOSER_SUBMISSION_STORE_NAME, 'readwrite')
        .objectStore(COMPOSER_SUBMISSION_STORE_NAME)
        .put(record),
    );
  }

  async delete(id: string): Promise<void> {
    const db = await this.open();
    await this.request(
      db.transaction(COMPOSER_SUBMISSION_STORE_NAME, 'readwrite')
        .objectStore(COMPOSER_SUBMISSION_STORE_NAME)
        .delete(id),
    );
  }

  private open(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const request = this.factory.open(COMPOSER_SUBMISSION_DB_NAME, COMPOSER_SUBMISSION_DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(COMPOSER_SUBMISSION_STORE_NAME)) {
            db.createObjectStore(COMPOSER_SUBMISSION_STORE_NAME, { keyPath: 'id' });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Failed to open submission journal'));
        request.onblocked = () => reject(new Error('Submission journal upgrade blocked'));
      }).catch((error) => {
        // Don't cache a rejected promise — a later attempt should retry rather
        // than permanently disable durability for the session.
        this.dbPromise = null;
        throw error;
      });
    }

    return this.dbPromise;
  }

  private request<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Submission journal request failed'));
    });
  }
}

export function createComposerSubmissionStorage(): ComposerSubmissionStorage {
  const factory = typeof indexedDB !== 'undefined' ? indexedDB : null;
  return factory
    ? new IndexedDbComposerSubmissionStorage(factory)
    : new MemoryComposerSubmissionStorage();
}
