// Regression guard for vikunja#682: a PDF URL must take the ordinary cascade,
// in tier order, rather than being diverted by URL shape.
//
// The bug this replaced was a fast path in fetchPage that matched `.pdf` on the
// pathname and dispatched straight to tier 2. The tier that path skipped
// (Firecrawl v2, which parsed PDFs natively) has since been removed in this
// fork, but the routing rule it established still holds: there is no PDF fast
// path, so a PDF is offered to each active tier in order and falls through on a
// miss, and the extensionless PDFs a suffix matcher could never see route the
// same way.
//
// These cases prove the *routing*. They cannot prove PDFs work end-to-end — the
// tiers are stubs here, and no tier in this build extracts PDF text (see the
// message in tiers/raw.ts).
//
// Mock surface copied from fetch-content-type-routing.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", () => ({
  FETCH_CACHE_TTL_SECONDS: 86400,
  WAYBACK_ENABLED: false,
  YOUTUBE_TRANSCRIPT_ENABLED: false,
  YOUTUBE_IGNORE_ROBOTS: false,
  REDDIT_FASTPATH_ENABLED: false,
  REDDIT_IGNORE_ROBOTS: false,
}));

vi.mock("node:dns/promises", () => ({
  lookup: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
}));

vi.mock("../src/cache.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  fetchCacheKey: (url: string) => `fetch:${url}`,
}));

vi.mock("../src/domains.js", () => ({
  getBlockList: vi.fn(() => []),
  urlMatchesDomain: vi.fn(() => false),
}));

