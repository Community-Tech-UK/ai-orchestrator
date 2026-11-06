import { describe, expect, it } from 'vitest';
import { CouncilPrefillService } from './council-prefill.service';

describe('CouncilPrefillService', () => {
  it('takes and clears the newest pending prefill', () => {
    const service = new CouncilPrefillService();
    expect(service.take()).toBeNull();
    service.set('First reply');
    service.set('Most recent reply');
    expect(service.take()).toBe('Most recent reply');
    expect(service.take()).toBeNull();
  });
});
