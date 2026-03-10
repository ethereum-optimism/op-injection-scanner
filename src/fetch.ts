import { lookup } from 'dns/promises';
import type { Config } from './types.ts';

// Private/internal IP CIDR patterns — block before any network request.
// NOTE: DNS rebinding is a known v1 limitation — we resolve once before the request,
// but a low-TTL DNS record could re-resolve to a private IP between our check and
// the actual TCP connection. Full mitigation requires a custom DNS resolver that
// pins the resolved IP for the connection (future iteration).
const BLOCKED_IP_PATTERNS = [
  /^0\./,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./, // link-local and cloud metadata (AWS, GCP, Azure)
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT / IANA Shared Address Space
  /^::1$/, // IPv6 loopback
  /^::ffff:/i, // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1)
  /^fc00:/i, // IPv6 unique local
  /^fe80:/i, // IPv6 link-local
] as const;

export async function isSafeUrl(url: string, maxUrlLength: number): Promise<boolean> {
  if (url.length > maxUrlLength) return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) return false;

  // Resolve all IP addresses for the hostname and check each one
  let records: { address: string }[];
  try {
    records = await lookup(parsed.hostname, { all: true });
  } catch {
    return false; // DNS failure — treat as unsafe
  }

  return records.every(
    (r) => !BLOCKED_IP_PATTERNS.some((pattern) => pattern.test(r.address)),
  );
}

// Patterns found in the noscript/fallback content of JS-rendered SPAs.
// Matched against the stripped text (lowercase) when content is short.
const JS_WALL_PATTERNS: readonly RegExp[] = [
  /you need to enable javascript/i,
  /javascript must be enabled/i,
  /please enable javascript/i,
  /enable javascript to (?:run|use|continue)/i,
  /requires javascript to (?:run|function|work)/i,
  /javascript is required/i,
  /javascript is disabled/i,
] as const;

// Returns true when the stripped page text looks like a JS-wall shell — i.e. the
// actual content is only available after JS execution and we got nothing useful.
// The 300-char cap is generous: real JS-wall shells are typically 30–80 chars after
// stripping, while legitimate pages that mention JavaScript are much longer.
export function detectJsWall(strippedText: string): boolean {
  if (strippedText.length >= 300) return false;
  const lower = strippedText.toLowerCase();
  if (!lower.includes('javascript')) return false;
  return JS_WALL_PATTERNS.some((pattern) => pattern.test(lower));
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export async function fetchPageText(url: string, config: Config): Promise<string> {
  // Manual redirect following to enforce max hops and re-validate each destination
  let currentUrl = url;
  let hops = 0;

  while (hops <= config.maxRedirects) {
    if (!(await isSafeUrl(currentUrl, config.maxUrlLength))) {
      throw new Error(`URL rejected by SSRF guard: ${currentUrl}`);
    }

    const response = await fetch(currentUrl, {
      signal: AbortSignal.timeout(config.fetchTimeoutMs),
      redirect: 'manual',
      headers: { Accept: 'text/html,text/plain,*/*' },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Redirect with no Location header');
      // Resolve relative redirects against the current URL
      currentUrl = new URL(location, currentUrl).toString();
      hops++;
      continue;
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching ${currentUrl}`);
    }

    // Only process text content — reject binary, JSON-only, or unknown types
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
      throw new Error(`Unsupported content type: ${contentType}`);
    }

    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > config.maxResponseBytes) {
      throw new Error('Response exceeds size limit');
    }

    const html = await response.text();
    if (html.length > config.maxResponseBytes) {
      throw new Error('Response exceeds size limit');
    }

    const text = stripHtml(html);
    if (text.length === 0) {
      throw new Error('Page produced no text content after stripping');
    }

    return text;
  }

  throw new Error(`Too many redirects (max ${config.maxRedirects})`);
}
