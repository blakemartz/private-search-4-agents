import {
  RERANK_AUTHORITY_WEIGHT,
  RERANK_RECENCY_WEIGHT,
  RERANKER_URL,
} from "../core/config.js";
import { logThrottled } from "../core/log.js";
import { withSpan } from "../core/observability.js";
import type { RerankResponse, SearxResult } from "../core/types.js";
import { getBoostList } from "../domains/rules.js";
import { authority } from "./authority.js";

/** Exponential decay recency score. Returns 0 for missing/unparseable dates. */
export function recencyScore(date?: string): number {
  if (!date) return 0;
  const ms = Date.parse(date);
  if (Number.isNaN(ms)) return 0;
  const ageDays = (Date.now() - ms) / 86_400_000;
  if (ageDays < 0) return 0; // future dates treated as neutral
  return Math.exp(-ageDays / 90);
}

async function rerank(
  query: string,
  results: SearxResult[],
  topN: number,
  applyRecency: boolean,
  minScore?: number,
  profile?: string,
): Promise<SearxResult[]> {
  if (results.length === 0) return results;
  const boostList = getBoostList(profile);

  const documents = results.map((r) => `${r.title}. ${r.content ?? ""}`.trim());

  const res = await fetch(`${RERANKER_URL}/v1/rerank`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Request scores for the full pool so the recency re-sort has all candidates.
    // FlashRank scores all documents regardless of top_n — this is a return-count
    // change only, not a compute change.
    body: JSON.stringify({ query, documents, top_n: results.length }),
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    throw new Error(`Reranker error: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as RerankResponse;

  const scored = data.results
    .filter((r) => r.index >= 0 && r.index < results.length)
    .map((r) => {
      const result = results[r.index];
      // Boosts are applied HERE, not only by applyDomainFilters' pre-sort:
      // that sort ran before the reranker re-sorted everything, so with a
      // reranker up a boosted domain got no lift at all.
      const combined =
        r.relevance_score +
        (applyRecency
          ? RERANK_RECENCY_WEIGHT * recencyScore(result.publishedDate)
          : 0) +
        RERANK_AUTHORITY_WEIGHT * authority(query, result.url, boostList).total;
      // `relevance` is carried alongside `score` rather than being discarded
      // here, because the two are NOT interchangeable and `min_score` must
      // filter on the raw one. See the filter below.
      return { result, score: combined, relevance: r.relevance_score };
    });

  // Filter BEFORE sort-and-slice. Slicing first would return fewer than `topN`
  // results even when enough qualifying ones existed further down the pool.
  //
  // Filtering on `relevance` (raw cross-encoder) and NOT on `score` (which adds
  // RERANK_RECENCY_WEIGHT * recencyScore) is deliberate. The combined value
  // ranges over 0..1.15 with the default weight of 0.15, so a parameter named
  // "minimum relevance" applied to it would silently let a low-relevance but
  // recent document past a threshold the caller believed was about relevance.
  const kept =
    minScore === undefined
      ? scored
      : scored.filter((s) => s.relevance >= minScore);

  kept.sort((a, b) => b.score - a.score);
  // The raw relevance rides along on the result so callers can show it. It is
  // the same value min_score filters on, never the recency-adjusted score.
  return kept
    .slice(0, topN)
    .map((s) => ({ ...s.result, relevance: s.relevance }));
}

export async function rerankWithFallback(
  query: string,
  results: SearxResult[],
  topN: number,
  timeRange?: string,
  minScore?: number,
  profile?: string,
): Promise<SearxResult[]> {
  return withSpan(
    "rerank",
    {
      "rerank.candidates": results.length,
      "rerank.top_n": topN,
      "rerank.min_score": minScore,
    },
    async () => {
      // An empty RERANKER_URL means "no reranker", and must actually mean it.
      //
      // Same shape as the CACHE_URL guard in cache.ts, for the same reason:
      // RERANKER_URL defaults to http://localhost:8787 and has no kill switch,
      // so "" is the only way off — and `fetch("" + "/v1/rerank")` is a
      // relative URL, which throws `Failed to parse URL from /v1/rerank` on
      // every single search. It fell through to the fallback below, so results
      // were correct, but each search paid a throw and logged a degradation
      // notice for a service the operator had deliberately not deployed.
      //
      // Returning here rather than throwing keeps "I turned it off" distinct
      // from "it broke" in the log, which is the whole point of the tri-state
      // capability line (vikunja#695).
      if (RERANKER_URL === "") return results.slice(0, topN);

      const applyRecency = !timeRange; // skip when caller already filtered by date
      try {
        return await rerank(
          query,
          results,
          topN,
          applyRecency,
          minScore,
          profile,
        );
      } catch (err) {
        // Reranker unavailable — fall back to SearXNG order. Silent otherwise;
        // one throttled line makes "why did ranking quality drop" answerable.
        logThrottled(
          "degrade:reranker",
          `reranker unavailable — using SearXNG result order: ${err instanceof Error ? err.message : String(err)}`,
        );
        // `min_score` becomes a documented NO-OP here, and says so. There are
        // no scores to filter on in this path, so the alternatives were: return
        // everything silently, which would let a caller believe a relevance
        // floor was applied when none was; or return nothing, which turns a
        // reranker outage into an empty result set. Both are worse than
        // unfiltered-and-announced.
        if (minScore !== undefined) {
          logThrottled(
            "degrade:reranker:min_score",
            `min_score=${minScore} ignored — reranker unavailable, so no relevance scores exist to filter on; returning unfiltered SearXNG order`,
          );
        }
        return results.slice(0, topN);
      }
    },
  );
}

/**
 * Raw cross-encoder relevance of each document to `query`, index-aligned with
 * `documents`. Null when the reranker is off or unavailable, so the caller can
 * pick its own fallback rather than treating a degraded score as a real one.
 */
export async function scorePassages(
  query: string,
  documents: string[],
): Promise<number[] | null> {
  if (RERANKER_URL === "" || documents.length === 0) return null;
  return withSpan(
    "rerank_passages",
    { "rerank.candidates": documents.length },
    async () => {
      try {
        const res = await fetch(`${RERANKER_URL}/v1/rerank`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query, documents, top_n: documents.length }),
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error(`Reranker error: ${res.status}`);
        const data = (await res.json()) as RerankResponse;
        const scores = new Array<number>(documents.length).fill(0);
        for (const r of data.results) {
          if (r.index >= 0 && r.index < documents.length) {
            scores[r.index] = r.relevance_score;
          }
        }
        return scores;
      } catch (err) {
        logThrottled(
          "degrade:reranker:passages",
          `reranker unavailable — passage selection falls back to term overlap: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    },
  );
}
