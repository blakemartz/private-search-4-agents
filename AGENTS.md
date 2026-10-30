# AGENTS.md — searxng-mcp

MCP server for private web search via a self-hosted SearXNG instance. Reranks results with a local ML model, fetches full-page content via a fetch cascade (fast paths → Crawl4AI → raw HTTP → solver and Wayback Machine, both opt-in), and optionally expands queries and synthesizes summaries via Ollama.

## What it does

Exposes three MCP tools to agents, plus two operator tools, and sends MCP server `instructions` describing the flow (`tools/list` is ~1.8k tokens). Schemas and `SERVER_INSTRUCTIONS` in `src/server/tools/index.ts` are the source of truth; `docs/tools.md` is the long form.

- **`search`** — SearXNG search reranked by a local model. `query` is a string or up to 5 phrasings (parallel, merged, URLs deduped); `max_results`; `content`: `snippets` (default) | `highlights` (top 5 pages' 2 best passages each) | `full` (top 3 pages' text); `answer: true` adds a cited synthesis from the local LLM (`OLLAMA_SUMMARIZE_MODEL`, default `qwen3:14b`). If the LLM is unavailable the payload leads with a `--- summarization unavailable (<kind>: <detail>) ---` marker and carries the pages instead; absence of that marker means you got a real synthesis. Also `include_domains`/`exclude_domains` (hard filters), `time_range`, `category`, `domain_profile`, `language`, `min_score`, `fresh`, `expand`, `engines`.
- **`fetch_url`** — readable markdown from up to 5 public URLs (HTML, PDF, GitHub API, opt-in YouTube/Reddit fast paths). Returns a window ending in a footer like `[chars 0–8,000 of 23,410 · continue with offset=8000]`; `max_tokens`, `offset`, `query` (reranked passages), `find` (literal passages), `fresh`, `domain_profile`, `target_selector`, `wait_for_selector`. Pages are always cached at the 40k-char store ceiling, so paging is a cache hit.
- **`crawl_site`** — crawl a site and return a page manifest (sitemap → optional BFS, scoped to the start URL's path); content cached for follow-up `fetch_url`
- **`clear_cache`** / **`domain_stats`** — operator tools, registered only with `SEARXNG_MCP_ADMIN_TOOLS=true`: purge the Valkey cache; read-only view of the domain capability database with structured output

`search_and_fetch` and `search_and_summarize` were removed in 4.0.0 (`search` `content: "full"` / `answer: true`).

## Structure

`src/` is grouped by responsibility, and imports only point down the layers:
`core/` ← `domains/` ← `search/`, `fetch/` ← `server/`, `cli/`. `search/` and `fetch/` do not
import each other, and there are no import cycles (`npx madge --circular --extensions ts src`).
Keep it that way: a module that needs something from a higher layer belongs in that layer.
Tests mirror the same tree under `tests/`.

```
src/
  index.ts            # Entry point — creates the MCP server, registers tools/resources, selects transport
  core/               # Cross-cutting infrastructure, no domain logic
    config.ts         #   Environment variable configuration (the one place env vars are parsed)
    package-root.ts   #   Locates the package root (package.json, domains.json) from any layout
    version.ts        #   Package version, read from package.json
    types.ts          #   Shared type definitions and zod enums
    log.ts            #   stderr logging + credential redaction
    context.ts        #   AsyncLocalStorage request id
    cache.ts          #   Valkey/Redis caching layer (get/set + Lua EVAL compare-and-set + SCAN)
    events.ts         #   Optional NATS event publishing
    observability.ts  #   Optional OpenTelemetry traces/metrics
    transport-failure.ts # Classify/redact backend transport errors
  domains/            # Per-domain knowledge
    rules.ts          #   domains.json: boost/block lists, profiles, llms.txt allowlist, tier_skip (hot-reloaded)
    db.ts             #   Per-domain capability records (tier stats, capabilities); best-effort writes
    stats.ts          #   Bounded SCAN enumerate + aggregate helpers, summary/formatters (tool + job)
    snapshot.ts       #   Durable JSON snapshot write/prune/load + non-clobbering restore
  search/             # Finding and ranking
    searxng.ts        #   SearXNG client (failover across instances, caching, query expansion)
    instances.ts      #   SearXNG instance list + health ordering
    reranker.ts       #   Jina-compatible reranker client + recency weighting + passage scoring
    authority.ts      #   Authority prior (project host, docs-shaped URL, boosted domain)
    docs-probe.ts     #   One `site:` follow-up for the project's domain when the pool lacks its docs
    passages.ts       #   Chunk stored markdown (~700 chars), drop link-dominated chunks, rerank against a query
    ollama.ts         #   Ollama/OpenAI-compatible client (query expansion + search answer synthesis)
  fetch/              # Reading pages
    fetch-page.ts     #   Orchestrator: fast paths, robots gate, tier cascade, caching, post-extract
    utils.ts          #   Shared primitives: USER_AGENT, assertPublicUrl, safeFetch, FetchTuning, readBoundedText, TierResult
    ssrf-guard.ts     #   isPrivateOrReservedAddress + DNS-validating undici dispatcher (connect-time, redirect-hop safe)
    robots.ts         #   robots.txt gate
    routing.ts        #   Which tiers run for a URL (config, operator tier_skip, observed success rate)
    content-type.ts   #   Content-type classification + rendering for non-HTML responses
    challenge.ts      #   Cloudflare-style challenge page detection
    paging.ts         #   fetch_url windowing: offset windows + continuation footer, literal `find` passages
    crawl.ts          #   crawl_site: sitemap → optional BFS, scoped to the start URL's path
    fastpaths/        #   Sources tried before the cascade
      pdf.ts          #     Local PDF text extraction via unpdf (bounded binary read, page cap)
      youtube.ts      #     YouTube transcripts (timedtext; opt-in via robots)
      reddit.ts       #     Reddit .json (post + top comments; opt-in via robots)
      llms-txt.ts     #     llms-full.txt sections for allowlisted docs sites
      kiwix.ts        #     Local Kiwix ZIM mirror
      hister.ts       #     Browsing-history index (Hister)
    tiers/            #   The cascade (one file per tier) + barrel
      crawl4ai.ts     #     Tier 2: Crawl4AI headless fetch + Readability comparison (no tier 1; slot names kept)
      raw.ts          #     Tier 3: raw HTTP + Readability; fetchRawHtmlForMetadata for post-extract
      solver.ts       #     Challenge solver (Byparr/FlareSolverr), only on a detected challenge (opt-in, SOLVER_ENABLED)
      wayback.ts      #     Tier 4: Wayback Machine CDX lookup + rawFetch (opt-in, WAYBACK_ENABLED)
      github.ts       #     GitHub fast path: README, blob, tree, releases (API); other github.com pages take the cascade
    extractors/
      readability.ts  #     JSDOM + Readability; preferReadability (wins at >=40% of the tier's prose)
      markdown.ts     #     Readability article element -> markdown (turndown + typed GFM table rule)
      post-extract.ts #     JSON-LD Article + title cascade
  server/             # The MCP surface
    tools/
      index.ts        #     registerTools + SERVER_INSTRUCTIONS; re-exports the handlers
      search.ts       #     search: schema, handler, result formatting
      fetch-url.ts    #     fetch_url: schema, handler, page rendering
      crawl-site.ts   #     crawl_site
      admin.ts        #     clear_cache / domain_stats (operator-only) + structured output schema
      args.ts         #     Argument schemas/helpers more than one tool uses (BoolArg, FreshSchema, domain profiles)
      instrument.ts   #     Request id, span, search events + latency histogram
    resources.ts      #   MCP resources (config://searxng-mcp, stats://domains)
    http-transport.ts #   HTTP transport: bearer gate, /health, per-session routing + eviction
    capabilities.ts   #   Startup capability log line
  cli/
    dump-domain.ts           # Print one domain's capability record
    domain-db-maintenance.ts # Standalone job: OTel gauges + durable snapshot (cron/PM2, single writer)
    restore-domain-db.ts     # Re-seed the domain-db from the newest snapshot after a flush
tests/                # Vitest, mirroring src/ (plus repo/ for whole-repo checks and integration/ for live backends)
scripts/bench.mjs     # Ranking/extraction benchmark against a live stack
domains.json          # Default domain rules (override with DOMAINS_CONFIG_PATH)
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

When set, all requests except `GET /livez` and `GET /health` require `Authorization: Bearer <token>`;
failures get a `401` with `WWW-Authenticate: Bearer`. Both probes are exempt on purpose: `/livez` is
process liveness (checks no dependency), `/health` is readiness (503 while Valkey is unreachable),
and neither takes input or returns secrets. Tokens are compared as SHA-256 digests so the
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
node --env-file=path/to/your.env scripts/bench.mjs
node --env-file=path/to/your.env scripts/bench.mjs --cases scripts/bench-holdout.json
```

Live pools drift between calls, and repeated `--fresh` runs can get an engine suspended for
"too many requests". To compare two variants, record the pools once (`--record pools.json`) and
`--replay pools.json` against each build: both then rank identical pools, and the engines see
nothing. Replay runs the server without a cache, so pages are fetched live.

## URL safety

All outbound fetches to caller-influenced or discovered URLs go through `safeFetch` (`fetch/utils.ts`): a string-level guard (`assertPublicUrl` — private/internal IP literals + non-HTTP) plus a DNS-validating undici dispatcher (`ssrf-guard.ts`) that rejects any hostname resolving to a private/reserved address at connect time, re-checked on every redirect hop (closes DNS-rebinding/TOCTOU). Configured internal services are intentionally not guarded, because their base URL comes from the environment rather than from a caller: Crawl4AI, SearXNG, Ollama, the reranker, **Kiwix, Hister and the solver**. The last three were missing from this list while using unguarded `fetch` exactly like the other four — so a reader auditing `hister.ts` or `kiwix.ts` against this paragraph found an undocumented unguarded fetch, which invites either a false finding or a "fix" that routes an internal service through a guard designed to reject internal addresses. Corrected 2026-09-20. The set is every module whose fetch target originates in the environment — directly from a `config.ts` constant, or via a helper that builds one (`getSearxCandidates()` reads `SEARXNG_URLS`). Anything whose target derives from a *caller's* URL goes through `safeFetch`, which is why `llms-txt.ts`, `robots.ts`, `youtube.ts`, `reddit.ts`, `pdf.ts`, `github.ts`, `raw.ts` and `wayback.ts` all use it.

Do not remove these checks — they prevent SSRF against internal services.

## Git workflow

Branch before editing — do not commit directly to `main`.
