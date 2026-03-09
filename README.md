# op-injection-scanner

An MCP server for prompt injection boundary enforcement. AI agents call `scan_url(url)` instead of fetching URLs directly. The server fetches the URL (with SSRF protection), strips HTML to plain text, and scans the content for prompt injection using a three-tier model escalation strategy (Haiku → Sonnet → Opus). Results are cached by URL and TTL bucket so repeated calls within the cache window incur no additional LLM cost.

## Installation

```bash
git clone https://github.com/ethereum-optimism/op-injection-scanner
cd op-injection-scanner
bun install
```

## Claude Code MCP config

Add to `~/.claude.json` or your project's `.claude/settings.json`:

```json
{
  "mcpServers": {
    "op-injection-scanner": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/op-injection-scanner/src/server.ts"]
    }
  }
}
```

The server requires `ANTHROPIC_API_KEY` in the environment.

## Usage

Agents call `scan_url` with a URL instead of fetching it directly:

```
scan_url({ url: "https://some-external-docs.example.com/page" })
```

**Clean response** — status 200, tool returns:
```json
{
  "status": "clean",
  "content": "The stripped page text...",
  "url": "https://some-external-docs.example.com/page",
  "scanned_at": "2026-03-08T12:00:00.000Z",
  "model_used": "claude-haiku-4-5",
  "escalated": false
}
```

**Blocked response** — tool returns `isError: true` so the calling agent receives a tool error:
```json
{
  "status": "blocked",
  "reason": "Content contains instructions attempting to override agent behaviour",
  "url": "https://malicious.example.com/page",
  "scanned_at": "2026-03-08T12:00:00.000Z",
  "model_used": "claude-haiku-4-5",
  "escalated": false
}
```

When the tool returns `isError: true`, the calling agent should not process the URL further.

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `ANTHROPIC_API_KEY` | (required) | Anthropic API key — read automatically by the SDK |
| `CACHE_MAX_ENTRIES` | `500` | Maximum number of cached scan results |
| `CACHE_TTL_SECONDS` | `3600` | Cache entry lifetime in seconds (1 hour) |
| `CONFIDENCE_THRESHOLD` | `0.8` | Minimum confidence for a verdict — below this, escalate to next tier |
| `FETCH_TIMEOUT_MS` | `10000` | HTTP request timeout in milliseconds |
| `MAX_RESPONSE_BYTES` | `2097152` | Maximum response body size (2 MB) |
| `MAX_REDIRECTS` | `5` | Maximum number of HTTP redirects to follow |
| `MAX_URL_LENGTH` | `2048` | Maximum URL length in characters |

## Design decisions

### Why MCP, not a hook

A Claude Code hook fires automatically on every tool call, but it cannot be selectively invoked or tested in isolation. An MCP server is explicit — agents opt in to scanning, the interface is testable, and it can be extended (new tools, new scan types) without touching hook infrastructure.

### v1 scope

This version detects prompt injection only. Malicious intent detection (e.g. phishing, credential harvesting) is a future iteration. The `clean` verdict means "no injection attempt detected" — not "content is safe in all respects."

### Tiered model strategy

- **Haiku** — fast, cheap, handles the majority of clear-cut cases
- **Sonnet** — escalated when Haiku returns `uncertain` or confidence < 0.8
- **Opus** — final arbiter, called only when Sonnet also cannot reach a confident verdict; schema enforces a definitive `clean` or `blocked` verdict (no `uncertain` allowed); parse failure defaults to `blocked`

### No auth or rate limiting

This is internal dev tooling. Network isolation is the access control. Auth and per-session rate limiting are noted as future work in the source.

### DNS rebinding (known v1 limitation)

The SSRF guard resolves DNS once before the request and checks all returned IPs. A sophisticated attacker controlling a low-TTL DNS record could return a public IP on the initial check and re-resolve to a private IP at TCP connection time, bypassing the guard. Full mitigation requires a custom DNS-pinning HTTP client. This is acceptable for internal tooling but must be addressed before any public or shared deployment.
