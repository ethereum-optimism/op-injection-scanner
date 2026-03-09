import { createHash } from 'crypto';

export class LRUCache<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly max: number) {}

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const val = this.map.get(key) as V;
    this.map.delete(key);
    this.map.set(key, val); // move to end (most-recently-used)
    return val;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.max) {
      // evict least-recently-used (first entry)
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) this.map.delete(firstKey);
    }
    this.map.set(key, value);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  get size(): number {
    return this.map.size;
  }
}

// Normalise a URL before using it as a cache key to prevent trivial bypasses
// (e.g. trailing slash, fragment, redundant query params that don't affect content).
export function normalizeUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hash = ''; // strip fragment — never sent to server
  // Sort query params for consistent key regardless of param order
  parsed.searchParams.sort();
  return parsed.toString();
}

export function cacheKey(url: string, ttlSeconds: number): string {
  const normalized = normalizeUrl(url);
  const bucket = Math.floor(Date.now() / 1000 / ttlSeconds);
  return createHash('sha256').update(`${normalized}:${bucket}`).digest('hex');
}
