<!-- Split out of README.md in v3.24.0 (vikunja#683). The README had reached 905 lines / 70KB, at which point it was a reference manual pretending to be an introduction. -->

# Configuration

All service URLs are configurable via environment variables.

| Variable | Default | Description |
|----------|---------|-------------|
| `SEARXNG_URL` | `http://localhost:8081` | SearXNG instance URL. Accepts a **list** of interchangeable replicas separated by `,` or `;` (e.g. `http://searxng-a:8080,http://searxng-b:8080`) — tried in order, with failover. A single value behaves exactly as before: one request, one host, no health lookup. Entries that are not valid http(s) URLs are dropped with a warning; if none survive the default is used rather than the server refusing to start. Basic-auth credentials may be embedded (`http://user:pass@host:8080`) — they are lifted out of the URL at startup and sent as an `Authorization: Basic` header, and never appear in logs, events, cache keys or error messages. |
| `SEARXNG_TOTAL_TIMEOUT_MS` | `10000` | Total timeout budget for one search **across all instances**, not per instance. Iterating N replicas at the per-attempt timeout each would make a total outage take longer to report the more replicas you add. |
| `SEARXNG_ATTEMPT_TIMEOUT_MS` | `10000` | Per-instance ceiling, further capped by whatever remains of `SEARXNG_TOTAL_TIMEOUT_MS`. |
| `SEARXNG_UNHEALTHY_TTL_SECONDS` | `30` | How long a failed instance is deprioritised for. A hint that reorders candidates, not a circuit breaker — an unhealthy instance is moved to the back, never removed, and if every instance is marked down the full list is still tried. Stored in the cache so the hint is shared across processes; a cache outage degrades to "try every instance in configured order". |
| `RERANKER_URL` | `http://localhost:8787` | Reranker instance URL |
| `RERANK_AUTHORITY_WEIGHT` | `0.1` | Weight of the authority prior added to the rerank score (project-named host, docs-shaped URL, boosted domain); `0` disables. See [architecture](architecture.md#authority-prior) |
| `GITHUB_TOKEN` | *(unset)* | GitHub personal access token — increases rate limit from 60 to 5,000 req/hour |
| `OLLAMA_URL` | *(unset)* | Ollama API base URL — required for `expand` and `search` with `answer: true` |
| `OLLAMA_API_KEY` | *(unset)* | Bearer token for authenticated Ollama proxies — adds `Authorization: Bearer <key>` header when set |
| `OLLAMA_EXPAND_MODEL` | `qwen3:4b` | Model used by query expansion (`expand` parameter). Override without rebuilding. |
| `OLLAMA_SUMMARIZE_MODEL` | `qwen3:14b` | Model used for the cited synthesis returned by `search` with `answer: true`. Override without rebuilding. |
| `OLLAMA_SUMMARIZE_TIMEOUT_MS` | `120000` | Budget for the `search` `answer: true` LLM call. Covers queue wait, model load **and** inference — so a call that is the first in longer than the Ollama host's `OLLAMA_KEEP_ALIVE` pays a full cold model load inside it. Raise it if you run a large summarize model on a cold GPU. Invalid/non-positive values fall back to the default. |
| `LLM_BASE_URL` | *(unset)* | OpenAI-compatible chat endpoint (e.g. vLLM, llama.cpp, LM Studio) for `expand` + `search` `answer: true`. Must include the API path — e.g. `http://host:8000/v1` — the server appends `/chat/completions`. When set, takes precedence over `OLLAMA_URL`, so an already-loaded model can be reused instead of running a separate Ollama model. |
| `LLM_MODEL` | *(unset)* | Model id for the OpenAI-compatible backend; overrides `OLLAMA_EXPAND_MODEL` / `OLLAMA_SUMMARIZE_MODEL` when set. |
| `LLM_API_KEY` | *(unset)* | Bearer token for the OpenAI-compatible backend — adds `Authorization: Bearer <key>` when set. |
| `LLM_DISABLE_THINKING` | `true` | Sends `chat_template_kwargs.enable_thinking: false` so reasoning models (e.g. Qwen3) return direct output. Set to `false` for servers that reject that field. |
| `CACHE_URL` | `redis://localhost:6381` | Redis-compatible URL — enables result caching. Also accepts `VALKEY_URL` or `REDIS_URL` as aliases. Works with Redis, Valkey, and Dragonfly. Server degrades gracefully if unavailable. |
| `CACHE_COMMAND_TIMEOUT_MS` | `2500` | Valkey command timeout — a stalled/CPU-spiked cache backend rejects instead of hanging (`cacheGet()` is the first `await` in every search). Invalid/non-positive values fall back to the default rather than becoming a NaN that would disable the timeout. |
| `CACHE_CONNECT_TIMEOUT_MS` | `3000` | Valkey connection timeout. Same fallback behavior as `CACHE_COMMAND_TIMEOUT_MS`. |
| `CACHE_MAX_RETRIES_PER_REQUEST` | `2` | Max retries per Valkey command before it rejects. Same fallback behavior as `CACHE_COMMAND_TIMEOUT_MS`. |
| `CACHE_TTL_SECONDS` | `3600` | Search result cache TTL in seconds |
| `FETCH_CACHE_TTL_SECONDS` | `86400` | Fetched page cache TTL in seconds |
| `CRAWL_MANIFEST_TTL_SECONDS` | `21600` | Crawl manifest and page content cache TTL in seconds (6 hours) |
| `CRAWL_MAX_PAGES_DEFAULT` | `20` | Default for `crawl_site`'s `max_pages` (capped at 100) |
| `CRAWL_BFS_ENABLED` | `false` | Set to `true` to enable the BFS (link-following) fallback in `crawl_site`. Server-side only — the tool has no per-call switch. |
| `CRAWL_BFS_MAX_DEPTH` | `3` | Maximum link-hop depth for BFS crawl |
| `EXPAND_QUERIES` | `false` | Set to `true` to enable query expansion globally |
| `CRAWL4AI_URL` | *(unset)* | Crawl4AI instance URL — enables tier 2, the JS-rendering first tier of the fetch cascade. Unset, fetches go straight to tier 3 (raw HTTP) |
| `FETCH_RAW_FIRST` | `true` | Try the raw HTTP tier before Crawl4AI; a raw result under ~1,500 chars of prose falls through to the browser. `false` restores browser-first. See [architecture](architecture.md#raw-first-cascade-order) |
| `CRAWL4AI_ENABLED` | `true` | Set to `false` to skip tier 2 regardless of `CRAWL4AI_URL`. Tier 2 is also skipped when `CRAWL4AI_URL` is unset |
| `CRAWL4AI_API_TOKEN` | *(unset)* | Optional Bearer token for Crawl4AI instances with API token protection |
| `WAYBACK_ENABLED` | `false` | Set to `true` to enable Wayback Machine tier-4 fallback — fetches archived snapshots when the main tiers fail |
| `SOLVER_URL` | *(unset)* | Base URL of a Byparr (or other FlareSolverr `POST /v1`-compatible) challenge-solving service, e.g. `http://byparr:8191`. Unset leaves the tier inert regardless of `SOLVER_ENABLED`. |
| `SOLVER_ENABLED` | `false` | Kill switch for the challenge-solving tier — mirrors `WAYBACK_ENABLED`. Requires `SOLVER_URL` to also be set; fires only when a challenge was actually detected on the current request, never on an unchallenged URL. |
| `SOLVER_MAX_TIMEOUT_MS` | `60000` | Per-request ceiling passed to the solver as `maxTimeout`. |
| `ADBLOCK_PROXY_URL` | *(unset)* | HTTP proxy URL for tier-2 (Crawl4AI) and tier-3 (raw Node fetch) adblocking — e.g. `http://adblock-proxy:8118`. See `docker/adblock-proxy/`. |
| `KIWIX_URL` | *(unset)* | kiwix-serve base URL (e.g. `http://localhost:8292`) — enables Kiwix fast path for Wikipedia, Stack Overflow, and Arch Wiki. Feature is disabled and zero-overhead when unset. |
| `HISTER_URL` | *(unset)* | Hister browsing-history index base URL — enables Hister fast path before the tier cascade for login-walled and JS-heavy pages. Feature disabled and zero-overhead when unset. |
| `HISTER_TOKEN` | *(unset)* | Bearer token for Hister API authentication. Required when `HISTER_URL` is set and the instance has token auth enabled. |
| `PDF_EXTRACT_ENABLED` | `true` | Local PDF text extraction (in-process, `unpdf`) for `.pdf` URLs and anything served as `application/pdf`. Set to `false` to disable; PDFs then take the normal cascade, where no tier can extract them. See [PDF fast path](architecture.md#pdf-fast-path). |
| `PDF_MAX_BYTES` | `20971520` | Largest PDF (bytes) the PDF fast path will download. A PDF has to be held whole to parse, so a larger one is refused — on its `Content-Length` before reading, or as soon as the stream crosses the cap — and falls through to the cascade. Invalid/non-positive values fall back to the default. |
| `PDF_MAX_PAGES` | `50` | Most pages the PDF fast path walks. Extraction also stops once the text fills the fetch store size, so this bounds CPU on long documents; a page-cap stop is noted at the end of the text. Invalid/non-positive values fall back to the default. |
| `YOUTUBE_TRANSCRIPT_ENABLED` | `true` | Enables the YouTube transcript fast path in `fetch_url`. Set to `false` to disable (e.g. if the unofficial timedtext endpoint breaks upstream). |
| `YOUTUBE_IGNORE_ROBOTS` | `false` | Opt into fetching YouTube transcripts despite YouTube's `robots.txt` disallowing `/api/`. Default respects robots (fast path stays dormant, falls through to the cascade). |
| `REDDIT_FASTPATH_ENABLED` | `true` | Enables the Reddit `.json` fast path in `fetch_url`. Set to `false` to disable. |
| `REDDIT_IGNORE_ROBOTS` | `false` | Opt into fetching Reddit `.json` despite Reddit's `robots.txt` (`Disallow: /`). Default respects robots (fast path stays dormant, falls through to the cascade). |
| `SEARXNG_MCP_TRANSPORT` | `stdio` | Transport mode: `stdio` (default, single-client) or `http` (shared HTTP/SSE server). |
| `SEARXNG_MCP_PORT` | `3001` | HTTP listen port (HTTP transport mode only). |
| `SEARXNG_MCP_HOST` | `127.0.0.1` | HTTP listen address (HTTP transport mode only). |
| `SEARXNG_MCP_ADMIN_TOOLS` | `false` | Set to `true` to also register the operator tools `clear_cache` and `domain_stats`. Off by default: `clear_cache` wipes cache shared by every agent on the box, and both add schema to every agent's context. The same data is available through the `config://` / `stats://domains` resources and the `dump-domain` CLI. |
| `SEARXNG_MCP_AUTH_TOKEN` | *(unset)* | HTTP transport only. When set, every request except `GET /health` must send `Authorization: Bearer <token>` or get a `401`. Unset (the default) disables the check entirely. **Set this whenever `SEARXNG_MCP_HOST` is not loopback** — see [HTTP transport authentication](deployment.md#http-transport-authentication). |
| `HTTP_SESSION_IDLE_TIMEOUT_MS` | `600000` | HTTP transport only. A session idle longer than this is evicted by a background sweep (sessions with an in-flight request are exempt, so a long `crawl_site` call is never closed mid-request). Bounds session-map growth from clients killed mid-turn, which never fire `transport.onclose`. |
| `HTTP_MAX_SESSIONS` | `256` | HTTP transport only. Hard-cap backstop — if the session map ever exceeds this, the least-recently-used idle session is evicted regardless of the idle timeout. |
| `HTTP_MAX_BODY_BYTES` | `1048576` | HTTP transport only. Maximum request body read on the pre-session `initialize` path; a larger body gets `413` and the read stops at the limit rather than buffering to completion first. Requests carrying an `Mcp-Session-Id` are read by the MCP SDK's own transport and are not covered by this — see [Bounded reads](security.md#bounded-reads). |
| `NATS_USER` | *(unset)* | NATS username for bcrypt username/password auth, used alongside `NATS_PASSWORD`. Ignored if `NATS_CREDS` is also set (creds-file JWT auth wins). |
| `NATS_PASSWORD` | *(unset)* | NATS password — see `NATS_USER`. |

# Prerequisites and service setup

**Runtime:** Node.js 22+ (`unpdf`, the PDF extractor, requires it), and pnpm (or npm).

## Required

- A running [SearXNG](https://github.com/searxng/searxng) instance, with JSON output enabled (see below).

That is the whole list. Everything under it is progressive enhancement.

## Strongly recommended

| Service | What it buys you |
|---------|------------------|
| [Valkey](https://valkey.io/), Dragonfly or any Redis-compatible cache | Repeat searches and fetches are served from cache instead of re-run. The single largest latency win. Fail-soft: a cache timeout serves live. |
| A reranker with a Jina-compatible `/v1/rerank` endpoint | Reorders results by semantic relevance to the query. Without it results keep SearXNG's own ordering and a throttled degradation line is logged. |

Neither has a kill switch — both have a default URL and are always attempted, because both fail
soft. Absence costs quality and latency, never correctness.

## Optional

| Service | Capability it unlocks | Turn it on with |
|---------|----------------------|-----------------|
| [Crawl4AI](https://github.com/unclecode/crawl4ai) — **recommended** | Fetch tier 2, the first tier of the cascade and the only one that renders JavaScript. Without it, JS-heavy pages get whatever tier 3's raw HTML holds | `CRAWL4AI_URL` |
| [Ollama](https://ollama.com/) with `qwen3:4b` and/or `qwen3:14b`, or any OpenAI-compatible endpoint | Query expansion and cited answers (`search` with `answer: true`) | `OLLAMA_URL` or `LLM_BASE_URL` |
| [kiwix-serve](https://github.com/kiwix/kiwix-tools) | Offline serving of Wikipedia, Stack Overflow and the Arch Wiki from local ZIM archives | `KIWIX_URL` |
| Hister | Archived-page fallback from a private archive | `HISTER_URL` |
| [Byparr](https://github.com/ThePhaseless/Byparr) or FlareSolverr | Solves Cloudflare-style interstitials on the domains that serve them | `SOLVER_URL` + `SOLVER_ENABLED=true` |
| Wayback Machine | Tier-4 fallback to an archived snapshot when the main tiers fail | `WAYBACK_ENABLED=true` |
| An OTLP collector / NATS | Traces and metrics; a JetStream event stream of every search and fetch | `OTEL_EXPORTER_OTLP_ENDPOINT` / `NATS_URL` |

On startup the server logs one line naming exactly which of these are configured, so a
lower-quality result set can be traced to a missing service rather than guessed at:

```
[searxng-mcp] capabilities on=tier3 unverified=none off=tier2,cache,reranker,llm,kiwix,hister,solver,wayback,otel,nats
```

That example is the minimal run from the README's Quick Start, measured 2026-09-07 — not an
illustration. Three states, not two:

| State | Meaning |
|---|---|
| `on` | Self-contained — nothing remote has to work for it to be true. Only `tier3` (in-process fetch + Readability) and `wayback` (a plain feature flag) can ever be `on`. |
| `unverified` | Configured, but this process has never contacted the backend. |
| `off` | Not configured. |

It reports configuration, not reachability — nothing is probed, so the line never delays
startup, and `unverified` is not a health failure. It is the honest absence of a health claim:
before v3.26.0 this line rendered a configured-but-uncontacted backend as `on`, and reported
`reranker` as on through a 4.5-hour reranker outage, because a URL was set the whole time.

Note that `cache` and `reranker` have non-empty default URLs and no kill switch, so they report
`unverified` even when nothing is deployed. Setting either to an **empty string** is what turns
them `off` — and, as of v3.28.0, what stops the process dialling them at all.

The rest of this section is setup reference for whichever of the above you chose to deploy —
skip any you did not.

## SearXNG

SearXNG must have JSON output format enabled. In `settings.yml`:

```yaml
search:
  formats:
    - html
    - json
```

## Reranker (recommended)

The reranker must expose a Jina-compatible `/v1/rerank` endpoint. One ships in this repo — a CPU-only FlashRank wrapper needing no API key and no GPU:

```bash
cd docker/reranker && docker compose up      # or, without building:
docker run -d -p 127.0.0.1:8787:8787 ghcr.io/tadmstr/searxng-mcp-reranker:latest
```

`RERANKER_URL` already defaults to `http://localhost:8787`, so nothing else needs configuring. [`docker/reranker/README.md`](../docker/reranker/README.md) covers the request/response contract, the model, and why it is baked into the image. Any other service speaking the same endpoint works too.

## Crawl4AI (recommended — fetch tier 2)

[Crawl4AI](https://github.com/unclecode/crawl4ai) is the first tier of the fetch cascade and the only one that renders JavaScript (JS-heavy sites, `wait_for_selector`). Set `CRAWL4AI_URL` to enable it. If unset, the cascade skips to raw HTTP fetch.

```bash
docker run -d -p 11235:11235 \
  -e CRAWL4AI_API_TOKEN="$(openssl rand -hex 32)" \
  unclecode/crawl4ai:0.9.3
```

Set `CRAWL4AI_API_TOKEN` to the same value on searxng-mcp.

**On 0.9.x the token is not optional, and omitting it fails invisibly.** With no token, the server binds the *container's* loopback: `docker ps` reports the container healthy, its own `/health` returns 200, and the published port answers with a connection reset. `/health` is unauthenticated even when a token *is* set, so no healthcheck at any layer distinguishes a working server from a dead one — only `/crawl` returns 401. searxng-mcp says so explicitly the first time a crawl is refused.

Two other things changed in 0.9.0 that matter if you are upgrading from 0.8.x:

- `proxy_config` and `proxy` are rejected at the network trust boundary with HTTP 400. searxng-mcp no longer sends either (see [Architecture](architecture.md#tier-3--adblock-proxy)).
- 5xx responses are generic — `{"error": "...", "correlation_id": "..."}`. searxng-mcp surfaces the correlation id in the tier failure reason so it can be matched against the server's own logs.

0.9.1 and 0.9.2 have no changelog entries upstream; 0.9.3 is the version this client is written and tested against.

Every caller (`search` content/answer modes, `fetch_url`, `crawl_site`) takes Crawl4AI's `raw_markdown`, cleaned by the Readability comparison described in [Architecture](architecture.md#fetch-quality).

## Kiwix (optional)

[kiwix-serve](https://github.com/kiwix/kiwix-tools) serves ZIM archives over HTTP. Download
the required ZIM files and run kiwix-serve with `--nodatealiases` (`-z`) so book names are
stable:

```bash
kiwix-serve --port 8292 --nodatealiases /path/to/zims/
```

Required ZIM files for each supported host:
- Wikipedia: `wikipedia_en_all_mini` (or `maxi`)
- Stack Overflow: `stackoverflow.com_en_all`
- Arch Wiki: `archlinux_en_all_maxi`

ZIM files can be downloaded from [library.kiwix.org](https://library.kiwix.org/).

## Hister (optional)

[Hister](https://github.com/nicholasgasior/hister) is a browsing-history index populated by a Firefox extension. When `HISTER_URL` is set, `fetchPage` checks the history index before invoking the tier cascade — useful for login-walled and JS-heavy pages where scrapers fail.

Set `HISTER_URL` to your Hister instance base URL and `HISTER_TOKEN` if bearer token auth is required.

## Valkey / Redis

Any Redis-compatible instance. Valkey is recommended. Search results are cached for 1 hour; fetched pages for 24 hours. If unavailable, the server operates without caching.

## Ollama

Required for `expand` and `search` with `answer: true`. Pull the required models:

```bash
ollama pull qwen3:4b   # query expansion
ollama pull qwen3:14b  # summarization
```

Set `think: false` behavior is handled automatically — no extra Ollama configuration needed.

---

[← Docs index](index.md) · [Deployment](deployment.md) · [Architecture](architecture.md)
