import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cacheClear } from "./cache.js";
import { ADMIN_TOOLS_ENABLED, CRAWL_MAX_PAGES_DEFAULT } from "./config.js";
import { newRequestId, withRequestId } from "./context.js";
import { crawlSite, formatCrawlManifest } from "./crawl.js";
import {
  getDomainRecord,
  TIER_SLOT_KEYS,
  type TierSlotKey,
} from "./domain-db.js";
import {
  aggregateDomainStats,
  enumerateDomains,
  formatDomainAggregate,
  formatDomainRecord,
  summarizeDomainRecord,
} from "./domain-stats.js";
import { getProfileNames, urlMatchesDomain } from "./domains.js";
import { events } from "./events.js";
import { FETCH_STORE_CEILING, fetchPage } from "./fetch.js";
import type { FetchTuning } from "./fetch-utils.js";
import { redactUrlCredentialsInText } from "./log.js";
import { incCounter, recordHistogram, withSpan } from "./observability.js";
import {
  formatSummaryFallbackNotice,
  formatSummaryResult,
  summarizePages,
} from "./ollama.js";
import { findPassages, formatPassages, windowText } from "./paging.js";
import { selectPassages } from "./passages.js";
import { rerankWithFallback } from "./reranker.js";
import { searxSearch } from "./search.js";
import {
  CategorySchema,
  type Citation,
  type SearxMeta,
  type SearxResult,
  TimeRangeSchema,
} from "./types.js";

async function instrumentTool<T>(
  toolName: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withRequestId(newRequestId(), () =>
    withSpan(`tool.${toolName}`, { "mcp.tool": toolName }, fn),
  );
}

interface SearchEventCtx {
  query: string;
  profile?: string;
  expand?: boolean;
  time_range?: string;
  num_results: number;
}

/**
 * The tools that share the `search` histogram. A named union rather than a
 * bare string keeps a typo out of the label set — a stray value would not fail
 * anything at runtime, it would quietly create a new series.
 */
type SearchToolName = "search";

async function withSearchEvents<T>(
  toolName: SearchToolName,
  ctx: SearchEventCtx,
  fn: () => Promise<{
    ranked: SearxResult[];
    result: T;
    rerankApplied: boolean;
  }>,
): Promise<T> {
  events.searchRequested(ctx);
  const t0 = Date.now();
  try {
    const { ranked, result, rerankApplied } = await fn();
    const latency_ms = Date.now() - t0;
    incCounter("search", {
      tool: toolName,
      profile: ctx.profile ?? "default",
      expand: ctx.expand ? "true" : "false",
    });
    recordHistogram("search", latency_ms / 1000, {
      tool: toolName,
      profile: ctx.profile ?? "default",
      outcome: "ok",
    });
    events.searchCompleted({
      result_count: ranked.length,
      latency_ms,
      sources: ranked.map((r) => new URL(r.url).hostname),
      rerank_applied: rerankApplied,
    });
    return result;
  } catch (err) {
    // Record latency on the failure path too. Previously only `errors_total`
    // was incremented here, so a search that failed after 40s and one that
    // failed instantly were indistinguishable in the metrics — which is
    // precisely the question asked of this histogram during the 300s stall.
    //
    // `outcome` keeps the two populations separable: folding error latencies
    // into the success distribution unlabelled would corrupt the p99 that the
    // histogram exists to report.
    recordHistogram("search", (Date.now() - t0) / 1000, {
      tool: toolName,
      profile: ctx.profile ?? "default",
      outcome: "error",
    });
    incCounter("errors", {
      tool: toolName,
      stage: "search",
      error_type: err instanceof Error ? err.name : "unknown",
    });
    // Scrubbed: this is a generic sink reached by errors from any source, and
    // it fires even on the single-instance path where the failover-specific
    // redaction above never runs.
    events.error({
      stage: "search",
      error_type: err instanceof Error ? err.name : "unknown",
      message: redactUrlCredentialsInText(
        err instanceof Error ? err.message : String(err),
      ),
    });
    throw err;
  }
}

/**
 * `instrumentTool` + `withSearchEvents` for the search tool, so the tool
 * name is written once per call site. Passing it separately to each would let
 * the span name and the metric label drift apart silently.
 *
 * NOTE: this does NOT make the histogram able to see a hang. Both the success
 * and failure recordings happen after `await fn()` settles, so a call that
 * never returns still records nothing at all. Closing that needs a watchdog
 * timer independent of the awaited promise, which is deliberately out of scope
 * here — see CHANGELOG.
 */
async function instrumentSearchTool<T>(
  toolName: SearchToolName,
  ctx: SearchEventCtx,
  fn: () => Promise<{
    ranked: SearxResult[];
    result: T;
    rerankApplied: boolean;
  }>,
): Promise<T> {
  return instrumentTool(toolName, () => withSearchEvents(toolName, ctx, fn));
}

// ── search ──────────────────────────────────────────────────────────────────
//
// Shaped after what Tavily, Exa and Gemini grounding converge on: one search
// call whose options decide how much of each result comes back (`content`) and
// whether a synthesized, cited answer comes with it (`answer`), rather than a
// separate tool per combination.

/** Most phrasings one `search` call fans out to. */
const MAX_QUERIES = 5;
/** Most URLs one `fetch_url` call reads. */
const MAX_URLS = 5;

