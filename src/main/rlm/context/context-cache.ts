/**
 * Context Cache Module
 *
 * Handles caching logic including:
 * - Bloom filter for fast negative lookups
 */

import type {
  ContextStore,
  BloomFilter
} from '../../../shared/types/rlm.types';

/**
 * Create a new Bloom filter for fast term lookups.
 * Uses multiple hash functions to minimize false positives.
 *
 * @param expectedItems - Expected number of items to store
 * @returns New BloomFilter instance
 */
export function createBloomFilter(expectedItems = 10000): BloomFilter {
  const size = Math.max(1000, expectedItems * 10); // ~10 bits per item
  const hashCount = 4;
  return {
    bits: new Uint8Array(Math.ceil(size / 8)),
    size,
    hashCount
  };
}

/**
 * Add an item to the Bloom filter.
 *
 * @param filter - Bloom filter to modify
 * @param item - Item to add
 */
export function bloomAdd(filter: BloomFilter, item: string): void {
  const hashes = getBloomHashes(item, filter.hashCount, filter.size);
  for (const hash of hashes) {
    const byteIndex = Math.floor(hash / 8);
    const bitIndex = hash % 8;
    filter.bits[byteIndex] |= 1 << bitIndex;
  }
}

/**
 * Check if an item might be in the Bloom filter.
 * Returns false if definitely not present, true if possibly present.
 *
 * @param filter - Bloom filter to check
 * @param item - Item to look for
 * @returns Boolean indicating if item might be present
 */
export function bloomMightContain(filter: BloomFilter, item: string): boolean {
  const hashes = getBloomHashes(item, filter.hashCount, filter.size);
  for (const hash of hashes) {
    const byteIndex = Math.floor(hash / 8);
    const bitIndex = hash % 8;
    if (!(filter.bits[byteIndex] & (1 << bitIndex))) {
      return false;
    }
  }
  return true;
}

/**
 * Generate hash values for Bloom filter using DJB2 with different seeds.
 *
 * @param item - Item to hash
 * @param count - Number of hash values to generate
 * @param size - Size of the Bloom filter
 * @returns Array of hash values
 */
export function getBloomHashes(
  item: string,
  count: number,
  size: number
): number[] {
  const hashes: number[] = [];
  for (let i = 0; i < count; i++) {
    let hash = 5381 + i * 33;
    for (let j = 0; j < item.length; j++) {
      hash = ((hash << 5) + hash) ^ item.charCodeAt(j);
    }
    hashes.push(Math.abs(hash) % size);
  }
  return hashes;
}

/**
 * Rebuild the Bloom filter for a store from its sections.
 *
 * @param store - Context store to rebuild filter for
 * @returns New BloomFilter instance
 */
export function rebuildBloomFilterForStore(store: ContextStore): BloomFilter {
  const filter = createBloomFilter(store.sections.length * 100);

  for (const section of store.sections) {
    if (section.depth > 0) continue; // Skip summaries
    const words = section.content.toLowerCase().match(/\b\w{3,}\b/g) || [];
    for (const word of words) {
      bloomAdd(filter, word);
    }
  }

  return filter;
}

/**
 * Quick check if a term might exist in the store using bloom filter.
 * Returns true if no filter exists (assume might contain).
 *
 * @param store - Context store to check
 * @param term - Term to look for
 * @returns Boolean indicating if term might be present
 */
export function mightContainTerm(store: ContextStore, term: string): boolean {
  if (!store.bloomFilter) return true;
  return bloomMightContain(store.bloomFilter, term.toLowerCase());
}
