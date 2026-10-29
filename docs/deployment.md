<!-- Split out of README.md in v3.24.0 (vikunja#683). The README had reached 905 lines / 70KB, at which point it was a reference manual pretending to be an introduction. -->

# Install and deployment

This fork is not published to npm or a container registry (`package.json` is `"private": true`).
Build it from source, or build the `Dockerfile`. Upstream's `@tadmstr/searxng-mcp` package and
`ghcr.io/tadmstr/*` images are a different project now (seven tools, Firecrawl).

## From source

```bash
git clone https://github.com/blakemartz/private-search-4-agents.git
cd private-search-4-agents
pnpm install
pnpm build
```

Output: `build/src/index.js`. Requires Node.js 22+ (`engines`; the PDF extractor `unpdf` needs it).
The client recipes below use `/path/to/private-search-4-agents` for the checkout.

## Container image

```bash
docker build -t private-search-4-agents:local .
docker run --rm -p 127.0.0.1:3001:3001 \
  -e SEARXNG_URL=http://searxng:8080 \
  -e SEARXNG_MCP_AUTH_TOKEN=change-me \
  private-search-4-agents:local
```

The image ships the repo's `domains.json` (domain boosts, blocks, profiles and the llms.txt
allowlist). To change the rules without rebuilding, mount your own file (a Kubernetes ConfigMap
works) and set `DOMAINS_CONFIG_PATH` to it; it is re-read within 5 s of a change.

The `examples/compose.*.yml` files build the same image (and the reranker and adblock-proxy sidecars
from `docker/`) instead of pulling.

# MCP Client Configuration

## Claude Code (CLI)

The recommended approach uses `claude mcp add-json` to register the server with full env var support:

```bash
claude mcp add-json searxng --scope user '{
  "command": "node",
  "args": ["/path/to/private-search-4-agents/build/src/index.js"],
  "env": {
    "SEARXNG_URL": "http://localhost:8081",
    "RERANKER_URL": "http://localhost:8787",
    "OLLAMA_URL": "http://localhost:11434",
    "CACHE_URL": "redis://localhost:6379",
    "CACHE_TTL_SECONDS": "3600",
    "FETCH_CACHE_TTL_SECONDS": "86400",
    "EXPAND_QUERIES": "false",
    "CRAWL4AI_URL": "http://localhost:11235"
  }
}'
```

This writes to `~/.claude.json`. Do not add searxng to `~/.claude/settings.json` — that file is not used for MCP env var injection in Claude Code.

## Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "searxng": {
      "command": "node",
      "args": ["/path/to/private-search-4-agents/build/src/index.js"],
      "env": {
        "SEARXNG_URL": "http://localhost:8081",
        "RERANKER_URL": "http://localhost:8787",
        "OLLAMA_URL": "http://localhost:11434",
        "CACHE_URL": "redis://localhost:6379",
        "CRAWL4AI_URL": "http://localhost:11235"
      }
    }
  }
}
```

## LibreChat (`librechat.yaml`)

```yaml
mcpServers:
  searxng:
    type: stdio
    command: node
    args:
      - /path/to/private-search-4-agents/build/src/index.js
    env:
      SEARXNG_URL: http://localhost:8081
      RERANKER_URL: http://localhost:8787
      OLLAMA_URL: http://localhost:11434
      CACHE_URL: redis://localhost:6379
      CRAWL4AI_URL: http://localhost:11235
```

## Pi coding agent

Pi ≥ 1.4 has a native MCP client. Run this server with the HTTP transport (see [Transport](#transport))
and add it to `~/.pi/agent/mcp.json`:

```json
{ "mcpServers": { "web": {
  "url": "http://127.0.0.1:3001/mcp",
  "headers": { "Authorization": "!echo Bearer $(sed -n 's/^SEARXNG_MCP_AUTH_TOKEN=//p' path/to/your.env)" },
  "exposure": "direct", "timeout": 180,
  "description": "Private web search (self-hosted SearXNG, local rerank, local page fetch): search, fetch_url, crawl_site" } } }
```

- The tools appear as `mcp__web__search`, `mcp__web__fetch_url` and `mcp__web__crawl_site`.
- A header value starting with `!` is run as a shell command and its output used, so the bearer
  token is read from the env file at connect time and never written into `mcp.json`. Point the
  `sed` at wherever your `SEARXNG_MCP_AUTH_TOKEN` lives; drop the header if the server runs
  without a token.
- `timeout: 180` leaves room for `search` with `answer: true` on a cold local model.
- Verify with `pi mcp list`.

## Wrappers that spawn per call (mcporter and similar)

Prefer the HTTP transport over letting a wrapper spawn a stdio child per call. Every stdio spawn
pays Node startup, module load and a fresh cache connection before the first byte of work;
measured on the same host, a cached `search` took **0.11 s** over a long-running HTTP server
against **2.3 s** through per-call stdio spawning. Run one HTTP server and point the wrapper at
`http://127.0.0.1:3001/mcp`.

## MCP Resources through a proxy