// Rough token→char conversion for budgets. Deliberately a cheap heuristic
// (chars ≈ tokens × 4), not an exact tokenizer.
const CHARS_PER_TOKEN = 4;
const FETCH_DEFAULT_CHARS = 8000;
/** Per-page default when several URLs are read at once. */
const FETCH_MULTI_DEFAULT_CHARS = 4000;
const SNIPPET_CHARS = 250;

/** Results whose pages `content: "highlights"` reads. */
const HIGHLIGHT_PAGES = 5;
const HIGHLIGHTS_PER_RESULT = 2;
const HIGHLIGHT_CHARS = 600;
/**
 * Chunks per page the cross-encoder scores for highlights. Two passages are
 * wanted from each of up to five pages, scored concurrently on one CPU-bound
 * reranker, so the candidate set is kept small (see MAX_SCORED_CHUNKS).
 */
const HIGHLIGHT_SCORED_CHUNKS = 12;
/** Results whose pages `content: "full"` returns, sharing one budget. */
const FULL_PAGES = 3;
const FULL_TOTAL_CHARS = 8000;
/** Pages the answer is synthesized from, and how much of each it reads. */
const ANSWER_PAGES = 3;
const ANSWER_PAGE_CHARS = 4000;
/** Reranker relevance below which a result's page is never fetched. */
const OFF_TOPIC = 0.01;
/** Passages fetch_url returns for a semantic `query`. */
const QUERY_PASSAGES = 5;

export type ContentMode = "snippets" | "highlights" | "full";

interface Highlight {
  offset: number;
  text: string;
  score: number;
}

/** A ranked result, the phrasing that produced it, and any passages picked from its page. */
interface RankedHit {
  result: SearxResult;
  queryIndex: number;
  highlights?: Highlight[];
}

function toList(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return (Array.isArray(v) ? v : [v]).map((s) => s.trim()).filter(Boolean);
}

/**
 * One block per result, with what an agent ranks on: date and relevance. The
 * engine name used to sit on its own line here; it cost a line per result and
 * no caller acted on it, so it lives only in structuredContent.
 */
function formatHit(h: RankedHit, n: number): string {
  const r = h.result;
  const tags = [
    r.publishedDate ? r.publishedDate.slice(0, 10) : null,
    r.relevance !== undefined ? `rel ${r.relevance.toFixed(2)}` : null,
  ].filter(Boolean);
  const meta = tags.length > 0 ? ` (${tags.join(", ")})` : "";
  let body = r.content
    ? `\n   ${r.content.replace(/\s+/g, " ").trim().slice(0, SNIPPET_CHARS)}`
    : "";
  if (h.highlights && h.highlights.length > 0) {
    // Line breaks are kept: collapsing them ran code blocks into one line.
    body = h.highlights
      .map((p) => {
        const lines = p.text
          .slice(0, HIGHLIGHT_CHARS)
          .split("\n")
          .map((l) => l.replace(/(\S)[ \t]+/g, "$1 ").trimEnd())
          .filter((l, i, all) => l !== "" || all[i - 1] !== "");
        return `\n   > ${lines.join("\n   > ")}\n   [offset ${p.offset}]`;
      })
      .join("");
  }
  return `${n}. ${r.title}${meta}\n   ${r.url}${body}`;
}

function formatHits(hits: RankedHit[], queries: string[]): string {
  if (hits.length === 0) return "No results found.";
  if (queries.length === 1) {
    return hits.map((h, i) => formatHit(h, i + 1)).join("\n\n");
  }
  // Several phrasings: one section each, numbered continuously so "fetch #4"
  // is unambiguous. A URL already listed under an earlier phrasing is not
  // repeated (see mergeHits), so a section can come back short or empty.
  let n = 0;
  return queries
    .map((q, qi) => {
      const mine = hits.filter((h) => h.queryIndex === qi);
      const body =
        mine.length === 0
          ? "   (nothing new beyond the phrasings above)"
          : mine.map((h) => formatHit(h, ++n)).join("\n\n");
      return `## ${q}\n\n${body}`;
    })
    .join("\n\n");
}

// SearXNG's native answers/infoboxes/corrections/suggestions, rendered above
// the ranked list. Returns "" when there's nothing to surface.
function formatMeta(meta: SearxMeta): string {
  const blocks: string[] = [];
  if (meta.answers.length > 0) {
    blocks.push(
      `Direct answer${meta.answers.length > 1 ? "s" : ""}:\n${meta.answers
        .map((a) => `  • ${a.answer}${a.url ? ` (${a.url})` : ""}`)
        .join("\n")}`,
    );
  }
  if (meta.infoboxes.length > 0) {
    blocks.push(
      `Infobox:\n${meta.infoboxes
        .map(
          (i) =>
            `  ${i.title ? `${i.title}: ` : ""}${i.content}${i.url ? ` (${i.url})` : ""}`,
        )
        .join("\n")}`,
    );
  }
  if (meta.corrections.length > 0) {
    blocks.push(`Did you mean: ${meta.corrections.join(", ")}`);
  }
  if (meta.suggestions.length > 0) {
    blocks.push(`Related searches: ${meta.suggestions.join(", ")}`);
  }
  return blocks.join("\n\n");
}

