// search — the one search tool.
//
// Shaped after what Tavily, Exa and Gemini grounding converge on: one search
// call whose options decide how much of each result comes back (`content`) and
// whether a synthesized, cited answer comes with it (`answer`), rather than a
// separate tool per combination.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withSpan } from "../../core/observability.js";
import {
  CategorySchema,
  type Citation,
  type SearxMeta,
  type SearxResult,
  TimeRangeSchema,
} from "../../core/types.js";
import { urlMatchesDomain } from "../../domains/rules.js";
import { FETCH_STORE_CEILING, fetchPage } from "../../fetch/fetch-page.js";
import { windowText } from "../../fetch/paging.js";
import { withProjectDocs } from "../../search/docs-probe.js";
import {
  formatSummaryFallbackNotice,
  formatSummaryResult,
  summarizePages,
} from "../../search/ollama.js";
import { rescoreFromPages } from "../../search/passage-rescore.js";
import { selectPassages } from "../../search/passages.js";
import { rerankWithFallback } from "../../search/reranker.js";
import { searxSearch } from "../../search/searxng.js";
import {
  BoolArg,
  type domainProfileSchema,
  FreshSchema,
  reasonOf,
  toList,
} from "./args.js";
import { instrumentSearchTool } from "./instrument.js";

/** Most phrasings one `search` call fans out to. */
const MAX_QUERIES = 5;
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
          const { results: pool, meta } = await searxSearch(
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
          // A caller's include_domains already scopes the search.
          const results =
            include.length > 0
              ? pool
              : await withProjectDocs(q, pool, {
                  category: category ?? "general",
                  timeRange: time_range,
                  domainProfile: domain_profile,
                  language,
                  engines,
                  fresh,
                });
          const filtered = filterDomains(results, include, exclude);
          // The whole pool comes back ranked so a docs page the snippet
          // undersold can still climb into the top max_results.
          const pooled = await rerankWithFallback(
            q,
            filtered,
            filtered.length,
            time_range,
            min_score,
            domain_profile,
          );
          const rescored = await rescoreFromPages(q, pooled, {
            fetchText: async (u) =>
              (
                await fetchPage(
                  u,
                  FETCH_STORE_CEILING,
                  domain_profile,
                  false,
                  undefined,
                  fresh,
                )
              ).text,
            applyRecency: !time_range,
            profile: domain_profile,
          });
          return { ranked: rescored.slice(0, max_results), meta };
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

// ── schemas ─────────────────────────────────────────────────────────────────

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

const DomainListSchema = (what: string) =>
  z
    .union([z.string(), z.array(z.string()).max(50)])
    .optional()
    .describe(what);

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

export function registerSearchTool(
  server: McpServer,
  DomainProfileSchema: ReturnType<typeof domainProfileSchema>,
): void {
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
}
