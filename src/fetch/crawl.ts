import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { cacheGet, cacheSet } from "../core/cache.js";
import {
  CRAWL_BFS_ENABLED,
  CRAWL_BFS_MAX_DEPTH,
  CRAWL_MANIFEST_TTL_SECONDS,
} from "../core/config.js";
import { incCounter, recordHistogram } from "../core/observability.js";
import { warnDependencyFailure } from "../core/transport-failure.js";
import { assertPublicUrl, fetchPage } from "./fetch-page.js";
import { checkRobots, getRobotsForOrigin } from "./robots.js";
import { assertResolvedPublic } from "./ssrf-guard.js";
import { readBoundedText, safeFetch } from "./utils.js";

export interface CrawlPage {
  url: string;
  title: string;
  snippet: string;
}

export interface CrawlManifest {
  strategy: "sitemap" | "bfs" | "error";
  base_url: string;
  page_count: number;
  pages: CrawlPage[];
  cached: boolean;
  note?: string;
}

function crawlManifestCacheKey(
  url: string,
  maxPages: number,
  sameDomainOnly: boolean,
  includePath?: string,
  excludePath?: string,
): string {
  const raw = `${url}|${maxPages}|${sameDomainOnly}|${includePath ?? ""}|${excludePath ?? ""}`;
  return `crawl:${createHash("sha256").update(raw).digest("hex")}`;
}

function makeSnippet(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

// ─── Default scope ───────────────────────────────────────────────────────────

/**
 * The path a crawl is confined to when the caller gives no `include_path`: the
 * start URL's path, taken as a directory (`/docs/index.html` → `/docs`). None
 * for a site root.
 *
 * Without it the sitemap and map strategies ignored the start URL's path
 * entirely — `crawl_site("https://valkey.io/docs", max_pages: 5)` returned the
 * home page and four author pages, the first five entries of the site-wide
 * sitemap — and BFS wandered out of the section through its navigation links.
 */
export function defaultCrawlScope(url: string): string | undefined {
  const segments = new URL(url).pathname.split("/").filter(Boolean);
  if (segments.at(-1)?.includes(".")) segments.pop();
  return segments.length > 0 ? `/${segments.join("/")}` : undefined;
}

/** Whether `url`'s path is `scope` or below it, on a segment boundary. */
export function inCrawlScope(url: string, scope: string): boolean {
  try {
    const { pathname } = new URL(url);
    return pathname === scope || pathname.startsWith(`${scope}/`);
  } catch {
    return false;
  }
}

// ─── Phase 1: Sitemap-first ──────────────────────────────────────────────────

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  isArray: (name) => ["url", "sitemap"].includes(name),
});

export function extractSitemapUrls(xml: string): string[] {
  try {
    const result = xmlParser.parse(xml) as Record<string, unknown>;
    const urlset = result.urlset as
      | { url?: Array<{ loc?: unknown }> }
      | undefined;
    if (urlset?.url) {
      return urlset.url
        .map((u) => String(u.loc ?? ""))
        .filter((loc) => loc.startsWith("http"));
    }
    const idx = result.sitemapindex as
      | { sitemap?: Array<{ loc?: unknown }> }
      | undefined;
    if (idx?.sitemap) {
      return idx.sitemap
        .map((s) => String(s.loc ?? ""))
        .filter((loc) => loc.startsWith("http"));
    }
  } catch {
    // Reviewed (vikunja#687 class sweep): malformed XML in a sitemap we DID
    // fetch is a fact about the sitemap, not a failure to reach it.
  }
  return [];
}