function mergeMeta(metas: SearxMeta[]): SearxMeta {
  const uniq = <T>(xs: T[], key: (x: T) => string) => [
    ...new Map(xs.map((x) => [key(x), x])).values(),
  ];
  return {
    answers: uniq(
      metas.flatMap((m) => m.answers),
      (a) => a.answer,
    ),
    infoboxes: uniq(
      metas.flatMap((m) => m.infoboxes),
      (i) => `${i.title}|${i.content}`,
    ),
    corrections: [...new Set(metas.flatMap((m) => m.corrections))],
    suggestions: [...new Set(metas.flatMap((m) => m.suggestions))],
  };
}

/** Flatten per-phrasing rankings, keeping each URL under its first phrasing. */
export function mergeHits(perQuery: SearxResult[][]): RankedHit[] {
  const seen = new Set<string>();
  const out: RankedHit[] = [];
  perQuery.forEach((results, queryIndex) => {
    for (const result of results) {
      if (seen.has(result.url)) continue;
      seen.add(result.url);
      out.push({ result, queryIndex });
    }
  });
  return out;
}

/**
 * include_domains is a hard filter (Tavily's `restrict`), applied after the
 * search even though it is also sent as a `site:` operator: some engines ignore
 * the operator, and a caller who named domains should not get others back.
 */
export function filterDomains(
  results: SearxResult[],
  include: string[],
  exclude: string[],
): SearxResult[] {
  return results.filter(
    (r) =>
      (include.length === 0 ||
        include.some((d) => urlMatchesDomain(r.url, d))) &&
      !exclude.some((d) => urlMatchesDomain(r.url, d)),
  );
}

type Page = { title: string; url: string; text: string };

async function fetchPages(
  urls: string[],
  domainProfile: string | undefined,
  fresh: boolean,
): Promise<Array<PromiseSettledResult<Page>>> {
  return Promise.allSettled(
    urls.map((u) =>
      fetchPage(u, FETCH_STORE_CEILING, domainProfile, false, undefined, fresh),
    ),
  );
}

const reasonOf = (s: PromiseRejectedResult) =>
  s.reason instanceof Error ? s.reason.message : String(s.reason);

function renderFullPages(
  urls: string[],
  pages: Map<string, PromiseSettledResult<Page>>,
  budget: number,
): string {
  return urls
    .map((u, i) => {
      const head = `=== ${i + 1}/${urls.length} ===`;
      const s = pages.get(u);
      if (!s || s.status === "rejected") {
        return `${head}\nURL: ${u}\nCould not fetch: ${s ? reasonOf(s) : "not fetched"}`;
      }
      const w = windowText(s.value.text, 0, budget, FETCH_STORE_CEILING);
      return [
        head,
        `Title: ${s.value.title}`,
        `URL: ${s.value.url}`,
        "",
        w.text,
        w.footer ? `\n${w.footer}` : "",
      ]
        .join("\n")
        .trimEnd();
    })
    .join("\n\n");
}

function buildSearchStructured(
  meta: SearxMeta,
  hits: RankedHit[],
  queries: string[],
  answer: { text: string; citations: Citation[] } | null,
  answerUnavailable: string | null,
) {
  return {
    queries,
    answer,
    answer_unavailable: answerUnavailable,
    answers: meta.answers.map((a) => ({
      answer: a.answer,
      url: a.url ?? null,
    })),
    infoboxes: meta.infoboxes.map((i) => ({
      title: i.title,
      content: i.content,
      url: i.url ?? null,
    })),
    corrections: meta.corrections,
    suggestions: meta.suggestions,
    results: hits.map(({ result: r, queryIndex, highlights }) => ({
      title: r.title,
      url: r.url,
      content: r.content ?? null,
      published: r.publishedDate ?? null,
      relevance: r.relevance ?? null,
      engines: r.engines ?? (r.engine ? [r.engine] : []),
      query_index: queryIndex,
      highlights: highlights ?? [],
    })),
  };
}

export interface SearchArgs {
  query: string | string[];
  max_results: number;
  content?: ContentMode;
  answer?: boolean;
  include_domains?: string | string[];
  exclude_domains?: string | string[];
  category?: string;
  time_range?: string;
  domain_profile?: string;
  expand?: boolean;
  language?: string;
  engines?: string;
  min_score?: number;
  fresh?: boolean;
}

