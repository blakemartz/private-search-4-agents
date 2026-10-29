// Authority prior for ranking: a small, explainable bonus added to the
// cross-encoder score so that, among results the reranker considers equally
// on-topic, the project's own documentation and operator-boosted domains come
// first.
//
// Why it is needed: the cross-encoder's scores are bimodal and saturate. For
// "python asyncio TaskGroup exception handling" six results scored 0.99–1.00
// and docs.python.org scored 0.93, so it ranked 7th behind dev.to,
// GeeksforGeeks and a Substack post. The scores say all of them are on topic;
// they say nothing about which one is the source.
//
// Deliberately crude and bounded: each signal is cheap to compute, visible in
// the URL, and capped, so it can reorder near-ties but cannot lift an
// off-topic page over an on-topic one (a 0.01 page gains at most ~0.2).

import { urlMatchesDomain } from "../domains/rules.js";

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "how",
  "what",
  "why",
  "when",
  "does",
  "use",
  "using",
  "vs",
  "explained",
  "example",
  "examples",
  "difference",
  "between",
  "best",
  "guide",
  "tutorial",
  "error",
  "not",
  "working",
  "without",
  "from",
]);

/** Labels that carry no project identity. */
const GENERIC_LABELS = new Set([
  "www",
  "com",
  "org",
  "net",
  "io",
  "dev",
  "app",
  "co",
  "uk",
  "de",
  "docs",
  "doc",
  "developer",
  "developers",
  "blog",
  "wiki",
  "en",
  "api",
  "help",
  "support",
  "learn",
  "community",
  "forum",
  "forums",
  "users",
  "github",
]);

const DOCS_PATH =
  /\/(docs?|reference|manual|man|api|library|std|spec|handbook)(\/|$)/i;
const DOCS_HOST = /^(docs|doc|developer|developers|man|manual|wiki)\./i;

export function queryTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
    ),
  ];
}

/**
 * Does the hostname name the project the query is about? `python` matches
 * docs.python.org, `postgres` matches postgresql.org (prefix, 5+ chars), `git`
 * matches git-scm.com (hyphen-split label). Generic labels never match.
 */
export function hostNamesQueryTerm(host: string, terms: string[]): boolean {
  const labels = host
    .toLowerCase()
    .split(".")
    .flatMap((l) => [l, ...l.split("-")])
    .filter((l) => l.length >= 3 && !GENERIC_LABELS.has(l));
  return terms.some((t) =>
    labels.some(
      (l) =>
        l === t ||
        (t.length >= 5 && l.startsWith(t)) ||
        (l.length >= 5 && t.startsWith(l)),
    ),
  );
}

export interface AuthorityBreakdown {
  projectHost: boolean;
  docsShaped: boolean;
  boosted: boolean;
  /** Sum of the signals, before the weight is applied. 0..2.5 */
  total: number;
}

export function authority(
  query: string,
  url: string,
  boostList: string[],
): AuthorityBreakdown {
  let host = "";
  let path = "";
  try {
    const u = new URL(url);
    host = u.hostname;
    path = u.pathname;
  } catch {
    return { projectHost: false, docsShaped: false, boosted: false, total: 0 };
  }
  const projectHost = hostNamesQueryTerm(host, queryTerms(query));
  const docsShaped = DOCS_HOST.test(host) || DOCS_PATH.test(path);
  const boosted = boostList.some((pat) => urlMatchesDomain(url, pat));
  const total =
    (projectHost ? 1 : 0) + (docsShaped ? 0.5 : 0) + (boosted ? 1 : 0);
  return { projectHost, docsShaped, boosted, total };
}
