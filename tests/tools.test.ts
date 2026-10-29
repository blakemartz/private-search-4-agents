import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/cache.js", () => ({
  cacheClear: vi.fn().mockResolvedValue(5),
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheAtomicUpdate: vi.fn().mockResolvedValue(undefined),
  getValkey: vi.fn().mockResolvedValue(null),
  searchCacheKey: vi.fn().mockReturnValue("key"),
}));

const EMPTY_META = {
  answers: [],
  infoboxes: [],
  corrections: [],
  suggestions: [],
};

vi.mock("../src/search.js", () => ({
  searxSearch: vi.fn().mockResolvedValue({
    results: [
      {
        title: "Result 1",
        url: "https://example.com/1",
        content: "Some content",
        engines: ["google"],
      },
      {
        title: "Result 2",
        url: "https://example.com/2",
        content: "More content",
        engines: ["bing"],
      },
    ],
    meta: {
      answers: [],
      infoboxes: [],
      corrections: [],
      suggestions: [],
    },
  }),
}));

vi.mock("../src/reranker.js", () => ({
  rerankWithFallback: vi
    .fn()
    .mockImplementation((_, results) => Promise.resolve(results)),
  // null = reranker unavailable, so passage selection uses term overlap.
  scorePassages: vi.fn().mockResolvedValue(null),
}));

vi.mock("../src/ollama.js", async () => {
  // The marker and the rendered summary are NOT stubbed: their wording is the
  // contract under test, and a stub would only assert against a string this
  // file made up.
  const actual =
    await vi.importActual<typeof import("../src/ollama.js")>(
      "../src/ollama.js",
    );
  return {
    summarizePages: vi.fn().mockResolvedValue({
      summary: "",
      citations: [],
      failure: { kind: "timeout", detail: "aborted due to timeout" },
    }),
    formatSummaryResult: actual.formatSummaryResult,
    formatSummaryFallbackNotice: actual.formatSummaryFallbackNotice,
  };
});

vi.mock("../src/fetch.js", () => ({
  FETCH_STORE_CEILING: 40000,
  fetchPage: vi.fn().mockResolvedValue({
    title: "Fetched Page",
    url: "https://example.com/1",
    text: "Page content here",
  }),
}));

vi.mock("../src/events.js", () => ({
  events: {
    searchRequested: vi.fn(),
    searchCompleted: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../src/observability.js", () => ({
  incCounter: vi.fn(),
  recordHistogram: vi.fn(),
  withSpan: vi.fn().mockImplementation((_name, _attrs, fn) => fn()),
}));

vi.mock("../src/context.js", () => ({
  newRequestId: vi.fn().mockReturnValue("test-req-id"),
  withRequestId: vi.fn().mockImplementation((_id, fn) => fn()),
}));

import { cacheClear, cacheGet, getValkey } from "../src/cache.js";
import type { DomainRecord } from "../src/domain-db.js";
import { fetchPage } from "../src/fetch.js";
import { summarizePages } from "../src/ollama.js";
import { scorePassages } from "../src/reranker.js";
import { searxSearch } from "../src/search.js";
import {
  handleClearCache,
  handleDomainStats,
  handleFetchUrl,
  handleSearch,
  mergeHits,
} from "../src/tools.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handleSearch", () => {
  it("calls searxSearch with provided params and returns formatted results", async () => {
    const result = await handleSearch({
      query: "test query",
      max_results: 5,
    });
    expect(searxSearch).toHaveBeenCalledWith(
      "test query",
      "general",
      5,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
    );
    expect(result.content[0].text).toContain("Result 1");
    expect(result.content[0].text).toContain("example.com/1");
  });

  it("passes language param through to searxSearch", async () => {
    await handleSearch({
      query: "test",
      max_results: 3,
      language: "de",
    });
    expect(searxSearch).toHaveBeenCalledWith(
      "test",
      "general",
      3,
      undefined,
      undefined,
      undefined,
      "de",
      undefined,
      undefined,
      false,
    );
  });

  it("returns No results found when searxSearch returns empty", async () => {
    vi.mocked(searxSearch).mockResolvedValueOnce({
      results: [],
      meta: EMPTY_META,
    });
    const result = await handleSearch({ query: "nothing", max_results: 5 });
    expect(result.content[0].text).toBe("No results found.");
  });

  it("surfaces a direct answer above the results and in structuredContent", async () => {
    vi.mocked(searxSearch).mockResolvedValueOnce({
      results: [
        {
          title: "Result 1",
          url: "https://example.com/1",
          content: "Some content",
          engines: ["google"],
        },
      ],
      meta: {
        answers: [{ answer: "42", url: "https://ref" }],
        infoboxes: [],
        corrections: [],
        suggestions: ["related"],
      },
    });
    const result = await handleSearch({ query: "answer me", max_results: 5 });
    expect(result.content[0].text).toContain("Direct answer");
    expect(result.content[0].text.indexOf("42")).toBeLessThan(
      result.content[0].text.indexOf("Result 1"),
    );
    expect(result.structuredContent?.answers).toEqual([
      { answer: "42", url: "https://ref" },
    ]);
    expect(result.structuredContent?.suggestions).toEqual(["related"]);
  });
});