export async function handleSearch(args: SearchArgs) {
  const queries = toList(args.query).slice(0, MAX_QUERIES);
  if (queries.length === 0) throw new Error("query must not be empty");
  const {
    max_results,
    category,
    time_range,
    domain_profile,
    expand,
    language,
    engines,
    min_score,
  } = args;
  const content: ContentMode = args.content ?? "snippets";
  const fresh = args.fresh ?? false;
  const include = toList(args.include_domains);
  const exclude = toList(args.exclude_domains);

  return instrumentSearchTool(
    "search",
    {
      query: queries.join(" | "),
      profile: domain_profile,
      expand,
      time_range,
      num_results: max_results,
    },
    async () => {
      const perQuery = await Promise.all(
        queries.map(async (q) => {
          const { results, meta } = await searxSearch(
            q,
            category ?? "general",
            max_results,
            time_range,
            domain_profile,
            expand,
            language,
            engines,
            include.length > 0 ? include : undefined,
            fresh,
          );
          const ranked = await rerankWithFallback(
            q,
            filterDomains(results, include, exclude),
            max_results,
            time_range,
            min_score,
            domain_profile,
          );
          return { ranked, meta };
        }),
      );
      const hits = mergeHits(perQuery.map((p) => p.ranked));
      const meta = mergeMeta(perQuery.map((p) => p.meta));
      const ranked = hits.map((h) => h.result);

      // Every page any option needs, fetched once, in parallel.
      // A result the reranker scored as off-topic is not worth a page fetch:
      // its passages would be noise, and the fetch is the slow part.
      const top = (n: number) =>
        ranked
          .slice(0, n)
          .filter((r) => r.relevance === undefined || r.relevance >= OFF_TOPIC)
          .map((r) => r.url);
      const need =
        (content === "highlights" ? HIGHLIGHT_PAGES : 0) ||
        (content === "full" ? FULL_PAGES : 0);
      const wanted = [
        ...new Set([...top(need), ...(args.answer ? top(ANSWER_PAGES) : [])]),
      ];
      const settled = await fetchPages(wanted, domain_profile, fresh);
      const pages = new Map(wanted.map((u, i) => [u, settled[i]]));

      if (content === "highlights") {
        await Promise.all(
          hits.slice(0, HIGHLIGHT_PAGES).map(async (h) => {
            const s = pages.get(h.result.url);
            if (s?.status !== "fulfilled") return;
            const sel = await selectPassages(
              queries[h.queryIndex],
              s.value.text,
              HIGHLIGHTS_PER_RESULT,
              HIGHLIGHT_SCORED_CHUNKS,
            );
            h.highlights = sel.passages.map((p) => ({
              offset: p.offset,
              text: p.text,
              score: p.score,
            }));
          }),
        );
      }

      // The answer. Synthesized from the top pages by the local LLM, with the
      // same fallback contract the old search_and_summarize tool had: when it
      // cannot be produced the response LEADS with the marker naming why, and
      // carries the pages themselves so the caller still gets substance.
      let answerText = "";
      let answer: { text: string; citations: Citation[] } | null = null;
      let answerUnavailable: string | null = null;
      let fallbackPages = false;
      if (args.answer) {
        const okPages = top(ANSWER_PAGES)
          .map((u) => pages.get(u))
          .filter(
            (s): s is PromiseFulfilledResult<Page> => s?.status === "fulfilled",
          )
          .map((s) => ({
            ...s.value,
            text: s.value.text.slice(0, ANSWER_PAGE_CHARS),
          }));
        const summary = await withSpan(
          "summarize_llm",
          { "summary.pages": okPages.length },
          () => summarizePages(queries[0], okPages),
        );
        if (summary.summary) {
          answer = { text: summary.summary, citations: summary.citations };
          answerText = formatSummaryResult(summary);
        } else {
          answerText = formatSummaryFallbackNotice(summary.failure);
          answerUnavailable = summary.failure
            ? `${summary.failure.kind}: ${summary.failure.detail}`
            : "unknown";
          fallbackPages = content !== "full";
        }
      }

      const sections = [
        answerText,
        formatMeta(meta),
        formatHits(hits, queries),
      ];
      if (content === "full" && ranked.length > 0) {
        sections.push(
          renderFullPages(
            top(FULL_PAGES),
            pages,
            Math.floor(FULL_TOTAL_CHARS / Math.min(FULL_PAGES, ranked.length)),
          ),
        );
      } else if (fallbackPages && ranked.length > 0) {
        const urls = top(ANSWER_PAGES);
        sections.push(
          renderFullPages(
            urls,
            pages,
            Math.floor(FULL_TOTAL_CHARS / urls.length),
          ),
        );
      }

      return {
        ranked,
        rerankApplied: ranked.some((r) => r.relevance !== undefined),
        result: {
          content: [
            {
              type: "text" as const,
              text: sections.filter(Boolean).join("\n\n"),
            },
          ],
          structuredContent: buildSearchStructured(
            meta,
            hits,
            queries,
            answer,
            answerUnavailable,
          ),
        },
      };
    },
  );
}

// ── fetch_url ───────────────────────────────────────────────────────────────

interface PageRequest {
  maxChars: number;
  offset: number;
  find?: string;
  query?: string;
  domainProfile?: string;
  tuning?: FetchTuning;
  fresh: boolean;
}

/**
 * One page, rendered for an agent: header, then the requested window, the
 * passages matching `find`, or the passages most relevant to `query`, with a
 * footer whenever a window is not the whole page. Reads the full stored text
 * and windows it here, so paging a long page is a cache hit, not a refetch.
 */
