import { randomUUID } from 'crypto';

export class RemoteObserverAuth {
  private static instance: RemoteObserverAuth | null = null;
  private token = randomUUID();

  static getInstance(): RemoteObserverAuth {
    if (!this.instance) {
      this.instance = new RemoteObserverAuth();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  getToken(): string {
    return this.token;
  }

  rotateToken(): string {
    this.token = randomUUID();
    return this.token;
  }

  validate(candidate: string | null | undefined): boolean {
    return Boolean(candidate) && candidate === this.token;
  }
}

export function getRemoteObserverAuth(): RemoteObserverAuth {
  return RemoteObserverAuth.getInstance();
}
