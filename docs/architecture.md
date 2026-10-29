<!-- Split out of README.md in v3.24.0 (vikunja#683). The README had reached 905 lines / 70KB, at which point it was a reference manual pretending to be an introduction. -->

# Architecture

```
MCP client (stdio)
      │
      ▼
  searxng-mcp ──────────────→ cache ($CACHE_URL)           → result cache (search 1h, fetch 24h, crawl 6h)
      │
      ├── expand (optional) →  Ollama ($OLLAMA_URL)        → rewritten query (qwen3:4b)
      ├── search ───────────→ SearXNG ($SEARXNG_URL)      → raw results
      ├── rerank ───────────→ Reranker ($RERANKER_URL)    → ranked results
      │                       (fallback: SearXNG order if reranker unavailable)
      ├── fetch content ────┬→ GitHub API (github.com)    → markdown
      │                     ├→ Kiwix ($KIWIX_URL)         → ZIM content (Wikipedia/SO/Arch Wiki, fast path)
      │                     ├→ Hister ($HISTER_URL)       → browsing-history index (login-walled/JS-heavy fast path)
      │                     ├→ Local PDF (unpdf)         → page-marked PDF text (in-process; .pdf path or application/pdf)
      │                     ├→ Crawl4AI ($CRAWL4AI_URL)  → page markdown (tier 2, first tier; optional, direct — no proxy, see below)
      │                     ├→ Raw HTTP + Readability     → page markdown (tier 3 fallback; via $ADBLOCK_PROXY_URL if set)
      │                     ├→ Byparr solver (opt-in)     → challenge-solved page markdown (only on a detected challenge, $SOLVER_ENABLED)
      │                     └→ Wayback Machine (opt-in)  → archived page markdown (tier 4, $WAYBACK_ENABLED)
      ├── crawl_site ───────┬→ Sitemap parsing           → page manifest (phase 1, fast-xml-parser)
      │                     └→ BFS crawl (opt-in)        → page manifest (phase 2, $CRAWL_BFS_ENABLED)
      ├── passages ─────────→ Reranker ($RERANKER_URL)    → query-relevant chunks (highlights, fetch_url query)
      └── answer (opt.) ────→  Ollama ($OLLAMA_URL)        → cited synthesis, search answer:true ($OLLAMA_SUMMARIZE_MODEL)
```

```mermaid
flowchart TD
    entry["fetchPage(url)"]
    cache{"Valkey cache hit?"}
    cached["→ return cached { title, url, text }"]
    github{"GitHub host?\ngithub.com · raw · api"}
    gh_fetch["GitHub API / raw.githubusercontent.com / api.github.com\n→ return"]
    llms{"llms.txt domain?"}
    llms_fetch["Probe /llms-full.txt\nextract matching section\n→ return"]
    kiwix{"Kiwix host?\nKIWIX_URL set"}
    kiwix_fetch["Local Kiwix ZIM\nWikipedia · Stack Overflow · Arch Wiki\n→ cache + return"]
    robots["robots.txt pre-check — tiers 2–3\ndisallowed → RobotsDisallowedError (cached 24h)"]
    pdf{"PDF?\n.pdf path, or HEAD says application/pdf"}
    pdf_fetch["Local PDF extraction — unpdf, in-process\npage-marked text · PDF_EXTRACT_ENABLED\n→ cache + return"]
    tier_skip(["Per-domain tier skip\nsuccess rate &lt;30% over ≥10 tries\nor tier_skip operator override"])
    t2["Tier 2 — Crawl4AI\n$CRAWL4AI_URL · optional\ndirect — no adblock proxy"]
    t3["Tier 3 — Raw HTTP + Readability\nfallback: raw HTML slice\nadblock proxy if $ADBLOCK_PROXY_URL"]
    challenge(["Challenge detected\non this URL, this request?"])
    solver["Solver — Byparr\n$SOLVER_URL · opt-in, SOLVER_ENABLED=true\nSSRF-guarded replay"]
    t4["Tier 4 — Wayback Machine CDX API\narchived snapshot · WAYBACK_ENABLED=true"]
    post["Post-extraction\nJSON-LD Article · title cascade\nog:title → twitter:title → title → h1 → URL"]
    result["→ return { title, url, text }"]

    entry --> cache
    cache -->|hit| cached
    cache -->|miss| github
    github -->|yes| gh_fetch
    github -->|no| llms
    llms -->|yes| llms_fetch
    llms -->|no| kiwix
    kiwix -->|yes| kiwix_fetch
    kiwix -->|no| robots
    robots --> pdf
    pdf -->|yes| pdf_fetch
    pdf -->|no| tier_skip
    pdf_fetch -->|"miss / error\n(not: no text layer)"| tier_skip
    tier_skip --> t2
    t2 -->|success| post
    t2 -->|"empty / error"| t3
    t3 -->|success| post
    t3 -->|"empty / error"| challenge
    challenge -->|"yes, SOLVER_ENABLED"| solver
    challenge -->|no| t4
    solver -->|success| post
    solver -->|"miss / disabled"| t4
    t4 -->|success| result
    post --> result

    style entry fill:#ffffff,stroke:#333333,color:#000000
    style cache fill:#ffffff,stroke:#333333,color:#000000
    style cached fill:#ffffff,stroke:#333333,color:#000000
    style github fill:#dae8fc,stroke:#6c8ebf,color:#000000
    style gh_fetch fill:#dae8fc,stroke:#6c8ebf,color:#000000
    style llms fill:#dae8fc,stroke:#6c8ebf,color:#000000
    style llms_fetch fill:#dae8fc,stroke:#6c8ebf,color:#000000
    style kiwix fill:#fff9c4,stroke:#b8860b,color:#000000
    style kiwix_fetch fill:#fff9c4,stroke:#b8860b,color:#000000
    style robots fill:#ffffff,stroke:#333333,color:#000000
    style pdf fill:#dae8fc,stroke:#6c8ebf,color:#000000
    style pdf_fetch fill:#dae8fc,stroke:#6c8ebf,color:#000000
    style tier_skip fill:#f5f5f5,stroke:#666666,color:#000000
    style t2 fill:#d5e8d4,stroke:#5a8a4a,color:#000000
    style t3 fill:#d5e8d4,stroke:#5a8a4a,color:#000000
    style challenge fill:#f5f5f5,stroke:#666666,color:#000000
    style solver fill:#d5e8d4,stroke:#5a8a4a,color:#000000
    style t4 fill:#f8cecc,stroke:#a03030,color:#000000
    style post fill:#e1d5e7,stroke:#7a5a8a,color:#000000
    style result fill:#ffffff,stroke:#333333,color:#000000
```

**Only SearXNG is required.** Every tier below it is optional: Crawl4AI, Valkey, Ollama, Kiwix, the reranker, the solver and Wayback each improve a named dimension, and the server degrades gracefully when any of them is unavailable. Tier 3 is a raw HTTP fetch plus Readability running in-process, so `fetch_url` still returns extracted content with nothing else deployed. Leave `CRAWL4AI_URL` unset (or set `CRAWL4AI_ENABLED=false`) and tier 2 is skipped with `reason: not_configured` rather than attempted and missed.

**There is no tier 1.** It was Firecrawl, removed in this fork; the cascade starts at Crawl4AI. The slot names `tier2`/`tier3` were deliberately not renumbered, because they are persisted in domain-db records and in `tier_skip` config.

**Every fetched page is cached at the store ceiling.** `fetchPage` always extracts and stores up to `FETCH_STORE_CEILING` (40,000 chars), whatever the caller asked for, and the tools window that stored text on read. So `fetch_url` paging (`offset`), `find`, `query` passages and `search` highlights over the same page are cache hits rather than refetches, and paging past the first 8,000 chars works however the page was first fetched. A stored text that reaches the ceiling was itself cut; `fetch_url`'s footer then reports the length as `≥40,000 (store limit)`.

**PDFs are extracted locally, ahead of the cascade.** No cascade tier reads PDFs (Crawl4AI renders them in a browser and finds no text; tier 3 reads bodies as text), so a PDF fast path does — see [PDF fast path](#pdf-fast-path). A PDF reaching tier 3 means that path was skipped or failed, and tier 3 says so: `PDF content cannot be extracted by raw fetch — the local PDF path was skipped or failed`.

## Adblocking

One adblocking sidecar ships, and it covers tier 3 only:

| Sidecar | Tier | Mechanism | Applies when |
|---------|------|-----------|--------------|
| `docker/adblock-proxy/` | Tier 3 (raw fetch) only | HTTP forward proxy — filters plain-HTTP ad domains | `ADBLOCK_PROXY_URL` is set |

**Per-domain bypass:** `domains.json` reserves an `adblock_skip` slot for future operator overrides. It is a schema slot only — nothing reads it yet. Tracked as scope-creep item I.

### Tier 3 — Adblock proxy

Set `ADBLOCK_PROXY_URL` (e.g. `http://adblock-proxy:8118`) to route raw Node fetch requests through an HTTP forward proxy that filters ad and tracker requests.

**This applies to tier 3 only. Tier 2 does not use it, and must not.** Tier 3 resolves the proxy hostname *in this process*; a proxy passed to Crawl4AI is resolved by *Crawl4AI*, inside its own container, which is a different network position entirely. Sending it was a 100% tier-2 outage until v3.25.0 — every crawl returned `net::ERR_PROXY_CONNECTION_FAILED` and was recorded as an ordinary empty result (vikunja#690). Crawl4AI 0.9.x additionally rejects the field at its trust boundary with HTTP 400. Adblocking for tier 2 would have to be configured server-side on Crawl4AI, which is a deployment change rather than a client one. HTTPS CONNECT tunnels are passed through unmodified — no MITM, so filtering applies to plain-HTTP ad domains only.

As of v3.19.0, the proxy validates the **resolved** address — not just the requested hostname string — on both its CONNECT and plain-HTTP paths before connecting, closing a DNS-rebinding gap (audit finding SSRF-10).

See [`docker/adblock-proxy/`](../docker/adblock-proxy/) for the service definition, configuration options, and deployment instructions (included in `examples/compose.full.yml`, rung 4).

## Raw-first cascade order

The cascade *list* is tier 2 (Crawl4AI) then tier 3 (raw HTTP + Readability), but it *runs* raw first (`orderTiers` in `src/fetch/fetch-page.ts`). A raw result is accepted when it extracts at least 1,500 chars of prose; anything thinner — a JS shell, a "please enable JavaScript" page — falls through to Crawl4AI, and is kept as the answer if Crawl4AI then fails too. `wait_for_selector` keeps the browser first (waiting only means something on a rendered page), as does `FETCH_RAW_FIRST=false`.

Why: measured 2026-10-28 on twelve documentation pages, raw found the answer on all twelve at 0.5–2s against Crawl4AI's 1.2–3.4s; Crawl4AI missed the answer on one page and errored on another. On the held-out benchmark with a cold cache, `fetch_url` `query` went from a 3.5s to a 1.5s median and highlights from 7.5s to 5.4s, answer rate unchanged at 100%.

## Data-driven tier routing

Before invoking the fetch cascade, searxng-mcp reads the domain's `tier_stats_30d` (see [domain capability database](#domain-capability-database)) and skips any tier with success rate below 30% over at least 10 attempts. Cold-start domains (<10 attempts) keep the default cascade. Each skip emits a `searxng.fetch.tier.skipped` NATS event and increments `searxng_fetch_total{outcome=skipped}`, both carrying the reason. Three reasons exist: `low_success_rate` (the stats rule above), `operator_override` (a `tier_skip` entry in `domains.json`), and `not_configured` (the tier's service is switched off, or has no URL). `not_configured` takes precedence over both others — an override cannot un-skip a tier there is nothing to call. Because a skipped tier is never recorded as an attempt, an unconfigured tier no longer books misses into `tier_stats_30d` meaning “not deployed” rather than “tried and failed”.

**Operator override.** Add a `tier_skip` map to `domains.json` to force-skip tiers regardless of stats:

```json
{
  "tier_skip": {
    "example-bot-blocked.com": ["tier2"],
    "another-site.example": ["tier2", "tier3"]
  }
}
```

`tier_skip` keys can be bare domains (`example.com` matches the domain and all subdomains) or domain + path prefix (`example.com/api/`). The file is hot-reloaded — no restart needed. Manual overrides emit `reason: operator_override`.

## PDF fast path

PDF text is extracted in-process with [`unpdf`](https://github.com/unjs/unpdf) (a pdf.js build) — keyless, no service to deploy. It replaces Firecrawl v2, the only tier that ever parsed PDFs, which was removed in this fork.

A URL takes this path when its path ends in `.pdf` (no probe needed), or when the [content-type probe](#content-type-fast-path)'s `HEAD` reports `application/pdf` — which is how extensionless PDFs (`arxiv.org/pdf/<id>`, `?download=` handlers) are found. It runs after the robots gate and `assertResolvedPublic`, fetches through `safeFetch`, and follows redirects by hand (at most 5) so every hop is re-checked by the string-level SSRF guard as well as the connect-time one.

- The body is read as bytes, capped at `PDF_MAX_BYTES` (20 MB) — a declared `Content-Length` over the cap is refused before reading, and a stream that crosses it is cancelled. The `%PDF-` signature must appear in the first 1 KB, or the body is treated as not a PDF.
- Output: the PDF's `Title` metadata (or the filename) as the title; text is each page under a `--- page N ---` marker, whitespace collapsed. Pages are walked up to `PDF_MAX_PAGES` (50) and stop once the text reaches the fetch store ceiling (40,000 chars), so CPU is bounded by what would be kept anyway; a page-cap stop is noted at the end.
- Recorded through `runTier` as `pdf_local` (domain-db slot `pdf`), cached like every other fast path.
- **Fail-open**, with one exception. A non-PDF body at a `.pdf` URL, an oversize file, an HTTP error or a parse failure falls through to the cascade, and the `pdf_local` reason is named in the final error if that fails too. A PDF that parses but has **no text layer** (scanned/image-only) or needs a password is a fact about the document, so it is returned as an error — `PDF has no extractable text layer (scanned?)` — rather than retried. There is no OCR.
- `PDF_EXTRACT_ENABLED=false` turns the path off; PDFs then take the cascade and fail at tier 3, as before.

## Content-type fast path

A URL serving structured, non-HTML content — `application/json`, any `*+json`, XML, YAML, TOML, CSV, or `text/plain` — is detected via a `HEAD` probe and routed straight to the raw-HTTP tier instead of through Crawl4AI. JSON is returned pretty-printed inside a fenced code block. Previously, asking a headless browser to render a JSON API response or CDN asset returned empty markdown, so API and CDN endpoints (`registry.npmjs.org`, `api.osv.dev`, `cdn.jsdelivr.net`, …) simply failed.

Guarantees:
- The probe is **fail-open**. An unreachable host, a server that refuses `HEAD`, or an unreadable/unparseable `Content-Type` header all fall through to the normal cascade unchanged.
- `application/xhtml+xml` is deliberately excluded — that is markup for a browser, not structured data.
- HTML that a server mislabels as `text/plain` is still parsed as HTML, not dumped as a raw text block.

## Domain capability database

Every fetch records what searxng-mcp learns about the target domain to Valkey under `domain:<hostname>` (90-day TTL, schema_version 7). Captured per record:

- `tier_stats_30d.{tier2,tier3,tier4,solver,github,pdf}.{attempts, ok, fail, last_fail_reason, window_start_ms}` — fetch success rate per tier over a rolling 30-day window. The cutoff is applied at **read time**, shared by tier-routing decisions and `domain_stats` reporting, so the two cannot disagree — a domain fetched once and then left idle reports a genuinely empty window rather than stale numbers surviving until the next write. The `tier4` (Wayback Machine) slot is recorded only when `WAYBACK_ENABLED=true`; the `solver` slot (Byparr challenge-solving tier, see [Challenge detection and solver tier](#challenge-detection-and-solver-tier)) only when `SOLVER_ENABLED=true`. The `github` slot records the [GitHub fast path](tools.md#github-urls) (`raw.githubusercontent.com` / `api.github.com` / `github.com` README fetches), which bypasses the tier cascade but is still tracked here. A `schema_version` bump rebuilds existing records fresh — accumulated windows for currently-idle domains are discarded (precedented across the 1→2 through 6→7 bumps). Removing Firecrawl did **not** bump the version: records written by upstream builds still carry `tier1` and `crawl` slots, which nothing reads and which are stripped on the next write. Adding the `pdf` slot (the [PDF fast path](#pdf-fast-path)) did not bump it either: a record written before the slot existed reads as an empty `pdf` window, gets the slot back-filled on its next write, and is still admitted by the snapshot restore guard.
- `capabilities.metadata_fetch.{attempts, ok, fail, last_fail_reason}` — success/failure of the metadata side-channel fetch (`fetchRawHtmlForMetadata`, used for JSON-LD/og:title sampling). Tracked separately from `tier_stats_30d` since it answers "is this domain reachable at all", not "did full-content delivery succeed".
- `capabilities.seen_in_search.{count, last_seen_ms}` — how often the domain appears in `search` results. Written fire-and-forget by `searxSearch()` on every return path (including cache hits) with no fetch performed, so a domain can be tracked before it is ever fetched.
- `capabilities.robots_txt.{present, fetched, allows_us}` — robots.txt presence and whether it permits us
- `capabilities.llms_full_txt.{present, size_bytes, last_checked}` — whether the domain serves `/llms-full.txt`
- `capabilities.json_ld_article.{sampled, present, last_sampled_at}` — whether the page carries Article-schema JSON-LD at all (Schema.org `Article`/`NewsArticle`/`BlogPosting`/`TechArticle` and subtypes like `ScholarlyArticle`/`OpinionNewsArticle`/`LiveBlogPosting`, matched by bare name or fully-qualified `https://schema.org/...` `@type`), independent of whether that schema had extractable body text — many sites publish headline/metadata JSON-LD with no `articleBody`, which is a distinct concern from [post-extraction](#fetch-quality) actually using it.
- `capabilities.og_title.{sampled, present, last_sampled_at}` — same for `<meta property="og:title">`
- `preferred_strategy` — currently set to `llms_full_txt` when a present probe lands; future phases will use this to skip the tier cascade

Inspect a record with the bundled CLI, or query it via the `domain_stats` admin tool (registered with `SEARXNG_MCP_ADMIN_TOOLS=true`; single-domain or aggregate; see [Tools](tools.md#admin-tools)) or the `stats://domains` resource:

```bash
pnpm dump-domain docs.anthropic.com
```

`dump-domain` distinguishes a window that has expired from a tier that has no data at all, rather than showing both the same way.

Concurrent updates for the same hostname (the tier-attempt, robots-probe, and post-extract-sample recorders that fire in parallel during one fetch) are serialized through a server-side Lua compare-and-set, paired with an in-process per-key queue that removes contention between a single process's own writers so the CAS only has to arbitrate genuinely concurrent writes across processes. Versions before v3.17.0 used a `WATCH`/`MULTI`/`EXEC` read-modify-write against a shared connection, which does not actually serialize concurrent writers — data collected before v3.17.0 was substantially incomplete as a result. Upgrading discards existing tier statistics via the schema bump; expect `domain_stats` to read near-empty immediately after upgrading and refill over the following days.

### Domain-db persistence

The domain-db lives only in Valkey under a 90-day TTL and 30-day rolling windows, so a cache flush or TTL expiry erases capability learning that is expensive to re-acquire. Two CLIs make it durable:

```bash
pnpm domain-db-maintenance   # SCAN all domain:* records → write a dated JSON snapshot (+ prune) and emit OTel gauges
pnpm restore-domain-db       # re-seed the domain-db from the newest snapshot after a flush
```

- **`domain-db-maintenance`** is a standalone job — run it on a schedule via cron or a container cron sidecar, **not** as an in-process timer. (The original reason was that searxng-mcp ran as several concurrent per-agent stdio children that would each fire the timer. That is no longer true: since vikunja#149/#321 it is one shared container. The conclusion still holds for a different reason — an in-process timer ties a bounded full-keyspace `SCAN` to the lifetime of the request-serving process, whereas a standalone job can be scheduled, retried and observed on its own.) One bounded `SCAN` feeds both outputs: a durable dated snapshot and, when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, gauges (`searxng_domains_tracked`, `searxng_domains_failing`, `searxng_domain_tier_success_ratio{tier}`) force-flushed before exit.
- **`restore-domain-db`** re-seeds only keys that are missing or whose live record is strictly staler than the snapshot (compares `last_fetch`) — it never clobbers a fresher-or-equal live record, so it is safe to run against a live, partially-populated Valkey (e.g. in a service boot sequence for automatic flush recovery).

| Env var | Default | Purpose |
|---------|---------|---------|
| `DOMAIN_DB_SNAPSHOT_DIR` | `./domain-db-snapshots` | Where dated snapshots are written/read. Set to a durable path (appdata or NFS mount) in deployment. |
| `DOMAIN_DB_SNAPSHOT_RETENTION` | `14` | How many snapshots to keep; older ones are pruned each maintenance run. |

## llms.txt fast path

For whitelisted documentation domains in `domains.json` (`llms_txt` array), `fetchPage` tries `<origin>/llms-full.txt` first and extracts the section matching the requested URL before invoking any tier. This avoids running a headless browser against well-instrumented docs sites and returns a clean markdown section directly. Probe outcomes and the full body are cached in Valkey (`llms:<origin>:full`, 24 h / 7 d for present/absent). Default whitelist: `docs.anthropic.com`, `docs.openai.com`, `docs.stripe.com`, `docs.crawl4ai.com`, `docs.firecrawl.dev`, `docs.cursor.com`. Extend by editing `domains.json` — the file is hot-reloaded.

A document is accepted only if it is between 1 KB and 64 MB; anything outside that is treated as absent and falls through to the normal tier cascade. The upper bound is a capability boundary as much as a memory one — for reference, `docs.anthropic.com/llms-full.txt` was 40.3 MB as of 2026-09-03, so lowering it much further would drop that domain off the fast path.

## Kiwix fast path

When `KIWIX_URL` is set, fetch requests for known offline-capable hosts are intercepted
before the tier cascade and served from the local [Kiwix](https://kiwix.org/)
ZIM archive. This sidesteps headless-scraper blocking on sites like Wikipedia and returns clean readable content with zero external network traffic.

Supported hosts and ZIM books (kiwix-serve must run with `--nodatealiases` / `-z`):

| Host | ZIM book |
|------|----------|
| `en.wikipedia.org`, `wikipedia.org` | `wikipedia_en_all_mini` |
| `stackoverflow.com` | `stackoverflow.com_en_all` |
| `wiki.archlinux.org` | `archlinux_en_all_maxi` |

The Kiwix path runs after the llms-txt fast path and before the robots gate. If the Kiwix
request fails or returns empty, the full tier cascade runs as normal. When `KIWIX_URL` is
unset the feature adds zero overhead — `isKiwixHost()` returns false immediately.

Set `KIWIX_URL` to your kiwix-serve base URL (e.g. `http://localhost:8292`).

## YouTube & Reddit fast paths

`fetch_url` recognises YouTube video URLs (`youtube.com`, `youtu.be`) and Reddit thread URLs and can serve them directly instead of scraping the rendered page:

- **YouTube** — extracts the video's caption track from the watch page and returns the transcript. Enabled by `YOUTUBE_TRANSCRIPT_ENABLED` (default on).
- **Reddit** — fetches the public `.json` view and returns the post plus top comments in the standard `{title, url, text}` shape; falls through on HTTP 429. Enabled by `REDDIT_FASTPATH_ENABLED` (default on).

Both rely on **unofficial, undocumented endpoints** (YouTube's timedtext API, Reddit's `.json`) — best-effort with no SLA; either may break on an upstream change, hence the kill switches. On any miss the request falls through to the normal tier cascade (which can still get a YouTube page's title/description).

**robots.txt:** both endpoints are disallowed by the sites' `robots.txt` (Reddit disallows everything; YouTube disallows `/api/`, where the transcript lives). By default these fast paths respect that and stay dormant, falling through to the cascade. On your own instance you can opt into direct fetching with `YOUTUBE_IGNORE_ROBOTS=true` / `REDDIT_IGNORE_ROBOTS=true`.

## Site crawling

`crawl_site` crawls a site and returns a manifest of URL/title/snippet for each page found. It uses a two-phase strategy cascade:

1. **Sitemap parsing** — fetches `/sitemap.xml` (and linked sitemaps) and extracts URLs, then fetches each page through the normal fetch cascade. Uses `fast-xml-parser` for sitemap XML parsing.
2. **BFS crawl** (opt-in) — if sitemap parsing yields nothing, performs a breadth-first crawl starting from the given URL up to `CRAWL_BFS_MAX_DEPTH` link hops. Only runs when `CRAWL_BFS_ENABLED=true`.

A start URL with a path (`https://example.com/docs`) confines both phases to pages under that path unless `include_path` is given; `include_path: "/"` crawls the whole site.

Full page content fetched during the crawl is cached in Valkey (TTL: `CRAWL_MANIFEST_TTL_SECONDS`, default 6 hours). Subsequent `fetch_url` calls for any URL in the manifest return immediately from cache — zero fetch overhead for follow-up reads.

The manifest cache can be cleared with the admin tool `clear_cache(target="crawl")`.

## Passages

`search` with `content: "highlights"` and `fetch_url` with `query` return the passages of a page most relevant to a question rather than its head (`src/search/passages.ts`):

1. **Chunk.** The stored markdown is split on blank lines and paragraphs are packed into ~700-char chunks; a longer paragraph is split on its own, at a sentence or line break where one is near. Each chunk keeps its character offset, so a passage can be followed up with `fetch_url` `offset`.
2. **Clean and filter.** Each chunk is reduced to prose (link targets, image syntax, heading/emphasis markers, permalink glyphs removed). Chunks under 80 chars of prose, or where prose is under 40% of the raw chunk — nav menus, tables of contents — are dropped.
3. **Score.** The remaining chunks (prefiltered by term overlap to at most 64 on long pages) are scored against the query by the same local cross-encoder that reranks search results (`RERANKER_URL`, `/v1/rerank`).
4. **Fallback.** With no reranker, or when it errors, chunks are scored by term overlap (the fraction of the query's distinct terms present). That is a much weaker signal, and the output says so: `fetch_url` prints `ranked by term overlap — reranker unavailable` instead of `ranked by the local reranker`.

`find` is separate and purely literal (`src/fetch/paging.ts`): case-insensitive matches, `|` for alternatives, ±300 chars of context, overlapping windows merged, at most 8 passages.

## Wayback Machine fallback

When `WAYBACK_ENABLED=true`, a last-resort tier queries the Wayback Machine CDX API for an archived snapshot when the main tiers fail. Returned content is prefixed with a provenance header (`[Archived snapshot – <timestamp> – <original_url>]`) so callers know the content may not reflect the current page state.

## Challenge detection and solver tier

A Cloudflare-style challenge interstitial is frequently served with **HTTP 200** — routine for
Managed Challenge and Turnstile — which used to pass straight through the tier cascade as a
successful fetch: Readability-extracted, cached, and written to the domain capability database
as evidence the tier works on that domain, feeding tier-skip decisions on nothing but a wrong
signal. As of v3.19.0, tiers 2–3 detect this case (matched on Cloudflare edge headers at
403/503, and on interstitial markers in a 200-status body) and report it as a distinct miss
(`reason: challenge_detected`) instead of a hit. A detected challenge is never cached and never
written to domain-db.

When `SOLVER_ENABLED=true` and `SOLVER_URL` points at a running solver — Byparr, or any service
implementing FlareSolverr's `POST /v1` contract — a challenge detected on a given request
triggers one solve attempt, dispatched after the tier 3 cascade fails and before the Wayback
fallback. The solve is **strictly per-request**: the tier never fires on a URL that was not
challenged in that same request, so it adds no overhead to the ordinary path. The solver's
response is replayed through the normal bounded-fetch and extraction path — re-validated for
SSRF (`assertPublicUrl` + `assertResolvedPublic` against the solver's resulting URL, since it
may differ from the one requested) and re-checked for a challenge — rather than trusted
directly, so a "solved" page that is still an interstitial registers as a miss, not a cache
write. Solver-returned cookies are scoped to the solved host and never forwarded elsewhere.

**This is not a guaranteed bypass.** Byparr's own documentation is explicit that a solve is not
guaranteed and often needs residential-IP traffic. A miss here is the expected common case and
degrades cleanly into the Wayback tier — not an error, and not something to alert on.

## Fetch quality

After any tier returns content with raw HTML, a post-extraction pass improves title and body quality:

- **JSON-LD Article extraction** — Schema.org `Article` / `NewsArticle` / `BlogPosting` / `TechArticle` blocks supply cleaner `headline` and `articleBody` than scraping the rendered page (size-capped at 1 MB per script tag).
- **Title cascade** — falls back through `og:title` → `twitter:title` → `<title>` (with publisher-suffix stripping) → first `<h1>` → URL.
- **Markdown, not plain text** — when Readability wins (tiers 2 and 3, and the Kiwix path), its cleaned article element is converted to markdown (`src/fetch/extractors/markdown.ts`, via `turndown`): ATX headings, paragraphs, lists, fenced code with the language from `language-x`/`lang-x`/`data-lang`, absolute links (same-page anchors dropped, only the first link to a URL kept), blockquotes, GFM tables, images as alt text.
- **Tier-2 Readability comparison** — when Crawl4AI returns markdown, JSDOM+Readability also runs over its raw HTML. Both candidates are compared on prose length (link targets and markdown syntax stripped). Readability wins when it keeps at least **40%** of the tier's prose — it exists to drop navigation and footers, so on a good page it is shorter by design (real articles measured 0.56–0.94, genuine Readability failures 0.03–0.11) — or unconditionally when the tier's own prose is under 500 chars.

## Authority prior

The cross-encoder's scores saturate: for a typical developer question five or six on-topic results all score 0.98–1.00, so their order is noise plus recency, and the official documentation (often 0.93–0.98) lands below blog posts. Ranking therefore adds a small, bounded prior (`src/search/authority.ts`):

| Signal | Bonus (before weight) |
|---|---|
| A hostname label names a query term — `python` → `docs.python.org`, `postgres` → `postgresql.org`, `git` → `git-scm.com`; generic labels (`docs`, `dev`, `blog`, `github`, …) never count | 1 |
| Docs-shaped URL — `docs.`/`developer.`/`man.` host, or a `/docs/`, `/reference/`, `/api/`, `/manual/`, `/std/` path | 0.5 |
| The domain is in the global or profile `boost` list | 1 |

The sum is multiplied by `RERANK_AUTHORITY_WEIGHT` (default `0.1`), so the largest possible lift is 0.25 — enough to reorder near-ties, never enough to lift an off-topic page (≈0.01) over an on-topic one. Domain boosts are applied here because the older pre-rerank boost sort was undone by the reranker's own sort whenever the reranker was up.

Measured with `scripts/bench.mjs` (10 tuning questions, 10 held-out): authoritative page at rank 1 went 30% → 60% (tuning) and 0% → 40% (held-out); in the top 5, 60% → 90% and 50% → 80%. `min_score` is unaffected — it still filters on the raw relevance.

## Relevance filtering (`min_score`)

`search` accepts `min_score` (0–1), a floor applied after reranking. Omit it and nothing changes.

It filters on the **raw cross-encoder `relevance_score`**, not on the value used for ordering. Ranking sorts by `relevance_score + RERANK_RECENCY_WEIGHT * recencyScore(publishedDate)`, which with the default weight of `0.15` ranges over **0–1.15, not 0–1**. Filtering a parameter called "minimum relevance" on that number would quietly make it mean "relevant enough *or* recent enough". Filtering happens before the top-N slice, so the floor never costs you a result that cleared it.

Two things make this knob behave differently from how a 0–1 range suggests. Both were measured against the local FlashRank service on the query *"how to configure nginx reverse proxy"*:

| Document | `relevance_score` |
|---|---|
| nginx reverse-proxy guide (`proxy_pass`) | **0.998** |
| Apache `mod_proxy` reverse proxying | **0.967** |
| nginx install page (topical, wrong subject) | **0.0028** |
| banana bread recipe | **0.0000151** |

- **The distribution is strongly bimodal.** Relevant results cluster near 1.0, irrelevant ones near 0, with very little in between — so any threshold in roughly 0.01–0.9 behaves near-identically. Useful values are around **0.01–0.1**; `0.5` is not a meaningful midpoint.
- **A high score means topically related, not correct.** The Apache document scored 0.967 on an nginx query. `min_score` is a topicality floor and cannot be trusted as a correctness filter.

Thresholds are model-dependent and not comparable across rerankers. When the reranker is unavailable there are no scores to filter on, so `min_score` becomes a **no-op with a throttled warning** — returning unfiltered results silently would let you believe a floor had been applied, and returning nothing would turn a reranker outage into "no results found".

## Resilience

- **Multi-instance SearXNG failover.** `SEARXNG_URL` accepts a list of interchangeable replicas (`,` or `;` separated), tried in order. A single value behaves exactly as before — one request, one host, no health lookup, no extra cache traffic. Three things about the multi-instance path are worth knowing:
  - The timeout budget is **total, not per instance**. `SEARXNG_TOTAL_TIMEOUT_MS` bounds the whole call and is decremented as candidates fail, so adding a replica cannot make a total outage take longer to report.
  - Health state lives in the **cache, not in process memory**, so one process's discovery of a dead instance informs the next call. It is a hint, not a circuit breaker: a failed instance is moved to the back of the order for `SEARXNG_UNHEALTHY_TTL_SECONDS`, never removed, and if every instance is marked down the full list is tried anyway. A cache outage degrades to "try every instance in configured order" — never to an error.
  - **Failover is loud.** Each fall-through emits a `search.failover` NATS event and a throttled stderr line. A silent failover is indistinguishable from a healthy primary, which is how a half-dead deployment goes unnoticed for weeks.

  Fan-out (querying replicas in parallel and merging) is deliberately **not** implemented: it needs meta reconciliation with no obvious right answer — if two instances return different `answers`/`infoboxes`, which wins? `searxSearch` already merges across expanded query variants, so the marginal recall gain is small.

- **Cache never hangs a search.** The Valkey client is bounded by `CACHE_COMMAND_TIMEOUT_MS`/`CACHE_CONNECT_TIMEOUT_MS`/`CACHE_MAX_RETRIES_PER_REQUEST` (see [Configuration](configuration.md)). A stalled or CPU-spiked cache backend now rejects the command instead of hanging forever — the existing fail-soft handling degrades that rejection to a cache miss (serve live) rather than throwing. Cache connect failures, client errors, and per-command errors emit a throttled `[searxng-mcp]` stderr line (deduped per key so a sustained outage leaves a periodic breadcrumb, not a flood) — stderr is always on, and is the sink that never depends on configuration. On the forge deployment OTel and NATS are also wired (`OTEL_EXPORTER_OTLP_ENDPOINT` and `NATS_URL` are both set, and the startup capability line reports `otel,nats` in its on-list), so stderr is the floor rather than the whole story.
- **Process crash handlers** — `uncaughtException` logs then exits 1, so the supervisor restarts cleanly (Docker's `restart: unless-stopped` on the forge deployment); `unhandledRejection` logs and continues rather than crashing the shared process silently.
- **Graceful-degradation warnings** — the reranker fallback and the Ollama/LLM expand + summarize fallbacks emit one throttled stderr line each when they silently degrade quality (reranker unavailable, LLM backend unreachable).
- **Version is single-sourced** from `package.json` at runtime (`src/core/version.ts`) — the `McpServer` version, OTel tracer/meter version, and outbound `USER_AGENT` all track it, so they can't drift independently.

## Observability (opt-in)

Tracing, metrics, and event publishing are entirely opt-in — with none of the env vars below set, the server has zero observability overhead and never loads the OpenTelemetry or NATS packages at runtime.

**OpenTelemetry (traces + metrics)** — set `OTEL_EXPORTER_OTLP_ENDPOINT` to your collector's HTTP endpoint and the server emits:

- Spans (per request): `tool.<name>` → `expand_query`? → `searxng_request` → `rerank` → `fetch` (×N) → `tier2_crawl4ai` | `tier3_rawfetch` | `solver_byparr` → `post_extract`; plus `rerank_passages` for highlights / `fetch_url` `query`, and `summarize_llm` for `search` `answer: true`.
- Counters: `searxng_search_total{profile, expand}`, `searxng_fetch_total{tier, outcome}`, `searxng_cache_total{namespace, outcome}`, `searxng_errors_total{stage, error_type}`.
- Histograms: `searxng_search_duration_seconds{profile}`, `searxng_fetch_duration_seconds{tier, outcome}`.

Standard OTEL env vars apply (`OTEL_SERVICE_NAME` defaults to `searxng-mcp`).

**NATS events** — set `NATS_URL` (e.g. `nats://localhost:4222`) and the server publishes a structured event on every search, fetch, cache hit/miss, robots skip, and error. Authenticates via `NATS_CREDS` (a JWT creds file) or `NATS_USER`/`NATS_PASSWORD` (bcrypt username/password) — creds-file auth wins if both are set. Subjects:

| Subject | When |
|---------|------|
| `searxng.search.requested` | Search tool invoked |
| `searxng.search.completed` | Search returned (with sources, latency, rerank applied) |
| `searxng.fetch.requested` | `fetchPage` called |
| `searxng.fetch.tier.miss` | A tier returned empty or threw |
| `searxng.fetch.tier.skipped` | robots.txt disallowed |
| `searxng.fetch.completed` | Fetch resolved (with `tier_served`, `text_len`, latency) |
| `searxng.cache.hit` / `.miss` | On every Valkey lookup |
| `searxng.error` | Stage-tagged errors |

Each envelope includes `request_id` and (when OTel is enabled) `trace_id` so subscribers can join the two streams. Subject prefix overridable via `NATS_SUBJECT_PREFIX`. Search queries flow through `search.*` events — downstream consumers are responsible for any PII scrubbing.

## Politeness

- **Honest User-Agent** — outbound requests identify as `private-search-4-agents/<version> (+https://github.com/blakemartz/private-search-4-agents; personal research)`.
- **robots.txt compliance** — `/robots.txt` is fetched once per origin and cached for 24 hours in Valkey under `robots:<origin>`. Disallowed paths are skipped before any tier runs and logged as `skipped_robots url=… reason=…`.

---

[← Docs index](index.md) · [Configuration](configuration.md) · [Tools](tools.md)
