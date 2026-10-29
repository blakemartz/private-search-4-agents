// Routing for the local PDF path (src/pdf.ts) in fetchPage.
//
// History: vikunja#682 replaced a `.pdf` suffix fast path that dispatched
// straight to tier 2, and for a while this build had no PDF reader at all —
// every PDF went down the cascade and tier 3 rejected it. The local path now
// sits ahead of the cascade, and these cases pin the routing rules it has to
// keep:
//
//   - a `.pdf` path is taken at its word (no HEAD probe);
//   - an extensionless PDF is found by the probe's Content-Type, which is the
//     case a suffix matcher could never see;
//   - anything else never touches the PDF path;
//   - every failure but "no text layer" falls through to the cascade;
//   - the kill switch restores the cascade;
//   - the SSRF guards still run before the PDF path fetches anything.
//
// Unlike the earlier version of this file, extraction here is REAL: the PDF
// path is not mocked, global fetch serves a hand-built fixture, and unpdf
// parses it. Only the network and the cascade's tiers are stubs.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const flags = vi.hoisted(() => ({
  enabled: true,
  maxBytes: 20 * 1024 * 1024,
  dnsAddress: "93.184.216.34",
}));

vi.mock("../src/config.js", () => ({
  FETCH_CACHE_TTL_SECONDS: 86400,
  get PDF_EXTRACT_ENABLED() {
    return flags.enabled;
  },
  get PDF_MAX_BYTES() {
    return flags.maxBytes;
  },
  PDF_MAX_PAGES: 50,
  WAYBACK_ENABLED: false,
  YOUTUBE_TRANSCRIPT_ENABLED: false,
  YOUTUBE_IGNORE_ROBOTS: false,
  REDDIT_FASTPATH_ENABLED: false,
  REDDIT_IGNORE_ROBOTS: false,
}));

vi.mock("node:dns/promises", () => ({
  lookup: () => Promise.resolve([{ address: flags.dnsAddress, family: 4 }]),
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
  histerConfigured: vi.fn().mockReturnValue(false),
  histerFetch: vi.fn().mockResolvedValue(null),
}));

vi.mock("../src/kiwix.js", () => ({
  isKiwixHost: vi.fn(() => false),
  kiwixFetch: vi.fn().mockResolvedValue(null),
}));

vi.mock("../src/llms-txt.js", () => ({
  isLlmsTxtDomain: vi.fn().mockReturnValue(false),
  tryLlmsTxtFetch: vi.fn().mockResolvedValue(null),
}));

vi.mock("../src/content-type.js", () => ({
  probeContentKind: vi.fn().mockResolvedValue(null),
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
  solverFetch: vi.fn().mockResolvedValue(null),
  waybackFetch: vi.fn().mockResolvedValue(null),
}));

import { cacheSet } from "../src/cache.js";
import { probeContentKind } from "../src/content-type.js";
import { recordTierAttempt } from "../src/domain-db.js";
import { events } from "../src/events.js";
import { fetchPage } from "../src/fetch.js";

const FIXTURES = join(__dirname, "fixtures", "pdf");
const HELLO_PDF = readFileSync(join(FIXTURES, "hello.pdf"));
const NO_TEXT_PDF = readFileSync(join(FIXTURES, "no-text.pdf"));

const { tier2Fetch, tier3Fetch } = tiers;
const probeMock = vi.mocked(probeContentKind);
const fetchCompletedMock = vi.mocked(events.fetchCompleted);
const recordTierAttemptMock = vi.mocked(recordTierAttempt);
const cacheSetMock = vi.mocked(cacheSet);

const PDF_URL = "https://example.com/papers/attention.pdf";
const EXTENSIONLESS_URL = "https://example.com/pdf/1706.03762";

function pdfResponse(bytes: Uint8Array, contentType = "application/pdf") {
  return new Response(bytes, {
    status: 200,
    headers: { "content-type": contentType },
  });
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  flags.enabled = true;
  flags.maxBytes = 20 * 1024 * 1024;
  flags.dnsAddress = "93.184.216.34";
  probeMock.mockResolvedValue(null);
  tier2Fetch.mockResolvedValue({
    title: "from cascade",
    url: PDF_URL,
    text: "cascade body",
  });
  tier3Fetch.mockResolvedValue(null);
  fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => pdfResponse(HELLO_PDF));
});

afterEach(() => vi.restoreAllMocks());