vi.mock("../src/domain-db.js", () => ({
  recordTierAttempt: vi.fn().mockResolvedValue(undefined),
  recordPostExtractSample: vi.fn().mockResolvedValue(undefined),
  recordMetadataFetchAttempt: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/events.js", () => ({
  events: {
    fetchRequested: vi.fn(),
    fetchCompleted: vi.fn(),
    fetchTierMiss: vi.fn(),
    fetchTierSkipped: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../src/observability.js", () => ({
  incCounter: vi.fn(),
  recordHistogram: vi.fn(),
  withSpan: (_name: string, _attrs: unknown, fn: () => unknown) => fn(),
}));

vi.mock("../src/robots.js", () => ({
  checkRobots: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("../src/hister.js", () => ({
  // histerConfigured returns TRUE so these tests keep exercising the same path
  // they did before the call-site guard was added: the guard passes, histerFetch
  // is called, and it misses. Mocking it false would make the fast path vanish
  // from every test in this file rather than miss in it.
  histerConfigured: vi.fn().mockReturnValue(true),
  histerFetch: vi.fn().mockResolvedValue(null),
}));

vi.mock("../src/kiwix.js", () => ({
  isKiwixHost: vi.fn(() => false),
  kiwixFetch: vi.fn().mockResolvedValue(null),
}));

vi.mock("../src/llms-txt.js", () => ({
  // isLlmsTxtDomain returns TRUE so these tests keep exercising the same path
  // they did before the call-site guard was added: the guard passes,
  // tryLlmsTxtFetch is called, and it misses. Mocking it false would make the
  // fast path vanish from every test in this file rather than miss in it, which
  // is a quieter kind of green.
  isLlmsTxtDomain: vi.fn().mockReturnValue(true),
  tryLlmsTxtFetch: vi.fn().mockResolvedValue(null),
}));

vi.mock("../src/content-type.js", () => ({
  probeStructuredContent: vi.fn().mockResolvedValue(null),
}));

vi.mock("../src/extractors/post-extract.js", () => ({
  postExtract: vi.fn(
    (_url: string, _html: unknown, base: { text: string }) => ({
      title: "t",
      text: base.text,
      source: "baseline",
      jsonLdPresent: false,
    }),
  ),
}));

const tiers = vi.hoisted(() => ({
  tier2Fetch: vi.fn(),
  tier3Fetch: vi.fn(),
}));

vi.mock("../src/routing.js", () => ({
  getTiers: vi.fn().mockResolvedValue({
    active: [
      { name: "tier2_crawl4ai", slot: "tier2", fetch: tiers.tier2Fetch },
      { name: "tier3_rawfetch", slot: "tier3", fetch: tiers.tier3Fetch },
    ],
    skipped: [],
  }),
  TIER_NAME: {},
}));

vi.mock("../src/tiers/index.js", () => ({
  fetchRawHtmlForMetadata: vi.fn().mockResolvedValue(null),
  githubFetch: vi.fn(),
  isGithubFastPathUrl: () => false,
  rawFetch: vi.fn(),
  tier2: { name: "tier2_crawl4ai", slot: "tier2", fetch: tiers.tier2Fetch },
  waybackFetch: vi.fn().mockResolvedValue(null),
}));

import { recordTierAttempt } from "../src/domain-db.js";
import { events } from "../src/events.js";
import { fetchPage } from "../src/fetch.js";

const { tier2Fetch, tier3Fetch } = tiers;
const fetchCompletedMock = vi.mocked(events.fetchCompleted);
const recordTierAttemptMock = vi.mocked(recordTierAttempt);

const PDF_URL = "https://www.rfc-editor.org/rfc/rfc9110.pdf";

beforeEach(() => {
  vi.clearAllMocks();
  tier2Fetch.mockResolvedValue({
    title: "RFC 9110",
    url: PDF_URL,
    text: "HTTP Semantics",
  });
  tier3Fetch.mockResolvedValue(null);
});

afterEach(() => vi.restoreAllMocks());

describe("fetchPage — PDF routing", () => {
  it("offers a .pdf URL to the first active tier, and serves its result", async () => {
    const result = await fetchPage(PDF_URL);

    expect(tier2Fetch).toHaveBeenCalledOnce();
    expect(result.text).toContain("HTTP Semantics");
    // The tier of record, not merely a tier that ran. A 200 from the wrong
    // tier is not a pass.
    expect(fetchCompletedMock).toHaveBeenCalledWith(
      expect.objectContaining({ tier_served: "tier2_crawl4ai" }),
    );
  });

  it("does not dispatch to a later tier once an earlier one serves it", async () => {
    await fetchPage(PDF_URL);

    expect(tier3Fetch).not.toHaveBeenCalled();
    expect(
      recordTierAttemptMock.mock.calls.some(
        (call) => call[1] === "tier3_rawfetch",
      ),
    ).toBe(false);
  });

  it("books the attempt against the tier that served it", async () => {
    await fetchPage(PDF_URL);

    expect(recordTierAttemptMock).toHaveBeenCalledWith(
      PDF_URL,
      "tier2_crawl4ai",
      "hit",
    );
  });

  it("falls through to tier3 when tier2 misses, rather than short-circuiting", async () => {
    // The cascade still applies to PDFs — there is no fast path pinning them
    // to any one tier.
    tier2Fetch.mockResolvedValue(null);
    tier3Fetch.mockResolvedValue({
      title: "RFC 9110",
      url: PDF_URL,
      text: "from tier three",
    });

    const result = await fetchPage(PDF_URL);

    expect(tier2Fetch).toHaveBeenCalledOnce();
    expect(tier3Fetch).toHaveBeenCalledOnce();
    expect(result.text).toContain("from tier three");
    expect(fetchCompletedMock).toHaveBeenCalledWith(
      expect.objectContaining({ tier_served: "tier3_rawfetch" }),
    );
  });

  it("routes an extensionless PDF the same way — a suffix matcher could not see these", async () => {
    // The old suffix matcher missed every PDF served without a .pdf path,
    // which is why keying on the URL was the wrong predicate.
    const url = "https://example.com/download?doc=9110";

    await fetchPage(url);

    expect(tier2Fetch).toHaveBeenCalledOnce();
    expect(fetchCompletedMock).toHaveBeenCalledWith(
      expect.objectContaining({ tier_served: "tier2_crawl4ai" }),
    );
  });
});
