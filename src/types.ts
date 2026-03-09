import { z } from 'zod';

// --- Scan result returned to callers ---

export const ScanResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('clean'),
    content: z.string(),
    url: z.string(),
    scanned_at: z.string(),
    model_used: z.string(),
    escalated: z.boolean(),
  }),
  z.object({
    status: z.literal('blocked'),
    reason: z.string(),
    url: z.string(),
    scanned_at: z.string(),
    model_used: z.string(),
    escalated: z.boolean(),
  }),
]);

export type ScanResult = z.infer<typeof ScanResultSchema>;

// --- Model classification outputs ---

export const HaikuClassificationSchema = z.object({
  verdict: z.enum(['clean', 'blocked', 'uncertain']),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});

export const SonnetClassificationSchema = z.object({
  verdict: z.enum(['clean', 'blocked', 'uncertain']), // can escalate to Opus if still uncertain
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});

export const OpusClassificationSchema = z.object({
  verdict: z.enum(['clean', 'blocked']), // no 'uncertain' — Opus is the final arbiter
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});

export type HaikuClassification = z.infer<typeof HaikuClassificationSchema>;
export type SonnetClassification = z.infer<typeof SonnetClassificationSchema>;
export type OpusClassification = z.infer<typeof OpusClassificationSchema>;

// --- Config from environment ---

export interface Config {
  cacheMaxEntries: number; // default: 500
  cacheTtlSeconds: number; // default: 3600 (1 hour)
  confidenceThreshold: number; // default: 0.8 — below this, escalate to next tier
  fetchTimeoutMs: number; // default: 10000
  maxResponseBytes: number; // default: 2097152 (2MB)
  maxRedirects: number; // default: 5
  maxUrlLength: number; // default: 2048
}

export function loadConfig(): Config {
  return {
    cacheMaxEntries: parseInt(process.env['CACHE_MAX_ENTRIES'] ?? '500', 10),
    cacheTtlSeconds: parseInt(process.env['CACHE_TTL_SECONDS'] ?? '3600', 10),
    confidenceThreshold: parseFloat(process.env['CONFIDENCE_THRESHOLD'] ?? '0.8'),
    fetchTimeoutMs: parseInt(process.env['FETCH_TIMEOUT_MS'] ?? '10000', 10),
    maxResponseBytes: parseInt(process.env['MAX_RESPONSE_BYTES'] ?? '2097152', 10),
    maxRedirects: parseInt(process.env['MAX_REDIRECTS'] ?? '5', 10),
    maxUrlLength: parseInt(process.env['MAX_URL_LENGTH'] ?? '2048', 10),
  };
}
