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
          content: [
            {
              type: 'text',
              text: JSON.stringify(result),
            },
          ],
        };
      } else {
        // Return as tool error so the calling agent knows to stop processing this URL
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify(result),
            },
          ],
        };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'error',
              message,
              url,
            }),
          },
        ],
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[op-injection-scanner] running on stdio');
