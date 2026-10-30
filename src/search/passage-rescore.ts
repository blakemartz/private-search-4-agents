// Rescore the project's own docs pages on their text, not their snippet.
//
// The reranker sees the engine's title and snippet, and a docs page's snippet
// is often its navigation or an opening line that never names the topic. For
// "tokio select! cancellation safety" docs.rs's macro.select page, which has a
// whole "Cancellation safety" section, scored 0.021 on its snippet while a
// dozen blog posts saturated at 0.999. Its best passage scores like the blogs
// do, and the authority prior then puts it first.
//
// Bounded: only project-host results whose snippet scored low (the ones the
// snippet can be wrong about), at most RESCORE_PAGES of them, a few chunks per
// page, and a wall-clock budget. A page not read in time keeps its snippet
// score; its fetch still finishes and lands in the page cache, so the next
// search for it is a cache hit.

import {
  DOCS_RESCORE_BUDGET_MS,
  DOCS_RESCORE_ENABLED,
} from "../core/config.js";
import type { SearxResult } from "../core/types.js";
import { getBoostList } from "../domains/rules.js";
import { authority } from "./authority.js";
import { selectPassages } from "./passages.js";
import { rankScore } from "./reranker.js";

/** Pages read per query. Each costs a fetch (cached) and one small rerank. */
const RESCORE_PAGES = 3;
/** Chunks per page scored; prefiltered by term overlap (see passages.ts). */
const RESCORE_CHUNKS = 8;
/** Snippet relevance at or above which the snippet already did its job. */
const RESCORE_BELOW = 0.5;

export interface RescoreOptions {
  /** The page's stored markdown. Injected: search/ does not import fetch/. */
  fetchText: (url: string) => Promise<string>;
  applyRecency: boolean;
  profile?: string;
  budgetMs?: number;
}

/** Results worth reading: project-host pages the snippet scored low, deepest path first. */
export function rescoreCandidates(
  query: string,
  ranked: SearxResult[],
  boostList: string[],
): SearxResult[] {
  return ranked
    .map((r, i) => ({ r, i }))
    .filter(
      ({ r }) =>
        r.relevance !== undefined &&
        r.relevance < RESCORE_BELOW &&
        authority(query, r.url, boostList).projectHost,
    )
    .sort((a, b) => depth(b.r.url) - depth(a.r.url) || a.i - b.i)
    .slice(0, RESCORE_PAGES)
    .map(({ r }) => r);
}

function depth(url: string): number {
  try {
    return new URL(url).pathname.split("/").filter(Boolean).length;
  } catch {
    return 0;
  }
}

/**
 * `ranked` (reranker output, carrying `relevance`) with candidates' relevance
 * raised to their best passage's score, re-sorted on the reranker's key. Never
 * lowers a score, never throws, and returns `ranked` unchanged when nothing
 * qualifies or the reranker did not score the pool.
 */
export async function rescoreFromPages(
  query: string,
  ranked: SearxResult[],
  opts: RescoreOptions,
): Promise<SearxResult[]> {
  if (!DOCS_RESCORE_ENABLED) return ranked;
  const boostList = getBoostList(opts.profile);
  // The project's own page already leads: reading more of its pages could
  // only reorder docs below it, and would cost the fetches anyway.
  if (ranked[0] && authority(query, ranked[0].url, boostList).projectHost) {
    return ranked;
  }
  const candidates = rescoreCandidates(query, ranked, boostList);
  if (candidates.length === 0) return ranked;

  const best = new Map<string, number>();
  const work = candidates.map(async (r) => {
    try {
      const text = await opts.fetchText(r.url);
      const sel = await selectPassages(query, text, 1, RESCORE_CHUNKS);
      // Term-overlap scores are not on the cross-encoder's scale.
      const top = sel.passages[0];
      if (sel.scoredBy === "reranker" && top) best.set(r.url, top.score);
    } catch {
      // Unfetchable page: keep its snippet score.
    }
  });
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.all(work),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, opts.budgetMs ?? DOCS_RESCORE_BUDGET_MS);
    }),
  ]);
  clearTimeout(timer);
  if (best.size === 0) return ranked;

  return ranked
    .map((r, i) => {
      const relevance = Math.max(r.relevance ?? 0, best.get(r.url) ?? 0);
      return {
        r: { ...r, relevance },
        i,
        s: rankScore(query, r, relevance, opts.applyRecency, boostList),
      };
    })
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map(({ r }) => r);
}
