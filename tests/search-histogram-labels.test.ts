/**
 * Labels on the `search` histogram, and latency on the failure path.
 *
 * `search` is the only tool that records into this histogram (the former
 * `search_and_fetch` / `search_and_summarize` tools were folded into
 * `search`'s `content: "full"`). The `tool` label is kept so the series stays
 * attributable if another search-shaped tool is ever added.
 *
 * The failure path used to record no duration at all, only `errors_total`, so a
 * search that failed after 40s looked exactly like one that failed instantly.
 *
 * NOT covered here, deliberately: a *hang*. Both recordings happen after
 * `await fn()` settles, so a call that never returns still records nothing.
 * That is a real remaining gap and needs a watchdog, not a label.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/cache.js", () => ({
  cacheClear: vi.fn().mockResolvedValue(0),
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheAtomicUpdate: vi.fn().mockResolvedValue(undefined),
  getValkey: vi.fn().mockResolvedValue(null),
  searchCacheKey: vi.fn().mockReturnValue("key"),
}));

vi.mock("../src/search.js", () => ({
  searxSearch: vi.fn().mockResolvedValue({
    results: [
      {
        title: "R1",
        url: "https://example.com/1",
        content: "c",
        engines: ["google"],
      },
    ],
    meta: { answers: [], infoboxes: [], corrections: [], suggestions: [] },
  }),
}));

vi.mock("../src/reranker.js", () => ({
  rerankWithFallback: vi
    .fn()
    .mockImplementation((_q, results) => Promise.resolve(results)),
}));

vi.mock("../src/fetch.js", () => ({
  FETCH_STORE_CEILING: 1_000_000,
  fetchPage: vi.fn().mockResolvedValue({
    title: "P",
    url: "https://example.com/1",
    text: "text",
  }),
}));

vi.mock("../src/observability.js", () => ({
  incCounter: vi.fn(),
  recordHistogram: vi.fn(),
  withSpan: vi.fn().mockImplementation((_n, _a, fn) => fn()),
}));

vi.mock("../src/context.js", () => ({
  newRequestId: vi.fn().mockReturnValue("req"),
  withRequestId: vi.fn().mockImplementation((_id, fn) => fn()),
}));

import { incCounter, recordHistogram } from "../src/observability.js";
import { searxSearch } from "../src/search.js";
import { handleSearch } from "../src/tools.js";

beforeEach(() => {
  vi.clearAllMocks();
});

/** The single `recordHistogram("search", ...)` call, or a clear failure. */
function soleSearchHistogram() {
  const calls = vi
    .mocked(recordHistogram)
    .mock.calls.filter((c) => c[0] === "search");
  expect(calls).toHaveLength(1);
  return { seconds: calls[0][1], attrs: calls[0][2] };
}

describe("search histogram — tool label", () => {
  // `content: "full"` adds page fetches to the same call; it must not change the
  // label or record a second sample.
  const cases = [
    ["plain", () => handleSearch({ query: "q", max_results: 3 })],
    [
      "content=full",
      () => handleSearch({ query: "q", max_results: 3, content: "full" }),
    ],
  ] as const;

  for (const [variant, invoke] of cases) {
    it(`records the histogram labelled tool=search (${variant})`, async () => {
      await invoke();
      expect(soleSearchHistogram().attrs).toMatchObject({
        tool: "search",
        outcome: "ok",
      });
    });

    it(`records the counter labelled tool=search (${variant})`, async () => {
      await invoke();
      const calls = vi
        .mocked(incCounter)
        .mock.calls.filter((c) => c[0] === "search");
      expect(calls).toHaveLength(1);
      expect(calls[0][1]).toMatchObject({ tool: "search" });
    });
  }
});

describe("search histogram — failure path", () => {
  it("records a duration when the search throws, not just an error count", async () => {
    vi.mocked(searxSearch).mockRejectedValueOnce(new Error("searxng down"));

    // Pin the clock so the assertion is on a REAL elapsed value. Asserting
    // `any(Number)` would pass against a hardcoded zero, which is the exact
    // failure this phase is meant to make visible.
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(41_000);

    await expect(handleSearch({ query: "q", max_results: 3 })).rejects.toThrow(
      "searxng down",
    );
    now.mockRestore();

    const { seconds, attrs } = soleSearchHistogram();
    expect(seconds).toBe(40);
    expect(attrs).toMatchObject({ tool: "search", outcome: "error" });
  });

  it("labels the error counter with the tool", async () => {
    vi.mocked(searxSearch).mockRejectedValueOnce(new Error("boom"));
    await expect(handleSearch({ query: "q", max_results: 3 })).rejects.toThrow(
      "boom",
    );

    const errCalls = vi
      .mocked(incCounter)
      .mock.calls.filter((c) => c[0] === "errors");
    expect(errCalls).toHaveLength(1);
    expect(errCalls[0][1]).toMatchObject({
      tool: "search",
      stage: "search",
    });
  });

  it("separates ok from error via outcome rather than merging the two", async () => {
    // Without `outcome`, error latencies would land in the same series as
    // successes and skew the p99 the histogram exists to report.
    await handleSearch({ query: "q", max_results: 3 });
    const ok = soleSearchHistogram().attrs?.outcome;

    vi.clearAllMocks();
    vi.mocked(searxSearch).mockRejectedValueOnce(new Error("x"));
    await expect(
      handleSearch({ query: "q", max_results: 3 }),
    ).rejects.toThrow();
    const err = soleSearchHistogram().attrs?.outcome;

    expect(ok).toBe("ok");
    expect(err).toBe("error");
  });
});
