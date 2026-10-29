// fetch_url — read up to five pages as windowed markdown, or the passages of
// each that match a question (`query`) or a literal string (`find`).
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FETCH_STORE_CEILING, fetchPage } from "../../fetch/fetch-page.js";
import {
  findPassages,
  formatPassages,
  windowText,
} from "../../fetch/paging.js";
import type { FetchTuning } from "../../fetch/utils.js";
import { selectPassages } from "../../search/passages.js";
import {
  type domainProfileSchema,
  FreshSchema,
  reasonOf,
  toList,
} from "./args.js";
import { instrumentTool } from "./instrument.js";

/** Most URLs one `fetch_url` call reads. */
const MAX_URLS = 5;

// Rough token→char conversion for budgets. Deliberately a cheap heuristic
// (chars ≈ tokens × 4), not an exact tokenizer.
const CHARS_PER_TOKEN = 4;
const FETCH_DEFAULT_CHARS = 8000;
/** Per-page default when several URLs are read at once. */
const FETCH_MULTI_DEFAULT_CHARS = 4000;
/** Passages fetch_url returns for a semantic `query`. */
const QUERY_PASSAGES = 5;

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

export function registerFetchUrlTool(
  server: McpServer,
  DomainProfileSchema: ReturnType<typeof domainProfileSchema>,
): void {
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
}
