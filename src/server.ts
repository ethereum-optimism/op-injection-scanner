import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Scanner } from './scanner.ts';
import { loadConfig } from './types.ts';

const config = loadConfig();
const scanner = new Scanner(config);

const server = new McpServer({
  name: 'op-injection-scanner',
  version: '0.1.0',
});

server.tool(
  'scan_url',
  'Fetch a URL and scan its content for prompt injection. Returns clean content or a structured rejection. Use this instead of WebFetch when consuming untrusted web content.',
  {
    url: z.string().url().max(2048).describe('The URL to fetch and scan'),
  },
  async ({ url }) => {
    try {
      const result = await scanner.scan(url);

      if (result.status === 'clean') {
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        };
      } else {
        // blocked: injection detected — caller should not process this URL
        // unverifiable: page requires JS rendering — caller should try scan_text with content
        //   obtained via another means (e.g. Notion MCP), or surface to the user
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify(result) }],
        };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ status: 'error', message, url }) }],
      };
    }
  },
);

server.tool(
  'scan_text',
  'Scan raw text content for prompt injection. Use when you already have content from another source (e.g. Notion MCP fetch, pasted text, file contents) and need to verify it before processing.',
  {
    text: z.string().min(1).describe('The text content to scan for prompt injection'),
    source_url: z
      .string()
      .url()
      .optional()
      .describe('Optional: the URL or source identifier this text came from, for audit logging'),
  },
  async ({ text, source_url }: { text: string; source_url?: string | undefined }) => {
    try {
      const result = await scanner.scanText(text, source_url);

      if (result.status === 'clean') {
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        };
      } else {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify(result) }],
        };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [
          { type: 'text', text: JSON.stringify({ status: 'error', message, source_url }) },
        ],
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[op-injection-scanner] running on stdio');
