import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/core/config.js", () => ({
  FETCH_CACHE_TTL_SECONDS: 86400,
  FETCH_RAW_FIRST: true,
  PDF_EXTRACT_ENABLED: true,
  PDF_MAX_BYTES: 20 * 1024 * 1024,
  PDF_MAX_PAGES: 50,
  WAYBACK_ENABLED: false,
  YOUTUBE_TRANSCRIPT_ENABLED: false,
  YOUTUBE_IGNORE_ROBOTS: false,
  REDDIT_FASTPATH_ENABLED: false,
  REDDIT_IGNORE_ROBOTS: false,
}));

vi.mock("node:dns/promises", () => ({
  lookup: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
}));

vi.mock("../../src/core/cache.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  fetchCacheKey: (url: string) => `fetch:${url}`,
}));

vi.mock("../../src/domains/rules.js", () => ({
  getBlockList: vi.fn(() => []),
  urlMatchesDomain: vi.fn(() => false),
}));

vi.mock("../../src/domains/db.js", () => ({
  recordTierAttempt: vi.fn().mockResolvedValue(undefined),
  recordPostExtractSample: vi.fn().mockResolvedValue(undefined),
  recordMetadataFetchAttempt: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/core/events.js", () => ({
  events: {
    fetchRequested: vi.fn(),
    fetchCompleted: vi.fn(),
    fetchTierMiss: vi.fn(),
    fetchTierSkipped: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../../src/core/observability.js", () => ({
  incCounter: vi.fn(),
  recordHistogram: vi.fn(),
  withSpan: (_name: string, _attrs: unknown, fn: () => unknown) => fn(),
}));

vi.mock("../../src/fetch/robots.js", () => ({
  checkRobots: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("../../src/fetch/fastpaths/hister.js", () => ({
  // histerConfigured returns TRUE so these tests keep exercising the same path
  // they did before the call-site guard was added: the guard passes, histerFetch
  // is called, and it misses. Mocking it false would make the fast path vanish
  // from every test in this file rather than miss in it.
  histerConfigured: vi.fn().mockReturnValue(true),
  histerFetch: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../src/fetch/fastpaths/kiwix.js", () => ({
  isKiwixHost: vi.fn(() => false),
  kiwixFetch: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../src/fetch/fastpaths/llms-txt.js", () => ({
  // isLlmsTxtDomain returns TRUE so these tests keep exercising the same path
  // they did before the call-site guard was added: the guard passes,
  // tryLlmsTxtFetch is called, and it misses. Mocking it false would make the
  // fast path vanish from every test in this file rather than miss in it, which
  // is a quieter kind of green.
  isLlmsTxtDomain: vi.fn().mockReturnValue(true),
  tryLlmsTxtFetch: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../src/fetch/content-type.js", () => ({
  probeContentKind: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../src/fetch/extractors/post-extract.js", () => ({
  postExtract: vi.fn(() => ({
    title: "t",
    text: "x",
    source: "baseline",
    jsonLdPresent: false,
  })),
}));

const tiers = vi.hoisted(() => ({
  tier2Fetch: vi.fn(),
  tier3Fetch: vi.fn(),
  getTiers: vi.fn(),
}));

vi.mock("../../src/fetch/routing.js", () => ({
  getTiers: tiers.getTiers,
  // The real map. A stubbed-empty TIER_NAME would render every skipped tier as
  // `undefined:` and the assertions below would pass on a blank name.
  TIER_NAME: {
    tier2: "tier2_crawl4ai",
    tier3: "tier3_rawfetch",
  },
}));

vi.mock("../../src/fetch/tiers/index.js", () => ({
  fetchRawHtmlForMetadata: vi.fn().mockResolvedValue(null),
  githubFetch: vi.fn(),
  isGithubFastPathUrl: () => false,
  rawFetch: vi.fn(),
  tier2: { name: "tier2_crawl4ai", slot: "tier2", fetch: vi.fn() },
  waybackFetch: vi.fn().mockResolvedValue(null),
}));

import { fetchPage, orderTiers } from "../../src/fetch/fetch-page.js";
import type { Tier } from "../../src/fetch/tiers/index.js";

// Raw HTTP before the headless browser. Measured on twelve documentation
// pages, raw found the answer on all twelve at a fraction of the browser's
// latency; the browser tier is kept for pages raw cannot render, which show
// up here as a "thin" raw result.

const URL_ = "https://example.com/page";
const FULL = "Real documentation prose. ".repeat(100); // ~2,600 chars
const THIN = "Loading… enable JavaScript.";

const page = (text: string) => ({ title: "T", url: URL_, text });

beforeEach(() => {
  vi.clearAllMocks();
  // Cascade order as routing returns it: tier2 first.
  tiers.getTiers.mockResolvedValue({
    active: [
      { name: "tier2_crawl4ai", slot: "tier2", fetch: tiers.tier2Fetch },
      { name: "tier3_rawfetch", slot: "tier3", fetch: tiers.tier3Fetch },
    ],
    skipped: [],
  });
});

afterEach(() => vi.restoreAllMocks());

describe("fetchPage — raw first", () => {
  it("serves a substantial raw result without launching the browser", async () => {
    tiers.tier3Fetch.mockResolvedValue(page(FULL));
    const r = await fetchPage(URL_);
    expect(tiers.tier3Fetch).toHaveBeenCalledTimes(1);
    expect(tiers.tier2Fetch).not.toHaveBeenCalled();
    expect(r.text.startsWith("Real documentation prose.")).toBe(true);
  });

  it("falls through to the browser when raw comes back thin", async () => {
    tiers.tier3Fetch.mockResolvedValue(page(THIN));
    tiers.tier2Fetch.mockResolvedValue(page(FULL));
    const r = await fetchPage(URL_);
    expect(tiers.tier2Fetch).toHaveBeenCalledTimes(1);
    expect(r.text.startsWith("Real documentation prose.")).toBe(true);
  });

  it("keeps the thin raw result when the browser tier fails too", async () => {
    tiers.tier3Fetch.mockResolvedValue(page(THIN));
    tiers.tier2Fetch.mockResolvedValue(null);
    const r = await fetchPage(URL_);
    expect(r.text).toBe(THIN);
  });

  it("falls through to the browser when raw misses outright", async () => {
    tiers.tier3Fetch.mockResolvedValue(null);
    tiers.tier2Fetch.mockResolvedValue(page(FULL));
    await fetchPage(URL_);
    expect(tiers.tier2Fetch).toHaveBeenCalledTimes(1);
  });

  it("goes browser-first when the caller waits for a selector", async () => {
    tiers.tier2Fetch.mockResolvedValue(page(FULL));
    await fetchPage(URL_, 8000, undefined, false, {
      waitForSelector: ".loaded",
    });
    expect(tiers.tier2Fetch).toHaveBeenCalledTimes(1);
    expect(tiers.tier3Fetch).not.toHaveBeenCalled();
  });

  it("accepts a thin raw result when raw is the only tier", async () => {
    tiers.getTiers.mockResolvedValue({
      active: [
        { name: "tier3_rawfetch", slot: "tier3", fetch: tiers.tier3Fetch },
      ],
      skipped: [{ tier: "tier2", reason: "not_configured" }],
    });
    tiers.tier3Fetch.mockResolvedValue(page(THIN));
    expect((await fetchPage(URL_)).text).toBe(THIN);
  });
});

describe("orderTiers", () => {
  const t2 = { slot: "tier2" } as Tier;
  const t3 = { slot: "tier3" } as Tier;
  it("puts tier3 first and keeps the rest in order", () => {
    expect(orderTiers([t2, t3])).toEqual([t3, t2]);
  });
  it("leaves the order alone for wait_for_selector", () => {
    expect(orderTiers([t2, t3], { waitForSelector: "#x" })).toEqual([t2, t3]);
  });
});
