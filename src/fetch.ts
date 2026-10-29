import { cacheGet, cacheSet, fetchCacheKey } from "./cache.js";
import {
  CHALLENGE_MISS_REASON,
  ChallengeDetectedError,
  type ChallengeSignal,
} from "./challenge.js";
import {
  FETCH_CACHE_TTL_SECONDS,
  FETCH_RAW_FIRST,
  PDF_EXTRACT_ENABLED,
  PDF_MAX_BYTES,
  PDF_MAX_PAGES,
  WAYBACK_ENABLED,
} from "./config.js";
import { probeContentKind } from "./content-type.js";
import {
  recordMetadataFetchAttempt,
  recordPostExtractSample,
  recordTierAttempt,
  type TierName,
} from "./domain-db.js";
import { getBlockList, urlMatchesDomain } from "./domains.js";
import { events } from "./events.js";
import { proseLength } from "./extractors/markdown.js";
import { postExtract } from "./extractors/post-extract.js";
import {
  assertPublicUrl,
  boundRelayedText,
  type FetchTuning,
  type TierResult,
} from "./fetch-utils.js";
import { histerConfigured, histerFetch } from "./hister.js";
import { isKiwixHost, kiwixFetch } from "./kiwix.js";
import { isLlmsTxtDomain, tryLlmsTxtFetch } from "./llms-txt.js";
import { incCounter, recordHistogram, withSpan } from "./observability.js";
import { isPdfUrlPath, PdfUnextractableError, pdfFetch } from "./pdf.js";
import { isRedditHost, redditFetch } from "./reddit.js";
import { checkRobots } from "./robots.js";
import { getTiers, TIER_NAME } from "./routing.js";
import { assertResolvedPublic } from "./ssrf-guard.js";
import {
  fetchRawHtmlForMetadata,
  githubFetch,
  isGithubFastPathUrl,
  rawFetch,
  solverFetch,
  type Tier,
  waybackFetch,
} from "./tiers/index.js";
import { isYouTubeHost, youtubeFetch } from "./youtube.js";

// Re-export for callers that import assertPublicUrl from this module.
export { assertPublicUrl } from "./fetch-utils.js";

export class RobotsDisallowedError extends Error {
  constructor(url: string) {
    super(`robots.txt disallows fetch: ${url}`);
    this.name = "RobotsDisallowedError";
  }
}

// Re-export rawFetch for external callers (e.g. tests).
export { rawFetch } from "./tiers/index.js";