async function renderPage(url: string, req: PageRequest): Promise<string> {
  const page = await fetchPage(
    url,
    FETCH_STORE_CEILING,
    req.domainProfile,
    false,
    req.tuning,
    req.fresh,
  );
  const header = `Title: ${page.title}\nURL: ${page.url}`;
  if (req.query) {
    const sel = await selectPassages(req.query, page.text, QUERY_PASSAGES);
    if (sel.passages.length === 0) {
      return `${header}\n\n[page has no text to select passages from]`;
    }
    const how =
      sel.scoredBy === "reranker"
        ? "ranked by the local reranker"
        : "ranked by term overlap — reranker unavailable";
    const body = sel.passages
      .map(
        (p) =>
          `--- offset ${p.offset} · score ${p.score.toFixed(2)} ---\n${p.text}`,
      )
      .join("\n\n");
    return `${header}\n\n[${sel.passages.length} of ${sel.chunkCount} passages for "${req.query}", ${how}]\n\n${body}`;
  }
  if (req.find) {
    const found = findPassages(page.text, req.find);
    return `${header}\n\n${formatPassages(req.find, found, page.text.length)}`;
  }
  const w = windowText(
    page.text,
    req.offset,
    req.maxChars,
    FETCH_STORE_CEILING,
  );
  return [header, "", w.text, w.footer ? `\n${w.footer}` : ""]
    .join("\n")
    .trimEnd();
}

export interface FetchUrlArgs {
  url: string | string[];
  domain_profile?: string;
  max_tokens?: number;
  offset?: number;
  find?: string;
  query?: string;
  target_selector?: string;
  wait_for_selector?: string;
  fresh?: boolean;
}

export async function handleFetchUrl(args: FetchUrlArgs) {
  return instrumentTool("fetch_url", async () => {
    const urls = toList(args.url).slice(0, MAX_URLS);
    if (urls.length === 0) throw new Error("url must not be empty");
    const tuning: FetchTuning | undefined =
      args.target_selector || args.wait_for_selector
        ? {
            targetSelector: args.target_selector,
            waitForSelector: args.wait_for_selector,
          }
        : undefined;
    const base = {
      offset: args.offset ?? 0,
      find: args.find?.trim() || undefined,
      query: args.query?.trim() || undefined,
      tuning,
      fresh: args.fresh ?? false,
      domainProfile: args.domain_profile,
    };
    const maxChars = args.max_tokens
      ? args.max_tokens * CHARS_PER_TOKEN
      : urls.length === 1
        ? FETCH_DEFAULT_CHARS
        : FETCH_MULTI_DEFAULT_CHARS;
    if (urls.length === 1) {
      const text = await renderPage(urls[0], { ...base, maxChars });
      return { content: [{ type: "text" as const, text }] };
    }
    // Several pages in parallel; a failure costs its own section, not the call.
    const settled = await Promise.allSettled(
      urls.map((u) => renderPage(u, { ...base, maxChars })),
    );
    const text = settled
      .map((s, i) =>
        s.status === "fulfilled"
          ? `=== ${i + 1}/${urls.length} ===\n${s.value}`
          : `=== ${i + 1}/${urls.length} ===\nURL: ${urls[i]}\nCould not fetch: ${reasonOf(s)}`,
      )
      .join("\n\n");
    return { content: [{ type: "text" as const, text }] };
  });
}

// ── crawl_site / admin ──────────────────────────────────────────────────────

export async function handleCrawlSite({
  url,
  max_pages,
  same_domain_only,
  include_path,
  exclude_path,
}: {
  url: string;
  max_pages: number;
  same_domain_only: boolean;
  include_path?: string;
  exclude_path?: string;
}) {
  return instrumentTool("crawl_site", async () => {
    const t0 = Date.now();
    events.crawlRequested({ url, max_pages, same_domain_only });
    const manifest = await crawlSite(
      url,
      max_pages,
      same_domain_only,
      include_path,
      exclude_path,
    );
    const latency_ms = Date.now() - t0;
    events.crawlCompleted({
      url,
      strategy: manifest.strategy,
      page_count: manifest.page_count,
      latency_ms,
      cached: manifest.cached,
    });
    incCounter("crawl", {
      outcome: manifest.strategy === "error" ? "error" : "success",
    });
    recordHistogram("tool.crawl_site", latency_ms / 1000, {});
    return {
      content: [{ type: "text" as const, text: formatCrawlManifest(manifest) }],
    };
  });
}

export async function handleClearCache({ target }: { target: string }) {
  return instrumentTool("clear_cache", async () => {
    let cleared = 0;
    if (target === "search" || target === "all") {
      cleared += await cacheClear("search:*");
    }
    if (target === "fetch" || target === "all") {
      cleared += await cacheClear("fetch:*");
    }
    if (target === "crawl" || target === "all") {
      cleared += await cacheClear("crawl:*");
    }
    return {
      content: [
        {
          type: "text" as const,
          text: `Cleared ${cleared} cache ${cleared === 1 ? "entry" : "entries"}.`,
        },
      ],
    };
  });
}

// ── domain_stats structured output ──────────────────────────────────────────
// Single Zod object covering both tool modes; the other mode's slot is null.
// The SDK validates returned `structuredContent` against this before it leaves
// the server and advertises the derived JSON Schema in tools/list.

const TierStatsOutputSchema = z.object({
  attempts: z.number(),
  ok: z.number(),
  fail: z.number(),
  success_rate: z.number().nullable(),
});

