<!-- Astra-local note, not upstream searxng-mcp documentation. Records the pi-web-access
     extension removed on 2026-10-25, what its SearXNG path did, and what this server does
     instead. Kept because the removal left two real capability gaps (PDF extraction,
     source_check) that are easy to rediscover the hard way. -->

# pi-web-access, and what it did differently

`pi-web-access` (v0.44.0, [`nicobailon/pi-web-access`](https://github.com/nicobailon/pi-web-access))
was a Pi coding-agent extension: one npm package providing web search across 39 providers, URL
fetching, GitHub repo cloning, PDF extraction, YouTube video understanding, and a browser-based
"curator" for reviewing search results.

It was installed as `npm:pi-web-access` in `~/.pi/agent/settings.json`. Its manifest declared
`"pi": { "extensions": ["./dist"] }`, so **only the esbuild bundle `dist/index.js` ever loaded** —
the ~90 `*.ts` files shipped next to it (including `searxng.ts`) were source for reference and
typechecking, not runtime. That is why "dist vs searxng.ts" was never a real choice: the bundle
already contained the compiled `searxng.ts`, at `dist/index.js:14191` (`// searxng.ts`).

It registered four Pi tools:

| Tool | What it did |
|---|---|
| `web_search` | Query one provider, several concurrently, or `auto`; returns bounded source-linked results plus a `responseId` for later paging. |
| `source_check` | Given a claim, gather sources and return a machine-readable research artifact with exact passage citations. |
| `fetch_content` | Fetch URL(s) → markdown; GitHub repos/files/releases, PDFs, YouTube, local video. |
| `get_search_content` | Page through the full stored results/content of a previous call, or `findText` passages inside it. |

It also shipped a standalone MCP server (`pi-web-access-mcp` → `dist/mcp-cli.js`) exposing the same
four tools. Nothing here used it: `~/.mcporter/mcporter.json` only ever had the `searxng` entry.

It was removed because exactly one of its 39 search providers was configured — SearXNG at
`http://127.0.0.1:8888` — and that path duplicated, at strictly lower quality, what `search` here
does. Everything else in the package was inert for lack of credentials.

## How its SearXNG search worked

The whole provider is ~150 lines in `searxng.ts`. One request, no state:

1. **Resolve the base URL.** `SEARXNG_BASE_URL` if set (even empty, which disables), else
   `searxngBaseUrl` from `~/.pi/agent/web-search.json`. Rejected unless http(s), no credentials in
   the URL, trailing slashes trimmed. Unset → the provider reports unavailable and `auto` skips it.
2. **Fold domain filters into the query text.** Allowed domains become `site:a` or
   `site:a OR site:b` appended to `q`; blocked domains become `-site:x`. This is query surgery, not
   a SearXNG parameter (`searxng.ts:139-148`).
3. **One GET** to `{base}/search` with exactly three parameters: `q`, `format=json`, and
   `time_range` when a recency filter was requested (`searxng.ts:186-190`). No `engines`, no
   `categories`, no `language`, no `pageno`.
4. **Send `Accept: application/json`** plus optional `searxngHeaders` (for reverse proxies and
   Cloudflare Access service tokens), with configured headers overriding the default.
5. **SSRF check.** `fetchRemoteUrl` validates the target; loopback hostnames are allowed without
   config, other private ranges need `ssrf.allowRanges`. Cross-origin redirects drop the configured
   headers. Hard 30 s timeout.
6. **Map and truncate.** `results[]` → `{title: title || url, url, snippet: content}`; a second
   pass re-applies domain filters to the returned hostnames (the `site:` operator is best-effort,
   so engines that ignore it are caught here); stop at `numResults` (1–20, default 5).
7. **Synthesize an `answer` string** by concatenating SearXNG's native `answers[]` with a
   `snippet\nSource: title (url)` block for every result (`searxng.ts:212-216`). No model is
   involved — it is a string join that reads like a synthesis.

Nothing else happened: no cache, no rerank, no result-pool widening, no per-domain learning, no
query expansion. SearXNG's own ordering was the ranking, and `web_search` returned it verbatim
under `provider: "searxng"`.

In `auto` mode this provider was tried **first**, before OpenAI, Exa, Brave and the rest
(`gemini-search.ts:712`), so with `provider: "searxng"` and `allowedProviders: ["searxng"]`
configured, every `web_search` call was one unranked SearXNG query.

## How search works here

`search` (`src/search.ts`) is a different procedure, not a different endpoint:

1. **Cache lookup.** Valkey key over `query|engines|site` + category + time range, default TTL
   3600 s. Skipped when `expand` is on, since expansion is the point of the call.
2. **Instance selection.** `getSearxCandidates()` orders configured SearXNG instances by health;
   each attempt has its own timeout, the whole search a total budget, and failures mark an instance
   unhealthy for later calls.
3. **Widen the pool.** Ask SearXNG for `numResults × 3`, capped at 20, so the reranker has
   something to choose from.
4. **Optional expansion.** With `expand`, Ollama rewrites the query into variants, all variants run
   in parallel, results merge with the original first and dedupe by URL.
5. **Rerank.** Every candidate is scored by the local cross-encoder at `RERANKER_URL`
   (`/v1/rerank`), then sorted on `relevance_score + RERANK_RECENCY_WEIGHT × recencyScore(date)`.
   `min_score` filters on the **raw** relevance, not the recency-adjusted value
   (`src/reranker.ts:45-72`).
6. **Filter and record.** `domain_profile` filters apply after rerank (and after cache read, so
   profile edits take effect immediately); each result domain is recorded in the domain capability
   database as "seen in search".

Plus what the tool surface adds around it: `category`, `language`, `engines`, `site` are real
SearXNG parameters, and `structuredContent` carries SearXNG's native answers, infoboxes,
corrections and suggestions as separate fields rather than as one concatenated string.

## Functional delta

| Capability | pi-web-access (`provider: searxng`) | `search` here |
|---|---|---|
| Ranking | SearXNG's own order, truncated | local cross-encoder over a 3× pool, recency-weighted |
| Relevance floor | — | `min_score` (raw relevance) |
| Result pool | `numResults` | `numResults × 3`, max 20 |
| Caching | none — every call hits SearXNG | Valkey, 1 h default, `clear_cache` |
| Query expansion | — | `expand` via Ollama |
| Engines / category / language | — (`category` was Exa-only) | `engines`, `category`, `language` |
| Site / domain filters | `site:` query surgery + hostname post-filter | `site` param + named `domain_profile` |
| Direct answers | concatenated into one `answer` string | separate `answers`/`infoboxes`/`corrections`/`suggestions` |
| Instance failover | single hardcoded base URL | candidate list, per-attempt timeouts, health marking |
| Domain learning | — | every search and fetch feeds the domain DB (`domain_stats`) |
| Fetch | own chain: local Readability/Defuddle → Crawl4AI → raw HTTP | robots gate → fast paths → Firecrawl → Crawl4AI → raw → Wayback, cached 24 h, learned per domain |
| PDF text extraction | **yes**, `unpdf` locally (keyless), plus Datalab/Gemini if keyed | **no** — see below |
| GitHub | API fast paths **and** repo cloning (`forceClone`) | API fast paths only (repo roots, files, trees, releases, issues, PRs) |
| YouTube | transcript, frames, local video via Gemini | transcript fast path (opt-in) |
| Claim verification | `source_check` — passage-level citations | — |
| Content paging | `get_search_content` by `responseId`, `findText` | full output spilled to a temp file when truncated |
| Multi-query / multi-provider | `queries[]`, provider arrays, 39 providers | one query, one backend |

### The three that actually mattered

**PDFs.** This is the one real loss (since restored locally — see "If PDFs come back" below). `searxng-mcp` cannot extract PDF text and says so: the PDF
fast path was deliberately removed (`src/fetch.ts:523`), Firecrawl is the only tier that can do it
and it is stopped here, v1 has no PDF support (`src/firecrawl-api.ts:82-83`), and Crawl4AI renders
the PDF in a browser, finds no text nodes, and misfires its anti-bot heuristic — so tier 3 rejects
it outright with "PDF content cannot be extracted by raw fetch" (`src/tiers/raw.ts:99`).
pi-web-access extracted PDFs locally with `unpdf` (`pdf-extract.ts:155`), no key required.

**`source_check`.** Nothing here produces a bounded, machine-readable evidence artifact with exact
passage citations for a claim. `search_and_fetch` gets you the pages; the citation assembly was the
extension's job.

**`get_search_content`.** `pi-searxng.ts` truncates tool output and spills the full text to a temp
file, which is a one-shot substitute. There is no `responseId` to page through, and no `findText`
passage search over stored content.

The rest of the loss is either inert (Gemini video, the 38 unconfigured providers, the curator UI)
or covered (GitHub, YouTube, readable-markdown extraction).

## Procedural delta, end to end

A search for *"nginx reverse proxy config"*, 5 results:

```
pi-web-access
  web_search(query, provider=auto)
    → allowedProviders ∩ available → searxng
    → GET :8888/search?q=nginx+reverse+proxy+config&format=json
    → results[0..4] as returned by SearXNG
    → answer = answers[] + "snippet\nSource: title (url)" × 5
    → store full payload, return responseId

here
  searxng_search(query, num_results=5)
    → mcporter → searxng-mcp stdio server
    → Valkey get(query|engines=|site=|general|) → miss
    → GET :8888/search?q=…&format=json (15 results, engines/category/language as given)
    → POST :8787/v1/rerank (15 docs) → relevance + recency
    → sort, slice 5, record 5 domains in domain DB
    → Valkey set (TTL 3600) → return
```

A fetch of `https://example.com/doc.pdf`:

```
pi-web-access
  fetch_content(url)
    → SSRF validate → isPDF → endpoint? datalab? gemini? → unpdf local
    → markdown text, stored under responseId

here
  searxng_fetch(url)
    → mcporter → searxng-mcp
    → robots gate → fast paths (not GitHub/YouTube/Reddit)
    → tier1 Firecrawl: unconfigured (stopped)
    → tier2 Crawl4AI: renders PDF, no text nodes, anti-bot misfire
    → tier3 raw: %PDF- signature → hard error, "cannot be extracted"
    → domain DB records the failure
```

## Residual state

Removing the package left one dead config file:

```
~/.pi/agent/web-search.json   # searxngBaseUrl, crawl4aiBaseUrl, crawl4aiApiToken, ssrf.allowRanges
```

Nothing reads it now. Before deleting it, confirm `crawl4aiApiToken` is present in
`~/dev/websearch/.env.searxng-mcp` — that is the token tier 2 actually uses.

## If PDFs come back

> **Done (option 2), 2026-10-28.** `src/pdf.ts` is a `unpdf` fast path ahead of the cascade —
> see [PDF fast path](architecture.md#pdf-fast-path). The rest of this section is kept as the
> record of the options weighed.

In rough order of effort:

1. **Restart Firecrawl at v2** — it extracts PDFs natively, and the cascade already routes to it
   (`src/firecrawl-api.ts:82-83`). This is the path the code was written for; `~/dev/websearch/`
   still has `firecrawl_start.sh`, volumes and config. Read that directory's README first — it
   documents why it was stopped.
2. **Add a `unpdf`-based fast path** to `src/fetch.ts`, ahead of the cascade, keyed on the same
   `%PDF-` signature check that `src/tiers/raw.ts:99` uses to reject. Small, keyless, and it is
   exactly what the removed extension did.
3. **Keep a minimal Pi extension** that registers a single `pdf_extract` tool. Cheapest to write,
   but it puts a second fetcher back in the picture — the thing this removal was meant to end.
