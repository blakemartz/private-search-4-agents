export { applyTier2Readability, crawl4aiFetch } from "./crawl4ai.js";
export { githubFetch, isGithubFastPathUrl, isGithubUrl } from "./github.js";
export { fetchRawHtmlForMetadata, rawFetch } from "./raw.js";
export { buildScopedCookieHeader, solverFetch } from "./solver.js";
export type { Tier } from "./types.js";
export { waybackFetch } from "./wayback.js";

import { assertNoChallengeBody } from "../challenge.js";
import { applyTier2Readability, crawl4aiFetch } from "./crawl4ai.js";
import { rawFetch } from "./raw.js";
import type { Tier } from "./types.js";

// Tier 2 reaches the origin through an external fetcher, so it hands back a
// rendered document with no origin status or headers — only the body rules in
// detectChallenge can apply. Both representations are passed because the
// markers live in the markup and the markdown/text projection strips them.
//
// There is no tier 1. It was Firecrawl, removed in this fork: the cascade
// starts at Crawl4AI. The slot names are kept as tier2/tier3 rather than
// renumbered because they are persisted in domain-db records and `tier_skip`
// config, and live processes on the old build share that database.

/** Tier 2 — Crawl4AI (browser automation + Readability post-processing). */
export const tier2: Tier = {
  name: "tier2_crawl4ai",
  slot: "tier2",
  async fetch(url, maxChars, preferFit = false, tuning) {
    const r = await crawl4aiFetch(url, maxChars, preferFit, tuning);
    if (!r) return null;
    assertNoChallengeBody(r.html, r.text);
    return applyTier2Readability(r, url);
  },
};

/** Tier 3 — Raw Node.js fetch + JSDOM Readability. */
export const tier3: Tier = {
  name: "tier3_rawfetch",
  slot: "tier3",
  async fetch(url, maxChars, _preferFit, tuning) {
    return rawFetch(url, maxChars, tuning);
  },
};

/** Canonical ordered tier list. Order determines cascade priority. */
export const ALL_TIERS: readonly Tier[] = [tier2, tier3];