/**
 * The per-slot tier block, DERIVED from `TIER_SLOT_KEYS` rather than hand-listed.
 *
 * This is the fix for vikunja#637, and the derivation is the point of it. Both
 * payload builders (`aggregateDomainStats`, `summarizeDomainRecord`) already
 * emit their `tiers` object via `Object.fromEntries(TIER_SLOT_KEYS.map(...))`.
 * When this schema was a hand-written literal, the two lists were free to
 * diverge — and they did: v3.19.0 added a sixth slot (`solver`) to the constant
 * and the payload grew it, while the schema stayed at five. Zod emits
 * `additionalProperties: false`, so every `domain_stats` call on a
 * solver-enabled deployment failed structured-output validation outright.
 *
 * Deriving from the same constant makes that class of drift unrepresentable:
 * `TierSlotKey` is itself `(typeof TIER_SLOT_KEYS)[number]`, so the mapped type
 * below and the runtime keys have one source. Adding a slot to the constant
 * cannot leave this schema behind.
 *
 * Every slot is OPTIONAL, and that is deliberate rather than defensive. A slot
 * is only written once its tier has run: `tier4` requires `WAYBACK_ENABLED`,
 * `solver` requires `SOLVER_ENABLED`. Marking them required does not fix the
 * bug, it inverts which deployments it breaks — `tier4` carried this identical
 * defect latently for every deployment whose records predate Wayback.
 */
type AllTiersShape = {
  [K in TierSlotKey]: z.ZodOptional<typeof TierStatsOutputSchema>;
};

const AllTiersOutputSchema = z.object(
  Object.fromEntries(
    TIER_SLOT_KEYS.map((slot) => [slot, TierStatsOutputSchema.optional()]),
  ) as AllTiersShape,
);

const SingleDomainOutputSchema = z.object({
  domain: z.string(),
  first_seen: z.string(),
  last_fetch: z.string(),
  preferred_strategy: z.string().nullable(),
  tiers: AllTiersOutputSchema,
  capabilities: z.object({
    llms_full_txt: z.boolean(),
    robots_allows_us: z.boolean().nullable(),
    metadata_fetch_rate: z.number().nullable(),
    seen_in_search: z.number(),
  }),
});

const AggregateOutputSchema = z.object({
  // Declared, not just emitted: the SDK validates structuredContent against
  // this schema before it leaves the server, so a field missing here is a field
  // the caller never receives however faithfully the handler builds it.
  schema_version: z.number(),
  window: z.object({
    oldest_sample_ms: z.number().nullable(),
    elapsed_ms: z.number().nullable(),
    ttl_ceiling_ms: z.number(),
  }),
  domains_tracked: z.number(),
  seen_never_fetched: z.number(),
  tiers: AllTiersOutputSchema,
  failing_count: z.number(),
  top_failing: z.array(
    z.object({
      domain: z.string(),
      attempts: z.number(),
      ok: z.number(),
      success_rate: z.number(),
    }),
  ),
  truncated: z.boolean(),
});

// Exported solely so tests can validate real payloads against the *declared*
// contract rather than a restatement of it. A test that rebuilds the schema
// locally proves nothing — this is the object actually handed to registerTool.
export const DomainStatsOutputSchema = z.object({
  mode: z.enum(["single", "aggregate"]),
  hostname: z.string().nullable(),
  found: z.boolean(),
  record: SingleDomainOutputSchema.nullable(),
  aggregate: AggregateOutputSchema.nullable(),
  // Set when the corpus could not be read. Declared here deliberately: the SDK
  // validates structuredContent against this schema before it leaves the
  // server, so an undeclared field is one the caller never receives however
  // faithfully the handler sets it — and this is precisely the field a caller
  // needs to not read `domains_tracked: 0` as a measurement (vikunja#688).
  unavailable: z.string().nullable().optional(),
});

export async function handleDomainStats({ hostname }: { hostname?: string }) {
  return instrumentTool("domain_stats", async () => {
    if (hostname) {
      const record = await getDomainRecord(hostname);
      if (!record) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No domain-db record for ${hostname}.`,
            },
          ],
          structuredContent: {
            mode: "single" as const,
            hostname,
            found: false,
            record: null,
            aggregate: null,
          },
        };
      }
      return {
        content: [{ type: "text" as const, text: formatDomainRecord(record) }],
        structuredContent: {
          mode: "single" as const,
          hostname,
          found: true,
          record: summarizeDomainRecord(record),
          aggregate: null,
        },
      };
    }

    // Aggregate mode — operator-triggered, bounded off-hot-path scan.
    const { records, truncated, unavailable } = await enumerateDomains();

    // "Could not read the database" and "the database is empty" produced the
    // same answer here, and the second is the one a reader believes. Research
    // hit exactly this while measuring for the plan that fixes it: a `0` that
    // was an auth failure. Say so instead of reporting a count (vikunja#688).
    if (unavailable) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Could not read the domain database: ${unavailable}\n\n` +
              "This is not a report that the database is empty — no count was " +
              "obtained. Check the cache backend is reachable and that " +
              "VALKEY_URL's credentials are correct.",
          },
        ],
        structuredContent: {
          mode: "aggregate" as const,
          hostname: null,
          found: false,
          record: null,
          aggregate: null,
          unavailable,
        },
      };
    }

    const aggregate = aggregateDomainStats(records, truncated);
    return {
      content: [
        { type: "text" as const, text: formatDomainAggregate(aggregate) },
      ],
      structuredContent: {
        mode: "aggregate" as const,
        hostname: null,
        found: aggregate.domains_tracked > 0,
        record: null,
        aggregate,
      },
    };
  });
}

