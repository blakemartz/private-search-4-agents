# AGENTS.md — searxng-mcp

MCP server for private web search via a self-hosted SearXNG instance. Reranks results with a local ML model, fetches full-page content via a fetch cascade (fast paths → Crawl4AI → raw HTTP → solver and Wayback Machine, both opt-in), and optionally expands queries and synthesizes summaries via Ollama.

## What it does

Exposes three MCP tools to agents, plus two operator tools, and sends MCP server `instructions` describing the flow (`tools/list` is ~1.8k tokens). Schemas and `SERVER_INSTRUCTIONS` in `src/tools.ts` are the source of truth; `docs/tools.md` is the long form.

- **`search`** — SearXNG search reranked by a local model. `query` is a string or up to 5 phrasings (parallel, merged, URLs deduped); `max_results`; `content`: `snippets` (default) | `highlights` (top 5 pages' 2 best passages each) | `full` (top 3 pages' text); `answer: true` adds a cited synthesis from the local LLM (`OLLAMA_SUMMARIZE_MODEL`, default `qwen3:14b`). If the LLM is unavailable the payload leads with a `--- summarization unavailable (<kind>: <detail>) ---` marker and carries the pages instead; absence of that marker means you got a real synthesis. Also `include_domains`/`exclude_domains` (hard filters), `time_range`, `category`, `domain_profile`, `language`, `min_score`, `fresh`, `expand`, `engines`.
- **`fetch_url`** — readable markdown from up to 5 public URLs (HTML, PDF, GitHub API, opt-in YouTube/Reddit fast paths). Returns a window ending in a footer like `[chars 0–8,000 of 23,410 · continue with offset=8000]`; `max_tokens`, `offset`, `query` (reranked passages), `find` (literal passages), `fresh`, `domain_profile`, `target_selector`, `wait_for_selector`. Pages are always cached at the 40k-char store ceiling, so paging is a cache hit.
- **`crawl_site`** — crawl a site and return a page manifest (sitemap → optional BFS, scoped to the start URL's path); content cached for follow-up `fetch_url`
- **`clear_cache`** / **`domain_stats`** — operator tools, registered only with `SEARXNG_MCP_ADMIN_TOOLS=true`: purge the Valkey cache; read-only view of the domain capability database with structured output

`search_and_fetch` and `search_and_summarize` were removed in 4.0.0 (`search` `content: "full"` / `answer: true`).

## Structure

```
src/
  index.ts        # Entry point — creates MCP server, registers tools, selects transport
  http-transport.ts # HTTP transport: bearer gate, /health, per-session routing + eviction
  tools.ts        # Tool definitions (schemas + handlers) and SERVER_INSTRUCTIONS
  paging.ts       # fetch_url windowing: offset windows + continuation footer, literal `find` passages
  passages.ts     # Chunk stored markdown (~700 chars), drop link-dominated chunks, rerank against a query
  search.ts       # SearXNG client
  fetch.ts        # Fetch orchestrator: fast paths, robots gate, tier cascade, caching, post-extract
  fetch-utils.ts  # Shared primitives: USER_AGENT, assertPublicUrl, safeFetch, FetchTuning, readBoundedText, TierResult
  ssrf-guard.ts   # isPrivateOrReservedAddress + DNS-validating undici dispatcher (connect-time, redirect-hop safe)
  youtube.ts      # YouTube transcript fast path (timedtext; opt-in via robots)
  reddit.ts       # Reddit .json fast path (post + top comments; opt-in via robots)
  pdf.ts          # PDF fast path: local text extraction via unpdf (bounded binary read, page cap)
  extractors/
    readability.ts  # JSDOM + Readability; preferReadability (wins at >=40% of the tier's prose)
    markdown.ts     # Readability article element -> markdown (turndown + typed GFM table rule)
    post-extract.ts # JSON-LD Article + title cascade
  tiers/          # Tier handlers (one file per tier)
    crawl4ai.ts   # Tier 2: Crawl4AI headless fetch + Readability comparison (no tier 1; slot names kept)
    raw.ts        # Tier 3: raw HTTP + Readability; fetchRawHtmlForMetadata for post-extract
    solver.ts     # Challenge solver (Byparr/FlareSolverr), reached only on a detected challenge (opt-in, SOLVER_ENABLED)
    wayback.ts    # Tier 4: Wayback Machine CDX lookup + rawFetch (opt-in, WAYBACK_ENABLED)
    github.ts     # GitHub fast path: README, blob, tree, releases (API); other github.com pages take the cascade
    index.ts      # Barrel re-export
  reranker.ts     # Jina-compatible reranker client + recency weighting + passage scoring
  ollama.ts       # Ollama/OpenAI-compatible client (query expansion + search answer synthesis)
  cache.ts        # Valkey/Redis caching layer (get/set + Lua EVAL compare-and-set + SCAN)
  domain-db.ts    # Per-domain capability records (tier stats, capabilities); best-effort writes
  domain-stats.ts # Bounded SCAN enumerate + aggregate helpers, summary/formatters (tool + job)
  domain-snapshot.ts # Durable JSON snapshot write/prune/load + non-clobbering restore
  domains.ts      # Domain boost/block filtering + profiles
  config.ts       # Environment variable configuration
  types.ts        # Shared type definitions
  cli/
    dump-domain.ts           # Print one domain's capability record
    domain-db-maintenance.ts # Standalone job: OTel gauges + durable snapshot (cron/PM2, single writer)
    restore-domain-db.ts     # Re-seed the domain-db from the newest snapshot after a flush
tests/
  *.test.ts       # Vitest unit tests (1,342 tests across 95 files, 6 skipped without VALKEY_TEST_URL)
```

The domain-db maintenance/restore CLIs are standalone (`pnpm domain-db-maintenance`, `pnpm restore-domain-db`) — run the maintenance job on a schedule, **not** as an in-process timer, since searxng-mcp runs as several concurrent per-agent stdio children. Snapshot path/retention via `DOMAIN_DB_SNAPSHOT_DIR` / `DOMAIN_DB_SNAPSHOT_RETENTION`.

## Dependencies

Required services:

| Service | Env var | Purpose |
|---|---|---|
| SearXNG | `SEARXNG_URL` | Meta-search engine |

Optional services (server degrades gracefully without these):

| Service | Env var | Purpose |
|---|---|---|
| Reranker | `RERANKER_URL` | ML relevance reranking |
| Crawl4AI | `CRAWL4AI_URL` | JS-rendering fetch, first tier of the cascade (tier 2); recommended |
| Valkey/Redis/Dragonfly | `CACHE_URL` | Result caching (also accepts `VALKEY_URL` or `REDIS_URL`) |
| Ollama | `OLLAMA_URL` | Query expansion + `search` `answer: true` |
| Wayback Machine | `WAYBACK_ENABLED=true` | Archived snapshot fallback (tier 4, opt-in) |
| Hister | `HISTER_URL`, `HISTER_TOKEN` | Browsing-history index (Firefox extension); fast path before tier cascade for login-walled and JS-heavy pages |

## Build and run

```bash
pnpm install
pnpm build        # tsc → build/
node build/src/index.js
```

Transport: stdio by default; `SEARXNG_MCP_TRANSPORT=http` runs a shared HTTP server on
`SEARXNG_MCP_HOST:SEARXNG_MCP_PORT`.

## Transport authentication

The HTTP transport is unauthenticated unless `SEARXNG_MCP_AUTH_TOKEN` is set — the default
`127.0.0.1` bind is what makes that safe. Any non-loopback bind (`0.0.0.0`, i.e. every
containerised deployment) **must** set the token, or every tool is reachable by anything that
can route to the port, including the arbitrary-URL `fetch_url` and, with `SEARXNG_MCP_ADMIN_TOOLS=true`, the
destructive `clear_cache`. The startup guard logs a warning for exactly that combination.

When set, all requests except `GET /health` require `Authorization: Bearer <token>`; failures
get a `401` with `WWW-Authenticate: Bearer`. `/health` is exempt on purpose — it is the
container healthcheck and returns no secrets. Tokens are compared as SHA-256 digests so the
check is constant-time and total (a raw `timingSafeEqual` throws on a length mismatch).

Do not add authorization decisions here. There is no per-caller identity model — the token
authenticates access to the server, not a client. Per-tool scoping belongs upstream in the
calling proxy.

## Testing

```bash
pnpm test         # vitest run --typecheck
```

Ranking and extraction changes are measured, not eyeballed: `scripts/bench.mjs` runs a fixed set of
developer questions against a live stack and reports where the authoritative page ranks (gold@1,
gold@5, MRR), whether `content: "highlights"` and `fetch_url` `query` passages contain the answer,
latency and output size. Tune on the default set, then confirm on the held-out set before keeping a
change:

```bash
pnpm build
node --env-file=~/dev/websearch/.env.searxng-mcp scripts/bench.mjs
node --env-file=~/dev/websearch/.env.searxng-mcp scripts/bench.mjs --cases scripts/bench-holdout.json
```

## URL safety

All outbound fetches to caller-influenced or discovered URLs go through `safeFetch` (`fetch-utils.ts`): a string-level guard (`assertPublicUrl` — private/internal IP literals + non-HTTP) plus a DNS-validating undici dispatcher (`ssrf-guard.ts`) that rejects any hostname resolving to a private/reserved address at connect time, re-checked on every redirect hop (closes DNS-rebinding/TOCTOU). Configured internal services are intentionally not guarded, because their base URL comes from the environment rather than from a caller: Crawl4AI, SearXNG, Ollama, the reranker, **Kiwix, Hister and the solver**. The last three were missing from this list while using unguarded `fetch` exactly like the other four — so a reader auditing `hister.ts` or `kiwix.ts` against this paragraph found an undocumented unguarded fetch, which invites either a false finding or a "fix" that routes an internal service through a guard designed to reject internal addresses. Corrected 2026-09-20. The set is every module whose fetch target originates in the environment — directly from a `config.ts` constant, or via a helper that builds one (`getSearxCandidates()` reads `SEARXNG_URLS`). Anything whose target derives from a *caller's* URL goes through `safeFetch`, which is why `llms-txt.ts`, `robots.ts`, `youtube.ts`, `reddit.ts`, `pdf.ts`, `github.ts`, `raw.ts` and `wayback.ts` all use it.

Do not remove these checks — they prevent SSRF against internal services.

## Git workflow

Branch before editing — do not commit directly to `main`.