describe("handleFetchUrl", () => {
  const LONG = "abcdefghij".repeat(1500); // 15,000 chars

  it("reads the full stored text and returns a header plus the page", async () => {
    const result = await handleFetchUrl({ url: "https://example.com/page" });
    // Always asks for the store ceiling and windows locally, so paging is a
    // cache hit rather than a refetch.
    expect(fetchPage).toHaveBeenCalledWith(
      "https://example.com/page",
      40000,
      undefined,
      false,
      undefined,
      false,
    );
    const text = result.content[0].text;
    expect(text).toContain("Title: Fetched Page");
    expect(text).toContain("URL: https://example.com/1");
    expect(text).toContain("Page content here");
    // A page that fits is returned whole, with no footer.
    expect(text).not.toContain("[chars");
  });

  it("windows a long page to the budget and says how to continue", async () => {
    vi.mocked(fetchPage).mockResolvedValueOnce({
      title: "T",
      url: "https://e/long",
      text: LONG,
    });
    const text = (
      await handleFetchUrl({ url: "https://e/long", max_tokens: 1000 })
    ).content[0].text;
    expect(text).toContain(LONG.slice(0, 4000));
    expect(text).not.toContain(LONG.slice(0, 4001));
    expect(text).toContain(
      "[chars 0–4,000 of 15,000 · continue with offset=4000]",
    );
  });

  it("starts from offset", async () => {
    vi.mocked(fetchPage).mockResolvedValueOnce({
      title: "T",
      url: "https://e/long",
      text: LONG,
    });
    const text = (
      await handleFetchUrl({
        url: "https://e/long",
        offset: 12000,
        max_tokens: 1000,
      })
    ).content[0].text;
    expect(text).toContain("[chars 12,000–15,000 of 15,000]");
  });

  it("returns passages for find instead of the page head", async () => {
    vi.mocked(fetchPage).mockResolvedValueOnce({
      title: "T",
      url: "https://e/f",
      text: `${"x".repeat(2000)} needle here ${"y".repeat(2000)}`,
    });
    const text = (await handleFetchUrl({ url: "https://e/f", find: "NEEDLE" }))
      .content[0].text;
    expect(text).toContain('[1 match for "NEEDLE"]');
    expect(text).toContain("needle here");
    expect(text.length).toBeLessThan(1000);
  });

  it("reads several URLs in parallel, isolating a failure to its section", async () => {
    vi.mocked(fetchPage)
      .mockResolvedValueOnce({ title: "One", url: "https://e/1", text: "a" })
      .mockRejectedValueOnce(new Error("boom"));
    const text = (await handleFetchUrl({ url: ["https://e/1", "https://e/2"] }))
      .content[0].text;
    expect(text).toContain("=== 1/2 ===\nTitle: One");
    expect(text).toContain(
      "=== 2/2 ===\nURL: https://e/2\nCould not fetch: boom",
    );
  });

  it("gives each of several URLs the smaller default budget", async () => {
    const long = {
      title: "T",
      url: "https://e/long",
      text: LONG,
    };
    vi.mocked(fetchPage)
      .mockResolvedValueOnce(long)
      .mockResolvedValueOnce(long);
    const text = (await handleFetchUrl({ url: ["https://e/a", "https://e/b"] }))
      .content[0].text;
    expect(text.match(/\[chars 0–4,000 of 15,000/g)).toHaveLength(2);
  });

  it("threads target_selector / wait_for_selector as fetch tuning", async () => {
    vi.mocked(fetchPage).mockResolvedValueOnce({
      title: "T",
      url: "https://e/p",
      text: "x",
    });
    await handleFetchUrl({
      url: "https://example.com/page",
      target_selector: "article",
      wait_for_selector: ".loaded",
    });
    expect(fetchPage).toHaveBeenCalledWith(
      "https://example.com/page",
      40000,
      undefined,
      false,
      { targetSelector: "article", waitForSelector: ".loaded" },
      false,
    );
  });

  it("propagates errors for a single URL", async () => {
    vi.mocked(fetchPage).mockRejectedValueOnce(
      new Error("Internal/private addresses are not allowed"),
    );
    await expect(
      handleFetchUrl({ url: "http://192.168.1.1/page" }),
    ).rejects.toThrow("Internal/private addresses are not allowed");
  });
});

describe("handleClearCache", () => {
  it("clears both caches when target is all", async () => {
    const result = await handleClearCache({ target: "all" });
    expect(cacheClear).toHaveBeenCalledWith("search:*");
    expect(cacheClear).toHaveBeenCalledWith("fetch:*");
    expect(cacheClear).toHaveBeenCalledWith("crawl:*");
    expect(result.content[0].text).toContain("15 cache entries");
  });

  it("clears only search cache when target is search", async () => {
    await handleClearCache({ target: "search" });
    expect(cacheClear).toHaveBeenCalledWith("search:*");
    expect(cacheClear).not.toHaveBeenCalledWith("fetch:*");
  });

  it("clears only fetch cache when target is fetch", async () => {
    await handleClearCache({ target: "fetch" });
    expect(cacheClear).not.toHaveBeenCalledWith("search:*");
    expect(cacheClear).toHaveBeenCalledWith("fetch:*");
  });

  it("uses singular 'entry' when exactly 1 cleared", async () => {
    vi.mocked(cacheClear).mockResolvedValueOnce(1);
    const result = await handleClearCache({ target: "search" });
    expect(result.content[0].text).toBe("Cleared 1 cache entry.");
  });
});

describe("handleDomainStats", () => {
  const NOW = Date.now();

  function stat(attempts: number, ok: number, fail: number) {
    return { attempts, ok, fail, window_start_ms: NOW };
  }

  function mkRecord(
    domain: string,
    tiers: Partial<DomainRecord["tier_stats_30d"]> = {},
    capabilities: DomainRecord["capabilities"] = {},
  ): DomainRecord {
    return {
      schema_version: 7,
      domain,
      first_seen: "2026-05-01T00:00:00Z",
      last_fetch: "2026-06-01T00:00:00Z",
      capabilities,
      tier_stats_30d: {
        tier2: stat(0, 0, 0),
        tier3: stat(0, 0, 0),
        tier4: stat(0, 0, 0),
        github: stat(0, 0, 0),
        solver: stat(0, 0, 0),
        ...tiers,
      },
    };
  }

  it("single mode: returns the record summary and structuredContent when found", async () => {
    vi.mocked(cacheGet).mockResolvedValueOnce(
      JSON.stringify(
        mkRecord(
          "docs.example.com",
          { tier2: stat(10, 9, 1) },
          { seen_in_search: { count: 4, last_seen_at: "x" } },
        ),
      ),
    );
    const result = await handleDomainStats({ hostname: "docs.example.com" });
    expect(result.content[0].text).toContain("tier stats (30d window)");
    expect(result.structuredContent).toMatchObject({
      mode: "single",
      hostname: "docs.example.com",
      found: true,
      aggregate: null,
    });
    expect(result.structuredContent.record?.domain).toBe("docs.example.com");
    expect(result.structuredContent.record?.tiers.tier2.success_rate).toBe(0.9);
    expect(result.structuredContent.record?.capabilities.seen_in_search).toBe(
      4,
    );
  });

  it("single mode: reports found=false with a null record when absent", async () => {
    vi.mocked(cacheGet).mockResolvedValueOnce(null);
    const result = await handleDomainStats({ hostname: "missing.example.com" });
    expect(result.content[0].text).toContain("No domain-db record");
    expect(result.structuredContent).toMatchObject({
      mode: "single",
      found: false,
      record: null,
      aggregate: null,
    });
  });

  it("aggregate mode: scans the domain-db and returns an aggregate", async () => {
    const scan = vi
      .fn()
      .mockResolvedValueOnce([
        "0",
        ["domain:good.com", "domain:raw.githubusercontent.com"],
      ]);
    const mget = vi
      .fn()
      .mockResolvedValueOnce([
        JSON.stringify(mkRecord("good.com", { tier2: stat(10, 9, 1) })),
        JSON.stringify(
          mkRecord("raw.githubusercontent.com", { github: stat(28, 0, 28) }),
        ),
      ]);
    vi.mocked(getValkey).mockResolvedValueOnce({
      scan,
      mget,
    } as unknown as NonNullable<Awaited<ReturnType<typeof getValkey>>>);

    const result = await handleDomainStats({});
    expect(result.content[0].text).toContain("domains tracked: 2");
    expect(result.structuredContent).toMatchObject({
      mode: "aggregate",
      hostname: null,
      found: true,
      record: null,
    });
    expect(result.structuredContent.aggregate?.domains_tracked).toBe(2);
    expect(result.structuredContent.aggregate?.truncated).toBe(false);
    expect(
      result.structuredContent.aggregate?.top_failing.map((f) => f.domain),
    ).toContain("raw.githubusercontent.com");
  });

  it("aggregate mode: found=false when the domain-db is empty", async () => {
    const scan = vi.fn().mockResolvedValueOnce(["0", []]);
    vi.mocked(getValkey).mockResolvedValueOnce({
      scan,
      mget: vi.fn(),
    } as unknown as NonNullable<Awaited<ReturnType<typeof getValkey>>>);
    const result = await handleDomainStats({});
    expect(result.structuredContent).toMatchObject({
      mode: "aggregate",
      found: false,
    });
    expect(result.structuredContent.aggregate?.domains_tracked).toBe(0);
  });
});

// ── Result and meta rendering: the optional-field branches ───────────────────
//
// formatResults and formatMeta are internal, so these go through handleSearch.
// Every branch below is an OPTIONAL field on a SearXNG response — engine name,
// published date, snippet, infobox title, answer URL — and each one is absent
// on some real engine's output. The failure they guard against is a literal
// "undefined" appearing in text an agent reads as fact.
describe("handleSearch — result rendering with fields absent", () => {
  it("keeps engines out of the text and in structuredContent", async () => {
    vi.mocked(searxSearch).mockResolvedValueOnce({
      results: [
        {
          title: "A",
          url: "https://e/a",
          content: "c",
          engines: ["brave", "google"],
        },
        { title: "B", url: "https://e/b", content: "c", engine: "duckduckgo" },
        { title: "C", url: "https://e/c", content: "c" },
      ],
      meta: EMPTY_META,
    });
    const r = await handleSearch({ query: "q", max_results: 5 });
    expect(r.content[0].text).not.toContain("Source:");
    expect(r.structuredContent.results.map((x) => x.engines)).toEqual([
      ["brave", "google"],
      ["duckduckgo"],
      [],
    ]);
  });

  it("omits the date and snippet segments entirely when those fields are absent", async () => {
    vi.mocked(searxSearch).mockResolvedValueOnce({
      results: [
        {
          title: "Dated",
          url: "https://e/a",
          content: "snip",
          publishedDate: "2026-01-02",
        },
        { title: "Bare", url: "https://e/b" },
      ],
      meta: EMPTY_META,
    });
    const text = (await handleSearch({ query: "q", max_results: 5 })).content[0]
      .text;
    expect(text).toContain("1. Dated (2026-01-02)");
    // No empty parens and no dangling indent for the result with neither.
    expect(text).toContain("2. Bare\n   https://e/b");
    expect(text.trimEnd().endsWith("https://e/b")).toBe(true);
    expect(text).not.toContain("()");
    expect(text).not.toContain("undefined");
  });

  it("truncates a long snippet to 250 characters", async () => {
    vi.mocked(searxSearch).mockResolvedValueOnce({
      results: [{ title: "T", url: "https://e/a", content: "x".repeat(400) }],
      meta: EMPTY_META,
    });
    const text = (await handleSearch({ query: "q", max_results: 5 })).content[0]
      .text;
    expect(text).toContain("x".repeat(250));
    expect(text).not.toContain("x".repeat(251));
  });
});

describe("handleSearch — meta block rendering", () => {
  const oneResult = [
    { title: "R", url: "https://e/r", content: "c", engines: ["brave"] },
  ];

  it("pluralises the answer heading and includes the URL only when present", async () => {
    vi.mocked(searxSearch).mockResolvedValueOnce({
      results: oneResult,
      meta: {
        answers: [
          { answer: "first", url: "https://ref/1" },
          { answer: "second" },
        ],
        infoboxes: [],
        corrections: [],
        suggestions: [],
      },
    });
    const text = (await handleSearch({ query: "q", max_results: 5 })).content[0]
      .text;
    expect(text).toContain("Direct answers:");
    expect(text).toContain("• first (https://ref/1)");
    expect(text).toContain("• second");
    expect(text).not.toContain("second (");
  });

  it("uses the singular heading for exactly one answer", async () => {
    vi.mocked(searxSearch).mockResolvedValueOnce({
      results: oneResult,
      meta: {
        answers: [{ answer: "only" }],
        infoboxes: [],
        corrections: [],
        suggestions: [],
      },
    });
    const text = (await handleSearch({ query: "q", max_results: 5 })).content[0]
      .text;
    expect(text).toContain("Direct answer:");
    expect(text).not.toContain("Direct answers:");
  });

  it("renders an infobox with and without its optional title and url", async () => {
    vi.mocked(searxSearch).mockResolvedValueOnce({
      results: oneResult,
      meta: {
        answers: [],
        infoboxes: [
          { title: "Debian", content: "an OS", url: "https://debian.org" },
          { content: "no title, no url" },
        ],
        corrections: [],
        suggestions: [],
      },
    });
    const text = (await handleSearch({ query: "q", max_results: 5 })).content[0]
      .text;
    expect(text).toContain("Debian: an OS (https://debian.org)");
    expect(text).toContain("no title, no url");
    expect(text).not.toContain("undefined");
    expect(text).not.toMatch(/^\s+: /m);
  });

  it("renders corrections and suggestions as their own blocks", async () => {
    vi.mocked(searxSearch).mockResolvedValueOnce({
      results: oneResult,
      meta: {
        answers: [],
        infoboxes: [],
        corrections: ["debian", "trixie"],
        suggestions: ["debian 13", "debian release"],
      },
    });
    const text = (await handleSearch({ query: "q", max_results: 5 })).content[0]
      .text;
    expect(text).toContain("Did you mean: debian, trixie");
    expect(text).toContain("Related searches: debian 13, debian release");
  });

  it("adds no separator at all when there is no meta to surface", async () => {
    vi.mocked(searxSearch).mockResolvedValueOnce({
      results: oneResult,
      meta: EMPTY_META,
    });
    const text = (await handleSearch({ query: "q", max_results: 5 })).content[0]
      .text;
    // No meta block, so the text starts with result 1.
    expect(text.startsWith("1. R")).toBe(true);
  });

  it("maps every meta field into structuredContent, nulling absent URLs", async () => {
    vi.mocked(searxSearch).mockResolvedValueOnce({
      results: [{ title: "R", url: "https://e/r" }],
      meta: {
        answers: [{ answer: "a1" }],
        infoboxes: [{ title: "T", content: "C" }],
        corrections: ["c1"],
        suggestions: ["s1"],
      },
    });
    const r = await handleSearch({ query: "q", max_results: 5 });
    // null rather than undefined: the SDK validates against SearchOutputSchema
    // before this leaves the server, and undefined would drop the key entirely.
    expect(r.structuredContent).toEqual({
      queries: ["q"],
      answer: null,
      answer_unavailable: null,
      answers: [{ answer: "a1", url: null }],
      infoboxes: [{ title: "T", content: "C", url: null }],
      corrections: ["c1"],
      suggestions: ["s1"],
      results: [
        {
          title: "R",
          url: "https://e/r",
          content: null,
          published: null,
          relevance: null,
          engines: [],
          query_index: 0,
          highlights: [],
        },
      ],
    });
  });
});

describe("handleSearch — several phrasings", () => {
  it("runs each phrasing, sections the output and drops repeated URLs", async () => {
    vi.mocked(searxSearch)
      .mockResolvedValueOnce({
        results: [
          { title: "A", url: "https://e/a" },
          { title: "B", url: "https://e/b" },
        ],
        meta: { ...EMPTY_META, suggestions: ["s"] },
      })
      .mockResolvedValueOnce({
        results: [
          { title: "B again", url: "https://e/b" },
          { title: "C", url: "https://e/c" },
        ],
        meta: { ...EMPTY_META, suggestions: ["s", "t"] },
      });
    const r = await handleSearch({ query: ["one", "two"], max_results: 5 });
    expect(searxSearch).toHaveBeenCalledTimes(2);
    const text = r.content[0].text;
    expect(text).toContain("## one\n\n1. A");
    expect(text).toContain("## two\n\n3. C");
    expect(text).not.toContain("B again");
    expect(r.structuredContent.queries).toEqual(["one", "two"]);
    expect(r.structuredContent.results.map((x) => x.query_index)).toEqual([
      0, 0, 1,
    ]);
    expect(r.structuredContent.suggestions).toEqual(["s", "t"]);
  });

  it("shows relevance when the reranker scored a result", async () => {
    vi.mocked(searxSearch).mockResolvedValueOnce({
      results: [{ title: "Scored", url: "https://e/s", relevance: 0.987 }],
      meta: EMPTY_META,
    });
    const r = await handleSearch({ query: "q", max_results: 5 });
    expect(r.content[0].text).toContain("1. Scored (rel 0.99)");
    expect(r.structuredContent.results[0].relevance).toBe(0.987);
  });

  it("appends the top pages' text for content: full", async () => {
    const r = await handleSearch({
      query: "q",
      max_results: 5,
      content: "full",
    });
    // The default mock returns two results, both under the 3-page cap.
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(r.content[0].text).toContain("=== 1/2 ===\nTitle: Fetched Page");
  });

  it("rejects an empty query", async () => {
    await expect(
      handleSearch({ query: ["  "], max_results: 5 }),
    ).rejects.toThrow("query must not be empty");
  });
});

describe("mergeHits", () => {
  it("keeps each URL under the first phrasing that found it", () => {
    const a = { title: "a", url: "u1" };
    const b = { title: "b", url: "u2" };
    expect(mergeHits([[a], [a, b]])).toEqual([
      { result: a, queryIndex: 0 },
      { result: b, queryIndex: 1 },
    ]);
  });
});

describe("handleSearch — answer", () => {
  it("leads with a cited synthesis and returns it in structuredContent", async () => {
    vi.mocked(summarizePages).mockResolvedValueOnce({
      summary: "Tokio's select! drops the losing branches [1].",
      citations: [
        { url: "https://example.com/1", title: "Result 1", key_facts: ["f"] },
      ],
    });
    const r = await handleSearch({ query: "q", max_results: 5, answer: true });
    const text = r.content[0].text;
    expect(text.startsWith("## Summary\n\nTokio's select!")).toBe(true);
    expect(text).toContain("## Sources");
    expect(text).toContain("1. Result 1");
    expect(r.structuredContent.answer?.citations[0].url).toBe(
      "https://example.com/1",
    );
    expect(r.structuredContent.answer_unavailable).toBeNull();
    // The pages went to the LLM trimmed to the per-page answer budget.
    const [question, pages] = vi.mocked(summarizePages).mock.calls[0];
    expect(question).toBe("q");
    expect(pages).toHaveLength(2);
  });

  it("leads with the marker and carries the pages when synthesis fails", async () => {
    const r = await handleSearch({ query: "q", max_results: 5, answer: true });
    const text = r.content[0].text;
    expect(text.startsWith("--- summarization unavailable (timeout")).toBe(
      true,
    );
    expect(text).toContain("=== 1/2 ===\nTitle: Fetched Page");
    expect(r.structuredContent.answer).toBeNull();
    expect(r.structuredContent.answer_unavailable).toBe(
      "timeout: aborted due to timeout",
    );
  });

  it("does not fetch pages for results the reranker scored off-topic", async () => {
    vi.mocked(searxSearch).mockResolvedValueOnce({
      results: [
        { title: "On", url: "https://e/on", relevance: 0.9 },
        { title: "Off", url: "https://e/off", relevance: 0.001 },
      ],
      meta: EMPTY_META,
    });
    await handleSearch({ query: "q", max_results: 5, answer: true });
    expect(vi.mocked(fetchPage).mock.calls.map((c) => c[0])).toEqual([
      "https://e/on",
    ]);
  });
});

describe("handleSearch — highlights", () => {
  it("replaces the snippet with the page's most relevant passages", async () => {
    // Each paragraph longer than half a chunk, so they cannot pack together.
    vi.mocked(fetchPage).mockResolvedValueOnce({
      title: "T",
      url: "https://example.com/1",
      text: [
        "Nothing about the subject here, just filler prose. ".repeat(8),
        "Cancellation safety of select branches is the point here. ".repeat(8),
      ].join("\n\n"),
    });
    const r = await handleSearch({
      query: "select cancellation safety",
      max_results: 1,
      content: "highlights",
    });
    const text = r.content[0].text;
    expect(text).toContain("> Cancellation safety of select branches");
    expect(text).not.toContain("Some content");
    expect(r.structuredContent.results[0].highlights[0].text).toContain(
      "Cancellation safety",
    );
    expect(scorePassages).toHaveBeenCalled();
  });
});

describe("handleSearch — domains and freshness", () => {
  it("enforces include_domains and exclude_domains after the search", async () => {
    vi.mocked(searxSearch).mockResolvedValueOnce({
      results: [
        { title: "GH", url: "https://github.com/a/b" },
        { title: "GH docs", url: "https://docs.github.com/x" },
        { title: "Other", url: "https://other.org/x" },
      ],
      meta: EMPTY_META,
    });
    const r = await handleSearch({
      query: "q",
      max_results: 5,
      include_domains: ["github.com"],
      exclude_domains: "docs.github.com",
    });
    expect(r.structuredContent.results.map((x) => x.title)).toEqual(["GH"]);
    // Also sent to SearXNG as the site: operator.
    expect(vi.mocked(searxSearch).mock.calls[0][8]).toEqual(["github.com"]);
  });

  it("passes fresh through to the search and page caches", async () => {
    await handleSearch({
      query: "q",
      max_results: 5,
      content: "full",
      fresh: true,
    });
    expect(vi.mocked(searxSearch).mock.calls[0][9]).toBe(true);
    expect(vi.mocked(fetchPage).mock.calls[0][5]).toBe(true);
  });
});

describe("handleFetchUrl — query", () => {
  it("returns the passages most relevant to the question, saying how they were ranked", async () => {
    vi.mocked(fetchPage).mockResolvedValueOnce({
      title: "T",
      url: "https://e/q",
      text: [
        "An introduction that talks about something else entirely. ".repeat(8),
        "The Mutex lock method is not cancellation safe; it queues. ".repeat(8),
      ].join("\n\n"),
    });
    const text = (
      await handleFetchUrl({
        url: "https://e/q",
        query: "is mutex lock cancellation safe",
      })
    ).content[0].text;
    expect(text).toContain("ranked by term overlap — reranker unavailable");
    expect(text.indexOf("Mutex lock")).toBeLessThan(
      text.indexOf("introduction"),
    );
  });
});