// ── schemas ─────────────────────────────────────────────────────────────────
//
// Descriptions are budgeted. Every word here is paid for in every agent's
// context on every turn, so each says what changes the caller's decision and
// nothing else. The rationale lives in the code comments, not the schema.

/**
 * Advertised as an enum so an agent can see the valid names. Read once at
 * registration: a profile added to domains.json later still works when named,
 * it just is not advertised until the next session.
 */
function domainProfileSchema() {
  const names = getProfileNames();
  const base =
    names.length > 0
      ? z.enum(names as [string, ...string[]])
      : z.string().max(0);
  return base
    .optional()
    .describe("Domain profile: boosts and blocks a set of sites");
}

const QuerySchema = z
  .union([
    z.string().min(1),
    z.array(z.string().min(1)).min(1).max(MAX_QUERIES),
  ])
  .describe(
    `Search query, or up to ${MAX_QUERIES} phrasings of one question (run in parallel, merged, duplicates dropped). Specific keyword-rich queries work best.`,
  );

const LanguageSchema = z
  .string()
  .optional()
  .describe("BCP-47 code like 'en', or 'all'");

const EnginesSchema = z
  .string()
  .optional()
  .describe("Comma-separated SearXNG engines to restrict to; omit normally");

/**
 * A boolean parameter that also accepts "true"/"false" strings, for clients
 * that stringify arguments. NOT z.coerce.boolean(): that is Boolean(value),
 * under which the string "false" is true — an agent asking for fresh: "false"
 * would get the cache bypassed, and answer: "false" a 60-second synthesis.
 */
export const BoolArg = z.preprocess(
  (v) => (v === "true" ? true : v === "false" ? false : v),
  z.boolean(),
);

const DomainListSchema = (what: string) =>
  z
    .union([z.string(), z.array(z.string()).max(50)])
    .optional()
    .describe(what);

const FreshSchema = BoolArg.optional().describe(
  "Bypass the cache for this call (search 1h, pages 24h)",
);

/**
 * `min_score` filters on the RAW cross-encoder relevance, not the
 * recency-adjusted ordering score, so a recent but irrelevant result cannot be
 * pushed past the floor. Scores measured against the live FlashRank service are
 * strongly bimodal (nginx reverse-proxy guide 0.998, Apache mod_proxy 0.967,
 * nginx install page 0.0028), so 0.01–0.1 is the useful range and 0.5 is not a
 * midpoint — and a high score means on-topic, not correct. No-op (with a
 * logged warning) when the reranker is down.
 */
const MinScoreSchema = z.coerce
  .number()
  .min(0)
  .max(1)
  .optional()
  .describe(
    "Drop results below this reranker relevance (the 'rel' shown). Scores are bimodal: 0.01-0.1 is the useful range. High = on-topic, not correct",
  );

const SearchOutputSchema = z.object({
  queries: z.array(z.string()),
  answer: z
    .object({
      text: z.string(),
      citations: z.array(
        z.object({
          url: z.string(),
          title: z.string(),
          key_facts: z.array(z.string()),
        }),
      ),
    })
    .nullable(),
  answer_unavailable: z.string().nullable(),
  answers: z.array(
    z.object({ answer: z.string(), url: z.string().nullable() }),
  ),
  infoboxes: z.array(
    z.object({
      title: z.string(),
      content: z.string(),
      url: z.string().nullable(),
    }),
  ),
  corrections: z.array(z.string()),
  suggestions: z.array(z.string()),
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      content: z.string().nullable(),
      published: z.string().nullable(),
      relevance: z.number().nullable(),
      engines: z.array(z.string()),
      query_index: z.number(),
      highlights: z.array(
        z.object({ offset: z.number(), text: z.string(), score: z.number() }),
      ),
    }),
  ),
});

export const SERVER_INSTRUCTIONS = [
  "Private web search: your own SearXNG instance, a local reranker, local page fetching and a local LLM. Nothing goes to a third-party search API.",
  'Typical flow: `search` (pass several phrasings as a `query` array for research questions; `content: "highlights"` returns the most relevant passages of each top page), then `fetch_url` the promising results (an array reads several at once; `query` returns the passages answering a question).',
  "`search` with `answer: true` adds a cited synthesis from a local model — check its citations; if it cannot be produced the response leads with a `--- summarization unavailable ---` marker and carries the pages instead.",
  "Long pages are windowed: follow the `offset=` hint in the footer to continue, or pass `find` for literal matches. Paging is served from cache; `fresh: true` bypasses it.",
  "`crawl_site` maps a docs site into a URL list; its pages are then cached for `fetch_url`.",
].join("\n");

