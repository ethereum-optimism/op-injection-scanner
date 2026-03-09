import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isSafeUrl, fetchPageText } from '../src/fetch.ts';
import type { Config } from '../src/types.ts';

// Mock dns/promises lookup
vi.mock('dns/promises', () => ({
  lookup: vi.fn(),
}));

import { lookup } from 'dns/promises';

// The lookup overload that we call uses `{ all: true }` and returns LookupAddress[].
// We cast here to avoid fighting TypeScript's overload resolution on the mock type.
const mockLookup = lookup as unknown as ReturnType<typeof vi.fn>;

function setLookupResult(addresses: { address: string; family: number }[]): void {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  mockLookup.mockResolvedValue(addresses);
}

function setLookupError(err: Error): void {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  mockLookup.mockRejectedValue(err);
}

function setLookupSequence(sequences: Array<{ address: string; family: number }[]>): void {
  for (const seq of sequences) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    mockLookup.mockResolvedValueOnce(seq);
  }
}

const baseConfig: Config = {
  cacheMaxEntries: 100,
  cacheTtlSeconds: 3600,
  confidenceThreshold: 0.8,
  fetchTimeoutMs: 10000,
  maxResponseBytes: 2097152,
  maxRedirects: 5,
  maxUrlLength: 2048,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isSafeUrl — SSRF guard', () => {
  it('blocks 127.0.0.1 (localhost)', async () => {
    setLookupResult([{ address: '127.0.0.1', family: 4 }]);
    const result = await isSafeUrl('http://localhost/', 2048);
    expect(result).toBe(false);
  });

  it('blocks 169.254.169.254 (cloud metadata endpoint)', async () => {
    setLookupResult([{ address: '169.254.169.254', family: 4 }]);
    const result = await isSafeUrl('http://169.254.169.254/', 2048);
    expect(result).toBe(false);
  });

  it('blocks 10.0.0.1 (private range)', async () => {
    setLookupResult([{ address: '10.0.0.1', family: 4 }]);
    const result = await isSafeUrl('http://internal.example/', 2048);
    expect(result).toBe(false);
  });

  it('blocks 192.168.1.1 (private range)', async () => {
    setLookupResult([{ address: '192.168.1.1', family: 4 }]);
    const result = await isSafeUrl('http://router.local/', 2048);
    expect(result).toBe(false);
  });

  it('blocks 100.64.0.1 (CGNAT / shared address space)', async () => {
    setLookupResult([{ address: '100.64.0.1', family: 4 }]);
    const result = await isSafeUrl('http://cgnat.example/', 2048);
    expect(result).toBe(false);
  });

  it('blocks ::ffff:127.0.0.1 (IPv4-mapped IPv6)', async () => {
    setLookupResult([{ address: '::ffff:127.0.0.1', family: 6 }]);
    const result = await isSafeUrl('http://mapped.example/', 2048);
    expect(result).toBe(false);
  });

  it('blocks ::1 (IPv6 loopback)', async () => {
    setLookupResult([{ address: '::1', family: 6 }]);
    const result = await isSafeUrl('http://ipv6loopback.example/', 2048);
    expect(result).toBe(false);
  });

  it('allows a public IP address', async () => {
    setLookupResult([{ address: '93.184.216.34', family: 4 }]);
    const result = await isSafeUrl('https://example.com/', 2048);
    expect(result).toBe(true);
  });

  it('rejects URL exceeding maxUrlLength', async () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(2048);
    const result = await isSafeUrl(longUrl, 2048);
    expect(result).toBe(false);
  });

  it('rejects non-http(s) protocols', async () => {
    const result = await isSafeUrl('ftp://example.com/', 2048);
    expect(result).toBe(false);
  });

  it('returns false when DNS lookup fails', async () => {
    setLookupError(new Error('DNS SERVFAIL'));
    const result = await isSafeUrl('https://unresolvable.invalid/', 2048);
    expect(result).toBe(false);
  });

  it('blocks when any resolved IP is private (dual-stack)', async () => {
    setLookupResult([
      { address: '93.184.216.34', family: 4 }, // public
      { address: '10.0.0.1', family: 4 }, // private
    ]);
    const result = await isSafeUrl('https://dual-stack.example/', 2048);
    expect(result).toBe(false);
  });
});

