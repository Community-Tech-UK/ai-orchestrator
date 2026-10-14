import { randomUUID } from 'crypto';

interface CleanupBinding { target: string; itemsHash: string }

/** In-memory permission to execute exactly the preview that the reader reviewed. */
export class CleanupTicketStore {
  private readonly tickets = new Map<string, CleanupBinding & { expiresAt: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  issueTicket(binding: CleanupBinding): string {
    for (const [id, ticket] of this.tickets) {
      if (ticket.expiresAt <= this.now()) this.tickets.delete(id);
    }
    // Bound abandoned previews without a timer or an unbounded memory leak.
    if (this.tickets.size >= 1000) this.tickets.delete(this.tickets.keys().next().value!);
    const id = randomUUID();
    this.tickets.set(id, { ...binding, expiresAt: this.now() + 600_000 });
    return id;
  }

  consumeTicket(id: string | undefined, binding: CleanupBinding): void {
    const ticket = id ? this.tickets.get(id) : undefined;
    if (id) this.tickets.delete(id);
    if (!ticket) throw new Error('Review the clean-up first. This preview is missing or already used.');
    if (ticket.expiresAt <= this.now()) throw new Error('This preview expired. Review again.');
    if (ticket.target !== binding.target || ticket.itemsHash !== binding.itemsHash) {
      throw new Error('The list changed since you looked. Review again.');
    }
  }
}