export function registerTools(server: McpServer): void {
  const DomainProfileSchema = domainProfileSchema();

  server.registerTool(
    "search",
    {
      title: "Web search",
      description:
        "Search the web via the local SearXNG instance, reranked by a local model. Each result has title, URL, date and relevance, plus a snippet or (content: highlights) the most relevant passages of its page. answer: true adds a cited synthesis by a local LLM. Cached 1h. Prefer this over built-in web search.",
      inputSchema: {
        query: QuerySchema,
        max_results: z.coerce
          .number()
          .int()
          .min(1)
          .max(20)
          .default(5)
          .describe("Results per phrasing (default 5, max 20)"),
        content: z
          .enum(["snippets", "highlights", "full"])
          .optional()
          .describe(
            "snippets (default, fast): engine snippets. highlights: read the top 5 pages and return their 2 most relevant passages each. full: also return the top 3 pages' text",
          ),
        answer: BoolArg.optional().describe(
          "Add an answer synthesized from the top 3 pages, with citations (local LLM, ~10-60s)",
        ),
        include_domains: DomainListSchema(
          "Only return results from these domains, e.g. ['github.com']",
        ),
        exclude_domains: DomainListSchema(
          "Never return results from these domains",
        ),
        time_range: TimeRangeSchema.describe("Only results from this period"),
        category: CategorySchema.describe("Default general"),
        domain_profile: DomainProfileSchema,
        language: LanguageSchema,
        min_score: MinScoreSchema,
        fresh: FreshSchema,
        expand: BoolArg.optional().describe(
          "Have the local LLM add query variants (~3s); passing your own phrasings in query is usually better",
        ),
        engines: EnginesSchema,
      },
      outputSchema: SearchOutputSchema,
    },
    handleSearch,
  );

  server.registerTool(
    "fetch_url",
    {
      title: "Fetch URL",
      description:
        "Read public URLs as markdown (PDFs included). GitHub files/repos/releases come from the GitHub API; YouTube and Reddit have fast paths; other pages go Crawl4AI (headless browser) then raw HTTP. Returns a window of the page with a footer saying how to continue; `query` or `find` return passages instead. Cached 24h.",
      inputSchema: {
        url: z
          .union([
            z.string().url(),
            z.array(z.string().url()).min(1).max(MAX_URLS),
          ])
          .describe(`http(s) URL, or up to ${MAX_URLS} URLs read in parallel`),
        max_tokens: z.coerce
          .number()
          .int()
          .min(100)
          .max(10000)
          .optional()
          .describe(
            "Approx tokens to return per page (default 2000; 1000 each when several URLs)",
          ),
        offset: z.coerce
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Character offset to start from, as given in the footer"),
        query: z
          .string()
          .max(500)
          .optional()
          .describe(
            "Return the page's 5 passages most relevant to this question (local reranker) instead of the page head",
          ),
        find: z
          .string()
          .max(500)
          .optional()
          .describe(
            "Return passages around literal case-insensitive matches; '|' separates alternatives",
          ),
        fresh: FreshSchema,
        domain_profile: DomainProfileSchema,
        target_selector: z
          .string()
          .max(500)
          .optional()
          .describe("CSS selector to scope extraction, e.g. 'article'"),
        wait_for_selector: z
          .string()
          .max(500)
          .optional()
          .describe("CSS selector to wait for on JS-rendered pages"),
      },
    },
    handleFetchUrl,
  );

  server.registerTool(
    "crawl_site",
    {
      title: "Crawl site",
      description:
        "Map a site (sitemap, else link-following if enabled) into a URL/title/snippet list; pages are cached for fetch_url. A start URL with a path stays under it; include_path '/' crawls the whole site.",
      inputSchema: {
        url: z.string().url().describe("Site root or docs URL"),
        max_pages: z.coerce
          .number()
          .int()
          .min(1)
          .max(100)
          .default(CRAWL_MAX_PAGES_DEFAULT)
          .describe(`Page cap (default ${CRAWL_MAX_PAGES_DEFAULT})`),
        same_domain_only: BoolArg.default(true).describe(
          "Stay on the start domain (default true)",
        ),
        include_path: z
          .string()
          .optional()
          .describe(
            "Only URLs under this path prefix; replaces the default scope",
          ),
        exclude_path: z
          .string()
          .optional()
          .describe("Skip URLs under this path prefix"),
      },
    },
    handleCrawlSite,
  );

  // Operator tools. Off by default: clear_cache wipes cache shared by every
  // agent on the box, and domain_stats is a diagnostic an agent mid-task has no
  // use for — together they were ~5k chars of schema in every agent's context.
  // The same data is available to operators through the config/stats MCP
  // resources and the dump-domain CLI.
  if (!ADMIN_TOOLS_ENABLED) return;

  server.registerTool(
    "clear_cache",
    {
      title: "Clear cache",
      description:
        "Purge cached search results (1h), fetched pages (24h) and/or crawl manifests.",
      inputSchema: {
        target: z
          .enum(["search", "fetch", "crawl", "all"])
          .default("all")
          .describe("Which cache (default all)"),
      },
    },
    handleClearCache,
  );

  server.registerTool(
    "domain_stats",
    {
      title: "Domain capability stats",
      description:
        "What the fetcher has learned about a host: per-tier success rates (tier2 crawl4ai, tier3 raw, tier4 wayback, github fast path, solver), llms.txt/robots presence, search appearances. Omit hostname for an aggregate. Read-only.",
      inputSchema: {
        hostname: z
          .string()
          .optional()
          .describe(
            "Hostname or URL, e.g. 'docs.python.org'; omit for aggregate",
          ),
      },
      outputSchema: DomainStatsOutputSchema,
    },
    handleDomainStats,
  );
}
