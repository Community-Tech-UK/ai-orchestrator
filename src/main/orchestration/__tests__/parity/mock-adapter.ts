import { EventEmitter } from 'events';

export class MockCliAdapter extends EventEmitter {
  private responses: string[];
  private callIndex = 0;

  constructor(responses: string[]) {
    super();
    this.responses = responses;
  }

  async sendInput(input: string): Promise<void> {
    const response = this.responses[this.callIndex++];
    if (response === undefined) {
      throw new Error(`MockCliAdapter: no response for call ${this.callIndex - 1}, input: ${input.slice(0, 100)}`);
    }
    this.emit('output', { type: 'assistant', content: response });
  }

  getNextResponse(): string | undefined {
    return this.responses[this.callIndex];
  }

  get callCount(): number {
    return this.callIndex;
  }
}