async function fetchSitemapXml(url: string): Promise<string | null> {
  try {
    // SSRF guard — sitemap URLs can come from untrusted robots.txt. safeFetch
    // applies the string check and the DNS-validating dispatcher (each redirect
    // hop included).
    const res = await safeFetch(url, {
      headers: { "User-Agent": "searxng-mcp" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return await readBoundedText(res); // bounded read — prevents oversized sitemap DoS (F-02)
  } catch (err) {
    // A sitemap we could not fetch is not a site without a sitemap, and the
    // caller reports the latter. Null still propagates — a crawl must not hard
    // fail because one sitemap URL was unreachable — but the reason is no
    // longer invisible.
    warnDependencyFailure(err, `sitemap ${url}`);
    return null;
  }
}

export async function discoverSitemapUrls(
  origin: string,
  maxDepth = 3,
): Promise<string[]> {
  const candidates: string[] = [];
  const allUrls = new Set<string>();

  // Try robots.txt Sitemap: directives first
  try {
    const robots = await getRobotsForOrigin(origin);
    if (robots.body) {
      const sitemapLines = robots.body
        .split("\n")
        .filter((l) => l.toLowerCase().startsWith("sitemap:"))
        .map((l) => l.split(":").slice(1).join(":").trim());
      candidates.push(...sitemapLines);
    }
  } catch {
    // continue
  }

  // Well-known paths as fallback
  candidates.push(`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`);

  async function processSitemap(url: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    const xml = await fetchSitemapXml(url);
    if (!xml) return;
    const locs = extractSitemapUrls(xml);
    for (const loc of locs) {
      if (loc.endsWith(".xml")) {
        // Child sitemap — recurse
        if (!allUrls.has(loc)) {
          allUrls.add(loc);
          await processSitemap(loc, depth + 1);
        }
      } else {
        allUrls.add(loc);
      }
    }
  }

  for (const candidate of candidates) {
    if (!allUrls.has(candidate)) {
      await processSitemap(candidate, 0);
      if (allUrls.size > 0) break; // first hit wins
    }
  }

  return Array.from(allUrls).filter((u) => !u.endsWith(".xml"));
}

async function batchFetch(
  urls: string[],
  maxPages: number,
  concurrency = 5,
): Promise<CrawlPage[]> {
  const sliced = urls.slice(0, maxPages);
  const pages: CrawlPage[] = [];

  for (let i = 0; i < sliced.length; i += concurrency) {
    const chunk = sliced.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      chunk.map(async (url) => {
        const robots = await checkRobots(url, "searxng-mcp");
        if (!robots.allowed) return null;
        const { title, text } = await fetchPage(url, 8000);
        const snippet = makeSnippet(text);
        return { url, title, snippet };
      }),
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) pages.push(r.value);
    }
  }
  return pages;
}

export async function sitemapCrawl(
  url: string,
  maxPages: number,
  includePath?: string,
  excludePath?: string,
  scope?: string,
): Promise<CrawlManifest | null> {
  try {
    const origin = new URL(url).origin;
    let urls = await discoverSitemapUrls(origin);
    if (urls.length === 0) return null;

    if (includePath) urls = urls.filter((u) => u.includes(includePath));
    if (excludePath) urls = urls.filter((u) => !u.includes(excludePath));
    if (scope) urls = urls.filter((u) => inCrawlScope(u, scope));
    if (urls.length === 0) return null;

    const pages = await batchFetch(urls, maxPages);
    return {
      strategy: "sitemap",
      base_url: url,
      page_count: pages.length,
      pages,
      cached: false,
    };
  } catch (err) {
    // The outer crawl catch. Returning null routes the caller to its other
    // strategies, which is right — but doing it silently made a failed crawl
    // and a site with no crawlable structure the same event.
    warnDependencyFailure(err, `sitemap crawl of ${url}`);
    return null;
  }
}

// ─── Phase 2: BFS ────────────────────────────────────────────────────────────

export async function bfsCrawl(
  startUrl: string,
  maxPages: number,
  maxDepth: number,
  sameDomainOnly: boolean,
  includePath?: string,
  excludePath?: string,
  scope?: string,
): Promise<CrawlManifest> {
  const startHost = new URL(startUrl).hostname;
  const visited = new Set<string>();
  const queue: Array<{ url: string; depth: number }> = [
    { url: startUrl, depth: 0 },
  ];
  const pages: CrawlPage[] = [];

  while (queue.length > 0 && visited.size < maxPages) {
    const item = queue.shift();
    if (!item) break;
    const normalizedUrl = item.url.split("#")[0]; // strip fragment
    if (visited.has(normalizedUrl)) continue;
    if (item.depth > maxDepth) continue;

    const robots = await checkRobots(normalizedUrl, "searxng-mcp");
    if (!robots.allowed) continue;

    visited.add(normalizedUrl);

    let fetchedTitle = normalizedUrl;
    let fetchedText = "";
    let rawHtml = "";

    try {
      const result = await fetchPage(normalizedUrl, 8000);
      fetchedTitle = result.title;
      fetchedText = result.text;

      // Extract links from the raw response — re-fetch with raw tier for link
      // extraction. fetchPage already cached the content; we need HTML for
      // links. safeFetch guards this attacker-influenced URL (BFS discovers it
      // from a crawled page) against private/reserved resolutions.
      const rawRes = await safeFetch(normalizedUrl, {
        headers: { "User-Agent": "searxng-mcp" },
        signal: AbortSignal.timeout(10_000),
      });
      if (rawRes.ok) rawHtml = await readBoundedText(rawRes); // bounded read — prevents oversized HTML DoS (F-02)
    } catch {
      continue;
    }

    pages.push({
      url: normalizedUrl,
      title: fetchedTitle,
      snippet: makeSnippet(fetchedText),
    });

    // Extract links via JSDOM (already a dep)
    if (rawHtml && item.depth < maxDepth) {
      try {
        const { JSDOM } = await import("jsdom");
        const dom = new JSDOM(rawHtml, { url: normalizedUrl });
        // Read hrefs out as strings, then close the window (see the note on
        // closing JSDOM windows in src/fetch/extractors/markdown.ts).
        const hrefs = [...dom.window.document.querySelectorAll("a[href]")].map(
          (a) => (a as HTMLAnchorElement).href,
        );
        dom.window.close();
        for (const href of hrefs) {
          if (!href.startsWith("http")) continue;
          const normalized = href.split("#")[0];
          if (visited.has(normalized)) continue;

          const parsed = new URL(normalized);
          if (sameDomainOnly && parsed.hostname !== startHost) continue;
          if (includePath && !parsed.pathname.includes(includePath)) continue;
          if (excludePath && parsed.pathname.includes(excludePath)) continue;
          if (scope && !inCrawlScope(normalized, scope)) continue;

          queue.push({ url: normalized, depth: item.depth + 1 });
        }
      } catch {
        // JSDOM unavailable or parse error — skip link extraction
      }
    }
  }

  return {
    strategy: "bfs",
    base_url: startUrl,
    page_count: pages.length,
    pages,
    cached: false,
    note: `BFS depth limited to ${maxDepth}`,
  };
}

// ─── Strategy cascade ────────────────────────────────────────────────────────

export async function crawlSite(
  url: string,
  maxPages: number,
  sameDomainOnly: boolean,
  includePath?: string,
  excludePath?: string,
): Promise<CrawlManifest> {
  assertPublicUrl(url); // SSRF guard — validate before any strategy dispatch (F-01)
  // Pre-resolve the hostname to reject a DNS-rebind to an internal address
  // before any strategy runs. Every page fetch below goes through fetchPage,
  // which hands URLs to Crawl4AI (an external fetcher the connect-time guard
  // cannot cover), so this keeps parity with fetchPage's own pre-check.
  await assertResolvedPublic(url);
  const t0 = Date.now();
  const cacheKey = crawlManifestCacheKey(
    url,
    maxPages,
    sameDomainOnly,
    includePath,
    excludePath,
  );

  // Check manifest cache
  const cached = await cacheGet(cacheKey);
  if (cached) {
    try {
      // SECURITY[accepted]: JSON.parse without schema validation. Cache is written only by
      // crawlSite itself from trusted crawl results. Corrupt entries fall through to a live
      // crawl via the catch block. Auditor confirmed no action required. Audit: 2026-06-05/searxng-mcp-crawl-2026-06.
      const manifest = JSON.parse(cached) as CrawlManifest;
      incCounter("crawl", {
        strategy: manifest.strategy,
        outcome: "manifest_hit",
      });
      return { ...manifest, cached: true };
    } catch {
      // corrupt cache — fall through
    }
  }

  // An explicit include_path — including "/" for the whole site — replaces the
  // default scope rather than narrowing it.
  const scope = includePath === undefined ? defaultCrawlScope(url) : undefined;

  // Phase 1: Sitemap
  let manifest = await sitemapCrawl(
    url,
    maxPages,
    includePath,
    excludePath,
    scope,
  );
  if (manifest) {
    incCounter("crawl", { strategy: "sitemap", outcome: "fallback_sitemap" });
  }

  // Phase 2: BFS (opt-in)
  if (!manifest && CRAWL_BFS_ENABLED) {
    manifest = await bfsCrawl(
      url,
      maxPages,
      CRAWL_BFS_MAX_DEPTH,
      sameDomainOnly,
      includePath,
      excludePath,
      scope,
    );
    if (manifest) {
      incCounter("crawl", { strategy: "bfs", outcome: "fallback_bfs" });
    }
  }

  const scopeNote = scope
    ? `Limited to pages under ${scope}/ (the start URL's path); pass include_path "/" to crawl the whole site.`
    : undefined;

  if (!manifest) {
    incCounter("crawl", { strategy: "none", outcome: "error" });
    return {
      strategy: "error",
      base_url: url,
      page_count: 0,
      pages: [],
      cached: false,
      note: scope
        ? `All crawl strategies failed: no sitemap entries under ${scope}/${CRAWL_BFS_ENABLED ? "" : " and BFS is disabled"}. ${scopeNote}`
        : "All crawl strategies failed. No sitemap found and BFS is disabled.",
    };
  }

  if (scopeNote) {
    manifest.note = manifest.note
      ? `${manifest.note}. ${scopeNote}`
      : scopeNote;
  }

  // Cache the manifest
  await cacheSet(
    cacheKey,
    JSON.stringify(manifest),
    CRAWL_MANIFEST_TTL_SECONDS,
  );

  const durationSeconds = (Date.now() - t0) / 1000;
  recordHistogram("crawl", durationSeconds, { strategy: manifest.strategy });

  return manifest;
}

// ─── Format output ───────────────────────────────────────────────────────────

export function formatCrawlManifest(manifest: CrawlManifest): string {
  if (manifest.strategy === "error") {
    return `Crawl failed: ${manifest.note ?? "Unknown error"}`;
  }

  const header = `Strategy: ${manifest.strategy} | base: ${manifest.base_url} | ${manifest.page_count} pages${manifest.cached ? " (cached)" : ""}`;
  const note = manifest.note ? `\n${manifest.note}` : "";

  if (manifest.pages.length === 0) {
    return `${header}${note}\n\nNo pages found.`;
  }

  const tableHeader = `\n\n| # | URL | Title | Snippet |\n|---|-----|-------|---------|\n`;
  const rows = manifest.pages
    .map(
      (p, i) =>
        `| ${i + 1} | ${p.url.replace(/\|/g, "\\|")} | ${p.title.replace(/\|/g, "\\|")} | ${p.snippet.replace(/\|/g, "\\|")} |`,
    )
    .join("\n");

  const footer =
    "\n\nFull content cached. Use fetch_url on any URL above for complete text.";

  return `${header}${note}${tableHeader}${rows}${footer}`;
}