function applyPostExtract(
  fetched: TierResult,
  url: string,
  metadataHtml: string | null,
  maxChars = 8000,
): TierResult {
  const html = metadataHtml ?? fetched.html ?? null;
  if (!html) return fetched;
  const enriched = postExtract({
    url,
    html,
    baselineTitle: fetched.title,
    baselineText: fetched.text,
    maxChars,
  });

  // Sample what we saw in the metadata HTML for the domain DB. Presence comes
  // from the scan postExtract already performed, NOT from whether JSON-LD won
  // the body: `source === "json_ld"` additionally requires a 300+ char
  // articleBody, so deriving presence from it reported 0 present across 111
  // sampled pages while og:title — checked directly against the HTML below —
  // read 40% on the same sample.
  const jsonLdPresent = enriched.jsonLdPresent;
  const ogTitlePresent =
    /<meta[^>]+(property|name)\s*=\s*["']og:title["']/i.test(html);
  recordPostExtractSample(url, { jsonLdPresent, ogTitlePresent }).catch(
    () => {},
  );

  return {
    ...fetched,
    title: enriched.title,
    text: enriched.text,
  };
}

/**
 * Run one tier and record its outcome (metrics, events, domain-db).
 *
 * `onChallenge` is how a detected challenge escapes the tier: the tier throws
 * ChallengeDetectedError, this wrapper turns it into a miss, and the callback
 * lets the caller remember that a challenge was seen for *this* request. The
 * flag it sets is a local in fetchPage, so it is request-scoped by
 * construction — no shared or ambient state.
 */
/**
 * Why one tier did not produce content.
 *
 * `runTier` collapses every failure to `null`, which is right for the cascade —
 * it just moves on — but wrong for the caller that has to explain the outcome
 * once every tier is exhausted. The whole of vikunja#682 hid behind exactly
 * that collapse: a null from one tier was reported as one specific cause
 * ("CRAWL4AI_URL not configured") on a deployment where that cause was false,
 * which sent an investigator to check configuration that was already correct.
 * Carrying the reason out alongside the null is what stops the next such
 * message from being invented.
 */
interface TierOutcome {
  tier: TierName;
  reason: string;
}

/**
 * Cap on a single tier's failure reason in the surfaced error.
 *
 * Most reasons are short and ours — "attempted, no content", a status code. But
 * one is neither: Crawl4AI's error prose is upstream-controlled text of
 * unbounded length, and this path relays a tier's own error to the caller
 * rather than swallowing it. An error message is not a transport
 * for an arbitrary upstream payload.
 *
 * Only length is bounded, not content. Every reason this can carry is already
 * topology-safe by construction: SsrfBlockedError deliberately keeps the
 * resolved address off its message, raw.ts's redirect throw deliberately omits
 * the Location header, and the tier errors carry status codes rather than URLs.
 */
// SECURITY[accepted]: relaying a tier's upstream error text verbatim, bounded
// to 200 chars, is accepted rather than classified down to a canned reason. This
// server is loopback-only and its callers are forge agents that already hold the
// requested URL, so the text discloses nothing they do not have; every other
// reason this path can carry is topology-safe by construction (see boundReason).
// Dropping the upstream string would claw back the diagnostic value this whole
// change exists to add — "All fetch tiers failed" telling an investigator nothing
// is what cost weeks on vikunja#682. Audit: 2026-09-06/searxng-mcp-fix-pass-2026-09,
// finding OE-02 (Low). Decision: Ted, 2026-09-06. The bound itself now lives in
// fetch-utils.ts as boundRelayedText(), shared with hister.ts.

async function runTier<T extends TierResult | null>(
  tier: TierName,
  url: string,
  fn: () => Promise<T>,
  onChallenge?: (signal: ChallengeSignal) => void,
  onOutcome?: (outcome: TierOutcome) => void,
): Promise<T> {
  const t0 = Date.now();
  try {
    const out = await withSpan(tier, { "fetch.url": url }, () => fn());
    const latency_ms = Date.now() - t0;
    if (out) {
      incCounter("fetch", { tier, outcome: "hit" });
      recordHistogram("fetch", latency_ms / 1000, { tier, outcome: "hit" });
      recordTierAttempt(url, tier, "hit").catch(() => {});
    } else {
      incCounter("fetch", { tier, outcome: "miss" });
      recordHistogram("fetch", latency_ms / 1000, { tier, outcome: "miss" });
      events.fetchTierMiss({ url, tier, reason: "empty_result", latency_ms });
      recordTierAttempt(url, tier, "miss", "empty_result").catch(() => {});
      onOutcome?.({ tier, reason: "attempted, no content" });
    }
    return out;
  } catch (err) {
    const latency_ms = Date.now() - t0;
    // A detected challenge is a miss, not an error: the tier reached the origin
    // and got a well-formed response, it just wasn't content. Recording it as
    // `challenge_detected` rather than the generic `empty_result` is what makes
    // the solver gate possible, and it stops the interstitial being booked as a
    // hit (cached, and counted as proof the tier works on this domain).
    if (err instanceof ChallengeDetectedError) {
      incCounter("fetch", { tier, outcome: "miss" });
      recordHistogram("fetch", latency_ms / 1000, { tier, outcome: "miss" });
      events.fetchTierMiss({
        url,
        tier,
        reason: CHALLENGE_MISS_REASON,
        latency_ms,
      });
      recordTierAttempt(url, tier, "miss", CHALLENGE_MISS_REASON).catch(
        () => {},
      );
      onChallenge?.(err.signal);
      onOutcome?.({ tier, reason: CHALLENGE_MISS_REASON });
      return null as T;
    }
    const reason = err instanceof Error ? err.message : "error";
    incCounter("fetch", { tier, outcome: "error" });
    recordHistogram("fetch", latency_ms / 1000, { tier, outcome: "error" });
    events.fetchTierMiss({ url, tier, reason, latency_ms });
    recordTierAttempt(url, tier, "error", reason).catch(() => {});
    onOutcome?.({ tier, reason: boundRelayedText(reason) });
    return null as T;
  }
}

/**
 * Prose a raw fetch must extract to be accepted without trying the browser.
 * Measured 2026-10-28 on twelve documentation pages: raw HTTP + Readability
 * found the answer on all twelve (prose 2,021–35,950), at 0.5–2s against
 * Crawl4AI's 1.2–3.4s; Crawl4AI missed the answer on one and errored on
 * another. A JS-rendered shell extracts far less than this and falls through.
 */
const RAW_ACCEPT_PROSE_CHARS = 1500;

/**
 * Cascade order: raw HTTP before the headless browser, unless the caller
 * asked to wait for a selector — that only means something on a rendered page
 * — or FETCH_RAW_FIRST=false. Tier routing (skips) has already been applied,
 * so a domain where raw habitually fails never gets here with tier3 at all.
 */
export function orderTiers(
  tiers: readonly Tier[],
  tuning?: FetchTuning,
): Tier[] {
  if (!FETCH_RAW_FIRST || tuning?.waitForSelector) return [...tiers];
  return [
    ...tiers.filter((t) => t.slot === "tier3"),
    ...tiers.filter((t) => t.slot !== "tier3"),
  ];
}

// The fetch cache always stores up to this ceiling and callers slice it down on
// read. It used to store 8000 unless a caller asked for more, and a cached
// 8000-char entry is never refetched — so a page first seen through a small
// budget could not be paged past 8000 for the life of the entry. Storing the
// ceiling unconditionally is what makes fetch_url's `offset` paging real.
const DEFAULT_FETCH_CHARS = 8000;
export const FETCH_STORE_CEILING = 40000;

export async function fetchPage(
  url: string,
  maxChars = DEFAULT_FETCH_CHARS,
  domainProfile?: string,
  preferFit = false,
  tuning?: FetchTuning,
  /** Skip the cache read (the fresh result is still written back). */
  fresh = false,
): Promise<{ title: string; url: string; text: string }> {
  return withSpan("fetch", { "fetch.url": url }, async () => {
    const t_total = Date.now();
    assertPublicUrl(url);
    const storeChars = FETCH_STORE_CEILING;
    events.fetchRequested({ url, max_chars: maxChars, prefer_fit: preferFit });

    // Refuse to fetch blocked domains
    const blockList = getBlockList(domainProfile);
    if (blockList.some((pat) => urlMatchesDomain(url, pat))) {
      events.error({
        stage: "fetch",
        url,
        error_type: "blocked_domain",
        message: "Domain is blocked by domain filter configuration",
      });
      throw new Error(`Domain is blocked by domain filter configuration`);
    }

    // Check fetch cache — stored at FETCH_STORE_CEILING, sliced to maxChars on read
    const key = fetchCacheKey(url);
    const cached = fresh ? null : await cacheGet(key);
    if (cached) {
      try {
        const r = JSON.parse(cached) as {
          title: string;
          url: string;
          text: string;
        };
        // Entries written before the store size was fixed at the ceiling were
        // cut at exactly DEFAULT_FETCH_CHARS. Serving one to a caller that
        // wants more would report an 8000-char page that is really longer, so
        // treat it as a miss and refetch. Self-retiring: the fetch TTL is 24h.
        if (
          r.text.length === DEFAULT_FETCH_CHARS &&
          maxChars > DEFAULT_FETCH_CHARS
        ) {
          throw new Error("legacy truncated cache entry");
        }
        events.fetchCompleted({
          url,
          tier_served: "cache",
          title: r.title,
          text_len: r.text.length,
          latency_ms: Date.now() - t_total,
        });
        return { ...r, text: r.text.slice(0, maxChars) };
      } catch {
        // Corrupted or legacy-truncated entry — fall through to live fetch
      }
    }

    let result: TierResult;
    let tierServed = "github";
    if (isGithubFastPathUrl(url)) {
      // GitHub fast path — only for URL shapes it can serve as the page they
      // name (repo root, blob, tree, releases, raw, API); other github.com
      // pages such as issues take the normal cascade below. Routed through
      // runTier() so its hit/miss/error is recorded in the domain-db and OTel
      // like any other tier (SXNG-10). githubFetch throws on failure; runTier
      // catches it, records an error attempt, and returns null, so we
      // translate that back into a throw for the caller.
      const gh = await runTier<TierResult | null>("github", url, () =>
        githubFetch(url, storeChars),
      );
      if (!gh) {
        events.error({
          stage: "fetch",
          url,
          error_type: "github_fetch_failed",
          message: "GitHub fast-path fetch failed",
        });
        throw new Error("GitHub fast-path fetch failed");
      }
      result = gh;
    } else {
      // llms.txt fast path — for whitelisted docs domains, try fetching the
      // section from a pre-cached llms-full.txt before invoking any tier.
      //
      // The allowlist test is HERE rather than only inside tryLlmsTxtFetch, so
      // the span wraps work performed instead of a call site traversed. It was
      // the other way round, and the cost was not a tidiness one: SigNoz showed
      // ~60 `llms_full_txt` spans over 15 days against ~105 total fetches, which
      // reads as a path under constant use. Six domains are allowlisted, so the
      // large majority of those spans were no-ops that never touched an
      // llms-full.txt. A span that counts traversals makes a dead path and a busy
      // path look identical — vikunja#640 is exactly that failure, and this is
      // the instrumentation half of it.
      //
      // Shape deliberately matches the kiwix/youtube/reddit fast paths below,
      // which guard at the call site and were always correct. The two paths that
      // were wrong, this one and hister, were the only two that did not.
      const llms = isLlmsTxtDomain(url)
        ? await withSpan("llms_full_txt", { "fetch.url": url }, () =>
            tryLlmsTxtFetch(url, storeChars),
          )
        : null;
      if (llms) {
        incCounter("fetch", { tier: "llms_full_txt", outcome: "hit" });
        const persisted = {
          title: llms.title,
          url: llms.url,
          text: llms.text,
        };
        await cacheSet(key, JSON.stringify(persisted), FETCH_CACHE_TTL_SECONDS);
        events.fetchCompleted({
          url,
          tier_served: "llms_full_txt",
          title: llms.title,
          text_len: llms.text.length,
          latency_ms: Date.now() - t_total,
          source: "llms_full_txt",
        });
        return { ...persisted, text: persisted.text.slice(0, maxChars) };
      }

      // Kiwix fast path — intercepts Wikipedia, Stack Overflow, Arch Wiki
      // requests and serves from local Kiwix before the tier cascade.
      if (isKiwixHost(url)) {
        const kiwix = await withSpan("kiwix", { "fetch.url": url }, () =>
          kiwixFetch(url, storeChars),
        );
        if (kiwix) {
          incCounter("fetch", { tier: "kiwix", outcome: "hit" });
          const persisted = {
            title: kiwix.title,
            url: kiwix.url,
            text: kiwix.text,
          };
          await cacheSet(
            key,
            JSON.stringify(persisted),
            FETCH_CACHE_TTL_SECONDS,
          );
          events.fetchCompleted({
            url,
            tier_served: "kiwix",
            title: kiwix.title,
            text_len: kiwix.text.length,
            latency_ms: Date.now() - t_total,
            source: "kiwix",
          });
          return { ...persisted, text: persisted.text.slice(0, maxChars) };
        }
        // Kiwix miss (article not in ZIM or Kiwix down) — fall through to cascade
        incCounter("fetch", { tier: "kiwix", outcome: "miss" });
      }

      // Hister fast path — check Ted's browsing-history index before the tier
      // cascade. Serves pages that are login-walled or JS-heavy (already rendered
      // by Firefox) and avoids re-fetching stable docs that are indexed here.
      //
      // GUARDED AT THE CALL SITE. The configuration test used to live inside
      // histerFetch while the span wrapped the call unconditionally, and the
      // running container has no HISTER_* set at all — so SigNoz showed ~60
      // `hister` spans over 15 days and every single one was a no-op that returned
      // at the first line. Zero Hister lookups have ever happened. Do not read
      // that span count as a baseline for anything: the correct pre-fix number of
      // real probes is zero (vikunja#643).
      //
      // The miss counter moved in here for the same reason. Outside the guard it
      // counted every fetch that got this far as a Hister miss, so the metric
      // agreed with the spans and the two corroborated each other into looking
      // like evidence.
      //
      // Shape matches kiwix/youtube/reddit above, which were always correct.
      const hister = histerConfigured()
        ? await withSpan("hister", { "fetch.url": url }, () =>
            histerFetch(url, storeChars),
          )
        : null;
      if (hister) {
        // No incCounter(hit) here either. histerFetch owns its own accounting on
        // BOTH outcomes, and counting the hit in two places inflated it by exactly
        // 2x — which, on a build whose whole subject is telemetry that
        // misreports reality, is worth stating rather than quietly deleting.
        // Caught by CodeRabbit on PR #65.
        const persisted = {
          title: hister.title,
          url: hister.url,
          text: hister.text,
        };
        await cacheSet(key, JSON.stringify(persisted), FETCH_CACHE_TTL_SECONDS);
        events.fetchCompleted({
          url,
          tier_served: "hister",
          title: hister.title,
          text_len: hister.text.length,
          latency_ms: Date.now() - t_total,
          source: "hister",
        });
        return { ...persisted, text: persisted.text.slice(0, maxChars) };
      }
      // No `incCounter(miss)` here. histerFetch records its own miss and, unlike
      // this line, records WHY — "not-indexed" reads very differently from
      // "schema-mismatch" or "http-error", and collapsing them into one
      // reasonless miss is what made a totally broken parser look like an empty
      // index for months (vikunja#643). A count here as well would double every
      // miss and reintroduce the reasonless one.

      // YouTube transcript fast path — timedtext captions for known video URLs.
      // Robots-gated by default (see youtubeFetch); on miss, falls through so
      // the cascade can still fetch the watch page's title/description.
      if (isYouTubeHost(url)) {
        const yt = await withSpan("youtube", { "fetch.url": url }, () =>
          youtubeFetch(url, storeChars),
        );
        if (yt) {
          incCounter("fetch", { tier: "youtube", outcome: "hit" });
          const persisted = { title: yt.title, url: yt.url, text: yt.text };
          await cacheSet(
            key,
            JSON.stringify(persisted),
            FETCH_CACHE_TTL_SECONDS,
          );
          events.fetchCompleted({
            url,
            tier_served: "youtube",
            title: yt.title,
            text_len: yt.text.length,
            latency_ms: Date.now() - t_total,
            source: "youtube",
          });
          return { ...persisted, text: persisted.text.slice(0, maxChars) };
        }
        incCounter("fetch", { tier: "youtube", outcome: "miss" });
      }

      // Reddit fast path — public .json for post + top comments. Robots-gated by
      // default (see redditFetch); on miss, falls through to the cascade.
      if (isRedditHost(url)) {
        const rd = await withSpan("reddit", { "fetch.url": url }, () =>
          redditFetch(url, storeChars),
        );
        if (rd) {
          incCounter("fetch", { tier: "reddit", outcome: "hit" });
          const persisted = { title: rd.title, url: rd.url, text: rd.text };
          await cacheSet(
            key,
            JSON.stringify(persisted),
            FETCH_CACHE_TTL_SECONDS,
          );
          events.fetchCompleted({
            url,
            tier_served: "reddit",
            title: rd.title,
            text_len: rd.text.length,
            latency_ms: Date.now() - t_total,
            source: "reddit",
          });
          return { ...persisted, text: persisted.text.slice(0, maxChars) };
        }
        incCounter("fetch", { tier: "reddit", outcome: "miss" });
      }

      // robots.txt gate — skips fetch on disallow (cached 24h per origin)
      const robots = await checkRobots(url, "searxng-mcp");
      if (!robots.allowed) {
        console.error(
          `[searxng-mcp] fetch skipped_robots url=${url} reason=${robots.reason ?? "disallowed"}`,
        );
        incCounter("fetch", { tier: "robots", outcome: "skipped_robots" });
        events.fetchTierSkipped({
          url,
          tier: "robots",
          reason: robots.reason ?? "disallowed",
        });
        throw new RobotsDisallowedError(url);
      }

      // Armed by runTier when any tier reports a challenge for this URL. A
      // plain local, so it is request-scoped by construction — the solver must
      // never fire on the strength of a challenge seen in some other request.
      let challengeDetected = false;
      const onChallenge = () => {
        challengeDetected = true;
      };

      // Resolve data-driven + operator skips before kicking off the cascade.
      const { active: activeTiers, skipped: skipDecisions } =
        await getTiers(url);
      // Announce all skipped tiers up front (metrics + events + logs).
      for (const { tier: slot, reason } of skipDecisions) {
        const tierName = TIER_NAME[slot];
        // `reason` is labelled here, not just carried on the event: without it
        // searxng_fetch_total{outcome="skipped"} cannot tell a tier that is not
        // configured from one that is failing. Three values, so cardinality is
        // a non-issue, and existing queries that do not select on reason still
        // aggregate the same total.
        incCounter("fetch", { tier: tierName, outcome: "skipped", reason });
        events.fetchTierSkipped({ url, tier: tierName, reason });
        console.error(
          `[searxng-mcp] fetch ${slot} skipped url=${url} reason=${reason}`,
        );
      }

      // Tier 2 (Crawl4AI) resolves and fetches the URL on our behalf, so the
      // connect-time DNS guard can't cover it. Pre-resolve the
      // hostname here (once, before any external-fetcher dispatch) so a public
      // hostname that DNS-rebinds to an internal address is rejected before it's
      // handed to that service — the string-level assertPublicUrl above only
      // catches literal private IPs. Throws SsrfBlockedError on a private
      // resolution (surfaces to the caller as a fetch error).
      await assertResolvedPublic(url);

      // SECURITY[control]: assertResolvedPublic runs once here, before any
      // dispatch below — the PDF and content-type fast paths as well as the
      // cascade. A PDF the local path cannot serve still falls through to
      // tier 2, and so shares tier 2's pre-existing SSRF-10 exposure (Crawl4AI
      // resolves and connects in its own process, so the pre-check narrows but
      // cannot fully close the DNS-rebinding window for it). Audit:
      // 2026-09-06/searxng-mcp-fix-pass-2026-09, finding SSRF-10 (Low) —
      // auditor's own disposition was "no action required from this build".

      // Why each tier produced nothing, in dispatch order. Seeded with the
      // tiers that never ran, so "skipped because unconfigured" and "ran and
      // came back empty" stay distinguishable in the final error rather than
      // collapsing into one unexplained failure (vikunja#682). Declared ahead
      // of the fast paths so a pdf_local failure that falls through is named
      // in that error too.
      const outcomes: TierOutcome[] = skipDecisions.map((d) => ({
        tier: TIER_NAME[d.tier],
        reason: `skipped (${d.reason})`,
      }));
      const noteOutcome = (o: TierOutcome) => outcomes.push(o);

      // One HEAD answers both diversions below. A `.pdf` path is taken at its
      // word and skips the probe; everything else — including the
      // extensionless PDFs (arxiv.org/pdf/<id>, ?download= handlers) a suffix
      // matcher never sees — is identified by its Content-Type.
      //
      // Probe is fail-open: an unreachable, HEAD-refusing or HTML-serving host
      // returns null and drops through to the normal cascade unchanged. Only a
      // positive identification diverts.
      const probedKind =
        PDF_EXTRACT_ENABLED && isPdfUrlPath(url)
          ? "pdf"
          : await probeContentKind(url);

      // PDF fast path — local text extraction (src/pdf.ts, unpdf). The only
      // PDF reader in this build: Crawl4AI renders a PDF in a browser, finds
      // no text nodes and misfires its anti-bot heuristic, and tier 3 reads
      // bodies as text. Dispatched directly with a TierName but no TierSlot,
      // like github and solver_byparr. PDF_EXTRACT_ENABLED=false turns it off
      // and PDFs take the cascade (and fail there, as they did before it).
      //
      // Fail-open, except for one answer: a PDF that parsed but has no text
      // layer (scanned) or needs a password. That is a fact about the
      // document, and the cascade cannot do better, so it is surfaced rather
      // than buried under a tier-by-tier failure list. Everything else — a
      // non-PDF body at a .pdf path, an oversize file, a 404, a parse error —
      // falls through to the cascade.
      if (probedKind === "pdf" && PDF_EXTRACT_ENABLED) {
        let unextractable: string | null = null;
        const pdf = await runTier(
          "pdf_local",
          url,
          async () => {
            try {
              return await pdfFetch(url, storeChars, {
                maxBytes: PDF_MAX_BYTES,
                maxPages: PDF_MAX_PAGES,
              });
            } catch (err) {
              if (err instanceof PdfUnextractableError) {
                unextractable = err.message;
              }
              throw err;
            }
          },
          onChallenge,
          noteOutcome,
        );
        if (pdf) {
          console.error(`[searxng-mcp] fetch pdf_local hit url=${url}`);
          const persisted = { title: pdf.title, url: pdf.url, text: pdf.text };
          await cacheSet(
            key,
            JSON.stringify(persisted),
            FETCH_CACHE_TTL_SECONDS,
          );
          events.fetchCompleted({
            url,
            tier_served: "pdf_local",
            title: pdf.title,
            text_len: pdf.text.length,
            latency_ms: Date.now() - t_total,
            source: "pdf_local",
          });
          return { ...persisted, text: persisted.text.slice(0, maxChars) };
        }
        if (unextractable) {
          events.error({
            stage: "fetch",
            url,
            error_type: "pdf_unextractable",
            message: unextractable,
          });
          throw new Error(unextractable);
        }
        console.error(
          `[searxng-mcp] fetch pdf_local miss url=${url} — falling through to cascade`,
        );
      }

      // Content-type fast path — a JSON/XML/YAML/CSV/plain-text endpoint has
      // nothing for a headless browser to render. A rendering tier returns
      // empty markdown for these and runTier books it as `empty_result`, which
      // poisons that tier's per-domain success rate for API and CDN hosts.
      const structuredKind = probedKind === "pdf" ? null : probedKind;
      if (structuredKind) {
        console.error(
          `[searxng-mcp] fetch content_type fast_path url=${url} kind=${structuredKind}`,
        );
        const structured = await runTier(
          "tier3_rawfetch",
          url,
          () => rawFetch(url, storeChars, tuning),
          onChallenge,
        );
        if (structured) {
          const persisted = {
            title: structured.title,
            url: structured.url,
            text: structured.text,
          };
          await cacheSet(
            key,
            JSON.stringify(persisted),
            FETCH_CACHE_TTL_SECONDS,
          );
          events.fetchCompleted({
            url,
            tier_served: "tier3_rawfetch",
            title: structured.title,
            text_len: structured.text.length,
            latency_ms: Date.now() - t_total,
          });
          return { ...persisted, text: persisted.text.slice(0, maxChars) };
        }
        // Raw fetch failed on something the probe said was structured — fall
        // through rather than throwing. The cascade may still have an answer
        // (wayback, a tier that handles the error differently), and a probe
        // must not be able to turn a fetchable URL into a hard failure.
        console.error(
          `[searxng-mcp] fetch content_type fast_path miss url=${url} — falling through to cascade`,
        );
      }

      // Run tier cascade and side-channel raw-HTML metadata fetch in parallel.
      const metadataHtmlPromise = fetchRawHtmlForMetadata(url);

      // Raw first, browser second (see orderTiers). A raw result too thin
      // to be the page is held back rather than discarded: if the browser
      // tier then fails, the thin result still beats no result.
      const ordered = orderTiers(activeTiers, tuning);
      let fetched: TierResult | null = null;
      let thin: TierResult | null = null;
      for (const [i, tier] of ordered.entries()) {
        fetched = await runTier(
          tier.name,
          url,
          () => tier.fetch(url, storeChars, preferFit, tuning),
          onChallenge,
          noteOutcome,
        );
        if (
          fetched &&
          tier.slot === "tier3" &&
          i < ordered.length - 1 &&
          proseLength(fetched.text) < RAW_ACCEPT_PROSE_CHARS
        ) {
          console.error(
            `[searxng-mcp] fetch tier3 thin url=${url} — trying the rendering tier`,
          );
          thin = fetched;
          fetched = null;
          continue;
        }
        if (fetched) {
          tierServed = tier.name;
          console.error(`[searxng-mcp] fetch ${tier.slot} hit url=${url}`);
          break;
        }
        console.error(`[searxng-mcp] fetch ${tier.slot} miss url=${url}`);
      }
      if (!fetched && thin) {
        fetched = thin;
        tierServed = "tier3_rawfetch";
      }

      // Challenge solver. Detection-gated: it fires only when a tier actually
      // reported `challenge_detected` for this URL, never on an unchallenged
      // one. searxng-mcp already runs two browser-rendering tiers ahead of
      // this, so solving unconditionally would re-render pages that were never
      // challenged, at seconds of latency and hundreds of MB of RAM each.
      //
      // Dispatched directly here rather than as a cascade tier, following
      // tier4_wayback and github: it takes a TierName but no TierSlot, which
      // keeps it out of computeTierSkips and the tier_skip domain config.
      // Placed after tier3 because a browser must not run ahead of a cheap raw
      // fetch that frequently succeeds, and before tier4_wayback because a
      // solved live page beats an archived one.
      //
      // A solver miss is expected and is not an error — it falls through to
      // wayback exactly as a tier miss does.
      if (!fetched && challengeDetected) {
        console.error(`[searxng-mcp] fetch solver_byparr attempt url=${url}`);
        fetched = await runTier(
          "solver_byparr",
          url,
          () => solverFetch(url, storeChars, tuning),
          undefined,
          noteOutcome,
        );
        if (fetched) {
          tierServed = "solver_byparr";
          console.error(`[searxng-mcp] fetch solver_byparr hit url=${url}`);
        } else {
          console.error(`[searxng-mcp] fetch solver_byparr miss url=${url}`);
        }
      }

      if (!fetched && WAYBACK_ENABLED) {
        console.error(`[searxng-mcp] fetch tier4_wayback attempt url=${url}`);
        fetched = await runTier(
          "tier4_wayback",
          url,
          () => waybackFetch(url, storeChars),
          undefined,
          noteOutcome,
        );
        if (fetched) {
          tierServed = "tier4_wayback";
          console.error(`[searxng-mcp] fetch tier4_wayback hit url=${url}`);
        } else {
          console.error(`[searxng-mcp] fetch tier4_wayback miss url=${url}`);
        }
      }

      if (!fetched) {
        // Name every tier and why. "All fetch tiers failed" on its own is the
        // shape of error that hid #682 for weeks: it is equally consistent with
        // nothing being configured, with a backend being down, and with the
        // page genuinely having no content, so it sends the reader nowhere.
        const detail = outcomes.map((o) => `${o.tier}: ${o.reason}`).join("; ");
        const message = detail
          ? `All fetch tiers failed — ${detail}`
          : "All fetch tiers failed";
        events.error({
          stage: "fetch",
          url,
          error_type: "all_tiers_failed",
          message,
        });
        throw new Error(message);
      }

      const tierFetched: TierResult = fetched;
      const metadataHtml = await metadataHtmlPromise;
      recordMetadataFetchAttempt(url, metadataHtml !== null).catch(() => {});
      result = await withSpan("post_extract", { "fetch.url": url }, () =>
        applyPostExtract(tierFetched, url, metadataHtml, storeChars),
      );
    }

    // Strip html from cache payload — only the resolved title/text/url are persisted
    const persisted = {
      title: result.title,
      url: result.url,
      text: result.text,
    };
    await cacheSet(key, JSON.stringify(persisted), FETCH_CACHE_TTL_SECONDS);

    events.fetchCompleted({
      url,
      tier_served: tierServed,
      title: result.title,
      text_len: result.text.length,
      latency_ms: Date.now() - t_total,
    });

    return { ...persisted, text: persisted.text.slice(0, maxChars) };
  });
}