Resources (`config://searxng-mcp`, `stats://domains`) are a separate JSON-RPC surface from
tools — `resources/list` / `resources/read`, not `tools/list` / `tools/call`. A proxy that
re-registers upstream tools on its own server, rather than forwarding the wire protocol
generically, carries the tools through fine and drops Resources without any error — there is
nothing to catch, because the client that dropped them never advertised support in the first
place.

Verified against one such proxy, scoped_mcp 1.14.0: its `mcp_proxy` calls only `list_tools()`
and `call_tool()` on the upstream client and re-registers the results on its own server — there
is no generic forwarding path, and `grep -rln "list_resources\|read_resource"` over its tree
returns zero files. Resources reach direct MCP clients (Claude Code, Claude Desktop, LibreChat)
without issue; they do not reach a client sitting behind that proxy. The tools are
unaffected either way.

If you're deploying behind a different proxy, check whether it implements `resources/list` and
`resources/read` before relying on either Resource — a tool-only proxy is a common shape to hit,
not something specific to the proxy above.

# Transport

**stdio** (default) — compatible with Claude Code MCP plugin and LibreChat `stdio` config.

**HTTP** — set `SEARXNG_MCP_TRANSPORT=http` to run as a shared HTTP/SSE server suitable for multi-client deployments or Docker-based setups. Binds to `SEARXNG_MCP_HOST:SEARXNG_MCP_PORT` (default `127.0.0.1:3001`):

```bash
SEARXNG_MCP_TRANSPORT=http SEARXNG_MCP_PORT=3001 node build/src/index.js
```

Register with Claude Code against an HTTP server:

```bash
claude mcp add-json searxng --scope user '{
  "type": "http",
  "url": "http://localhost:3001/mcp"
}'
```

Sessions are keyed by the `Mcp-Session-Id` header, so multiple clients can connect to the same shared process concurrently. Idle sessions are swept after `HTTP_SESSION_IDLE_TIMEOUT_MS` and hard-capped at `HTTP_MAX_SESSIONS` — see [Configuration](configuration.md).

## HTTP transport authentication

The HTTP transport is **unauthenticated by default**, which is safe only because it binds `127.0.0.1` by default. If you change `SEARXNG_MCP_HOST` to anything else — including `0.0.0.0`, which is what running in a container requires — set `SEARXNG_MCP_AUTH_TOKEN` as well:

```bash
SEARXNG_MCP_AUTH_TOKEN=$(openssl rand -hex 32)
```

When it is set, every request except `GET /livez` and `GET /health` must carry the token as an [RFC 6750](https://datatracker.ietf.org/doc/html/rfc6750) bearer credential:

```
Authorization: Bearer <token>
```

Anything else — no header, a different scheme, a wrong token — gets `401` with `WWW-Authenticate: Bearer` and a JSON-RPC error body. The response is identical in all three cases and never echoes the presented credential. Tokens are compared as SHA-256 digests, so the comparison is constant-time and leaks no length information.

Registering an authenticated server with Claude Code:

```bash
claude mcp add-json searxng --scope user '{
  "type": "http",
  "url": "http://localhost:3001/mcp",
  "headers": {"Authorization": "Bearer <token>"}
}'
```

Leaving the variable unset preserves the previous behaviour exactly, so stdio users and existing loopback-bound HTTP deployments need no change. There is no per-caller authorization model — a single token authenticates *access to the server*, not a particular client identity. On startup, a non-loopback bind with no token logs a warning.

**`GET /livez` and `GET /health` are deliberately exempt** from the check. They are the probes, they take no input, and their responses carry no secrets. Only those exact paths with `GET` are exempt; any other method or path still needs the token.

## Health probes

**`GET /livez`** — process liveness. Returns `200 {"status":"ok"}` whenever the server's event loop answers, and checks no dependency. Point a Kubernetes `livenessProbe` here.

**`GET /health`** — readiness. Served on the same address as the MCP endpoint. Pings Valkey through the bounded cache command timeout (so the check itself can never hang) and returns:

```json
{"status": "ok", "cache": "up", "sessions": 3}
```

or, when the cache backend is unreachable:

```json
{"status": "degraded", "cache": "degraded", "sessions": 3}
```

`sessions` is the live HTTP session count. Useful for sysadmin monitoring to detect a degraded cache from the MCP side without instrumenting the cache backend directly.

Don't use `/health` as a liveness probe. During a Valkey outage the server keeps serving, uncached, while `/health` returns 503, so a liveness probe on it would restart every replica for a fault a restart can't fix. In Kubernetes:

```yaml
livenessProbe:
  httpGet: { path: /livez, port: 3001 }
  periodSeconds: 10
  failureThreshold: 3
readinessProbe:
  httpGet: { path: /health, port: 3001 }
  periodSeconds: 10
  failureThreshold: 3
```

Using `/health` for readiness takes a pod out of the Service while its cache is unreachable. If every replica shares one Valkey, that drains them all at once. If you'd rather keep serving uncached, use `/livez` for readiness too. The image's Docker `HEALTHCHECK` stays on `/health`: Docker never restarts a container because its healthcheck fails, so there it only reports status.

---

[← Docs index](index.md) · [Configuration](configuration.md)
