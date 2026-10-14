import { describe, expect, it } from 'vitest';
import { CleanupTicketStore } from './cleanup-ticket';

describe('cleanup preview tickets', () => {
  const binding = { target: 'backups', itemsHash: 'fixture-hash' };
  it('works once and rejects unknown or missing tickets', () => {
    const tickets = new CleanupTicketStore();
    const id = tickets.issueTicket(binding);
    tickets.consumeTicket(id, binding);
    expect(() => tickets.consumeTicket(id, binding)).toThrow();
    expect(() => tickets.consumeTicket(undefined, binding)).toThrow();
    expect(() => tickets.consumeTicket('unknown', binding)).toThrow();
  });
  it('expires at ten minutes', () => {
    let now = 0;
    const tickets = new CleanupTicketStore(() => now);
    const id = tickets.issueTicket(binding);
    now = 600_000;
    expect(() => tickets.consumeTicket(id, binding)).toThrow(/expired/);
  });
  it.each([{ target: 'logs', itemsHash: 'fixture-hash' }, { target: 'backups', itemsHash: 'changed' }])('rejects a mismatched binding', (changed) => {
    const tickets = new CleanupTicketStore();
    expect(() => tickets.consumeTicket(tickets.issueTicket(binding), changed)).toThrow(/changed/);
  });
});
