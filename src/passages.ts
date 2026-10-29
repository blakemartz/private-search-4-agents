// Query-relevant passages from a page: the shape Tavily calls `chunks` and Exa
// calls `highlights`. Chunk the stored markdown on paragraph boundaries, score
// every chunk against the query with the local cross-encoder, return the best.
//
// Without a reranker the scores fall back to term overlap. That is a much
// weaker signal, and the output says which one was used rather than letting a
// keyword match pass for a semantic one.

import { scorePassages } from "./reranker.js";

export interface Chunk {
  offset: number;
  text: string;
}

export interface ScoredChunk extends Chunk {
  score: number;
}

/** Target chunk size in chars. Big enough to carry a claim, small enough to rank. */
const CHUNK_CHARS = 700;
/** Most chunks sent to the cross-encoder per page; longer pages are prefiltered. */
const MAX_SCORED_CHUNKS = 64;

/**
 * Split on blank lines, then pack paragraphs into ~CHUNK_CHARS chunks. A
 * paragraph longer than a chunk is split on its own, at a sentence or line
 * break where one is near. Offsets index into `text` so a passage can be
 * followed up with fetch_url's `offset`.
 */
export function chunkText(text: string, size = CHUNK_CHARS): Chunk[] {
  const chunks: Chunk[] = [];
  const paras: Chunk[] = [];
  const re = /\n\s*\n/g;
  let last = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    paras.push({ offset: last, text: text.slice(last, m.index) });
    last = m.index + m[0].length;
  }
  paras.push({ offset: last, text: text.slice(last) });

  let cur: Chunk | null = null;
  const flush = () => {
    if (cur?.text.trim()) {
      chunks.push({ offset: cur.offset, text: cur.text.trim() });
    }
    cur = null;
  };
  for (const p of paras) {
    if (!p.text.trim()) continue;
    if (p.text.length > size) {
      flush();
      for (let i = 0; i < p.text.length; ) {
        let end = Math.min(i + size, p.text.length);
        if (end < p.text.length) {
          const window = p.text.slice(i + size / 2, end);
          const brk = Math.max(
            window.lastIndexOf(". "),
            window.lastIndexOf("\n"),
          );
          if (brk >= 0) end = i + size / 2 + brk + 1;
        }
        chunks.push({
          offset: p.offset + i,
          text: p.text.slice(i, end).trim(),
        });
        i = end;
      }
      continue;
    }
    if (cur && cur.text.length + p.text.length + 2 > size) flush();
    if (cur) cur.text += `\n\n${p.text}`;
    else cur = { offset: p.offset, text: p.text };
  }
  flush();
  return chunks.filter((c) => c.text.length > 0);
}

/**
 * A chunk as prose: link targets, image syntax, heading/emphasis markers and
 * permalink glyphs removed. Scored and shown in this form — a passage full of
 * `[text](https://… "title")` costs the reader tokens and the reranker signal.
 */
export function proseOf(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\((?:[^()]|\([^)]*\))*\)/g, "$1")
    .replace(/[§¶]/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*|__/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Below this, a chunk is mostly link targets or markup — a nav menu, a TOC. */
const MIN_PROSE_RATIO = 0.4;
const MIN_PROSE_CHARS = 80;

function terms(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 2);
}

/** Fraction of the query's distinct terms that appear in the chunk. */
export function overlapScore(query: string, text: string): number {
  const q = [...new Set(terms(query))];
  if (q.length === 0) return 0;
  const have = new Set(terms(text));
  return q.filter((t) => have.has(t)).length / q.length;
}

export interface PassageSelection {
  passages: ScoredChunk[];
  /** "reranker" when the cross-encoder scored them, "overlap" otherwise. */
  scoredBy: "reranker" | "overlap";
  chunkCount: number;
}

/** The `k` chunks of `text` most relevant to `query`, best first. */
export async function selectPassages(
  query: string,
  text: string,
  k: number,
): Promise<PassageSelection> {
  const all = chunkText(text)
    .map((c) => ({
      offset: c.offset,
      raw: c.text.length,
      text: proseOf(c.text),
    }))
    .filter(
      (c) =>
        c.text.length >= MIN_PROSE_CHARS &&
        c.text.length >= c.raw * MIN_PROSE_RATIO,
    )
    .map(({ offset, text }) => ({ offset, text }));
  if (all.length === 0) {
    return { passages: [], scoredBy: "overlap", chunkCount: 0 };
  }
  // Prefilter long pages by term overlap so the cross-encoder sees a bounded
  // batch. Stable sort keeps document order among ties.
  const pool =
    all.length <= MAX_SCORED_CHUNKS
      ? all
      : all
          .map((c, i) => ({ c, i, s: overlapScore(query, c.text) }))
          .sort((a, b) => b.s - a.s || a.i - b.i)
          .slice(0, MAX_SCORED_CHUNKS)
          .map((x) => x.c);

  const scores = await scorePassages(
    query,
    pool.map((c) => c.text),
  );
  const scoredBy = scores ? "reranker" : "overlap";
  const scored = pool.map((c, i) => ({
    ...c,
    score: scores ? scores[i] : overlapScore(query, c.text),
  }));
  scored.sort((a, b) => b.score - a.score);
  return { passages: scored.slice(0, k), scoredBy, chunkCount: all.length };
}
