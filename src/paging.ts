// Windowing over a fetched page's stored text: the `offset` and `find` modes of
// fetch_url. Pure functions over a string so they are testable without a fetch.
//
// Every window that does not reach the end of the page says so, with the exact
// offset to continue from. The previous behaviour — slice to the budget and stop
// mid-word with no marker — left an agent unable to tell a short page from a cut
// one, and with no way to ask for the rest.

export interface PageWindow {
  /** The text to return, without the footer. */
  text: string;
  /** One line describing where the window sits in the page, or "" if it is the whole page. */
  footer: string;
}

const fmt = (n: number) => n.toLocaleString("en-US");

/**
 * `stored` is everything the cache holds for the page. `storeLimit` is the
 * cache ceiling: a stored text that reaches it was itself cut, so its length is
 * a lower bound on the page, not the page's size.
 */
export function windowText(
  stored: string,
  offset: number,
  maxChars: number,
  storeLimit: number,
): PageWindow {
  const total = stored.length;
  const capped = total >= storeLimit;
  const start = Math.min(Math.max(0, offset), total);
  const end = Math.min(start + maxChars, total);
  const text = stored.slice(start, end);
  if (start === 0 && end === total && !capped) return { text, footer: "" };

  const of = capped ? `≥${fmt(total)} (store limit)` : fmt(total);
  if (offset >= total) {
    return {
      text: "",
      footer: `[offset ${fmt(offset)} is past the end of the stored text (${of} chars)]`,
    };
  }
  const next =
    end < total
      ? ` · continue with offset=${end}`
      : capped
        ? " · rest of the page is beyond the store limit; use find to locate passages"
        : "";
  return {
    text,
    footer: `[chars ${fmt(start)}–${fmt(end)} of ${of}${next}]`,
  };
}

export interface Passage {
  offset: number;
  text: string;
}

/**
 * Passages of `stored` around case-insensitive matches of `find`. `find` may
 * name alternatives separated by `|` (e.g. "Q4_K_M|Q6_K"). Overlapping windows
 * merge, so one dense region comes back once rather than as N near-duplicates.
 */
export function findPassages(
  stored: string,
  find: string,
  { context = 300, maxPassages = 8 } = {},
): { passages: Passage[]; matches: number } {
  const terms = find
    .split("|")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (terms.length === 0) return { passages: [], matches: 0 };

  const hay = stored.toLowerCase();
  const hits: Array<[number, number]> = [];
  for (const term of terms) {
    for (let i = hay.indexOf(term); i !== -1; i = hay.indexOf(term, i + 1)) {
      hits.push([i, i + term.length]);
    }
  }
  hits.sort((a, b) => a[0] - b[0]);

  const ranges: Array<[number, number]> = [];
  for (const [s, e] of hits) {
    const lo = Math.max(0, s - context);
    const hi = Math.min(stored.length, e + context);
    const last = ranges.at(-1);
    if (last && lo <= last[1]) last[1] = Math.max(last[1], hi);
    else ranges.push([lo, hi]);
  }

  return {
    matches: hits.length,
    passages: ranges.slice(0, maxPassages).map(([lo, hi]) => ({
      offset: lo,
      text: stored.slice(lo, hi).trim(),
    })),
  };
}

export function formatPassages(
  find: string,
  result: { passages: Passage[]; matches: number },
  total: number,
): string {
  if (result.matches === 0) {
    return `[no matches for "${find}" in ${fmt(total)} stored chars]`;
  }
  const shown = result.passages.length;
  const body = result.passages
    .map((p) => `--- at offset ${p.offset} ---\n${p.text}`)
    .join("\n\n");
  const more =
    shown < result.matches
      ? ` (showing ${shown} passage${shown === 1 ? "" : "s"})`
      : "";
  return `[${result.matches} match${result.matches === 1 ? "" : "es"} for "${find}"${more}]\n\n${body}`;
}
