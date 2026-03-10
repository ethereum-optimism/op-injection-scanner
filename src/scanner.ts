import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { LRUCache, cacheKey } from './cache.ts';
import { fetchPageText, detectJsWall } from './fetch.ts';
import {
  HAIKU_SYSTEM_PROMPT,
  SONNET_SYSTEM_PROMPT,
  OPUS_SYSTEM_PROMPT,
  buildUserTurn,
} from './prompts.ts';
import {
  HaikuClassificationSchema,
  SonnetClassificationSchema,
  OpusClassificationSchema,
  type Config,
  type ScanResult,
} from './types.ts';

const HAIKU_MODEL = 'claude-haiku-4-5';
const SONNET_MODEL = 'claude-sonnet-4-6';
const OPUS_MODEL = 'claude-opus-4-6';

export class Scanner {
  private readonly client: Anthropic;
  private readonly cache: LRUCache<string, ScanResult>;
  private readonly config: Config;

  constructor(config: Config, client?: Anthropic) {
    this.client = client ?? new Anthropic();
    this.cache = new LRUCache<string, ScanResult>(config.cacheMaxEntries);
    this.config = config;
  }

  // Public: scan a URL — fetch, detect JS-wall, then classify.
  // Unverifiable results (JS-wall) are cached: the HTTP shell won't change within TTL.
  async scan(url: string): Promise<ScanResult> {
    const key = cacheKey(url, this.config.cacheTtlSeconds);

    const cached = this.cache.get(key);
    if (cached !== undefined) {
      console.error(`[scanner] cache hit: ${url}`);
      return cached;
    }

    console.error(`[scanner] cache miss, fetching: ${url}`);
    const pageText = await fetchPageText(url, this.config);

    if (detectJsWall(pageText)) {
      console.error(`[scanner] js-wall detected, unverifiable: ${url}`);
      const result: ScanResult = {
        status: 'unverifiable',
        reason: 'js_rendering_required',
        url,
        scanned_at: new Date().toISOString(),
      };
      this.cache.set(key, result);
      return result;
    }

    const result = await this.runClassification(pageText, url);
    this.cache.set(key, result);
    return result;
  }

  // Public: scan raw text directly — for content fetched via other means
  // (Notion MCP, pasted text, file contents, etc.). No cache — caller owns the content lifecycle.
  // sourceUrl is used only for audit logging in the result's url field.
  async scanText(text: string, sourceUrl?: string): Promise<ScanResult> {
    return this.runClassification(text, sourceUrl ?? '<direct text>');
  }

  // Private: LLM classification pipeline (Haiku → Sonnet → Opus).
  // Accepts already-obtained text; has no knowledge of how content was acquired.
  // Parameters: text first (content to classify), sourceUrl second (for result metadata).
  private async runClassification(text: string, sourceUrl: string): Promise<ScanResult> {
    const userTurn = buildUserTurn(text);
    const scanned_at = new Date().toISOString();

    // Tier 1: Haiku
    const haiku = await this.client.messages.parse({
      model: HAIKU_MODEL,
      max_tokens: 256,
      system: HAIKU_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userTurn }],
      output_config: { format: zodOutputFormat(HaikuClassificationSchema) },
    });

    const tier1 = haiku.parsed_output;
    if (tier1 === null) {
      // Parsing failure — treat as uncertain and escalate
      console.error(`[scanner] haiku parse failure, escalating: ${sourceUrl}`);
    } else if (
      tier1.verdict !== 'uncertain' &&
      tier1.confidence >= this.config.confidenceThreshold
    ) {
      if (tier1.verdict === 'clean') {
        return {
          status: 'clean',
          content: text,
          url: sourceUrl,
          scanned_at,
          model_used: HAIKU_MODEL,
          escalated: false,
        };
      } else {
        return {
          status: 'blocked',
          reason: tier1.reason,
          url: sourceUrl,
          scanned_at,
          model_used: HAIKU_MODEL,
          escalated: false,
        };
      }
    }

    // Tier 2: Sonnet escalation
    console.error(`[scanner] escalating to Sonnet: ${sourceUrl}`);
    const sonnet = await this.client.messages.parse({
      model: SONNET_MODEL,
      max_tokens: 256,
      system: SONNET_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userTurn }],
      output_config: { format: zodOutputFormat(SonnetClassificationSchema) },
    });

    const tier2 = sonnet.parsed_output;
    if (
      tier2 !== null &&
      tier2.verdict !== 'uncertain' &&
      tier2.confidence >= this.config.confidenceThreshold
    ) {
      if (tier2.verdict === 'clean') {
        return {
          status: 'clean',
          content: text,
          url: sourceUrl,
          scanned_at,
          model_used: SONNET_MODEL,
          escalated: true,
        };
      } else {
        return {
          status: 'blocked',
          reason: tier2.reason,
          url: sourceUrl,
          scanned_at,
          model_used: SONNET_MODEL,
          escalated: true,
        };
      }
    }

    // Tier 3: Opus — final arbiter, cannot return uncertain
    console.error(`[scanner] escalating to Opus: ${sourceUrl}`);
    const opus = await this.client.messages.parse({
      model: OPUS_MODEL,
      max_tokens: 256,
      system: OPUS_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userTurn }],
      output_config: { format: zodOutputFormat(OpusClassificationSchema) },
    });

    const tier3 = opus.parsed_output;
    if (tier3 === null) {
      return {
        status: 'blocked',
        reason: 'Classification failed — blocked as a precaution',
        url: sourceUrl,
        scanned_at,
        model_used: OPUS_MODEL,
        escalated: true,
      };
    }

    if (tier3.verdict === 'clean') {
      return {
        status: 'clean',
        content: text,
        url: sourceUrl,
        scanned_at,
        model_used: OPUS_MODEL,
        escalated: true,
      };
    } else {
      return {
        status: 'blocked',
        reason: tier3.reason,
        url: sourceUrl,
        scanned_at,
        model_used: OPUS_MODEL,
        escalated: true,
      };
    }
  }
}
