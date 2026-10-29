// Verifies the content-type fast path: a URL serving structured data must be
// routed to tier3 rawFetch and must never reach the browser tiers, while an
// HTML URL — or a host the probe can't read — must run the cascade unchanged.
//
// Modelled on fetch-github-routing.test.ts; the mock surface is the same.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/core/config.js", () => ({
  FETCH_CACHE_TTL_SECONDS: 86400,
  // These suites exercise the browser-first order; raw-first has its own.
  FETCH_RAW_FIRST: false,
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

// vi.mock factories are hoisted above module-scope consts, so the tier stubs
// have to be created inside vi.hoisted or the factory hits them in the TDZ.
const tiers = vi.hoisted(() => ({
  tier2Fetch: vi.fn(),
  tier3Fetch: vi.fn(),
}));
const { tier2Fetch, tier3Fetch } = tiers;

vi.mock("../../src/fetch/routing.js", () => ({
  getTiers: vi.fn().mockResolvedValue({
    active: [
      { name: "tier2_crawl4ai", slot: "tier2", fetch: tiers.tier2Fetch },
      { name: "tier3_rawfetch", slot: "tier3", fetch: tiers.tier3Fetch },
    ],
    skipped: [],
  }),
  TIER_NAME: {},
}));

vi.mock("../../src/fetch/tiers/index.js", () => ({
  fetchRawHtmlForMetadata: vi.fn().mockResolvedValue(null),
  githubFetch: vi.fn(),
  isGithubFastPathUrl: () => false,
  rawFetch: vi.fn(),
  tier2: { name: "tier2_crawl4ai", slot: "tier2", fetch: vi.fn() },
  waybackFetch: vi.fn().mockResolvedValue(null),
}));

import { recordTierAttempt } from "../../src/domains/db.js";
import { probeContentKind } from "../../src/fetch/content-type.js";
import { fetchPage } from "../../src/fetch/fetch-page.js";
import { rawFetch } from "../../src/fetch/tiers/index.js";

const probeMock = vi.mocked(probeContentKind);
const rawFetchMock = vi.mocked(rawFetch);
const recordTierAttemptMock = vi.mocked(recordTierAttempt);

beforeEach(() => {
  vi.clearAllMocks();
  probeMock.mockResolvedValue(null);
  tier2Fetch.mockResolvedValue({ title: "t2", url: "u", text: "html body" });
  tier3Fetch.mockResolvedValue(null);
});

afterEach(() => vi.restoreAllMocks());

describe("fetchPage — content-type fast path", () => {
  it("routes a JSON endpoint to tier3 rawFetch and never invokes the browser tier", async () => {
    // The live failure this replaces: registry.npmjs.org served JSON to a
    // rendering tier, which returned empty markdown and was booked as an
    // `empty_result` miss against that tier.
    probeMock.mockResolvedValue("json");
    rawFetchMock.mockResolvedValue({
      title: "https://registry.npmjs.org/express",
      url: "https://registry.npmjs.org/express",
      text: '```json\n{\n  "name": "express"\n}\n```',
    });

    const result = await fetchPage("https://registry.npmjs.org/express");

    expect(rawFetchMock).toHaveBeenCalledOnce();
    expect(tier2Fetch).not.toHaveBeenCalled();
    expect(tier3Fetch).not.toHaveBeenCalled();
    expect(result.text).toContain('"name": "express"');
  });

  it("books the fast path as a tier3 attempt, not tier2", async () => {
    // Accounting matters as much as the routing: this is what stops the
    // domain-db recording JSON hosts as browser-tier failures.
    probeMock.mockResolvedValue("json");
    rawFetchMock.mockResolvedValue({
      title: "u",
      url: "https://api.osv.dev/v1/vulns/GHSA-x",
      text: "{}",
    });

    await fetchPage("https://api.osv.dev/v1/vulns/GHSA-x");

    expect(recordTierAttemptMock).toHaveBeenCalledWith(
      "https://api.osv.dev/v1/vulns/GHSA-x",
      "tier3_rawfetch",
      "hit",
    );
    expect(
      recordTierAttemptMock.mock.calls.some(
        (call) => call[1] === "tier2_crawl4ai",
      ),
    ).toBe(false);
  });

  it("runs the normal cascade when the probe finds HTML", async () => {
    probeMock.mockResolvedValue(null);
    await fetchPage("https://example.com/page");
    expect(rawFetchMock).not.toHaveBeenCalled();
    expect(tier2Fetch).toHaveBeenCalledOnce();
  });

  it("falls through to the cascade when the fast path's raw fetch fails", async () => {
    // A probe must not be able to convert a fetchable URL into a hard failure:
    // if rawFetch throws, the browser tiers still get their turn.
    probeMock.mockResolvedValue("json");
    rawFetchMock.mockRejectedValue(new Error("connection reset"));

    const result = await fetchPage("https://api.codetabs.com/v1/proxy");

    expect(rawFetchMock).toHaveBeenCalledOnce();
    expect(tier2Fetch).toHaveBeenCalledOnce();
    expect(result.text).toBe("html body"); // tier2's body — the cascade served it
  });

  it("routes every structured kind, not just JSON", async () => {
    for (const kind of ["xml", "yaml", "csv", "text", "toml"] as const) {
      vi.clearAllMocks();
      probeMock.mockResolvedValue(kind);
      rawFetchMock.mockResolvedValue({ title: "u", url: "u", text: "body" });
      await fetchPage(`https://example.com/data.${kind}`);
      expect(
        rawFetchMock,
        `${kind} should take the fast path`,
      ).toHaveBeenCalledOnce();
      expect(tier2Fetch, `${kind} should skip tier2`).not.toHaveBeenCalled();
    }
  });
});