describe('fetchPageText', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    // Default: resolve DNS to a public IP
    setLookupResult([{ address: '93.184.216.34', family: 4 }]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('returns stripped text for a successful text/html response', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (h: string) => {
          if (h === 'content-type') return 'text/html; charset=utf-8';
          return null;
        },
      },
      text: () => Promise.resolve('<html><body><p>Hello world</p></body></html>'),
    });

    const text = await fetchPageText('https://example.com/', baseConfig);
    expect(text).toContain('Hello world');
    expect(text).not.toContain('<p>');
  });

  it('throws on unsupported content type', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (h: string) => {
          if (h === 'content-type') return 'application/octet-stream';
          return null;
        },
      },
      text: () => Promise.resolve('binary data'),
    });

    await expect(fetchPageText('https://example.com/', baseConfig)).rejects.toThrow(
      'Unsupported content type',
    );
  });

  it('throws when response body exceeds maxResponseBytes', async () => {
    const bigBody = 'x'.repeat(baseConfig.maxResponseBytes + 1);
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (h: string) => {
          if (h === 'content-type') return 'text/plain';
          return null;
        },
      },
      text: () => Promise.resolve(bigBody),
    });

    await expect(fetchPageText('https://example.com/', baseConfig)).rejects.toThrow(
      'Response exceeds size limit',
    );
  });

  it('throws when content-length header exceeds maxResponseBytes', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (h: string) => {
          if (h === 'content-type') return 'text/html';
          if (h === 'content-length') return String(baseConfig.maxResponseBytes + 1);
          return null;
        },
      },
      text: () => Promise.resolve('small body'),
    });

    await expect(fetchPageText('https://example.com/', baseConfig)).rejects.toThrow(
      'Response exceeds size limit',
    );
  });

  it('throws when stripped body is empty', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (h: string) => {
          if (h === 'content-type') return 'text/html';
          return null;
        },
      },
      text: () => Promise.resolve('<html><body>   </body></html>'),
    });

    await expect(fetchPageText('https://example.com/', baseConfig)).rejects.toThrow(
      'Page produced no text content after stripping',
    );
  });

  it('throws when redirect count exceeds maxRedirects', async () => {
    // Every fetch call returns a redirect to the same URL — infinite loop
    mockFetch.mockResolvedValue({
      ok: false,
      status: 301,
      headers: {
        get: (h: string) => {
          if (h === 'location') return 'https://example.com/redirect';
          return null;
        },
      },
    });

    await expect(fetchPageText('https://example.com/', baseConfig)).rejects.toThrow(
      'Too many redirects',
    );
  });

  it('SSRF: re-validates each redirect hop — blocks redirect to private IP', async () => {
    // First call: redirect to a private IP
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 301,
      headers: {
        get: (h: string) => {
          if (h === 'location') return 'http://192.168.1.1/admin';
          return null;
        },
      },
    });

    // DNS for initial URL is public, but redirect destination is private
    setLookupSequence([
      [{ address: '93.184.216.34', family: 4 }], // initial URL — public
      [{ address: '192.168.1.1', family: 4 }], // redirect — private
    ]);

    await expect(fetchPageText('https://example.com/', baseConfig)).rejects.toThrow(
      'URL rejected by SSRF guard',
    );

    // fetch should have been called exactly once (for the initial URL)
    // The redirect destination was blocked before fetching it
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('URL too long is rejected by isSafeUrl before fetching', async () => {
    const shortConfig = { ...baseConfig, maxUrlLength: 50 };
    const longUrl = 'https://example.com/' + 'a'.repeat(50);

    await expect(fetchPageText(longUrl, shortConfig)).rejects.toThrow('URL rejected by SSRF guard');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
