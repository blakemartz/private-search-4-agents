<!-- Split out of README.md in v3.24.0 (vikunja#683). The README had reached 905 lines / 70KB, at which point it was a reference manual pretending to be an introduction. -->

# Tools

Three tools for agents, plus two operator tools that register only when `SEARXNG_MCP_ADMIN_TOOLS=true`.
The schemas are deliberately terse (`tools/list` is ~1.8k tokens, down from ~7.6k); this page is
the long form. The server also sends MCP `instructions` describing the typical flow: `search`,
then `fetch_url` the promising results, following the window footer to page.

| Tool | What it does |
|------|--------------|
| [`search`](#search) | SearXNG search, reranked locally. Snippets, the most relevant passages of the top pages, or their full text; optionally a cited answer from a local LLM. Cached 1 h. |
| [`fetch_url`](#fetch_url) | Read up to 5 public URLs (HTML, PDF, GitHub, YouTube, Reddit) as markdown, as a pageable window, as passages relevant to a question, or as literal matches. Cached 24 h. |
| [`crawl_site`](#crawl_site) | Map a site into a URL/title/snippet manifest; its pages are cached for `fetch_url`. |
| [`clear_cache`](#admin-tools) | Admin only. Purge the search, fetch or crawl cache. |
| [`domain_stats`](#admin-tools) | Admin only. Read-only view of the domain capability database. |

Removed in 4.0.0: `search_and_fetch` (use `search` with `content: "full"`) and
`search_and_summarize` (use `search` with `answer: true`). `search`'s `num_results` is now
`max_results`, and `site` is now `include_domains`.

## `search`

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `query` | string, or array of up to 5 strings | — | The query, or several phrasings of one question. Phrasings run in parallel, each is reranked against itself, results are merged and a URL is kept only under the first phrasing that found it. |
| `max_results` | int 1–20 | `5` | Results per phrasing. |
| `content` | `snippets` \| `highlights` \| `full` | `snippets` | `snippets`: engine snippets (≤250 chars), no page fetches. `highlights`: read the top 5 pages and return each one's 2 most relevant passages ([how](architecture.md#passages)), each tagged with its `offset`. `full`: also return the top 3 pages' text, sharing an 8,000-char budget, each with a [window footer](#window-footer). |
| `answer` | boolean | `false` | Add an answer synthesized from the top 3 pages (4,000 chars each) by the local LLM (`OLLAMA_SUMMARIZE_MODEL` / `LLM_MODEL`), with citations. Takes ~10–60 s. See [Answer fallback](#answer-fallback). |
| `include_domains` | string or array (≤50) | — | Only results from these domains (subdomains included). Sent as `site:` operators **and** enforced as a hard filter afterwards, since some engines ignore the operator. |
| `exclude_domains` | string or array (≤50) | — | Never return results from these domains. |
| `time_range` | `day` \| `week` \| `month` \| `year` | all time | Only results from this period. |
| `category` | `general` \| `news` \| `it` \| `science` | `general` | SearXNG category. |
| `domain_profile` | enum from `domains.json` (`homelab`, `dev`) | — | Apply a named boost/block profile. |
| `language` | string | instance default | BCP-47 code (`en`, `de`) or `all`. |
| `min_score` | number 0–1 | — | Drop results below this reranker relevance (the `rel` shown). Scores are bimodal: 0.01–0.1 is the useful range; high means on-topic, not correct. No-op with a logged warning when the reranker is down. See [Relevance filtering](architecture.md#relevance-filtering-min_score). |
| `fresh` | boolean | `false` | Bypass the cache for this call (search and any pages fetched); fresh results are still written back. |
| `expand` | boolean | `EXPAND_QUERIES` | Have the local LLM (`OLLAMA_EXPAND_MODEL`) add query variants (~3 s). Passing your own phrasings in `query` is usually better. |
| `engines` | string | — | Comma-separated SearXNG engine names (`google,duckduckgo`). Forwarded verbatim; unknown engines degrade to fewer results. |

Each result shows title, URL, published date and reranker relevance when known; SearXNG's own
direct answers, infoboxes, spelling corrections and related searches are printed above the list.
A result the reranker scored as off-topic (relevance < 0.01) never has its page fetched for
`highlights`, `full` or `answer`. Everything is also returned as `structuredContent`
(`queries`, `answer`, `answer_unavailable`, `answers`, `infoboxes`, `corrections`,
`suggestions`, `results[]` with `engines`, `query_index` and `highlights`).

Snippet mode (default):

```
1. Configuring HTTPS servers (2025-11-04, rel 0.99)
   https://nginx.org/en/docs/http/configuring_https_servers.html
   To configure an HTTPS server, the ssl parameter must be enabled on listening sockets in the server block, and the locations of the server certificate and private key files should be specified…

2. NGINX Reverse Proxy | NGINX Documentation (rel 0.97)
   https://docs.nginx.com/nginx/admin-guide/web-server/reverse-proxy/
   This article describes the basic configuration of a proxy server. You will learn how to pass a request from NGINX to proxied servers over different protocols…
```

With several phrasings, results are grouped under a `## <phrasing>` heading per query, numbered
continuously, and a phrasing that found nothing new says `(nothing new beyond the phrasings above)`.

`content: "highlights"` replaces each top result's snippet with passages, each with the offset
to read on from via `fetch_url`:

```
1. Configuring HTTPS servers (2025-11-04, rel 0.99)
   https://nginx.org/en/docs/http/configuring_https_servers.html
   > The ssl_protocols and ssl_ciphers directives can be used to require that clients use only the strong versions and ciphers of SSL/TLS when establishing connections… [offset 4210]
   > By default nginx uses "ssl_protocols TLSv1.2 TLSv1.3" and "ssl_ciphers HIGH:!aNULL:!MD5"… [offset 4890]
```

### Answer fallback

When `answer: true` cannot produce a synthesis (no LLM configured, timeout, unreachable,
unusable output), the response **leads** with a marker naming why —
`--- summarization unavailable (<kind>: <detail>) — the text below is raw fetched pages, NOT a synthesis ---`
— and carries the top pages themselves (8,000 chars shared) after the result list, so the
caller still gets substance. `structuredContent.answer` is then `null` and
`answer_unavailable` holds `<kind>: <detail>`. No marker means a real synthesis; check its
citations all the same.

## `fetch_url`

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `url` | URL, or array of up to 5 URLs | — | http(s) only. Several URLs are read in parallel; each gets a `=== i/n ===` section and a failure costs only its own section. |
| `max_tokens` | int 100–10,000 | 2,000 (1,000 each for several URLs) | Approximate tokens per page (chars ≈ tokens × 4). |
| `offset` | int ≥ 0 | `0` | Character offset to start from, as given in the footer. |
| `query` | string ≤500 | — | Return the page's 5 passages most relevant to this question, scored by the local reranker, instead of a window. Says when it fell back to term overlap. |
| `find` | string ≤500 | — | Return passages (±300 chars, up to 8) around literal case-insensitive matches; `\|` separates alternatives (`Q4_K_M\|Q6_K`). |
| `fresh` | boolean | `false` | Bypass the 24 h page cache. |
| `domain_profile` | enum from `domains.json` | — | Domain profile for routing. |
| `target_selector` | CSS selector | — | Scope extraction to an element (`article`, `main .content`). Honored natively by Crawl4AI, applied client-side on raw HTTP; ignored by fast paths and when it matches nothing. |
| `wait_for_selector` | CSS selector | — | Wait for this element before extracting (JS-rendered pages). Crawl4AI only. |

`query` takes precedence over `find`, which takes precedence over `offset`.

What it reads: GitHub repo roots, files, directories and releases come from the GitHub API
([below](#github-urls)); YouTube video URLs return the transcript and Reddit threads the post and
top comments (both opt-in, because robots.txt disallows them: `YOUTUBE_IGNORE_ROBOTS`,
`REDDIT_IGNORE_ROBOTS`); PDFs — `.pdf` URLs and anything served as `application/pdf` — are
extracted locally as page-marked text; everything else goes through the fetch cascade (Crawl4AI,
then raw HTTP + Readability) and comes back as markdown with headings, lists, code fences, links
and tables kept. See [Architecture](architecture.md).

### Window footer

Pages are always cached at the 40,000-char store ceiling, and every window that is not the
whole page ends with a footer saying where it sits and how to continue:

```
Title: Node.js fs module
URL: https://nodejs.org/api/fs.html

# File system
…

[chars 0–8,000 of 23,410 · continue with offset=8000]
```

Paging is served from cache. When the stored text hit the ceiling, the footer says
`of ≥40,000 (store limit)`, and the last window says the rest is beyond the store limit — use
`find` or `query` to reach passages in it. An `offset` past the end says so instead of returning
nothing silently.

`query` output starts `[5 of 31 passages for "<query>", ranked by the local reranker]` (or
`ranked by term overlap — reranker unavailable`), then `--- offset N · score S ---` blocks.
`find` output starts `[N matches for "<find>"]`, then `--- at offset N ---` blocks.

## `crawl_site`

Map a site into a URL/title/snippet manifest. Tries the sitemap first, then BFS link-following
if the server has `CRAWL_BFS_ENABLED=true`. A start URL with a path (`https://example.com/docs`)
limits every strategy to pages under that path unless `include_path` is given;
`include_path: "/"` crawls the whole site. Page content is cached (6 h) so follow-up
`fetch_url` calls are cache hits.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `url` | URL | — | Site root or docs URL. |
| `max_pages` | int 1–100 | `20` | Page cap. |
| `same_domain_only` | boolean | `true` | Stay on the start domain. |
| `include_path` | string | — | Only URLs under this path prefix; replaces the default scope. |
| `exclude_path` | string | — | Skip URLs under this path prefix. |

## Admin tools

Registered only when `SEARXNG_MCP_ADMIN_TOOLS=true`. They are off by default because
`clear_cache` wipes cache shared by every agent on the host, and `domain_stats` is a diagnostic an
agent mid-task has no use for. The same data is available through the `config://searxng-mcp` and
`stats://domains` resources and the `pnpm dump-domain` CLI.

| Tool | Parameters | What it does |
|---|---|---|
| `clear_cache` | `target`: `search` \| `fetch` \| `crawl` \| `all` (default `all`) | Purge cached search results (1 h), fetched pages (24 h) and/or crawl manifests. |
| `domain_stats` | `hostname` (optional; hostname or URL) | With `hostname`: one domain's per-tier success rates (tier2 Crawl4AI, tier3 raw, tier4 Wayback, github, pdf, solver) and capability flags. Without: an aggregate across tracked domains. Returns `structuredContent`; reports `unavailable` when the database could not be read, which is not the same as empty. See [Domain capability database](architecture.md#domain-capability-database). |

# GitHub URLs

GitHub URLs are handled natively, ahead of the tier cascade. `githubFetch` dispatches on hostname and, for `github.com`, on the URL's shape:

- **Repo root** (`github.com/owner/repo`) — fetches the README via the GitHub API
- **File blob** (`github.com/owner/repo/blob/branch/path/to/file`) — rewrites to and fetches raw content from `raw.githubusercontent.com`
- **Directory** (`github.com/owner/repo/tree/branch/path`) — that directory's README at that ref; a file listing if it has none
- **Releases** (`github.com/owner/repo/releases`, `…/releases/latest`, `…/releases/tag/<tag>`) — release notes from the releases API as markdown (the list is the 10 most recent, newest first)
- **Raw file** (`raw.githubusercontent.com/...`) — fetched directly as-is
- **API** (`api.github.com/...`) — response decoded (base64 `content` fields) or pretty-printed as JSON

Direct `raw.githubusercontent.com` and `api.github.com` URLs previously matched only `github.com` and fell through to the HTML-scraping tier cascade, which cannot render a raw text file or bare JSON response — they failed 100% of the time. They now take the GitHub fast path.

Any other `github.com` page — issues, pull requests, commits, wiki, owner pages, release asset downloads — is not handled here and takes the normal fetch cascade, which renders the page. Until 3.30.x those were claimed by the fast path too and answered with the **repo-root README**, with nothing in the result to say it was not the requested page.

Unauthenticated requests are rate-limited to 60/hour. Set `GITHUB_TOKEN` to raise this to 5,000/hour.

---

[← Docs index](index.md) · [Architecture](architecture.md)
