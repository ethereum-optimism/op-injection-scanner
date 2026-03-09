import { describe, it, expect, vi } from 'vitest';
import { LRUCache, normalizeUrl, cacheKey } from '../src/cache.ts';

describe('LRUCache', () => {
  it('stores and retrieves values', () => {
    const cache = new LRUCache<string, number>(3);
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
  });

  it('returns undefined for missing keys', () => {
    const cache = new LRUCache<string, number>(3);
    expect(cache.get('missing')).toBeUndefined();
  });

  it('evicts least-recently-used entry when at max capacity', () => {
    const cache = new LRUCache<string, number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    // Access 'a' to make it recently used — 'b' becomes LRU
    cache.get('a');
    // Adding 'd' should evict 'b'
    cache.set('d', 4);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('a')).toBe(true);
    expect(cache.has('c')).toBe(true);
    expect(cache.has('d')).toBe(true);
  });

  it('evicts the first-inserted entry when none have been accessed', () => {
    const cache = new LRUCache<string, number>(2);
    cache.set('first', 1);
    cache.set('second', 2);
    cache.set('third', 3);
    // 'first' should have been evicted
    expect(cache.has('first')).toBe(false);
    expect(cache.has('second')).toBe(true);
    expect(cache.has('third')).toBe(true);
  });

  it('respects LRU ordering — most recently used survives eviction', () => {
    const cache = new LRUCache<string, string>(2);
    cache.set('x', 'x-val');
    cache.set('y', 'y-val');
    // Access 'x' to make it MRU
    cache.get('x');
    // Adding 'z' evicts 'y' (LRU), not 'x' (MRU)
    cache.set('z', 'z-val');
    expect(cache.has('x')).toBe(true);
    expect(cache.has('y')).toBe(false);
    expect(cache.has('z')).toBe(true);
  });

  it('size reflects number of entries', () => {
    const cache = new LRUCache<string, number>(10);
    expect(cache.size).toBe(0);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.size).toBe(2);
  });

  it('updating an existing key does not grow the cache beyond max', () => {
    const cache = new LRUCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 99); // update existing key
    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBe(99);
  });
});

describe('normalizeUrl', () => {
  it('strips fragment from URL', () => {
    const withFragment = 'https://example.com/foo#section';
    const withoutFragment = 'https://example.com/foo';
    expect(normalizeUrl(withFragment)).toBe(normalizeUrl(withoutFragment));
  });

  it('sorts query parameters for consistent ordering', () => {
    const url1 = 'https://example.com/page?a=1&b=2';
    const url2 = 'https://example.com/page?b=2&a=1';
    expect(normalizeUrl(url1)).toBe(normalizeUrl(url2));
  });

  it('preserves the URL when there is no fragment', () => {
    const url = 'https://example.com/path?q=hello';
    const normalized = normalizeUrl(url);
    expect(normalized).toContain('example.com');
    expect(normalized).toContain('q=hello');
    expect(normalized).not.toContain('#');
  });
});

describe('cacheKey', () => {
  it('returns same hash for URL with and without fragment', () => {
    const url1 = 'https://example.com/foo';
    const url2 = 'https://example.com/foo#bar';
    expect(cacheKey(url1, 3600)).toBe(cacheKey(url2, 3600));
  });

  it('returns same hash for equivalent query param orderings', () => {
    const url1 = 'https://example.com/?a=1&b=2';
    const url2 = 'https://example.com/?b=2&a=1';
    expect(cacheKey(url1, 3600)).toBe(cacheKey(url2, 3600));
  });

  it('different TTL buckets produce different hashes', () => {
    const url = 'https://example.com/page';
    // Use a very small TTL so different buckets are easy to trigger
    const now = Date.now();
    const ttl = 1; // 1 second buckets
    const bucket1 = Math.floor(now / 1000 / ttl);
    const bucket2 = bucket1 + 1; // a different bucket

    // Override Date.now for bucket1
    const spy = vi.spyOn(Date, 'now');
    spy.mockReturnValue(bucket1 * 1000 * ttl);
    const key1 = cacheKey(url, ttl);

    spy.mockReturnValue(bucket2 * 1000 * ttl);
    const key2 = cacheKey(url, ttl);

    spy.mockRestore();

    expect(key1).not.toBe(key2);
  });

  it('returns a 64-character hex SHA256 hash', () => {
    const key = cacheKey('https://example.com/', 3600);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });
});