describe("fetchPage — local PDF path", () => {
  it("extracts a .pdf URL locally, without a probe and without the cascade", async () => {
    const result = await fetchPage(PDF_URL);

    expect(result.title).toBe("Fixture Title");
    expect(result.text).toContain("--- page 1 ---");
    expect(result.text).toContain("Hello from page one.");
    // Whitespace runs inside a line are collapsed.
    expect(result.text).toContain("Attention is all you need.");
    expect(result.text).toContain("--- page 2 ---\n\nSecond page text.");

    expect(probeMock).not.toHaveBeenCalled();
    expect(tier2Fetch).not.toHaveBeenCalled();
    expect(tier3Fetch).not.toHaveBeenCalled();
    expect(fetchCompletedMock).toHaveBeenCalledWith(
      expect.objectContaining({ tier_served: "pdf_local" }),
    );
    expect(recordTierAttemptMock).toHaveBeenCalledWith(
      PDF_URL,
      "pdf_local",
      "hit",
    );
  });

  it("caches the extracted text like the other fast paths", async () => {
    await fetchPage(PDF_URL);

    expect(cacheSetMock).toHaveBeenCalledOnce();
    const [key, payload, ttl] = cacheSetMock.mock.calls[0];
    expect(key).toBe(`fetch:${PDF_URL}`);
    expect(ttl).toBe(86400);
    expect(JSON.parse(payload as string)).toMatchObject({
      title: "Fixture Title",
      url: PDF_URL,
    });
  });

  it("finds an extensionless PDF by the probe's Content-Type", async () => {
    probeMock.mockResolvedValue("pdf");

    const result = await fetchPage(EXTENSIONLESS_URL);

    expect(probeMock).toHaveBeenCalledOnce();
    expect(result.text).toContain("Hello from page one.");
    expect(tier2Fetch).not.toHaveBeenCalled();
    expect(fetchCompletedMock).toHaveBeenCalledWith(
      expect.objectContaining({ tier_served: "pdf_local" }),
    );
  });

  it("leaves a non-PDF URL alone: the PDF path never fetches", async () => {
    const url = "https://example.com/article";

    const result = await fetchPage(url);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(tier2Fetch).toHaveBeenCalledOnce();
    expect(result.text).toBe("cascade body");
    expect(
      recordTierAttemptMock.mock.calls.some((c) => c[1] === "pdf_local"),
    ).toBe(false);
  });

  it("falls through to the cascade when a .pdf path serves HTML", async () => {
    fetchSpy.mockImplementation(async () =>
      pdfResponse(
        new TextEncoder().encode("<html><body>Sign in</body></html>"),
        "text/html",
      ),
    );

    const result = await fetchPage(PDF_URL);

    expect(result.text).toBe("cascade body");
    expect(recordTierAttemptMock).toHaveBeenCalledWith(
      PDF_URL,
      "pdf_local",
      "miss",
      "empty_result",
    );
  });

  it("rejects an oversize PDF and falls through rather than buffering it", async () => {
    flags.maxBytes = 100;

    const result = await fetchPage(PDF_URL);

    expect(result.text).toBe("cascade body");
    expect(recordTierAttemptMock).toHaveBeenCalledWith(
      PDF_URL,
      "pdf_local",
      "error",
      expect.stringMatching(/exceeds 100 bytes/),
    );
  });

  it("names the pdf_local failure in the final error when the cascade fails too", async () => {
    flags.maxBytes = 100;
    tier2Fetch.mockResolvedValue(null);

    await expect(fetchPage(PDF_URL)).rejects.toThrow(
      /All fetch tiers failed — pdf_local: Response body exceeds 100 bytes/,
    );
  });

  it("surfaces a PDF with no text layer instead of running the cascade", async () => {
    fetchSpy.mockImplementation(async () => pdfResponse(NO_TEXT_PDF));

    await expect(fetchPage(PDF_URL)).rejects.toThrow(
      "PDF has no extractable text layer (scanned?)",
    );
    expect(tier2Fetch).not.toHaveBeenCalled();
    expect(cacheSetMock).not.toHaveBeenCalled();
  });

  it("restores the cascade under the kill switch", async () => {
    flags.enabled = false;

    const result = await fetchPage(PDF_URL);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(tier2Fetch).toHaveBeenCalledOnce();
    expect(result.text).toBe("cascade body");
  });

  it("ignores a probe that says PDF under the kill switch", async () => {
    flags.enabled = false;
    probeMock.mockResolvedValue("pdf");

    await fetchPage(EXTENSIONLESS_URL);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(tier2Fetch).toHaveBeenCalledOnce();
  });
});

describe("fetchPage — local PDF path keeps the SSRF guards", () => {
  it("refuses a private IP literal before anything is fetched", async () => {
    await expect(fetchPage("http://127.0.0.1/secret.pdf")).rejects.toThrow(
      /Internal\/private addresses are not allowed/,
    );
    await expect(fetchPage("http://10.0.0.5/report.pdf")).rejects.toThrow(
      /Internal\/private addresses are not allowed/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a public hostname that resolves to a private address", async () => {
    flags.dnsAddress = "10.1.2.3";

    await expect(fetchPage(PDF_URL)).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(tier2Fetch).not.toHaveBeenCalled();
  });

  it("refuses a redirect to a private IP literal", async () => {
    fetchSpy.mockImplementation(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data.pdf" },
        }),
    );

    // Falls through to the cascade (a redirect failure is not a fact about
    // the document) — but the internal hop was never requested.
    await fetchPage(PDF_URL);

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(String(fetchSpy.mock.calls[0][0])).toBe(PDF_URL);
    expect(recordTierAttemptMock).toHaveBeenCalledWith(
      PDF_URL,
      "pdf_local",
      "error",
      expect.stringMatching(/Internal\/private addresses are not allowed/),
    );
  });
});
